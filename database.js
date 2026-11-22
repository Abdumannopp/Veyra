const bcrypt = require('bcryptjs');
const path = require('path');
const crypto = require('crypto');
const { httpError, normalizePlate } = require('./lib/validation');
const { createRunner } = require('./lib/migrations');
const { normalizeCurrency, roundMoney, addMoney } = require('./lib/money');
const timeLib = require('./lib/time');
const legsLib = require('./lib/legs');
const tripsLib = require('./lib/trips');
const { current: currentContext, runAsSystem, settingsFor } = require('./lib/tenant-context');
const secrets = require('./lib/secrets');

const DB_PATH = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(__dirname, 'data', 'veyra.db');
// PostgreSQL when DATABASE_URL is set (production at scale); otherwise built-in SQLite in one file.
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const isPostgres = /^postgres(ql)?:\/\//i.test(DATABASE_URL);
// Tests run in parallel against one PostgreSQL: each test file gets its own schema.
const pgSchema = process.env.PG_TEST_SCHEMAS === '1'
  ? `t_${crypto.createHash('sha1').update(DB_PATH).digest('hex').slice(0, 16)}`
  : 'public';
const db = isPostgres
  ? new (require('./lib/postgres').Database)(DATABASE_URL, { schema: pgSchema })
  : new (require('./lib/sqlite').Database)(DB_PATH);
db.configure('busyTimeout', 10000);
db.run('PRAGMA foreign_keys = ON');
let hasLegacyEventStatusColumn = false;
let connectionQueue = Promise.resolve();

// One bcrypt cost for every hash (seeded, registered, admin-created and the login dummy),
// so response time cannot reveal which accounts exist.
const BCRYPT_COST = Math.min(Math.max(Number.parseInt(process.env.BCRYPT_COST, 10) || 12, 10), 14);

// Tenant 1 always exists: single-company installs and data from before multi-tenancy live there.
const DEFAULT_TENANT_ID = 1;
// Currency of amounts when a company has not chosen one (the server default, same rule as the app's).
const DEFAULT_CURRENCY = normalizeCurrency(process.env.CURRENCY, 'USD');

function runRaw(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function getRaw(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row || null);
    });
  });
}

function allRaw(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows || []);
    });
  });
}

function enqueueQuery(query) {
  const operation = connectionQueue.then(query);
  connectionQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

// Row level security (PostgreSQL): each statement runs for the company that started the request.
// The context is captured when the call is made, then applied in query order on the one connection.
async function applyContext(context) {
  if (typeof db.useContext !== 'function') return;
  await db.useContext(settingsFor(context));
}

function run(sql, params = []) {
  const context = currentContext();
  return enqueueQuery(async () => { await applyContext(context); return runRaw(sql, params); });
}

function get(sql, params = []) {
  const context = currentContext();
  return enqueueQuery(async () => { await applyContext(context); return getRaw(sql, params); });
}

function all(sql, params = []) {
  const context = currentContext();
  return enqueueQuery(async () => { await applyContext(context); return allRaw(sql, params); });
}

function withTransaction(work) {
  const context = currentContext();
  const transaction = connectionQueue.then(async () => {
    await applyContext(context);
    await runRaw('BEGIN IMMEDIATE');
    try {
      const result = await work({ run: runRaw, get: getRaw, all: allRaw });
      await runRaw('COMMIT');
      return result;
    } catch (error) {
      try {
        await runRaw('ROLLBACK');
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
      throw error;
    }
  });
  connectionQueue = transaction.then(() => undefined, () => undefined);
  return transaction;
}

// The currency new amounts are entered in: the company's own, else the server default.
async function currencyOf(tenantId, reader = get) {
  const row = await reader('SELECT currency FROM tenants WHERE id = ?', [tenantId]);
  return normalizeCurrency(row?.currency, DEFAULT_CURRENCY);
}

// The time zone people in this company see times and days in (storage is always UTC).
async function timeZoneOf(tenantId, reader = get) {
  const row = await reader('SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  return timeLib.timeZoneOr(row?.timezone, timeLib.timeZoneOr(process.env.TIMEZONE));
}

// Every data function is scoped to one company. A missing tenant is a programming error,
// and failing closed here is what keeps one company's loads invisible to another.
function assertTenant(tenantId) {
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new Error('A tenant is required for this operation.');
  }
  return tenantId;
}

async function ensureColumns(table, columns) {
  const existing = new Set((await all(`PRAGMA table_info(${table})`)).map((column) => column.name));
  for (const [column, type] of columns) {
    if (!existing.has(column)) {
      await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
}

// The whole schema as it was before versioned migrations. Idempotent: on an existing database it only
// adds what is missing, so it is safe as migration 0001 for old and new installs alike.
async function createBaselineSchema() {
  await run(`
    CREATE TABLE IF NOT EXISTS tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      gps_token_hash TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run('INSERT OR IGNORE INTO tenants (id, name) VALUES (?, ?)', [DEFAULT_TENANT_ID, (process.env.COMPANY_NAME || 'My company').slice(0, 120)]);

  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'operator'
    )
  `);
  // ALTER TABLE cannot add a REFERENCES column with a non-NULL default, so tenant links are
  // enforced by the application (every query filters on tenant_id).
  await ensureColumns('users', [
    ['disabled_at', 'INTEGER'],
    ['tenant_id', `INTEGER NOT NULL DEFAULT ${DEFAULT_TENANT_ID}`],
    ['is_platform_admin', 'INTEGER NOT NULL DEFAULT 0']
  ]);

  await run(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      jti TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    )
  `);
  await ensureColumns('auth_sessions', [['user_id', 'INTEGER']]);
  await run('DELETE FROM auth_sessions WHERE expires_at <= ?', [Math.floor(Date.now() / 1000)]);

  await run(`
    CREATE TABLE IF NOT EXISTS rate_limit_attempts (
      rate_key TEXT NOT NULL,
      attempted_at INTEGER NOT NULL
    )
  `);
  await run('CREATE INDEX IF NOT EXISTS idx_rate_limit_attempts_key_time ON rate_limit_attempts (rate_key, attempted_at)');
  await run('DELETE FROM rate_limit_attempts WHERE attempted_at <= ?', [Date.now() - 30 * 24 * 60 * 60 * 1000]);

  await run(`
    CREATE TABLE IF NOT EXISTS shipments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer TEXT NOT NULL,
      origin TEXT NOT NULL,
      destination TEXT NOT NULL,
      pickup TEXT,
      delivery TEXT,
      status TEXT NOT NULL,
      weight TEXT,
      equipment TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Carriers first: loads point to them (PostgreSQL needs the table to exist before the reference).
  await run(`
    CREATE TABLE IF NOT EXISTS carriers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL
    )
  `);

  await ensureColumns('shipments', [
    ['reference', 'TEXT'],
    ['carrier_id', 'INTEGER REFERENCES carriers(id)'],
    ['rate', 'REAL'],
    ['tracking_number', 'TEXT'],
    // Truck workflow: what the customer pays, who drives which truck, and where it is now.
    ['customer_rate', 'REAL'],
    ['driver_name', 'TEXT'],
    ['driver_phone', 'TEXT'],
    ['truck_plate', 'TEXT'],
    ['last_location', 'TEXT'],
    ['eta', 'TEXT'],
    ['last_tracked_at', 'TEXT'],
    ['customer_phone', 'TEXT'],
    ['tenant_id', `INTEGER NOT NULL DEFAULT ${DEFAULT_TENANT_ID}`],
    // Money follow-up: the invoice sent to the customer, and when each side was paid.
    ['customer_invoice_number', 'TEXT'],
    ['customer_invoiced_at', 'TEXT'],
    ['customer_paid_at', 'TEXT'],
    ['carrier_paid_at', 'TEXT'],
    // A link the customer can open without an account (only a hash of its secret is stored).
    ['share_token_hash', 'TEXT']
  ]);
  await run('CREATE INDEX IF NOT EXISTS idx_shipments_share ON shipments (share_token_hash)');

  // Who did what: account, settings and money changes. Never holds passwords, tokens or message texts.
  await run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      actor_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL,
      detail TEXT,
      ip TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run('CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_log (tenant_id, id)');

  await run(`
    CREATE TABLE IF NOT EXISTS shipment_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_id INTEGER NOT NULL,
      actor_id INTEGER,
      from_status TEXT,
      to_status TEXT NOT NULL,
      note TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (shipment_id) REFERENCES shipments(id),
      FOREIGN KEY (actor_id) REFERENCES users(id)
    )
  `);

  const eventColumns = await all('PRAGMA table_info(shipment_events)');
  const existingEventColumns = new Set(eventColumns.map((column) => column.name));
  hasLegacyEventStatusColumn = existingEventColumns.has('status');
  if (!existingEventColumns.has('from_status')) {
    await run('ALTER TABLE shipment_events ADD COLUMN from_status TEXT');
  }
  if (!existingEventColumns.has('to_status')) {
    await run('ALTER TABLE shipment_events ADD COLUMN to_status TEXT');
    if (existingEventColumns.has('status')) {
      await run('UPDATE shipment_events SET to_status = status WHERE to_status IS NULL');
    }
  }

  await ensureColumns('carriers', [
    ['phone', 'TEXT'],
    ['contact_name', 'TEXT'],
    ['tenant_id', `INTEGER NOT NULL DEFAULT ${DEFAULT_TENANT_ID}`]
  ]);

  // Location updates: typed by a dispatcher ("check call") or pushed by a GPS provider.
  await run(`
    CREATE TABLE IF NOT EXISTS tracking_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_id INTEGER NOT NULL,
      actor_id INTEGER,
      location TEXT NOT NULL,
      eta TEXT,
      note TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (shipment_id) REFERENCES shipments(id),
      FOREIGN KEY (actor_id) REFERENCES users(id)
    )
  `);
  await ensureColumns('tracking_updates', [
    ['source', "TEXT NOT NULL DEFAULT 'manual'"],
    ['lat', 'REAL'],
    ['lng', 'REAL']
  ]);

  // SMS / WhatsApp messages sent from a load (RELAY).
  await run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      shipment_id INTEGER NOT NULL REFERENCES shipments(id),
      channel TEXT NOT NULL,
      recipient_type TEXT NOT NULL,
      to_phone TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      provider TEXT,
      provider_message_id TEXT,
      error TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // One row per AI call: which agent, which model, tokens, time, result. Cost and quality are measured from this.
  await run(`
    CREATE TABLE IF NOT EXISTS agent_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      shipment_id INTEGER REFERENCES shipments(id),
      agent TEXT NOT NULL,
      status TEXT NOT NULL,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      latency_ms INTEGER,
      error TEXT,
      actor_id INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Delivery reports from the provider (delivered / read / failed), matched by a per-message secret.
  await ensureColumns('messages', [
    ['delivery_status', 'TEXT'],
    ['delivery_updated_at', 'TEXT'],
    ['error_code', 'TEXT'],
    ['callback_token_hash', 'TEXT']
  ]);
  await run('CREATE INDEX IF NOT EXISTS idx_messages_callback ON messages (callback_token_hash)');

  await ensureColumns('tenants', [
    ['inbox_token_hash', 'TEXT'],
    ['inbox_allowed_senders', 'TEXT'],
    // Encrypted JSON (see lib/secrets.js): this company's own Twilio account.
    ['messaging_config', 'TEXT'],
    // Encrypted JSON: the mailbox VEYRA reads orders from (IMAP). The state (position, last check) is plain JSON.
    ['imap_config', 'TEXT'],
    ['imap_state', 'TEXT'],
    // Which automatic NEXUS jobs this company wants (JSON; anything missing counts as on).
    ['automation_settings', 'TEXT'],
    // Subscription (see lib/plans.js). Companies that existed before plans keep everything: Enterprise, active.
    ['plan', "TEXT NOT NULL DEFAULT 'enterprise'"],
    ['plan_status', "TEXT NOT NULL DEFAULT 'active'"],
    ['trial_ends_at', 'TEXT'],
    ['user_limit', 'INTEGER'],
    ['shipment_limit', 'INTEGER'],
    // Paddle subscription (card payments): who pays, which subscription, and the newest change applied.
    ['billing_period', 'TEXT'],
    ['paddle_customer_id', 'TEXT'],
    ['paddle_subscription_id', 'TEXT'],
    ['paddle_changed_at', 'TEXT'],
    // Region per company (empty = the server default): ISO currency code and kg / lb.
    ['currency', 'TEXT'],
    ['weight_unit', 'TEXT'],
    // Which version of the Terms and Privacy Policy the company accepted, and when.
    ['terms_version', 'TEXT'],
    ['terms_accepted_at', 'TEXT']
  ]);

  // Emails (and other messages) that arrived for a company, waiting to become loads.
  await run(`
    CREATE TABLE IF NOT EXISTS inbox_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      source TEXT NOT NULL DEFAULT 'email',
      external_id TEXT,
      from_address TEXT,
      subject TEXT,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      parsed_json TEXT,
      error TEXT,
      shipment_id INTEGER REFERENCES shipments(id),
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_dedupe ON inbox_items (tenant_id, external_id) WHERE external_id IS NOT NULL');

  // Files that came with an email. They wait here until the email becomes a load (or is matched to one),
  // then they move to that load's documents.
  await run(`
    CREATE TABLE IF NOT EXISTS inbox_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      inbox_id INTEGER NOT NULL REFERENCES inbox_items(id),
      filename TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      content BLOB NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run('CREATE INDEX IF NOT EXISTS idx_inbox_attachments_item ON inbox_attachments (inbox_id)');

  // Work NEXUS prepared for a person: review an order, book a carrier, approve a message...
  // dedupe_key makes every event idempotent: the same event twice never creates a second task.
  await run(`
    CREATE TABLE IF NOT EXISTS nexus_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      shipment_id INTEGER REFERENCES shipments(id),
      inbox_id INTEGER REFERENCES inbox_items(id),
      payload TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      dedupe_key TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT,
      resolved_by INTEGER REFERENCES users(id)
    )
  `);
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_nexus_tasks_dedupe ON nexus_tasks (tenant_id, dedupe_key)');

  // CMR, proof of delivery and other files attached to a load (stored in the database file itself,
  // so one backup covers everything).
  await run(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      shipment_id INTEGER NOT NULL REFERENCES shipments(id),
      doc_type TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      content BLOB NOT NULL,
      extraction_status TEXT NOT NULL DEFAULT 'pending',
      extracted_json TEXT,
      comparison_json TEXT,
      error TEXT,
      uploaded_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_dedupe ON documents (shipment_id, sha256)');

  // Prices the company knows from the market (a broker's list, a freight exchange): PULSE compares with them.
  await run(`
    CREATE TABLE IF NOT EXISTS market_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      origin TEXT NOT NULL,
      destination TEXT NOT NULL,
      equipment TEXT NOT NULL DEFAULT '',
      rate REAL NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_market_rates_lane ON market_rates (tenant_id, lower(origin), lower(destination), equipment)');

  // Typical waiting time at a border between two countries (hours), entered by the company.
  await run(`
    CREATE TABLE IF NOT EXISTS border_waits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      pair TEXT NOT NULL,
      hours REAL NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_border_waits_pair ON border_waits (tenant_id, pair)');

  // Price offers to customers, before a load exists. An accepted quote becomes a load.
  await run(`
    CREATE TABLE IF NOT EXISTS quotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      customer TEXT NOT NULL,
      customer_phone TEXT,
      origin TEXT NOT NULL,
      destination TEXT NOT NULL,
      equipment TEXT NOT NULL,
      weight REAL,
      pickup TEXT,
      delivery TEXT,
      price REAL NOT NULL,
      carrier_cost REAL,
      valid_until TEXT NOT NULL,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      shipment_id INTEGER REFERENCES shipments(id),
      created_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run('CREATE INDEX IF NOT EXISTS idx_quotes_tenant ON quotes (tenant_id, id)');

  // Automation Studio: rules a company writes ("when ... then ...") and a log of each time one ran.
  await run(`
    CREATE TABLE IF NOT EXISTS workflows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      name TEXT NOT NULL,
      description TEXT,
      trigger TEXT NOT NULL,
      trigger_status TEXT,
      conditions TEXT NOT NULL DEFAULT '[]',
      actions TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run('CREATE INDEX IF NOT EXISTS idx_workflows_tenant ON workflows (tenant_id, trigger)');
  await run(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      workflow_id INTEGER NOT NULL,
      shipment_id INTEGER,
      status TEXT NOT NULL,
      detail TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run('CREATE INDEX IF NOT EXISTS idx_workflow_runs_tenant ON workflow_runs (tenant_id, id)');

  // Map lookups are cached: a place name is looked up once, a road route once.
  await run(`
    CREATE TABLE IF NOT EXISTS geo_places (
      place_key TEXT PRIMARY KEY,
      lat REAL,
      lng REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS geo_routes (
      route_key TEXT PRIMARY KEY,
      distance_km REAL NOT NULL,
      duration_h REAL NOT NULL,
      points_json TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Indexes for the columns the app filters, joins and sorts on.
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments (status)',
    'CREATE INDEX IF NOT EXISTS idx_shipments_carrier ON shipments (carrier_id)',
    'CREATE INDEX IF NOT EXISTS idx_shipments_created ON shipments (created_at, id)',
    'CREATE INDEX IF NOT EXISTS idx_shipments_tenant ON shipments (tenant_id, id)',
    'CREATE INDEX IF NOT EXISTS idx_shipments_tenant_status ON shipments (tenant_id, status)',
    'CREATE INDEX IF NOT EXISTS idx_shipment_events_shipment ON shipment_events (shipment_id, id)',
    'CREATE INDEX IF NOT EXISTS idx_carriers_status ON carriers (status)',
    'CREATE INDEX IF NOT EXISTS idx_carriers_tenant ON carriers (tenant_id, status)',
    'CREATE INDEX IF NOT EXISTS idx_users_tenant ON users (tenant_id)',
    'CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions (expires_at)',
    'CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions (user_id)',
    'CREATE INDEX IF NOT EXISTS idx_tracking_updates_shipment ON tracking_updates (shipment_id, id)',
    'CREATE INDEX IF NOT EXISTS idx_messages_shipment ON messages (shipment_id, id)',
    'CREATE INDEX IF NOT EXISTS idx_agent_tasks_tenant ON agent_tasks (tenant_id, id)',
    'CREATE INDEX IF NOT EXISTS idx_inbox_tenant ON inbox_items (tenant_id, id)',
    'CREATE INDEX IF NOT EXISTS idx_nexus_tasks_open ON nexus_tasks (tenant_id, status, id)',
    'CREATE INDEX IF NOT EXISTS idx_nexus_tasks_shipment ON nexus_tasks (shipment_id)',
    'CREATE INDEX IF NOT EXISTS idx_documents_shipment ON documents (shipment_id, id)'
  ];
  for (const statement of indexes) await run(statement);
}

/* ---------- row level security (PostgreSQL only) ---------- */
const RLS_ROLE = 'veyra_app';
// Tables whose rows belong to a company through their shipment rather than a tenant_id column of their own.
const RLS_VIA_SHIPMENT = ['shipment_events', 'tracking_updates'];
const RLS_SYSTEM = "current_setting('veyra.system', true) = 'on'";
const RLS_TENANT = "nullif(current_setting('veyra.tenant_id', true), '')::bigint";

async function rlsTables(tx) {
  const rows = await tx.all(
    "SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'tenant_id' ORDER BY table_name"
  );
  return rows.map((row) => row.table_name);
}

// One company table: forced RLS and a policy that shows a company only its own rows.
async function protectTenantTable(tx, table) {
  await tx.run(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  await tx.run(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  await tx.run(`DROP POLICY IF EXISTS tenant_isolation ON ${table}`);
  await tx.run(`CREATE POLICY tenant_isolation ON ${table} USING (${RLS_SYSTEM} OR tenant_id = ${RLS_TENANT}) WITH CHECK (${RLS_SYSTEM} OR tenant_id = ${RLS_TENANT})`);
  await tx.run(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RLS_ROLE}') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO ${RLS_ROLE}', '${table}');
      EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO ${RLS_ROLE}', current_schema());
    END IF;
  END $$`);
}

async function enableRowLevelSecurity(tx) {
  // The role the app switches to. It cannot log in, owns nothing and bypasses nothing, so policies bind it.
  await tx.run(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RLS_ROLE}') THEN
      BEGIN CREATE ROLE ${RLS_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS;
      EXCEPTION WHEN duplicate_object THEN NULL; WHEN insufficient_privilege THEN RAISE NOTICE 'cannot create role ${RLS_ROLE}';
      END;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RLS_ROLE}') THEN
      BEGIN EXECUTE 'GRANT ${RLS_ROLE} TO CURRENT_USER'; EXCEPTION WHEN OTHERS THEN NULL; END;
    END IF;
  END $$`);
  for (const table of await rlsTables(tx)) await protectTenantTable(tx, table);
  // The tenants table is keyed by id, not tenant_id.
  await tx.run('ALTER TABLE tenants ENABLE ROW LEVEL SECURITY');
  await tx.run('ALTER TABLE tenants FORCE ROW LEVEL SECURITY');
  await tx.run('DROP POLICY IF EXISTS tenant_isolation ON tenants');
  await tx.run(`CREATE POLICY tenant_isolation ON tenants USING (${RLS_SYSTEM} OR id = ${RLS_TENANT}) WITH CHECK (${RLS_SYSTEM} OR id = ${RLS_TENANT})`);
  for (const table of RLS_VIA_SHIPMENT) {
    const visible = `${RLS_SYSTEM} OR EXISTS (SELECT 1 FROM shipments s WHERE s.id = ${table}.shipment_id AND s.tenant_id = ${RLS_TENANT})`;
    await tx.run(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await tx.run(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    await tx.run(`DROP POLICY IF EXISTS tenant_isolation ON ${table}`);
    await tx.run(`CREATE POLICY tenant_isolation ON ${table} USING (${visible}) WITH CHECK (${visible})`);
  }
  await tx.run(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RLS_ROLE}') THEN
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO ${RLS_ROLE}', current_schema());
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO ${RLS_ROLE}', current_schema());
      EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO ${RLS_ROLE}', current_schema());
      EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %I TO ${RLS_ROLE}', current_schema());
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${RLS_ROLE}', current_schema());
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO ${RLS_ROLE}', current_schema());
    END IF;
  END $$`);
}

async function disableRowLevelSecurity(tx) {
  for (const table of [...(await rlsTables(tx)), 'tenants', ...RLS_VIA_SHIPMENT]) {
    await tx.run(`DROP POLICY IF EXISTS tenant_isolation ON ${table}`);
    await tx.run(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
    await tx.run(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
  }
}

// After migrating, the app connection drops to the restricted role so the policies apply.
// DB_RLS=off keeps the owner role (development and tests that read across companies).
let rlsEnforced = false;
async function enforceRowLevelSecurity() {
  if (!isPostgres || process.env.DB_RLS === 'off') return false;
  const role = await get('SELECT 1 AS ok FROM pg_roles WHERE rolname = ?', [RLS_ROLE]);
  if (!role) {
    console.warn(`[db] row level security is NOT enforced: the ${RLS_ROLE} role could not be created (the database user needs CREATEROLE).`);
    return false;
  }
  await db.enforceRole(RLS_ROLE);
  rlsEnforced = true;
  return true;
}

/* ---------- money: currency per amount, exact decimals ---------- */
const MONEY_TABLES = ['shipments', 'quotes', 'market_rates'];
const MONEY_COLUMNS = { shipments: ['rate', 'customer_rate'], quotes: ['price', 'carrier_cost'], market_rates: ['rate'] };

async function addMoneyCurrency() {
  for (const table of MONEY_TABLES) {
    await ensureColumns(table, [['currency', 'TEXT']]);
    // Existing amounts were entered in the company's currency at the time; label them with it.
    await run(
      `UPDATE ${table} SET currency = COALESCE(NULLIF((SELECT tenants.currency FROM tenants WHERE tenants.id = ${table}.tenant_id), ''), ?) WHERE currency IS NULL`,
      [DEFAULT_CURRENCY]
    );
    if (isPostgres) {
      for (const column of MONEY_COLUMNS[table]) {
        await run(`ALTER TABLE ${table} ALTER COLUMN ${column} TYPE NUMERIC(18,4) USING ROUND(${column}::numeric, 4)`);
      }
    }
  }
}

/* ---------- versioned migrations (lib/migrations.js) ---------- */
// Add new schema changes as new entries at the end, never by editing an applied one.
const MIGRATIONS = [
  {
    id: '0001_baseline',
    name: 'Schema as of the first versioned release',
    transactional: false,
    up: () => createBaselineSchema(),
    down: () => {
      throw new Error('0001_baseline cannot be reversed. Recovery: restore the database backup taken before the upgrade.');
    }
  },
  {
    id: '0002_row_level_security',
    name: 'PostgreSQL row level security: a company can only reach its own rows',
    up: (tx) => (isPostgres ? enableRowLevelSecurity(tx) : undefined),
    down: (tx) => (isPostgres ? disableRowLevelSecurity(tx) : undefined)
  },
  {
    id: '0003_money_currency',
    name: 'Every amount carries its ISO currency; PostgreSQL stores money as exact NUMERIC(18,4)',
    transactional: false,
    up: () => addMoneyCurrency(),
    down: () => {
      throw new Error('0003_money_currency cannot be reversed. Recovery: restore the database backup taken before the upgrade.');
    }
  },
  {
    id: '0004_durable_jobs',
    name: 'Durable background jobs: retries, backoff, idempotency keys, dead letters',
    up: async (tx) => {
      await tx.run(`
        CREATE TABLE IF NOT EXISTS jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL REFERENCES tenants(id),
          kind TEXT NOT NULL,
          lane TEXT NOT NULL DEFAULT 'default',
          payload TEXT NOT NULL DEFAULT '{}',
          idempotency_key TEXT,
          status TEXT NOT NULL DEFAULT 'queued',
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 5,
          run_at TEXT DEFAULT CURRENT_TIMESTAMP,
          locked_at TEXT,
          locked_by TEXT,
          last_error TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          finished_at TEXT
        )`);
      await tx.run('CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs (status, run_at, id)');
      await tx.run('CREATE INDEX IF NOT EXISTS idx_jobs_lane ON jobs (tenant_id, lane, status, id)');
      await tx.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idempotency ON jobs (tenant_id, kind, idempotency_key) WHERE idempotency_key IS NOT NULL');
      if (isPostgres) await protectTenantTable(tx, 'jobs');
    },
    down: (tx) => tx.run('DROP TABLE IF EXISTS jobs')
  },
  {
    id: '0005_company_time_zone_locale',
    name: 'Each company chooses a time zone and a locale for how dates and numbers are shown (storage stays UTC)',
    transactional: false,
    up: () => ensureColumns('tenants', [['timezone', 'TEXT'], ['locale', 'TEXT']]),
    down: (tx) => {
      throw new Error('0005_company_time_zone_locale cannot be reversed. Recovery: restore the database backup taken before the upgrade (the new columns are harmless if left).');
    }
  },
  {
    id: '0006_shipment_legs',
    name: 'Shipment legs: one order, several legs by road, ocean, air, rail, warehouse or last mile',
    transactional: false,
    up: async (tx) => {
      await ensureColumns('shipments', [['leg_mode', "TEXT NOT NULL DEFAULT 'single'"]]);
      await ensureColumns('documents', [['leg_id', 'INTEGER']]);
      await ensureColumns('tracking_updates', [['leg_id', 'INTEGER']]);
      await run(`
        CREATE TABLE IF NOT EXISTS shipment_legs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL REFERENCES tenants(id),
          shipment_id INTEGER NOT NULL REFERENCES shipments(id),
          sequence INTEGER NOT NULL,
          mode TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'Planned',
          carrier_id INTEGER REFERENCES carriers(id),
          origin TEXT NOT NULL,
          destination TEXT NOT NULL,
          scheduled_pickup TEXT,
          scheduled_delivery TEXT,
          price REAL,
          currency TEXT,
          reference TEXT,
          details TEXT NOT NULL DEFAULT '{}',
          last_location TEXT,
          eta TEXT,
          last_tracked_at TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
      await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_shipment_legs_sequence ON shipment_legs (shipment_id, sequence)');
      await run('CREATE INDEX IF NOT EXISTS idx_shipment_legs_tenant ON shipment_legs (tenant_id, shipment_id)');
      await run(`
        CREATE TABLE IF NOT EXISTS leg_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL REFERENCES tenants(id),
          leg_id INTEGER NOT NULL REFERENCES shipment_legs(id),
          from_status TEXT,
          to_status TEXT NOT NULL,
          note TEXT,
          actor_id INTEGER,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
      await run('CREATE INDEX IF NOT EXISTS idx_leg_events_leg ON leg_events (leg_id, id)');
      await run(`
        CREATE TABLE IF NOT EXISTS leg_handovers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL REFERENCES tenants(id),
          shipment_id INTEGER NOT NULL REFERENCES shipments(id),
          from_leg_id INTEGER NOT NULL REFERENCES shipment_legs(id),
          to_leg_id INTEGER NOT NULL REFERENCES shipment_legs(id),
          location TEXT,
          received_by TEXT,
          note TEXT,
          actor_id INTEGER,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
      await run('CREATE INDEX IF NOT EXISTS idx_leg_handovers_shipment ON leg_handovers (shipment_id, id)');
      if (isPostgres) {
        await run('ALTER TABLE shipment_legs ALTER COLUMN price TYPE NUMERIC(18,4) USING ROUND(price::numeric, 4)');
        for (const table of ['shipment_legs', 'leg_events', 'leg_handovers']) await protectTenantTable(tx, table);
      }
    },
    down: () => {
      throw new Error('0006_shipment_legs cannot be reversed. Recovery: restore the database backup taken before the upgrade.');
    }
  },
  {
    id: '0007_leg_payments',
    name: 'Each leg of a multi-leg load can be marked paid to its carrier',
    transactional: false,
    up: () => ensureColumns('shipment_legs', [['paid_at', 'TEXT']]),
    down: () => {
      throw new Error('0007_leg_payments cannot be reversed. Recovery: restore the database backup taken before the upgrade (the new column is harmless if left).');
    }
  },
  {
    id: '0008_trips',
    name: 'Trips: one truck run carrying several shipments (LTL), with the truck price split among them',
    transactional: false,
    up: async (tx) => {
      await ensureColumns('shipments', [['trip_id', 'INTEGER']]);
      await run(`
        CREATE TABLE IF NOT EXISTS trips (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL REFERENCES tenants(id),
          carrier_id INTEGER REFERENCES carriers(id),
          status TEXT NOT NULL DEFAULT 'Planned',
          origin TEXT NOT NULL,
          destination TEXT NOT NULL,
          scheduled_pickup TEXT,
          scheduled_delivery TEXT,
          capacity_weight_kg REAL,
          capacity_pallets INTEGER,
          cost REAL,
          currency TEXT,
          truck_plate TEXT,
          driver_name TEXT,
          driver_phone TEXT,
          notes TEXT,
          last_location TEXT,
          eta TEXT,
          last_tracked_at TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
      await run('CREATE INDEX IF NOT EXISTS idx_trips_tenant ON trips (tenant_id, status, id)');
      await run(`
        CREATE TABLE IF NOT EXISTS trip_shipments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL REFERENCES tenants(id),
          trip_id INTEGER NOT NULL REFERENCES trips(id),
          shipment_id INTEGER NOT NULL REFERENCES shipments(id),
          weight_kg REAL NOT NULL DEFAULT 0,
          pallets INTEGER NOT NULL DEFAULT 0,
          pickup_seq INTEGER,
          drop_seq INTEGER,
          cost_share REAL,
          delivered_at TEXT,
          released_at TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
      // A shipment is on at most one trip at a time (a released allocation stays as history).
      await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_trip_shipments_active ON trip_shipments (shipment_id) WHERE released_at IS NULL');
      await run('CREATE INDEX IF NOT EXISTS idx_trip_shipments_trip ON trip_shipments (tenant_id, trip_id)');
      await run(`
        CREATE TABLE IF NOT EXISTS trip_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL REFERENCES tenants(id),
          trip_id INTEGER NOT NULL REFERENCES trips(id),
          from_status TEXT,
          to_status TEXT NOT NULL,
          note TEXT,
          actor_id INTEGER,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
      await run('CREATE INDEX IF NOT EXISTS idx_trip_events_trip ON trip_events (trip_id, id)');
      if (isPostgres) {
        await run('ALTER TABLE trips ALTER COLUMN cost TYPE NUMERIC(18,4) USING ROUND(cost::numeric, 4)');
        await run('ALTER TABLE trip_shipments ALTER COLUMN cost_share TYPE NUMERIC(18,4) USING ROUND(cost_share::numeric, 4)');
        for (const table of ['trips', 'trip_shipments', 'trip_events']) await protectTenantTable(tx, table);
      }
    },
    down: () => {
      throw new Error('0008_trips cannot be reversed. Recovery: restore the database backup taken before the upgrade.');
    }
  }
];

// Only one server process may migrate at a time (PostgreSQL advisory lock; SQLite has one writer anyway).
const migrationRunner = createRunner({
  run, get, all, withTransaction,
  lock: async (work) => {
    if (!isPostgres) return work();
    await run('SELECT pg_advisory_lock(472019)');
    try {
      return await work();
    } finally {
      await run('SELECT pg_advisory_unlock(472019)');
    }
  }
});

async function migrate(options) {
  return migrationRunner.up(MIGRATIONS, options);
}

async function initialize() {
  const isProduction = process.env.NODE_ENV !== 'development';
  await migrate();
  await enforceRowLevelSecurity();
  // Seeding and repair work belong to the server, not to one company.
  return runAsSystem(() => seedAndVerify(isProduction));
}

async function seedAndVerify(isProduction) {
  // Installs upgraded from very old versions still carry a legacy status column on events.
  hasLegacyEventStatusColumn = (await all('PRAGMA table_info(shipment_events)')).some((column) => column.name === 'status');

  const seedUsers = [
    { name: 'Alex Carter', email: 'admin@veyra.ai', password: 'admin123', role: 'admin', platform: 1 },
    { name: 'Emma Wilson', email: 'ops@veyra.ai', password: 'ops123', role: 'operations', platform: 0 },
    { name: 'Demo Operator', email: 'demo@veyra.ai', password: 'demo123', role: 'operator', platform: 0 }
  ];

  if (isProduction) {
    const userCount = await get('SELECT COUNT(*) AS total FROM users');
    if (Number(userCount?.total) === 0) {
      const { INITIAL_ADMIN_NAME, INITIAL_ADMIN_EMAIL, INITIAL_ADMIN_PASSWORD } = process.env;
      if (!INITIAL_ADMIN_NAME || !INITIAL_ADMIN_EMAIL || !INITIAL_ADMIN_PASSWORD || INITIAL_ADMIN_PASSWORD.length < 12) {
        throw new Error('Set INITIAL_ADMIN_NAME, INITIAL_ADMIN_EMAIL, and an INITIAL_ADMIN_PASSWORD of at least 12 characters before first production startup.');
      }
      const hashedPassword = await bcrypt.hash(INITIAL_ADMIN_PASSWORD, BCRYPT_COST);
      // The first administrator also runs the platform: they can add other companies.
      await run(
        'INSERT INTO users (name, email, password, role, tenant_id, is_platform_admin) VALUES (?, ?, ?, ?, ?, 1)',
        [INITIAL_ADMIN_NAME.trim(), INITIAL_ADMIN_EMAIL.trim().toLowerCase(), hashedPassword, 'admin', DEFAULT_TENANT_ID]
      );
    }
  } else {
    for (const user of seedUsers) {
      const exists = await get('SELECT id FROM users WHERE email = ?', [user.email]);
      if (!exists) {
        const hashedPassword = await bcrypt.hash(user.password, BCRYPT_COST);
        await run(
          'INSERT INTO users (name, email, password, role, tenant_id, is_platform_admin) VALUES (?, ?, ?, ?, ?, ?)',
          [user.name, user.email, hashedPassword, user.role, DEFAULT_TENANT_ID, user.platform]
        );
      }
    }

    const carrierCount = await get('SELECT COUNT(*) AS total FROM carriers');
    if (!carrierCount || Number(carrierCount.total) === 0) {
      await run('INSERT INTO carriers (name, mode, status, phone, contact_name, tenant_id) VALUES (?, ?, ?, ?, ?, ?)', ['Atlas Freight', 'Truckload', 'Available', '+1 214 555 0100', 'Dana Brooks', DEFAULT_TENANT_ID]);
      await run('INSERT INTO carriers (name, mode, status, phone, contact_name, tenant_id) VALUES (?, ?, ?, ?, ?, ?)', ['North Wind Logistics', 'LTL', 'Available', '+1 312 555 0142', 'Sam Ortiz', DEFAULT_TENANT_ID]);
      // Available (not Busy): a carrier is only Busy while it has an active load.
      await run('INSERT INTO carriers (name, mode, status, phone, contact_name, tenant_id) VALUES (?, ?, ?, ?, ?, ?)', ['Blue Ridge Cargo', 'Expedited', 'Available', '+1 404 555 0178', 'Lee Grant', DEFAULT_TENANT_ID]);
    }

    const shipmentCount = await get('SELECT COUNT(*) AS total FROM shipments');
    if (!shipmentCount || Number(shipmentCount.total) === 0) {
      const seed = 'INSERT INTO shipments (customer, origin, destination, pickup, delivery, status, weight, equipment, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
      await run(seed, ['ABC Retail', 'Dallas, TX', 'Houston, TX', 'Oct 3', 'Oct 4', 'New', '4500 kg', 'Dry Van', DEFAULT_TENANT_ID]);
      await run(seed, ['Global Parts', 'Chicago, IL', 'Atlanta, GA', 'Oct 3', 'Oct 5', 'Pending Approval', '3850 kg', 'Reefer', DEFAULT_TENANT_ID]);
      await run(seed, ['Prime Goods', 'Los Angeles, CA', 'Phoenix, AZ', 'Oct 2', 'Oct 3', 'Sourcing', '5400 kg', 'Flatbed', DEFAULT_TENANT_ID]);
    }
  }

  // Upgrading an install from before multi-company support: its first active admin runs the platform.
  const platformAdmin = await get('SELECT id FROM users WHERE is_platform_admin = 1 LIMIT 1');
  if (!platformAdmin) {
    await run(
      "UPDATE users SET is_platform_admin = 1 WHERE id = (SELECT id FROM users WHERE role = 'admin' AND disabled_at IS NULL AND tenant_id = ? ORDER BY id LIMIT 1)",
      [DEFAULT_TENANT_ID]
    );
  }

  const eventBackfill = hasLegacyEventStatusColumn
    ? `INSERT INTO shipment_events (shipment_id, status, from_status, to_status, note)
       SELECT shipments.id, shipments.status, NULL, shipments.status, 'Current status imported'
       FROM shipments
       WHERE NOT EXISTS (SELECT 1 FROM shipment_events WHERE shipment_events.shipment_id = shipments.id)`
    : `INSERT INTO shipment_events (shipment_id, from_status, to_status, note)
       SELECT shipments.id, NULL, shipments.status, 'Current status imported'
       FROM shipments
       WHERE NOT EXISTS (SELECT 1 FROM shipment_events WHERE shipment_events.shipment_id = shipments.id)`;
  await run(eventBackfill);


  const health = await checkIntegrity();
  if (!health.ok) {
    console.warn('[database] integrity warning:', JSON.stringify(health));
  }
}

async function checkIntegrity() {
  const [integrity, violations] = await Promise.all([all('PRAGMA integrity_check'), all('PRAGMA foreign_key_check')]);
  const messages = integrity.map((row) => row.integrity_check);
  return {
    ok: messages.length === 1 && messages[0] === 'ok' && violations.length === 0,
    integrity: messages,
    foreignKeyViolations: violations.length
  };
}

/* ---------------- tenants (companies) ---------------- */

async function getTenant(tenantId) {
  const row = await get(
    `SELECT id, name, gps_token_hash AS gpsTokenHash, inbox_token_hash AS inboxTokenHash,
       inbox_allowed_senders AS inboxAllowedSenders, messaging_config AS messagingConfig,
       imap_config AS imapConfig, imap_state AS imapState, automation_settings AS automationSettingsJson, created_at AS createdAt,
       plan, plan_status AS planStatus, trial_ends_at AS trialEndsAt, user_limit AS userLimit, shipment_limit AS shipmentLimit,
       billing_period AS billingPeriod, paddle_customer_id AS paddleCustomerId, paddle_subscription_id AS paddleSubscriptionId,
       currency, weight_unit AS weightUnit, timezone AS timeZone, locale, terms_version AS termsVersion, terms_accepted_at AS termsAcceptedAt
     FROM tenants WHERE id = ?`,
    [assertTenant(tenantId)]
  );
  if (!row) return null;
  let allowedSenders = [];
  try {
    const parsed = JSON.parse(row.inboxAllowedSenders || '[]');
    if (Array.isArray(parsed)) allowedSenders = parsed.filter((entry) => typeof entry === 'string');
  } catch (_) {
    allowedSenders = [];
  }
  // The decrypted Twilio settings stay on the server; callers outside messaging never expose them.
  const messagingSettings = row.messagingConfig ? secrets.decrypt(row.messagingConfig) : null;
  const imapSettings = row.imapConfig ? secrets.decrypt(row.imapConfig) : null;
  let imapState = null;
  try {
    imapState = row.imapState ? JSON.parse(row.imapState) : null;
  } catch (_) {
    imapState = null;
  }
  let automationSettings = {};
  try {
    const parsed = JSON.parse(row.automationSettingsJson || '{}');
    if (parsed && typeof parsed === 'object') automationSettings = parsed;
  } catch (_) {
    automationSettings = {};
  }
  const { imapConfig, automationSettingsJson, ...rest } = row;
  return { ...rest, allowedSenders, messagingSettings, imapSettings, imapState, automationSettings };
}

async function listTenants() {
  const rows = await all(`
    SELECT tenants.id, tenants.name, tenants.created_at AS createdAt,
      tenants.plan, tenants.plan_status AS planStatus, tenants.trial_ends_at AS trialEndsAt,
      tenants.user_limit AS userLimit, tenants.shipment_limit AS shipmentLimit,
      (SELECT COUNT(*) FROM users WHERE users.tenant_id = tenants.id) AS users,
      (SELECT COUNT(*) FROM shipments WHERE shipments.tenant_id = tenants.id) AS shipments,
      (SELECT COUNT(*) FROM shipments WHERE shipments.tenant_id = tenants.id AND shipments.created_at >= strftime('%Y-%m-01 00:00:00', 'now')) AS shipmentsThisMonth
    FROM tenants ORDER BY tenants.id
  `);
  return rows.map((row) => ({ ...row, users: Number(row.users) || 0, shipments: Number(row.shipments) || 0, shipmentsThisMonth: Number(row.shipmentsThisMonth) || 0 }));
}

// A new customer company and its first administrator, created together or not at all.
async function createTenantWithAdmin({ name, adminName, adminEmail, passwordHash, plan = 'growth', trialDays = 14, currency = null, weightUnit = null, termsVersion = null }) {
  return withTransaction(async (transaction) => {
    if (await transaction.get('SELECT id FROM users WHERE email = ?', [adminEmail])) {
      throw httpError(409, 'A user with this email already exists.');
    }
    if (await transaction.get('SELECT id FROM tenants WHERE lower(name) = lower(?)', [name])) {
      throw httpError(409, 'A company with this name already exists.');
    }
    // A new company starts on a free trial of the chosen plan.
    const tenant = await transaction.run(
      `INSERT INTO tenants (name, plan, plan_status, trial_ends_at, currency, weight_unit, terms_version, terms_accepted_at)
       VALUES (?, ?, 'trial', datetime('now', ?), ?, ?, ?, ?)`,
      [name, plan, `+${Number(trialDays)} days`, currency, weightUnit, termsVersion,
        termsVersion ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null]
    );
    const user = await transaction.run(
      "INSERT INTO users (name, email, password, role, tenant_id) VALUES (?, ?, ?, 'admin', ?)",
      [adminName, adminEmail, passwordHash, tenant.id]
    );
    return { tenant: { id: tenant.id, name, plan, planStatus: 'trial' }, admin: { id: user.id, name: adminName, email: adminEmail, role: 'admin' } };
  });
}

async function setTenantGpsTokenHash(tenantId, tokenHash) {
  await run('UPDATE tenants SET gps_token_hash = ? WHERE id = ?', [tokenHash, assertTenant(tenantId)]);
}

async function findTenantByGpsTokenHash(tokenHash) {
  if (!tokenHash) return null;
  return get('SELECT id, name FROM tenants WHERE gps_token_hash = ?', [tokenHash]);
}

async function setTenantInboxTokenHash(tenantId, tokenHash) {
  await run('UPDATE tenants SET inbox_token_hash = ? WHERE id = ?', [tokenHash, assertTenant(tenantId)]);
}

async function findTenantByInboxTokenHash(tokenHash) {
  if (!tokenHash) return null;
  return get('SELECT id, name FROM tenants WHERE inbox_token_hash = ?', [tokenHash]);
}

async function setTenantInboxAllowedSenders(tenantId, senders) {
  await run('UPDATE tenants SET inbox_allowed_senders = ? WHERE id = ?', [JSON.stringify(senders), assertTenant(tenantId)]);
}

// settings = { sid, token, smsFrom, whatsappFrom } or null to remove. Stored encrypted.
// Saving (or removing) the mailbox also forgets the reading position: a new mailbox starts from now.
async function setTenantImapSettings(tenantId, settings) {
  await run('UPDATE tenants SET imap_config = ?, imap_state = NULL WHERE id = ?', [settings ? secrets.encrypt(settings) : null, assertTenant(tenantId)]);
}

async function setTenantAutomationSettings(tenantId, values) {
  await run('UPDATE tenants SET automation_settings = ? WHERE id = ?', [JSON.stringify(values), assertTenant(tenantId)]);
}

// What NEXUS and the agents did for this company over the last days: the numbers behind the AI Command Center.
async function getCommandCenterStats(tenantId, days = 30) {
  assertTenant(tenantId);
  const since = `-${Number(days)} days`;
  const tasks = await get(
    `SELECT COUNT(*) AS prepared,
       SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
       SUM(CASE WHEN status = 'dismissed' THEN 1 ELSE 0 END) AS dismissed,
       SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
       AVG(CASE WHEN resolved_at IS NOT NULL THEN (julianday(resolved_at) - julianday(created_at)) * 24 * 60 END) AS minutesToHandle
     FROM nexus_tasks WHERE tenant_id = ? AND created_at >= datetime('now', ?)`,
    [tenantId, since]
  );
  const calls = await get(
    `SELECT COUNT(*) AS calls, SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded
     FROM agent_tasks WHERE tenant_id = ? AND created_at >= datetime('now', ?)`,
    [tenantId, since]
  );
  const byKind = await all(
    `SELECT kind, COUNT(*) AS total FROM nexus_tasks WHERE tenant_id = ? AND created_at >= datetime('now', ?) GROUP BY kind`,
    [tenantId, since]
  );
  // Per calendar day of the company's own time zone.
  const zone = await timeZoneOf(tenantId);
  const taskTimes = await all("SELECT created_at AS createdAt FROM nexus_tasks WHERE tenant_id = ? AND created_at >= datetime('now', ?)", [tenantId, since]);
  const perDay = new Map();
  for (const row of taskTimes) {
    const day = timeLib.localDate(zone, row.createdAt);
    perDay.set(day, (perDay.get(day) || 0) + 1);
  }
  const daily = [...perDay].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, total]) => ({ day, total }));
  const live = await get(
    `SELECT SUM(CASE WHEN status IN ('Dispatched', 'In Transit') THEN 1 ELSE 0 END) AS onRoad,
       SUM(CASE WHEN status IN ('New', 'Sourcing', 'Pending Approval') THEN 1 ELSE 0 END) AS waiting,
       SUM(CASE WHEN status = 'Exception' THEN 1 ELSE 0 END) AS exceptions
     FROM shipments WHERE tenant_id = ?`,
    [tenantId]
  );
  const activity = await all(
    `SELECT id, kind, title, status, shipment_id AS shipmentId, created_at AS createdAt, resolved_at AS resolvedAt
     FROM nexus_tasks WHERE tenant_id = ? ORDER BY id DESC LIMIT 12`,
    [tenantId]
  );
  const n = (value) => Number(value) || 0;
  return {
    days,
    prepared: n(tasks?.prepared),
    done: n(tasks?.done),
    dismissed: n(tasks?.dismissed),
    open: n(tasks?.open),
    minutesToHandle: tasks?.minutesToHandle === null || tasks?.minutesToHandle === undefined ? null : Math.round(tasks.minutesToHandle),
    aiCalls: n(calls?.calls),
    aiSucceeded: n(calls?.succeeded),
    byKind: Object.fromEntries(byKind.map((row) => [row.kind, n(row.total)])),
    daily: daily.map((row) => ({ day: row.day, total: n(row.total) })),
    live: { onRoad: n(live?.onRoad), waiting: n(live?.waiting), exceptions: n(live?.exceptions) },
    activity: activity.map((row) => ({ ...row, shipmentId: row.shipmentId ? `SHP-${row.shipmentId}` : null }))
  };
}

async function setTenantImapState(tenantId, state) {
  await run('UPDATE tenants SET imap_state = ? WHERE id = ?', [JSON.stringify(state), assertTenant(tenantId)]);
}

// System job (mailbox poller): companies that have a mailbox connected.
async function listTenantIdsWithImap() {
  return (await all('SELECT id FROM tenants WHERE imap_config IS NOT NULL ORDER BY id')).map((row) => row.id);
}

async function setTenantMessagingSettings(tenantId, settings) {
  await run('UPDATE tenants SET messaging_config = ? WHERE id = ?', [settings ? secrets.encrypt(settings) : null, assertTenant(tenantId)]);
}

/* ---------------- users and sessions ---------------- */

async function findUserByEmail(email) {
  return get('SELECT * FROM users WHERE email = ?', [email]);
}

async function createAuthSession(jti, expiresAt, userId = null) {
  await run('INSERT INTO auth_sessions (jti, expires_at, user_id) VALUES (?, ?, ?)', [jti, expiresAt, userId]);
}

async function revokeUserSessions(userId, queryRun = run) {
  await queryRun(
    'UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
    [Math.floor(Date.now() / 1000), userId]
  );
}

async function isAuthSessionActive(jti) {
  if (!jti) return false;
  const session = await get(
    'SELECT jti FROM auth_sessions WHERE jti = ? AND revoked_at IS NULL AND expires_at > ?',
    [jti, Math.floor(Date.now() / 1000)]
  );
  return Boolean(session);
}

async function revokeAuthSession(jti) {
  if (!jti) return;
  await run(
    'UPDATE auth_sessions SET revoked_at = ? WHERE jti = ? AND revoked_at IS NULL',
    [Math.floor(Date.now() / 1000), jti]
  );
}

async function getRateLimitStatus(rateKey, windowMs, max) {
  const now = Date.now();
  const result = await get(
    'SELECT COUNT(*) AS attempts, MIN(attempted_at) AS oldest_attempt FROM rate_limit_attempts WHERE rate_key = ? AND attempted_at > ?',
    [rateKey, now - windowMs]
  );
  const attempts = Number(result?.attempts || 0);
  return {
    limited: attempts >= max,
    attempts,
    retryAfterMs: attempts >= max ? Math.max(1, Number(result.oldest_attempt) + windowMs - now) : 0
  };
}

async function consumeRateLimit(rateKey, windowMs, max) {
  return withTransaction(async (query) => {
    const now = Date.now();
    const cutoff = now - windowMs;
    await query.run('DELETE FROM rate_limit_attempts WHERE rate_key = ? AND attempted_at <= ?', [rateKey, cutoff]);
    const result = await query.get(
      'SELECT COUNT(*) AS attempts, MIN(attempted_at) AS oldest_attempt FROM rate_limit_attempts WHERE rate_key = ?',
      [rateKey]
    );
    const attempts = Number(result?.attempts || 0);
    if (attempts >= max) {
      return {
        limited: true,
        attempts,
        retryAfterMs: Math.max(1, Number(result.oldest_attempt) + windowMs - now)
      };
    }

    await query.run('INSERT INTO rate_limit_attempts (rate_key, attempted_at) VALUES (?, ?)', [rateKey, now]);
    return { limited: false, attempts: attempts + 1, retryAfterMs: 0 };
  });
}

async function recordRateLimitAttempts(rateKeys, windowMs) {
  return withTransaction(async (query) => {
    const now = Date.now();
    const cutoff = now - windowMs;
    for (const rateKey of rateKeys) {
      await query.run('DELETE FROM rate_limit_attempts WHERE rate_key = ? AND attempted_at <= ?', [rateKey, cutoff]);
      await query.run('INSERT INTO rate_limit_attempts (rate_key, attempted_at) VALUES (?, ?)', [rateKey, now]);
    }
    const ipResult = await query.get(
      'SELECT COUNT(*) AS attempts FROM rate_limit_attempts WHERE rate_key = ?',
      [rateKeys[0]]
    );
    return Number(ipResult?.attempts || 0);
  });
}

async function clearRateLimitAttempts(rateKey) {
  await run('DELETE FROM rate_limit_attempts WHERE rate_key = ?', [rateKey]);
}

async function findUserById(id) {
  if (!id || !Number.isInteger(Number(id))) return null;
  return get(
    `SELECT users.id, users.name, users.email, users.role, users.disabled_at AS disabledAt, users.tenant_id AS tenantId,
       users.is_platform_admin AS isPlatformAdmin, tenants.name AS tenantName,
       tenants.currency AS tenantCurrency, tenants.weight_unit AS tenantWeightUnit,
       tenants.timezone AS tenantTimeZone, tenants.locale AS tenantLocale
     FROM users JOIN tenants ON tenants.id = users.tenant_id WHERE users.id = ?`,
    [Number(id)]
  );
}

const ALLOWED_ROLES = ['admin', 'operations', 'operator'];

// Change a user's role and/or access. Any change revokes that user's sessions,
// so a demoted or disabled user loses access immediately, not when the token expires.
async function updateUser(tenantId, id, { role, active }, actorId) {
  assertTenant(tenantId);
  return withTransaction(async (transaction) => {
    const user = await transaction.get('SELECT id, name, email, role, disabled_at FROM users WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!user) throw httpError(404, 'User not found.');
    if (Number(actorId) === Number(id)) throw httpError(409, 'You cannot change your own role or access.');

    const nextRole = role === undefined ? user.role : role;
    const nextDisabled = active === undefined ? user.disabled_at : (active ? null : Math.floor(Date.now() / 1000));
    if (!ALLOWED_ROLES.includes(nextRole)) throw httpError(400, 'Unknown role.');

    const losesAdmin = user.role === 'admin' && !user.disabled_at && (nextRole !== 'admin' || nextDisabled);
    if (losesAdmin) {
      const others = await transaction.get(
        "SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND disabled_at IS NULL AND id <> ? AND tenant_id = ?",
        [id, tenantId]
      );
      if (!Number(others?.total)) throw httpError(409, 'At least one active administrator must remain.');
    }

    await transaction.run('UPDATE users SET role = ?, disabled_at = ? WHERE id = ?', [nextRole, nextDisabled, id]);
    await revokeUserSessions(id, transaction.run);
    return { id: user.id, name: user.name, email: user.email, role: nextRole, active: !nextDisabled };
  });
}

// The stored hash, to check the current password before a change.
async function getUserPasswordHash(tenantId, id) {
  const row = await get('SELECT password FROM users WHERE id = ? AND tenant_id = ? AND disabled_at IS NULL', [id, assertTenant(tenantId)]);
  return row ? row.password : null;
}

// Sets a new password hash and signs the person out everywhere (every existing session stops working).
async function setUserPassword(tenantId, id, passwordHash) {
  assertTenant(tenantId);
  return withTransaction(async (transaction) => {
    const result = await transaction.run('UPDATE users SET password = ? WHERE id = ? AND tenant_id = ?', [passwordHash, id, tenantId]);
    if (result.changes !== 1) throw httpError(404, 'User not found.');
    await revokeUserSessions(id, transaction.run);
    return true;
  });
}

/* ---------------- audit log ---------------- */

async function recordAudit(tenantId, { actorId = null, action, detail = null, ip = null }) {
  assertTenant(tenantId);
  await run('INSERT INTO audit_log (tenant_id, actor_id, action, detail, ip) VALUES (?, ?, ?, ?, ?)',
    [tenantId, actorId, String(action).slice(0, 60), detail ? String(detail).slice(0, 300) : null, ip ? String(ip).slice(0, 60) : null]);
}

async function listAudit(tenantId, { limit = 200 } = {}) {
  return all(
    `SELECT audit_log.id, audit_log.action, audit_log.detail, audit_log.ip, audit_log.created_at AS createdAt, users.name AS actor
     FROM audit_log LEFT JOIN users ON users.id = audit_log.actor_id
     WHERE audit_log.tenant_id = ? ORDER BY audit_log.id DESC LIMIT ?`,
    [assertTenant(tenantId), limit]
  );
}

// A consistent copy of the whole database in one file (safe while the app is running).
async function backupTo(filePath) {
  await run('VACUUM INTO ?', [filePath]);
}

async function createUser({ name, email, password, role = 'operator', tenantId }) {
  assertTenant(tenantId);
  const safeRole = ALLOWED_ROLES.includes(role) ? role : 'operator';
  const result = await run(
    'INSERT INTO users (name, email, password, role, tenant_id) VALUES (?, ?, ?, ?, ?)',
    [name, email, password, safeRole, tenantId]
  );

  return {
    id: result.id,
    name,
    email,
    role: safeRole,
    tenant_id: tenantId,
    is_platform_admin: 0
  };
}

async function listUsers(tenantId) {
  const rows = await all('SELECT id, name, email, role, disabled_at FROM users WHERE tenant_id = ? ORDER BY id', [assertTenant(tenantId)]);
  return rows.map((row) => ({ id: row.id, name: row.name, email: row.email, role: row.role, active: !row.disabled_at }));
}

/* ---------------- shipments ---------------- */

const SHIPMENT_SELECT = `SELECT shipments.*, carriers.name AS carrierName, carriers.phone AS carrierPhone
  FROM shipments LEFT JOIN carriers ON carriers.id = shipments.carrier_id`;

async function listShipments(tenantId, { limit = 50, offset = 0 } = {}) {
  assertTenant(tenantId);
  const safeLimit = Math.min(Math.max(Math.trunc(Number(limit)) || 50, 1), 200);
  const safeOffset = Math.max(Math.trunc(Number(offset)) || 0, 0);
  return all(
    `${SHIPMENT_SELECT} WHERE shipments.tenant_id = ? ORDER BY shipments.created_at DESC, shipments.id DESC LIMIT ? OFFSET ?`,
    [tenantId, safeLimit, safeOffset]
  );
}

const SEARCH_SORTS = {
  newest: 'shipments.id DESC',
  oldest: 'shipments.id ASC',
  customer: 'shipments.customer COLLATE NOCASE ASC, shipments.id DESC',
  rate: 'shipments.rate IS NULL, shipments.rate DESC, shipments.id DESC'
};

// Server-side filtering and paging, so the list works the same with 50 or 50,000 loads.
async function searchShipments(tenantId, { status, q, equipment, sort, limit = 50, offset = 0 } = {}) {
  assertTenant(tenantId);
  const where = ['shipments.tenant_id = ?'];
  const params = [tenantId];
  if (equipment) {
    where.push('shipments.equipment = ?');
    params.push(equipment);
  }
  const text = String(q || '').trim();
  if (text) {
    const like = `%${text.replace(/[\\%_]/g, '\\$&')}%`;
    const columns = ["'SHP-' || shipments.id", 'shipments.reference', 'shipments.customer', 'shipments.origin', 'shipments.destination',
      'carriers.name', 'shipments.tracking_number', 'shipments.status', 'shipments.driver_name', 'shipments.truck_plate', 'shipments.last_location'];
    where.push(`(${columns.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    columns.forEach(() => params.push(like));
  }
  const baseFrom = 'FROM shipments LEFT JOIN carriers ON carriers.id = shipments.carrier_id';
  const countRows = await all(`SELECT shipments.status AS status, COUNT(*) AS total ${baseFrom} WHERE ${where.join(' AND ')} GROUP BY shipments.status`, params);
  const statusCounts = Object.fromEntries(countRows.map((row) => [row.status, Number(row.total)]));
  const allCount = countRows.reduce((sum, row) => sum + Number(row.total), 0);

  const listWhere = [...where];
  const listParams = [...params];
  if (status) {
    listWhere.push('shipments.status = ?');
    listParams.push(status);
  }
  const safeLimit = Math.min(Math.max(Math.trunc(Number(limit)) || 50, 1), 200);
  const safeOffset = Math.max(Math.trunc(Number(offset)) || 0, 0);
  const items = await all(
    `${SHIPMENT_SELECT} WHERE ${listWhere.join(' AND ')} ORDER BY ${SEARCH_SORTS[sort] || SEARCH_SORTS.newest} LIMIT ? OFFSET ?`,
    [...listParams, safeLimit, safeOffset]
  );
  return { items, total: status ? (statusCounts[status] || 0) : allCount, allCount, statusCounts };
}

async function getShipment(tenantId, id) {
  return get(`${SHIPMENT_SELECT} WHERE shipments.id = ? AND shipments.tenant_id = ?`, [id, assertTenant(tenantId)]);
}

// A load with several legs is driven through its legs (API /api/v2); the classic single-truck actions would contradict them.
function assertSingleLeg(shipment) {
  if (shipment.leg_mode === 'multi') throw httpError(409, 'This load has several legs. Update its legs instead (API /api/v2/legs).');
  if (shipment.trip_id) throw httpError(409, `This load travels on trip T-${shipment.trip_id}. Manage it there (API /api/v2/trips).`);
}

const STATUS_TRANSITIONS = {
  New: ['Sourcing', 'Cancelled'],
  // 'Dispatched' is reachable only through dispatchShipment (needs carrier + rate).
  Sourcing: ['Pending Approval', 'Cancelled'],
  'Pending Approval': ['Sourcing', 'Cancelled'],
  // A booked truck can still be cancelled before pickup; the carrier is released.
  Dispatched: ['In Transit', 'Exception', 'Cancelled'],
  'In Transit': ['Delivered', 'Exception'],
  Exception: ['In Transit', 'Cancelled']
};

// Statuses where the truck is booked and moving (or stuck), so location updates make sense.
const TRACKABLE_STATUSES = ['Dispatched', 'In Transit', 'Exception'];

async function recordShipmentEvent(shipmentId, fromStatus, toStatus, note, actorId, queryRun = run) {
  if (hasLegacyEventStatusColumn) {
    await queryRun(
      'INSERT INTO shipment_events (shipment_id, status, from_status, to_status, note, actor_id) VALUES (?, ?, ?, ?, ?, ?)',
      [shipmentId, toStatus, fromStatus || null, toStatus, note || null, actorId || null]
    );
    return;
  }
  await queryRun(
    'INSERT INTO shipment_events (shipment_id, from_status, to_status, note, actor_id) VALUES (?, ?, ?, ?, ?)',
    [shipmentId, fromStatus || null, toStatus, note || null, actorId || null]
  );
}

async function updateShipmentStatus(tenantId, id, status, actorId, note) {
  assertTenant(tenantId);
  return withTransaction(async (transaction) => {
    const current = await transaction.get('SELECT id, status, carrier_id, leg_mode, trip_id FROM shipments WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!current) throw httpError(404, 'Shipment not found.');
    assertSingleLeg(current);

    if (!(STATUS_TRANSITIONS[current.status] || []).includes(status)) {
      throw httpError(409, `Cannot move shipment from ${current.status} to ${status}.`);
    }

    const result = await transaction.run(
      'UPDATE shipments SET status = ? WHERE id = ? AND status = ?',
      [status, id, current.status]
    );
    if (result.changes !== 1) throw httpError(409, 'Shipment state changed before the update could be applied.');

    if (['Delivered', 'Cancelled'].includes(status) && current.carrier_id) {
      const carrier = await transaction.get('SELECT id, status FROM carriers WHERE id = ?', [current.carrier_id]);
      if (!carrier) throw httpError(409, 'Assigned carrier no longer exists.');

      const otherActiveAssignment = await transaction.get(
        "SELECT id FROM shipments WHERE carrier_id = ? AND id <> ? AND status NOT IN ('Delivered', 'Cancelled') LIMIT 1",
        [current.carrier_id, id]
      );
      if (otherActiveAssignment) throw httpError(409, 'Assigned carrier is still attached to another active shipment.');

      if (carrier.status === 'Busy') {
        const released = await transaction.run(
          "UPDATE carriers SET status = 'Available' WHERE id = ? AND status = 'Busy'",
          [current.carrier_id]
        );
        if (released.changes !== 1) throw httpError(409, 'Carrier availability changed during shipment completion.');
      } else if (carrier.status !== 'Available') {
        throw httpError(409, 'Assigned carrier has an invalid availability state.');
      }
    }

    await recordShipmentEvent(id, current.status, status, note, actorId, transaction.run);
    return { changes: result.changes, id, status };
  });
}

async function createShipment(fields) {
  assertTenant(fields.tenantId);
  return withTransaction((transaction) => insertShipment(transaction, fields));
}

// The insert itself, inside a transaction the caller already holds.
async function insertShipment(transaction, { customer, origin, destination, pickup, delivery, status, weight, equipment, reference, trackingNumber, customerRate, customerPhone, actorId, tenantId }) {
  {
    const currency = await currencyOf(tenantId, transaction.get);
    customerRate = customerRate === null || customerRate === undefined ? null : roundMoney(customerRate, currency);
    const result = await transaction.run(
      `INSERT INTO shipments (customer, origin, destination, pickup, delivery, status, weight, equipment, reference, tracking_number, customer_rate, currency, customer_phone, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [customer, origin, destination, pickup, delivery, status, weight, equipment, reference || null, trackingNumber || null, customerRate, currency, customerPhone || null, tenantId]
    );
    await recordShipmentEvent(result.id, null, status, 'Shipment created', actorId, transaction.run);

    return {
      id: `SHP-${result.id}`,
      reference: reference || null,
      customer,
      origin,
      destination,
      pickup,
      delivery,
      status,
      weight,
      equipment,
      customerRate: customerRate ?? null,
      currency,
      customerPhone: customerPhone || null
    };
  }
}

const EDITABLE_FIELDS = {
  customer: ['customer', 'Customer'], customerPhone: ['customer_phone', 'Customer phone'], reference: ['reference', 'Reference'],
  origin: ['origin', 'Origin'], destination: ['destination', 'Destination'], pickup: ['pickup', 'Pickup'], delivery: ['delivery', 'Delivery'],
  weight: ['weight', 'Weight'], equipment: ['equipment', 'Equipment'], customerRate: ['customer_rate', 'Customer price'],
  driverName: ['driver_name', 'Driver'], driverPhone: ['driver_phone', 'Driver phone'], truckPlate: ['truck_plate', 'Truck plate']
};

// Corrects a load's details. A finished load (Delivered / Cancelled) is not edited. Every change is written
// to the load's history: what changed, from what to what, by whom. Returns { changed: [labels] }.
async function updateShipmentDetails(tenantId, id, changes, actorId) {
  assertTenant(tenantId);
  return withTransaction(async (transaction) => {
    const row = await transaction.get('SELECT * FROM shipments WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!row) throw httpError(404, 'Shipment not found.');
    if (['Delivered', 'Cancelled'].includes(row.status)) throw httpError(409, `A ${row.status.toLowerCase()} load can no longer be edited.`);
    const pickup = changes.pickup ?? row.pickup;
    const delivery = changes.delivery ?? row.delivery;
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(pickup)) && /^\d{4}-\d{2}-\d{2}$/.test(String(delivery)) && delivery < pickup) {
      throw httpError(400, 'Delivery date must be on or after pickup date.');
    }
    const sets = [];
    const params = [];
    const notes = [];
    // A load keeps the currency it was first priced in; an unpriced load takes the company's current one.
    const currency = row.currency || await currencyOf(tenantId, transaction.get);
    for (const [field, value] of Object.entries(changes)) {
      const [column, label] = EDITABLE_FIELDS[field] || [];
      if (!column || value === undefined) continue;
      const before = row[column] ?? null;
      const after = column === 'customer_rate' && value !== null ? roundMoney(value, currency) : (value ?? null);
      if (String(before ?? '') === String(after ?? '')) continue;
      sets.push(`${column} = ?`);
      params.push(after);
      notes.push(`${label}: ${before ?? '—'} → ${after ?? '—'}`);
    }
    if (!sets.length) return { changed: [] };
    if (!row.currency) {
      sets.push('currency = ?');
      params.push(currency);
    }
    await transaction.run(`UPDATE shipments SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`, [...params, id, tenantId]);
    // 'Updated' is not a status: it marks a correction in the history without touching status timings.
    await recordShipmentEvent(id, row.status, 'Updated', notes.join('; ').slice(0, 500), actorId, transaction.run);
    return { changed: notes };
  });
}

// Money follow-up on a load. Each flag is true (set now), false (clear) or undefined (leave).
async function setShipmentPayment(tenantId, id, { invoiceNumber, invoiced, customerPaid, carrierPaid }, actorId) {
  assertTenant(tenantId);
  return withTransaction(async (transaction) => {
    const row = await transaction.get('SELECT * FROM shipments WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!row) throw httpError(404, 'Shipment not found.');
    if (row.status === 'Cancelled') throw httpError(409, 'A cancelled load has no payments.');
    if (customerPaid === true && (row.customer_rate === null || row.customer_rate === undefined)) throw httpError(409, 'Enter the customer price on the load first.');
    if (row.leg_mode === 'multi' && carrierPaid !== undefined) throw httpError(409, 'This load has several legs, each with its own carrier. Mark each leg paid instead.');
    if (carrierPaid === true && !row.carrier_id) throw httpError(409, 'This load has no carrier to pay.');
    const sets = [];
    const params = [];
    const notes = [];
    const stamp = (column, flag, on, off) => {
      if (flag === undefined || Boolean(row[column]) === flag) return;
      sets.push(`${column} = ${flag ? 'CURRENT_TIMESTAMP' : 'NULL'}`);
      notes.push(flag ? on : off);
    };
    if (invoiceNumber !== undefined && (invoiceNumber || null) !== (row.customer_invoice_number || null)) {
      sets.push('customer_invoice_number = ?');
      params.push(invoiceNumber || null);
      notes.push(invoiceNumber ? `Invoice number ${invoiceNumber}` : 'Invoice number removed');
    }
    stamp('customer_invoiced_at', invoiced, 'Invoice sent to the customer', 'Invoice marked as not sent');
    stamp('customer_paid_at', customerPaid, 'Customer paid', 'Customer payment undone');
    stamp('carrier_paid_at', carrierPaid, 'Carrier paid', 'Carrier payment undone');
    if (sets.length) {
      await transaction.run(`UPDATE shipments SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`, [...params, id, tenantId]);
      await recordShipmentEvent(id, row.status, 'Payment', notes.join('; '), actorId, transaction.run);
    }
    return { changed: notes };
  });
}

// Money that is still open: delivered loads the customer has not paid, and carriers not yet paid.
// Totals add up only amounts in the company's current currency; loads priced in another currency
// (kept from before the company changed currency) are listed under otherCurrencies, never mixed in.
// A load with several legs owes each carrier for its own delivered legs (openLegs), not one carrier for the load.
async function getFinanceSummary(tenantId) {
  assertTenant(tenantId);
  const currency = await currencyOf(tenantId);
  const inCurrency = `COALESCE(currency, '${DEFAULT_CURRENCY}')`;
  const totals = await get(`
    SELECT
      ROUND(SUM(CASE WHEN status = 'Delivered' AND customer_paid_at IS NULL AND customer_rate IS NOT NULL THEN customer_rate ELSE 0 END), 4) AS receivable,
      SUM(CASE WHEN status = 'Delivered' AND customer_paid_at IS NULL AND customer_rate IS NOT NULL THEN 1 ELSE 0 END) AS receivableLoads,
      SUM(CASE WHEN status = 'Delivered' AND customer_paid_at IS NULL AND customer_invoiced_at IS NULL AND customer_rate IS NOT NULL THEN 1 ELSE 0 END) AS notInvoiced,
      ROUND(SUM(CASE WHEN status = 'Delivered' AND carrier_paid_at IS NULL AND rate IS NOT NULL AND leg_mode <> 'multi' THEN rate ELSE 0 END), 4) AS payable,
      SUM(CASE WHEN status = 'Delivered' AND carrier_paid_at IS NULL AND rate IS NOT NULL AND leg_mode <> 'multi' THEN 1 ELSE 0 END) AS payableLoads
    FROM shipments WHERE tenant_id = ? AND ${inCurrency} = ?`, [tenantId, currency]);
  const others = await all(`
    SELECT ${inCurrency} AS currency,
      ROUND(SUM(CASE WHEN status = 'Delivered' AND customer_paid_at IS NULL AND customer_rate IS NOT NULL THEN customer_rate ELSE 0 END), 4) AS receivable,
      ROUND(SUM(CASE WHEN status = 'Delivered' AND carrier_paid_at IS NULL AND rate IS NOT NULL AND leg_mode <> 'multi' THEN rate ELSE 0 END), 4) AS payable
    FROM shipments WHERE tenant_id = ? AND ${inCurrency} <> ? AND status = 'Delivered'
    GROUP BY ${inCurrency} ORDER BY currency`, [tenantId, currency]);

  // Delivered legs not yet paid to their carriers, by currency (a leg without its own currency uses its load's).
  const legCurrency = `COALESCE(l.currency, s.currency, '${DEFAULT_CURRENCY}')`;
  const legTotals = await all(`
    SELECT ${legCurrency} AS currency, ROUND(SUM(l.price), 4) AS payable, COUNT(DISTINCT l.shipment_id) AS loads
    FROM shipment_legs l JOIN shipments s ON s.id = l.shipment_id
    WHERE l.tenant_id = ? AND l.status = 'Delivered' AND l.paid_at IS NULL AND l.price IS NOT NULL AND s.status <> 'Cancelled'
    GROUP BY ${legCurrency}`, [tenantId]);
  const legDelivered = `(SELECT MAX(created_at) FROM leg_events WHERE leg_events.leg_id = l.id AND leg_events.to_status = 'Delivered')`;
  const openLegs = await all(`
    SELECT l.id AS legId, l.shipment_id AS shipmentId, l.sequence, l.mode, carriers.name AS carrierName, l.price, ${legCurrency} AS currency,
      s.customer, ${legDelivered} AS deliveredAt, CAST(julianday('now') - julianday(${legDelivered}) AS INTEGER) AS daysSinceDelivery
    FROM shipment_legs l JOIN shipments s ON s.id = l.shipment_id LEFT JOIN carriers ON carriers.id = l.carrier_id
    WHERE l.tenant_id = ? AND l.status = 'Delivered' AND l.paid_at IS NULL AND l.price IS NOT NULL AND s.status <> 'Cancelled'
    ORDER BY ${legDelivered} ASC LIMIT 100`, [tenantId]);

  const otherCurrencies = new Map(others.map((row) => [row.currency, { currency: row.currency, receivable: Number(row.receivable) || 0, payable: Number(row.payable) || 0 }]));
  let payable = Number(totals?.payable) || 0;
  let payableLoads = Number(totals?.payableLoads) || 0;
  for (const row of legTotals) {
    if (row.currency === currency) {
      payable = addMoney(currency, payable, Number(row.payable) || 0);
      payableLoads += Number(row.loads) || 0;
    } else {
      const entry = otherCurrencies.get(row.currency) || { currency: row.currency, receivable: 0, payable: 0 };
      entry.payable = addMoney(row.currency, entry.payable, Number(row.payable) || 0);
      otherCurrencies.set(row.currency, entry);
    }
  }

  const delivered = `(SELECT MAX(created_at) FROM shipment_events WHERE shipment_events.shipment_id = shipments.id AND shipment_events.to_status = 'Delivered')`;
  const open = await all(`
    SELECT shipments.id, customer, customer_rate AS customerRate, CASE WHEN leg_mode = 'multi' THEN NULL ELSE rate END AS rate, ${inCurrency} AS currency, customer_invoice_number AS invoiceNumber,
      customer_invoiced_at AS invoicedAt, customer_paid_at AS customerPaidAt, carrier_paid_at AS carrierPaidAt,
      carriers.name AS carrierName, ${delivered} AS deliveredAt,
      CAST(julianday('now') - julianday(${delivered}) AS INTEGER) AS daysSinceDelivery
    FROM shipments LEFT JOIN carriers ON carriers.id = shipments.carrier_id
    WHERE shipments.tenant_id = ? AND shipments.status = 'Delivered'
      AND ((customer_paid_at IS NULL AND customer_rate IS NOT NULL) OR (carrier_paid_at IS NULL AND rate IS NOT NULL AND leg_mode <> 'multi'))
    ORDER BY ${delivered} ASC LIMIT 100`, [tenantId]);
  return {
    currency,
    receivable: Number(totals?.receivable) || 0,
    receivableLoads: Number(totals?.receivableLoads) || 0,
    notInvoiced: Number(totals?.notInvoiced) || 0,
    payable,
    payableLoads,
    otherCurrencies: [...otherCurrencies.values()].sort((a, b) => (a.currency < b.currency ? -1 : 1)),
    open: open.map((row) => ({ ...row, id: `SHP-${row.id}` })),
    openLegs: openLegs.map((row) => ({ ...row, shipmentId: `SHP-${row.shipmentId}`, price: Number(row.price) }))
  };
}

async function setShipmentShareTokenHash(tenantId, id, tokenHash) {
  const result = await run('UPDATE shipments SET share_token_hash = ? WHERE id = ? AND tenant_id = ?', [tokenHash, id, assertTenant(tenantId)]);
  return result.changes === 1;
}

// Public tracking page: only what a customer may see. No prices, no phone numbers, no carrier name.
async function findSharedShipment(tokenHash) {
  if (!tokenHash) return null;
  return get(
    `SELECT shipments.id, shipments.reference, shipments.origin, shipments.destination, shipments.pickup, shipments.delivery, shipments.status,
       shipments.last_location AS lastLocation, shipments.eta, shipments.last_tracked_at AS lastTrackedAt, shipments.truck_plate AS truckPlate,
       tenants.name AS company, tenants.timezone AS timeZone, tenants.locale AS locale
     FROM shipments JOIN tenants ON tenants.id = shipments.tenant_id WHERE shipments.share_token_hash = ?`,
    [tokenHash]
  );
}

// details: optional { customerRate, driverName, driverPhone, truckPlate } agreed at booking.
async function dispatchShipment(tenantId, id, carrierId, rate, actorId, details = {}) {
  assertTenant(tenantId);
  return withTransaction(async (transaction) => {
    const shipment = await transaction.get('SELECT id, status, carrier_id, currency, leg_mode, trip_id FROM shipments WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!shipment) throw httpError(404, 'Shipment not found.');
    assertSingleLeg(shipment);
    if (!['Sourcing', 'Pending Approval'].includes(shipment.status) || shipment.carrier_id) {
      throw httpError(409, 'Shipment must be unassigned and in sourcing or pending approval before dispatch.');
    }

    // A carrier from another company is treated as not existing.
    const carrier = await transaction.get('SELECT id, name, status FROM carriers WHERE id = ? AND tenant_id = ?', [carrierId, tenantId]);
    if (!carrier) throw httpError(404, 'Carrier not found.');
    if (carrier.status !== 'Available') throw httpError(409, 'Selected carrier is not available.');

    const activeAssignment = await transaction.get(
      "SELECT id FROM shipments WHERE carrier_id = ? AND status NOT IN ('Delivered', 'Cancelled') LIMIT 1",
      [carrierId]
    );
    if (activeAssignment) throw httpError(409, 'Selected carrier already has an active shipment.');

    const claimedCarrier = await transaction.run(
      "UPDATE carriers SET status = 'Busy' WHERE id = ? AND status = 'Available'",
      [carrierId]
    );
    if (claimedCarrier.changes !== 1) throw httpError(409, 'Selected carrier is no longer available.');

    const { customerRate, driverName, driverPhone, truckPlate } = details;
    const currency = shipment.currency || await currencyOf(tenantId, transaction.get);
    const assignedShipment = await transaction.run(
      `UPDATE shipments SET carrier_id = ?, rate = ?, currency = ?, status = 'Dispatched',
         customer_rate = COALESCE(?, customer_rate), driver_name = ?, driver_phone = ?, truck_plate = ?
       WHERE id = ? AND status = ? AND carrier_id IS NULL`,
      [carrierId, roundMoney(rate, currency), currency, roundMoney(customerRate ?? null, currency), driverName || null, driverPhone || null, truckPlate || null, id, shipment.status]
    );
    if (assignedShipment.changes !== 1) throw httpError(409, 'Shipment state changed before dispatch could be applied.');

    const truck = [truckPlate && `truck ${truckPlate}`, driverName && `driver ${driverName}`].filter(Boolean).join(', ');
    const note = `Assigned to ${carrier.name} at ${Number(rate).toFixed(2)}${truck ? ` (${truck})` : ''}`;
    await recordShipmentEvent(id, shipment.status, 'Dispatched', note, actorId, transaction.run);
    return { id, status: 'Dispatched', carrier: carrier.name, rate };
  });
}

/* ---------------- tracking (manual check calls and GPS) ---------------- */

async function addTrackingUpdate(tenantId, shipmentId, { location, eta, note }, actorId) {
  assertTenant(tenantId);
  return withTransaction(async (transaction) => {
    const shipment = await transaction.get('SELECT id, status, leg_mode, trip_id FROM shipments WHERE id = ? AND tenant_id = ?', [shipmentId, tenantId]);
    if (!shipment) throw httpError(404, 'Shipment not found.');
    assertSingleLeg(shipment);
    if (!TRACKABLE_STATUSES.includes(shipment.status)) {
      throw httpError(409, `Location updates are only possible while a load is ${TRACKABLE_STATUSES.join(', ')}.`);
    }
    const result = await transaction.run(
      "INSERT INTO tracking_updates (shipment_id, actor_id, location, eta, note, source) VALUES (?, ?, ?, ?, ?, 'manual')",
      [shipmentId, actorId || null, location, eta || null, note || null]
    );
    const created = await transaction.get('SELECT created_at FROM tracking_updates WHERE id = ?', [result.id]);
    // Keep the newest position and ETA on the shipment itself so lists can show it without a join.
    await transaction.run(
      'UPDATE shipments SET last_location = ?, eta = COALESCE(?, eta), last_tracked_at = ? WHERE id = ?',
      [location, eta || null, created.created_at, shipmentId]
    );
    return { id: result.id, shipmentId: `SHP-${shipmentId}`, location, eta: eta || null, note: note || null, source: 'manual', createdAt: created.created_at };
  });
}

// GPS positions for one company. Each is matched to that company's active load by truck plate
// (or load id). Positions closer together than minIntervalMinutes are skipped so a tracker that
// reports every few seconds does not flood the history.
async function recordGpsPositions(tenantId, positions, { minIntervalMinutes = 15 } = {}) {
  assertTenant(tenantId);
  return withTransaction(async (transaction) => {
    const summary = { accepted: 0, skipped: 0, unmatched: 0 };
    for (const position of positions) {
      // A truck can carry several loads at once (a trip): the position belongs to every one of them.
      const targets = position.shipmentId
        ? await transaction.all(
          `SELECT id FROM shipments WHERE id = ? AND tenant_id = ? AND status IN (${TRACKABLE_STATUSES.map(() => '?').join(', ')})`,
          [position.shipmentId, tenantId, ...TRACKABLE_STATUSES]
        )
        : await transaction.all(
          `SELECT id FROM shipments WHERE tenant_id = ? AND truck_plate IS NOT NULL
             AND upper(replace(replace(replace(truck_plate, ' ', ''), '-', ''), '.', '')) = ?
             AND status IN (${TRACKABLE_STATUSES.map(() => '?').join(', ')})
           ORDER BY id DESC`,
          [tenantId, normalizePlate(position.truckPlate), ...TRACKABLE_STATUSES]
        );
      if (!targets.length) {
        summary.unmatched += 1;
        continue;
      }
      for (const shipment of targets) {
      const recent = await transaction.get(
        "SELECT id FROM tracking_updates WHERE shipment_id = ? AND source = 'gps' AND created_at > datetime('now', ?) LIMIT 1",
        [shipment.id, `-${Number(minIntervalMinutes)} minutes`]
      );
      if (recent) {
        summary.skipped += 1;
        continue;
      }
      const location = position.address || `${position.lat.toFixed(5)}, ${position.lng.toFixed(5)}`;
      const note = position.speed !== null && position.speed !== undefined ? `GPS · ${Math.round(position.speed)} km/h` : 'GPS';
      const result = await transaction.run(
        "INSERT INTO tracking_updates (shipment_id, actor_id, location, note, source, lat, lng) VALUES (?, NULL, ?, ?, 'gps', ?, ?)",
        [shipment.id, location, note, position.lat, position.lng]
      );
      const created = await transaction.get('SELECT created_at FROM tracking_updates WHERE id = ?', [result.id]);
      await transaction.run('UPDATE shipments SET last_location = ?, last_tracked_at = ? WHERE id = ?', [location, created.created_at, shipment.id]);
      summary.accepted += 1;
      }
    }
    return summary;
  });
}

async function listTrackingUpdates(tenantId, shipmentId) {
  assertTenant(tenantId);
  return all(
    `SELECT tracking_updates.id, tracking_updates.location, tracking_updates.eta, tracking_updates.note, tracking_updates.source,
       tracking_updates.lat, tracking_updates.lng, tracking_updates.created_at AS createdAt, users.name AS actorName
     FROM tracking_updates
     JOIN shipments ON shipments.id = tracking_updates.shipment_id
     LEFT JOIN users ON users.id = tracking_updates.actor_id
     WHERE tracking_updates.shipment_id = ? AND shipments.tenant_id = ? ORDER BY tracking_updates.id DESC`,
    [shipmentId, tenantId]
  );
}

async function listShipmentEvents(tenantId, id) {
  assertTenant(tenantId);
  return all(
    `SELECT shipment_events.id, shipment_events.shipment_id AS shipmentId, shipment_events.from_status AS fromStatus,
       shipment_events.to_status AS status, shipment_events.note, shipment_events.actor_id AS actorId, shipment_events.created_at AS createdAt
     FROM shipment_events JOIN shipments ON shipments.id = shipment_events.shipment_id
     WHERE shipment_events.shipment_id = ? AND shipments.tenant_id = ? ORDER BY shipment_events.id DESC`,
    [id, tenantId]
  );
}

/* ---------------- messages (RELAY) ---------------- */

async function createMessage(tenantId, { shipmentId, channel, recipientType, toPhone, body, status, provider, providerMessageId, error, createdBy, callbackTokenHash }) {
  assertTenant(tenantId);
  const result = await run(
    `INSERT INTO messages (tenant_id, shipment_id, channel, recipient_type, to_phone, body, status, provider, provider_message_id, error, created_by, callback_token_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [tenantId, shipmentId, channel, recipientType, toPhone, body, status, provider || null, providerMessageId || null, error || null, createdBy || null, callbackTokenHash || null]
  );
  return { id: result.id };
}

// Delivery reports only move forward: a late "sent" never overwrites "delivered".
const DELIVERY_RANK = { queued: 0, accepted: 0, scheduled: 0, sending: 1, sent: 2, delivered: 3, read: 4 };
const DELIVERY_FAILURES = ['failed', 'undelivered'];

// System job (provider webhook): the message a delivery report belongs to, found by its secret.
async function findMessageByCallbackTokenHash(tokenHash) {
  if (!tokenHash) return null;
  return get(
    `SELECT id, tenant_id AS tenantId, shipment_id AS shipmentId, provider_message_id AS providerMessageId,
       recipient_type AS recipientType, to_phone AS toPhone, channel, delivery_status AS deliveryStatus
     FROM messages WHERE callback_token_hash = ?`,
    [tokenHash]
  );
}

// Returns { changed, status, failedNow }.
async function recordMessageDelivery(tenantId, messageId, { status, errorCode }) {
  assertTenant(tenantId);
  const next = String(status || '').toLowerCase();
  if (!(next in DELIVERY_RANK) && !DELIVERY_FAILURES.includes(next)) return { changed: false, status: null, failedNow: false };
  return withTransaction(async (transaction) => {
    const row = await transaction.get('SELECT delivery_status FROM messages WHERE id = ? AND tenant_id = ?', [messageId, tenantId]);
    if (!row) return { changed: false, status: null, failedNow: false };
    const current = row.delivery_status;
    const failure = DELIVERY_FAILURES.includes(next);
    const allowed = current === null || current === undefined
      || (failure ? !DELIVERY_FAILURES.includes(current) && (DELIVERY_RANK[current] ?? 0) < DELIVERY_RANK.delivered
        : !DELIVERY_FAILURES.includes(current) && DELIVERY_RANK[next] > (DELIVERY_RANK[current] ?? -1));
    if (!allowed) return { changed: false, status: current, failedNow: false };
    await transaction.run(
      "UPDATE messages SET delivery_status = ?, delivery_updated_at = CURRENT_TIMESTAMP, error_code = ? WHERE id = ? AND tenant_id = ?",
      [next, failure && errorCode ? String(errorCode).slice(0, 20) : null, messageId, tenantId]
    );
    return { changed: true, status: next, failedNow: failure };
  });
}

async function listMessages(tenantId, shipmentId) {
  assertTenant(tenantId);
  return all(
    `SELECT messages.id, messages.channel, messages.recipient_type AS recipientType, messages.to_phone AS toPhone, messages.body,
       messages.status, messages.error, messages.delivery_status AS deliveryStatus, messages.delivery_updated_at AS deliveryUpdatedAt,
       messages.error_code AS errorCode, messages.created_at AS createdAt, users.name AS sentBy
     FROM messages LEFT JOIN users ON users.id = messages.created_by
     WHERE messages.shipment_id = ? AND messages.tenant_id = ? ORDER BY messages.id DESC`,
    [shipmentId, tenantId]
  );
}

/* ---------------- AI agent tasks ---------------- */

async function recordAgentTask(tenantId, { shipmentId, agent, status, model, inputTokens, outputTokens, latencyMs, error, actorId }) {
  assertTenant(tenantId);
  await run(
    `INSERT INTO agent_tasks (tenant_id, shipment_id, agent, status, model, input_tokens, output_tokens, latency_ms, error, actor_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [tenantId, shipmentId || null, agent, status, model || null, inputTokens ?? null, outputTokens ?? null, latencyMs ?? null, error ? String(error).slice(0, 300) : null, actorId || null]
  );
}

async function getAgentUsage(tenantId, days = 30) {
  assertTenant(tenantId);
  const rows = await all(
    `SELECT agent, COUNT(*) AS calls, SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
       COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens, AVG(latency_ms) AS avgLatencyMs
     FROM agent_tasks WHERE tenant_id = ? AND created_at >= datetime('now', ?) GROUP BY agent ORDER BY agent`,
    [tenantId, `-${Number(days)} days`]
  );
  return rows.map((row) => ({
    agent: row.agent,
    calls: Number(row.calls),
    succeeded: Number(row.succeeded),
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    avgLatencyMs: row.avgLatencyMs === null ? null : Math.round(row.avgLatencyMs)
  }));
}

/* ---------------- carriers ---------------- */

async function listCarriers(tenantId) {
  return all('SELECT * FROM carriers WHERE tenant_id = ? ORDER BY id', [assertTenant(tenantId)]);
}

const CARRIER_MODES = ['Truckload', 'LTL', 'Expedited', 'Reefer', 'Flatbed', 'Intermodal'];
const CARRIER_MANUAL_STATUSES = ['Available', 'Inactive'];

async function listCarriersWithStats(tenantId) {
  assertTenant(tenantId);
  // Cancelled loads are counted as loads but never as booked money (same rule as bookedRevenue).
  const rows = await all(`
    SELECT carriers.id, carriers.name, carriers.mode, carriers.status, carriers.phone, carriers.contact_name AS contactName,
      COUNT(shipments.id) AS totalLoads,
      SUM(CASE WHEN shipments.status NOT IN ('Delivered', 'Cancelled') THEN 1 ELSE 0 END) AS activeLoads,
      SUM(CASE WHEN shipments.status = 'Delivered' THEN 1 ELSE 0 END) AS deliveredLoads,
      SUM(CASE WHEN shipments.status = 'Exception' THEN 1 ELSE 0 END) AS exceptionLoads,
      ROUND(COALESCE(SUM(CASE WHEN shipments.status <> 'Cancelled' THEN shipments.rate END), 0), 4) AS revenue,
      ROUND(AVG(CASE WHEN shipments.status <> 'Cancelled' THEN shipments.rate END), 4) AS averageRate,
      MAX(CASE WHEN shipments.status NOT IN ('Delivered', 'Cancelled') THEN shipments.id END) AS currentShipmentId
    FROM carriers
    LEFT JOIN shipments ON shipments.carrier_id = carriers.id
    WHERE carriers.tenant_id = ?
    GROUP BY carriers.id
    ORDER BY carriers.id
  `, [tenantId]);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    mode: row.mode,
    status: row.status,
    phone: row.phone || null,
    contactName: row.contactName || null,
    totalLoads: Number(row.totalLoads) || 0,
    activeLoads: Number(row.activeLoads) || 0,
    deliveredLoads: Number(row.deliveredLoads) || 0,
    exceptionLoads: Number(row.exceptionLoads) || 0,
    revenue: Number(row.revenue) || 0,
    averageRate: row.averageRate === null ? null : Number(row.averageRate),
    currentShipment: row.currentShipmentId ? `SHP-${row.currentShipmentId}` : null
  }));
}

// Everything SCOUT needs to rank carriers for one load: availability, history on this lane,
// delivered loads and how often their loads went into Exception.
async function getScoutData(tenantId, shipmentId) {
  assertTenant(tenantId);
  const shipment = await getShipment(tenantId, shipmentId);
  if (!shipment) throw httpError(404, 'Shipment not found.');
  const lane = [shipment.origin, shipment.destination];
  const carriers = await all(`
    SELECT carriers.id, carriers.name, carriers.mode, carriers.phone,
      SUM(CASE WHEN shipments.status = 'Delivered' THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN shipments.status = 'Delivered' AND lower(shipments.origin) = lower(?) AND lower(shipments.destination) = lower(?) THEN 1 ELSE 0 END) AS laneDelivered,
      ROUND(AVG(CASE WHEN shipments.status <> 'Cancelled' AND lower(shipments.origin) = lower(?) AND lower(shipments.destination) = lower(?) THEN shipments.rate END), 4) AS laneAverageRate,
      (SELECT COUNT(DISTINCT shipment_events.shipment_id) FROM shipment_events
         JOIN shipments AS s2 ON s2.id = shipment_events.shipment_id
         WHERE s2.carrier_id = carriers.id AND shipment_events.to_status = 'Exception') AS exceptionLoads
    FROM carriers
    LEFT JOIN shipments ON shipments.carrier_id = carriers.id
    WHERE carriers.tenant_id = ? AND carriers.status = 'Available'
    GROUP BY carriers.id
  `, [...lane, ...lane, tenantId]);
  const market = await get(
    "SELECT ROUND(AVG(rate), 4) AS averageRate, COUNT(rate) AS loads FROM shipments WHERE tenant_id = ? AND status <> 'Cancelled' AND lower(origin) = lower(?) AND lower(destination) = lower(?)",
    [tenantId, ...lane]
  );
  return {
    shipment,
    carriers: carriers.map((row) => ({
      id: row.id,
      name: row.name,
      mode: row.mode,
      phone: row.phone || null,
      delivered: Number(row.delivered) || 0,
      laneDelivered: Number(row.laneDelivered) || 0,
      laneAverageRate: row.laneAverageRate === null ? null : Number(row.laneAverageRate),
      exceptionLoads: Number(row.exceptionLoads) || 0
    })),
    laneAverageRate: market?.averageRate === null || market?.averageRate === undefined ? null : Number(market.averageRate),
    laneLoads: Number(market?.loads) || 0
  };
}

async function createCarrier({ name, mode, phone, contactName, tenantId }) {
  assertTenant(tenantId);
  // Check and insert in one transaction so two people cannot add the same carrier twice.
  return withTransaction(async (transaction) => {
    const existing = await transaction.get('SELECT id FROM carriers WHERE lower(name) = lower(?) AND tenant_id = ?', [name, tenantId]);
    if (existing) throw httpError(409, 'A carrier with this name already exists.');
    const result = await transaction.run(
      'INSERT INTO carriers (name, mode, status, phone, contact_name, tenant_id) VALUES (?, ?, ?, ?, ?, ?)',
      [name, mode, 'Available', phone || null, contactName || null, tenantId]
    );
    return { id: result.id, name, mode, status: 'Available', phone: phone || null, contactName: contactName || null };
  });
}

async function updateCarrierStatus(tenantId, id, status) {
  assertTenant(tenantId);
  return withTransaction(async (transaction) => {
    const carrier = await transaction.get('SELECT id, name, status FROM carriers WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!carrier) throw httpError(404, 'Carrier not found.');
    const activeAssignment = await transaction.get(
      "SELECT id FROM shipments WHERE carrier_id = ? AND status NOT IN ('Delivered', 'Cancelled') LIMIT 1",
      [id]
    );
    if (activeAssignment) throw httpError(409, 'Carrier has an active load. Deliver or cancel it before changing availability.');
    await transaction.run('UPDATE carriers SET status = ? WHERE id = ?', [status, id]);
    return { id: carrier.id, name: carrier.name, status };
  });
}

/* ---------------- analytics, dashboard and alerts ---------------- */

const ANALYTICS_RANGES = [7, 30, 90];

async function getAnalyticsPayload(tenantId, { days = 7 } = {}) {
  assertTenant(tenantId);
  const rangeDays = ANALYTICS_RANGES.includes(Number(days)) ? Number(days) : 7;
  // Days are the company's own calendar days, not UTC days.
  const zone = await timeZoneOf(tenantId);
  const today = timeLib.localDate(zone);
  const firstDay = timeLib.addDays(today, -(rangeDays - 1));
  const [statusRows, createdRows, shipmentTotals, carriers] = await Promise.all([
    all('SELECT status, COUNT(*) AS total FROM shipments WHERE tenant_id = ? GROUP BY status', [tenantId]),
    all('SELECT created_at AS createdAt FROM shipments WHERE tenant_id = ? AND created_at >= ?', [tenantId, timeLib.utcText(timeLib.localDayStart(zone, firstDay))]),
    get(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status NOT IN ('Delivered', 'Cancelled') THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN status = 'Pending Approval' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'Delivered' THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN status = 'Exception' THEN 1 ELSE 0 END) AS exceptions,
      ROUND(AVG(CASE WHEN rate IS NOT NULL THEN rate END), 4) AS averageRate
      FROM shipments WHERE tenant_id = ?`, [tenantId]),
    listCarriers(tenantId)
  ]);

  const statuses = {
    New: 0,
    Sourcing: 0,
    'Pending Approval': 0,
    Dispatched: 0,
    'In Transit': 0,
    Delivered: 0,
    Exception: 0,
    Cancelled: 0
  };
  statusRows.forEach((row) => {
    if (Object.hasOwn(statuses, row.status)) statuses[row.status] = Number(row.total);
  });

  const dailyTotals = new Map();
  for (const row of createdRows) {
    const day = timeLib.localDate(zone, row.createdAt);
    dailyTotals.set(day, (dailyTotals.get(day) || 0) + 1);
  }
  const weeklyVolume = Array.from({ length: rangeDays }, (_, index) => {
    const day = timeLib.addDays(firstDay, index);
    return {
      day,
      label: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`)),
      total: dailyTotals.get(day) || 0
    };
  });

  return {
    stats: {
      totalShipments: Number(shipmentTotals.total) || 0,
      activeShipments: Number(shipmentTotals.active) || 0,
      pendingApproval: Number(shipmentTotals.pending) || 0,
      completed: Number(shipmentTotals.delivered) || 0,
      exceptions: Number(shipmentTotals.exceptions) || 0,
      availableCarriers: carriers.filter((carrier) => carrier.status === 'Available').length,
      totalCarriers: carriers.length,
      averageRate: Number(shipmentTotals.averageRate) || 0
    },
    statuses,
    rangeDays,
    weeklyVolume
  };
}

async function getAnalyticsReport(tenantId, { days = 7 } = {}) {
  const base = await getAnalyticsPayload(tenantId, { days });
  const [equipmentRows, laneRows, customerRows, revenueRow, carrierStats] = await Promise.all([
    all("SELECT COALESCE(equipment, 'Unspecified') AS label, COUNT(*) AS total FROM shipments WHERE tenant_id = ? GROUP BY COALESCE(equipment, 'Unspecified') ORDER BY total DESC", [tenantId]),
    all(`SELECT origin, destination, COUNT(*) AS total, ROUND(AVG(CASE WHEN status <> 'Cancelled' THEN rate END), 4) AS averageRate
      FROM shipments WHERE tenant_id = ? GROUP BY origin, destination ORDER BY total DESC, origin LIMIT 5`, [tenantId]),
    all(`SELECT customer, COUNT(*) AS total,
      SUM(CASE WHEN status NOT IN ('Delivered', 'Cancelled') THEN 1 ELSE 0 END) AS active,
      ROUND(COALESCE(SUM(CASE WHEN status <> 'Cancelled' THEN rate END), 0), 4) AS revenue
      FROM shipments WHERE tenant_id = ? GROUP BY customer ORDER BY total DESC, revenue DESC, customer LIMIT 5`, [tenantId]),
    // rate = what we pay the carrier; customer_rate = what the customer pays us. Margin needs both.
    get(`SELECT ROUND(COALESCE(SUM(rate), 0), 4) AS revenue, COUNT(rate) AS pricedLoads,
      ROUND(COALESCE(SUM(CASE WHEN rate IS NOT NULL AND customer_rate IS NOT NULL THEN customer_rate - rate END), 0), 4) AS margin,
      ROUND(COALESCE(SUM(CASE WHEN rate IS NOT NULL AND customer_rate IS NOT NULL THEN customer_rate END), 0), 4) AS marginBase,
      SUM(CASE WHEN rate IS NOT NULL AND customer_rate IS NOT NULL THEN 1 ELSE 0 END) AS marginLoads
      FROM shipments WHERE tenant_id = ? AND status <> 'Cancelled'`, [tenantId]),
    listCarriersWithStats(tenantId)
  ]);
  const total = base.stats.totalShipments;
  const closed = base.statuses.Delivered + base.statuses.Cancelled;
  return {
    ...base,
    stats: {
      ...base.stats,
      bookedRevenue: Number(revenueRow?.revenue) || 0,
      pricedLoads: Number(revenueRow?.pricedLoads) || 0,
      grossMargin: Number(revenueRow?.margin) || 0,
      marginLoads: Number(revenueRow?.marginLoads) || 0,
      marginRate: Number(revenueRow?.marginBase) ? Number(revenueRow.margin) / Number(revenueRow.marginBase) : null,
      deliveryRate: closed ? base.statuses.Delivered / closed : null,
      exceptionRate: total ? base.stats.exceptions / total : null,
      busyCarriers: carrierStats.filter((carrier) => carrier.status === 'Busy').length
    },
    equipment: equipmentRows.map((row) => ({ label: row.label, total: Number(row.total) })),
    topLanes: laneRows.map((row) => ({
      origin: row.origin,
      destination: row.destination,
      total: Number(row.total),
      averageRate: row.averageRate === null ? null : Number(row.averageRate)
    })),
    topCustomers: customerRows.map((row) => ({
      customer: row.customer,
      total: Number(row.total),
      active: Number(row.active) || 0,
      revenue: Number(row.revenue) || 0
    })),
    carrierPerformance: carrierStats
  };
}

async function getDashboardPayload(tenantId, { days = 7 } = {}) {
  const shipments = await listShipments(tenantId, { limit: 20 });
  const carriers = await listCarriers(tenantId);
  const analytics = await getAnalyticsPayload(tenantId, { days });

  const recentShipments = shipments.map((shipment) => ({
    id: `SHP-${shipment.id}`,
    customer: shipment.customer,
    origin: shipment.origin,
    destination: shipment.destination,
    pickup: shipment.pickup || 'Today',
    delivery: shipment.delivery || 'Next Day',
    status: shipment.status || 'Pending Approval'
  }));

  const latestShipment = shipments[0] || null;

  return {
    ...analytics,
    shipments: recentShipments,
    route: latestShipment ? {
      origin: latestShipment.origin,
      destination: latestShipment.destination,
      weight: latestShipment.weight,
      equipment: latestShipment.equipment,
      pickup: latestShipment.pickup,
      delivery: latestShipment.delivery
    } : null,
    assistant: {
      title: 'VEYRA AI Assistant',
      prompt: 'Create a shipment for 10,000 kg dry van from Dallas to Houston'
    },
    carriers
  };
}

// The last time anyone heard from a truck: its latest location update, otherwise when it was booked.
// A truck booked a minute ago has not "missed" an update yet.
const LAST_SIGN_OF_LIFE = `COALESCE(last_tracked_at,
  (SELECT MAX(created_at) FROM shipment_events WHERE shipment_events.shipment_id = shipments.id AND shipment_events.to_status = 'Dispatched'),
  created_at)`;

// Counts behind the notification bell, computed in SQL so they stay right at any volume.
async function getAlerts(tenantId, { staleHours = 12 } = {}) {
  assertTenant(tenantId);
  const row = await get(`
    SELECT
      SUM(CASE WHEN status = 'Exception' THEN 1 ELSE 0 END) AS exceptions,
      SUM(CASE WHEN status = 'Pending Approval' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'New' THEN 1 ELSE 0 END) AS fresh,
      SUM(CASE WHEN status = 'Sourcing' THEN 1 ELSE 0 END) AS sourcing,
      SUM(CASE WHEN status IN ('Dispatched', 'In Transit') AND ${LAST_SIGN_OF_LIFE} < datetime('now', ?) THEN 1 ELSE 0 END) AS staleTracking
    FROM shipments WHERE tenant_id = ?
  `, [`-${Number(staleHours)} hours`, tenantId]);
  const openTasks = await get("SELECT COUNT(*) AS total FROM nexus_tasks WHERE tenant_id = ? AND status = 'open'", [tenantId]);
  const carriers = await get("SELECT SUM(CASE WHEN status = 'Available' THEN 1 ELSE 0 END) AS available, COUNT(*) AS total FROM carriers WHERE tenant_id = ?", [tenantId]);
  return {
    exceptions: Number(row?.exceptions) || 0,
    pendingApproval: Number(row?.pending) || 0,
    new: Number(row?.fresh) || 0,
    sourcing: Number(row?.sourcing) || 0,
    staleTracking: Number(row?.staleTracking) || 0,
    staleHours,
    openTasks: Number(openTasks?.total) || 0,
    availableCarriers: Number(carriers?.available) || 0,
    totalCarriers: Number(carriers?.total) || 0
  };
}

/* ---------------- inbox (incoming email) ---------------- */

const INBOX_BODY_MAX = 8000;

function mapInboxItem(row) {
  let parsed = null;
  try {
    parsed = row.parsed_json ? JSON.parse(row.parsed_json) : null;
  } catch (_) {
    parsed = null;
  }
  return {
    id: row.id,
    source: row.source,
    from: row.from_address,
    subject: row.subject,
    body: row.body,
    status: row.status,
    parsed,
    error: row.error,
    shipmentId: row.shipment_id ? `SHP-${row.shipment_id}` : null,
    createdAt: row.created_at
  };
}

// Returns { item, duplicate }. The same message (same external id) is stored once.
async function createInboxItem(tenantId, { externalId, from, subject, body, status = 'new', source = 'email' }) {
  assertTenant(tenantId);
  const text = String(body || '').slice(0, INBOX_BODY_MAX);
  const result = await run(
    `INSERT OR IGNORE INTO inbox_items (tenant_id, source, external_id, from_address, subject, body, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [tenantId, source, externalId || null, from ? String(from).slice(0, 254) : null, subject ? String(subject).slice(0, 300) : null, text, status]
  );
  if (!result.changes) return { item: null, duplicate: true };
  return { item: await getInboxItem(tenantId, result.id), duplicate: false };
}

async function getInboxItem(tenantId, id) {
  const row = await get('SELECT * FROM inbox_items WHERE id = ? AND tenant_id = ?', [id, assertTenant(tenantId)]);
  if (!row) return null;
  return { ...mapInboxItem(row), attachments: await listInboxAttachments(tenantId, id) };
}

/* ---------------- files that came with an email ---------------- */

// Returns { id, duplicate }. The same file twice in one email is kept once.
async function addInboxAttachment(tenantId, inboxId, { filename, mime, content }) {
  assertTenant(tenantId);
  const sha256 = require('crypto').createHash('sha256').update(content).digest('hex');
  return withTransaction(async (transaction) => {
    const item = await transaction.get('SELECT id FROM inbox_items WHERE id = ? AND tenant_id = ?', [inboxId, tenantId]);
    if (!item) throw httpError(404, 'Message not found.');
    const existing = await transaction.get('SELECT id FROM inbox_attachments WHERE inbox_id = ? AND sha256 = ?', [inboxId, sha256]);
    if (existing) return { id: existing.id, duplicate: true };
    const result = await transaction.run(
      'INSERT INTO inbox_attachments (tenant_id, inbox_id, filename, mime, size, sha256, content) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [tenantId, inboxId, filename, mime, content.length, sha256, content]
    );
    return { id: result.id, duplicate: false };
  });
}

async function listInboxAttachments(tenantId, inboxId) {
  return all(
    'SELECT id, filename, mime, size FROM inbox_attachments WHERE inbox_id = ? AND tenant_id = ? ORDER BY id',
    [inboxId, assertTenant(tenantId)]
  );
}

async function getInboxAttachmentFile(tenantId, inboxId, id) {
  return get(
    'SELECT id, filename, mime, content FROM inbox_attachments WHERE id = ? AND inbox_id = ? AND tenant_id = ?',
    [id, inboxId, assertTenant(tenantId)]
  );
}

async function deleteInboxAttachments(tenantId, inboxId) {
  await run('DELETE FROM inbox_attachments WHERE inbox_id = ? AND tenant_id = ?', [inboxId, assertTenant(tenantId)]);
}

// Moves an email's files into a load's documents, in one transaction.
// typeFor(filename) picks the document type. Returns { documentIds, skipped } (skipped: the load is full).
async function moveInboxAttachmentsToShipment(tenantId, inboxId, shipmentId, { uploadedBy = null, typeFor = () => 'other', maxPerShipment = 20 } = {}) {
  assertTenant(tenantId);
  return withTransaction(async (transaction) => {
    const shipment = await transaction.get('SELECT id FROM shipments WHERE id = ? AND tenant_id = ?', [shipmentId, tenantId]);
    if (!shipment) throw httpError(404, 'Shipment not found.');
    const files = await transaction.all('SELECT * FROM inbox_attachments WHERE inbox_id = ? AND tenant_id = ? ORDER BY id', [inboxId, tenantId]);
    let count = Number((await transaction.get('SELECT COUNT(*) AS total FROM documents WHERE shipment_id = ?', [shipmentId]))?.total) || 0;
    const documentIds = [];
    let skipped = 0;
    for (const file of files) {
      const existing = await transaction.get('SELECT id FROM documents WHERE shipment_id = ? AND sha256 = ?', [shipmentId, file.sha256]);
      if (!existing) {
        if (count >= maxPerShipment) {
          skipped += 1;
          continue;
        }
        const result = await transaction.run(
          'INSERT INTO documents (tenant_id, shipment_id, doc_type, filename, mime, size, sha256, content, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [tenantId, shipmentId, typeFor(file.filename), file.filename, file.mime, file.size, file.sha256, file.content, uploadedBy]
        );
        documentIds.push(result.id);
        count += 1;
      }
      await transaction.run('DELETE FROM inbox_attachments WHERE id = ?', [file.id]);
    }
    return { documentIds, skipped };
  });
}

// Loads of this company whose own reference number is one of the given words (used to match an email to a load).
async function findShipmentIdsByReference(tenantId, references) {
  assertTenant(tenantId);
  const list = [...new Set(references.map((value) => String(value).toLowerCase()))].slice(0, 30);
  if (!list.length) return [];
  const rows = await all(
    `SELECT id FROM shipments WHERE tenant_id = ? AND lower(reference) IN (${list.map(() => '?').join(', ')}) LIMIT 5`,
    [tenantId, ...list]
  );
  return rows.map((row) => row.id);
}

async function listInboxItems(tenantId, { status, limit = 50 } = {}) {
  assertTenant(tenantId);
  const where = status ? 'AND status = ?' : "AND status NOT IN ('converted', 'dismissed', 'attached')";
  const params = status ? [tenantId, status, limit] : [tenantId, limit];
  const rows = await all(`SELECT * FROM inbox_items WHERE tenant_id = ? ${where} ORDER BY id DESC LIMIT ?`, params);
  if (!rows.length) return [];
  const files = await all(
    `SELECT id, inbox_id AS inboxId, filename, mime, size FROM inbox_attachments
     WHERE tenant_id = ? AND inbox_id IN (${rows.map(() => '?').join(', ')}) ORDER BY id`,
    [tenantId, ...rows.map((row) => row.id)]
  );
  return rows.map((row) => ({
    ...mapInboxItem(row),
    attachments: files.filter((file) => file.inboxId === row.id).map(({ inboxId, ...file }) => file)
  }));
}

async function countInboxItemsToday(tenantId) {
  const row = await get("SELECT COUNT(*) AS total FROM inbox_items WHERE tenant_id = ? AND created_at >= datetime('now', '-1 day')", [assertTenant(tenantId)]);
  return Number(row?.total) || 0;
}

async function updateInboxItem(tenantId, id, { status, parsed, error, shipmentId }) {
  assertTenant(tenantId);
  const fields = ["updated_at = CURRENT_TIMESTAMP"];
  const params = [];
  if (status !== undefined) { fields.push('status = ?'); params.push(status); }
  if (parsed !== undefined) { fields.push('parsed_json = ?'); params.push(parsed === null ? null : JSON.stringify(parsed)); }
  if (error !== undefined) { fields.push('error = ?'); params.push(error ? String(error).slice(0, 300) : null); }
  if (shipmentId !== undefined) { fields.push('shipment_id = ?'); params.push(shipmentId); }
  const result = await run(`UPDATE inbox_items SET ${fields.join(', ')} WHERE id = ? AND tenant_id = ?`, [...params, id, tenantId]);
  return result.changes === 1;
}

/* ---------------- NEXUS tasks ---------------- */

function mapTask(row) {
  let payload = null;
  try {
    payload = row.payload ? JSON.parse(row.payload) : null;
  } catch (_) {
    payload = null;
  }
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    shipmentId: row.shipment_id ? `SHP-${row.shipment_id}` : null,
    inboxId: row.inbox_id || null,
    payload,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at || null
  };
}

// Idempotent: returns { created: false } when a task with this dedupe key already exists.
async function createTask(tenantId, { kind, title, shipmentId = null, inboxId = null, payload = null, dedupeKey }) {
  assertTenant(tenantId);
  const result = await run(
    'INSERT OR IGNORE INTO nexus_tasks (tenant_id, kind, title, shipment_id, inbox_id, payload, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [tenantId, kind, String(title).slice(0, 200), shipmentId, inboxId, payload === null ? null : JSON.stringify(payload), dedupeKey]
  );
  return { created: result.changes === 1, id: result.changes === 1 ? result.id : null };
}

async function listTasks(tenantId, { status = 'open', limit = 100 } = {}) {
  assertTenant(tenantId);
  const rows = await all('SELECT * FROM nexus_tasks WHERE tenant_id = ? AND status = ? ORDER BY id DESC LIMIT ?', [tenantId, status, limit]);
  return rows.map(mapTask);
}

async function getTask(tenantId, id) {
  const row = await get('SELECT * FROM nexus_tasks WHERE id = ? AND tenant_id = ?', [id, assertTenant(tenantId)]);
  return row ? mapTask(row) : null;
}

// Closes one open task. Returns false when it was not open (already handled by someone else).
async function resolveTask(tenantId, id, { status = 'done', userId = null } = {}) {
  assertTenant(tenantId);
  const result = await run(
    "UPDATE nexus_tasks SET status = ?, resolved_at = CURRENT_TIMESTAMP, resolved_by = ? WHERE id = ? AND tenant_id = ? AND status = 'open'",
    [status, userId, id, tenantId]
  );
  return result.changes === 1;
}

// Closes the open tasks of a load whose dedupe key starts with a prefix (e.g. "book:" once it is booked).
async function resolveTasksByKey(tenantId, dedupeKeyPrefix, { status = 'done', userId = null } = {}) {
  assertTenant(tenantId);
  const like = `${String(dedupeKeyPrefix).replace(/[\\%_]/g, '\\$&')}%`;
  const result = await run(
    "UPDATE nexus_tasks SET status = ?, resolved_at = CURRENT_TIMESTAMP, resolved_by = ? WHERE tenant_id = ? AND status = 'open' AND dedupe_key LIKE ? ESCAPE '\\'",
    [status, userId, tenantId, like]
  );
  return result.changes;
}

async function resolveTasksForShipment(tenantId, shipmentId, { status = 'done', userId = null } = {}) {
  assertTenant(tenantId);
  const result = await run(
    "UPDATE nexus_tasks SET status = ?, resolved_at = CURRENT_TIMESTAMP, resolved_by = ? WHERE tenant_id = ? AND shipment_id = ? AND status = 'open'",
    [status, userId, tenantId, shipmentId]
  );
  return result.changes;
}

// How many AI calls this company made in the last 24 hours (automatic AI work stops at a daily cap).
async function countAgentTasksToday(tenantId) {
  const row = await get("SELECT COUNT(*) AS total FROM agent_tasks WHERE tenant_id = ? AND created_at >= datetime('now', '-1 day')", [assertTenant(tenantId)]);
  return Number(row?.total) || 0;
}

// System job only (NEXUS sweeper): loads in any company with no sign of life for staleHours.
// Tenant-scoped callers must never use this.
async function listStaleLoadsAllTenants(staleHours) {
  return all(
    `SELECT id, tenant_id AS tenantId, last_tracked_at AS lastTrackedAt FROM shipments
     WHERE status IN ('Dispatched', 'In Transit') AND leg_mode <> 'multi' AND trip_id IS NULL AND ${LAST_SIGN_OF_LIFE} < datetime('now', ?)`,
    [`-${Number(staleHours)} hours`]
  );
}

// Open tasks whose key starts with a prefix. tenantId null = every company (system jobs only).
async function listOpenTasksByKeyPrefix(tenantId, prefix) {
  const scoped = tenantId !== null;
  if (scoped) assertTenant(tenantId);
  return all(
    `SELECT id, tenant_id AS tenantId, dedupe_key AS dedupeKey FROM nexus_tasks
     WHERE status = 'open' AND substr(dedupe_key, 1, ?) = ? ${scoped ? 'AND tenant_id = ?' : ''}`,
    scoped ? [prefix.length, prefix, tenantId] : [prefix.length, prefix]
  );
}

/* ---------------- market prices (PULSE) ---------------- */

const mapMarketRate = (row) => ({ id: row.id, origin: row.origin, destination: row.destination, equipment: row.equipment || null, rate: Number(row.rate), currency: row.currency || DEFAULT_CURRENCY, updatedAt: row.updated_at });

async function listMarketRates(tenantId) {
  return (await all('SELECT * FROM market_rates WHERE tenant_id = ? ORDER BY lower(origin), lower(destination), equipment LIMIT 2000', [assertTenant(tenantId)])).map(mapMarketRate);
}

// Adds or updates one lane price. Returns 'created' or 'updated'.
async function upsertMarketRate(tenantId, { origin, destination, equipment = '', rate }) {
  assertTenant(tenantId);
  const currency = await currencyOf(tenantId);
  rate = roundMoney(rate, currency);
  const existing = await get('SELECT id FROM market_rates WHERE tenant_id = ? AND lower(origin) = lower(?) AND lower(destination) = lower(?) AND equipment = ?', [tenantId, origin, destination, equipment]);
  if (existing) {
    await run('UPDATE market_rates SET rate = ?, currency = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?', [rate, currency, existing.id, tenantId]);
    return 'updated';
  }
  await run('INSERT INTO market_rates (tenant_id, origin, destination, equipment, rate, currency) VALUES (?, ?, ?, ?, ?, ?)', [tenantId, origin, destination, equipment, rate, currency]);
  return 'created';
}

async function deleteMarketRate(tenantId, id) {
  const result = await run('DELETE FROM market_rates WHERE id = ? AND tenant_id = ?', [id, assertTenant(tenantId)]);
  return result.changes === 1;
}

/* ---------------- border waiting times ---------------- */

// "UZ" and "KZ" in any order name the same border: the pair is stored sorted ("KZ-UZ").
const borderPair = (a, b) => [String(a).toUpperCase(), String(b).toUpperCase()].sort().join('-');

async function listBorderWaits(tenantId) {
  return (await all('SELECT id, pair, hours, updated_at AS updatedAt FROM border_waits WHERE tenant_id = ? ORDER BY pair', [assertTenant(tenantId)]))
    .map((row) => ({ id: row.id, pair: row.pair, hours: Number(row.hours), updatedAt: row.updatedAt }));
}

async function upsertBorderWait(tenantId, countryA, countryB, hours) {
  assertTenant(tenantId);
  const pair = borderPair(countryA, countryB);
  const existing = await get('SELECT id FROM border_waits WHERE tenant_id = ? AND pair = ?', [tenantId, pair]);
  if (existing) {
    await run('UPDATE border_waits SET hours = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?', [hours, existing.id, tenantId]);
    return 'updated';
  }
  await run('INSERT INTO border_waits (tenant_id, pair, hours) VALUES (?, ?, ?)', [tenantId, pair, hours]);
  return 'created';
}

async function deleteBorderWait(tenantId, id) {
  return (await run('DELETE FROM border_waits WHERE id = ? AND tenant_id = ?', [id, assertTenant(tenantId)])).changes === 1;
}

async function getBorderWait(tenantId, countryA, countryB) {
  const row = await get('SELECT pair, hours FROM border_waits WHERE tenant_id = ? AND pair = ?', [assertTenant(tenantId), borderPair(countryA, countryB)]);
  return row ? { pair: row.pair, hours: Number(row.hours) } : null;
}

/* ---------------- quotes ---------------- */

const QUOTE_FIELDS = {
  customer: 'customer', customerPhone: 'customer_phone', origin: 'origin', destination: 'destination', equipment: 'equipment',
  weight: 'weight', pickup: 'pickup', delivery: 'delivery', price: 'price', carrierCost: 'carrier_cost', validUntil: 'valid_until', notes: 'notes'
};

// Amounts are kept to the minor unit of the quote's currency.
const quoteValue = (key, value, currency) => (['price', 'carrierCost'].includes(key) && value !== null && value !== undefined ? roundMoney(value, currency) : value);

// A sent quote whose date has passed shows as expired (nothing is stored for that).
function mapQuote(row, today = new Date().toISOString().slice(0, 10)) {
  const expired = ['draft', 'sent'].includes(row.status) && row.valid_until < today;
  return {
    id: row.id,
    number: `Q-${row.id}`,
    customer: row.customer,
    customerPhone: row.customer_phone || null,
    origin: row.origin,
    destination: row.destination,
    equipment: row.equipment,
    weight: row.weight === null ? null : Number(row.weight),
    pickup: row.pickup || null,
    delivery: row.delivery || null,
    price: Number(row.price),
    carrierCost: row.carrier_cost === null ? null : Number(row.carrier_cost),
    currency: row.currency || DEFAULT_CURRENCY,
    margin: row.carrier_cost === null ? null : addMoney(row.currency || DEFAULT_CURRENCY, row.price, -row.carrier_cost),
    validUntil: row.valid_until,
    notes: row.notes || null,
    status: expired ? 'expired' : row.status,
    shipmentId: row.shipment_id ? `SHP-${row.shipment_id}` : null,
    createdBy: row.createdBy || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const QUOTE_SELECT = 'SELECT quotes.*, users.name AS createdBy FROM quotes LEFT JOIN users ON users.id = quotes.created_by';

async function createQuote(tenantId, fields, actorId) {
  assertTenant(tenantId);
  const columns = Object.keys(QUOTE_FIELDS).filter((key) => fields[key] !== undefined);
  const currency = await currencyOf(tenantId);
  const result = await run(
    `INSERT INTO quotes (tenant_id, created_by, currency, ${columns.map((key) => QUOTE_FIELDS[key]).join(', ')}) VALUES (?, ?, ?, ${columns.map(() => '?').join(', ')})`,
    [tenantId, actorId || null, currency, ...columns.map((key) => quoteValue(key, fields[key], currency))]
  );
  return getQuote(tenantId, result.id);
}

async function getQuote(tenantId, id) {
  const row = await get(`${QUOTE_SELECT} WHERE quotes.id = ? AND quotes.tenant_id = ?`, [id, assertTenant(tenantId)]);
  return row ? mapQuote(row, timeLib.localDate(await timeZoneOf(tenantId))) : null;
}

async function listQuotes(tenantId, { limit = 200 } = {}) {
  const rows = await all(`${QUOTE_SELECT} WHERE quotes.tenant_id = ? ORDER BY quotes.id DESC LIMIT ?`, [assertTenant(tenantId), limit]);
  const today = timeLib.localDate(await timeZoneOf(tenantId));
  return rows.map((row) => mapQuote(row, today));
}

// Changes fields and/or status. An accepted quote that became a load, or a declined one, is not edited.
async function updateQuote(tenantId, id, fields, status) {
  assertTenant(tenantId);
  const current = await getQuote(tenantId, id);
  if (!current) throw httpError(404, 'Quote not found.');
  const editable = Object.keys(fields).filter((key) => fields[key] !== undefined && QUOTE_FIELDS[key]);
  if (editable.length && (current.shipmentId || current.status === 'declined')) throw httpError(409, 'This quote is closed and can no longer be edited.');
  if (status && current.shipmentId) throw httpError(409, 'This quote already became a load.');
  const sets = editable.map((key) => `${QUOTE_FIELDS[key]} = ?`);
  const params = editable.map((key) => quoteValue(key, fields[key], current.currency));
  if (status) {
    sets.push('status = ?');
    params.push(status);
  }
  if (!sets.length) return current;
  await run(`UPDATE quotes SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?`, [...params, id, tenantId]);
  return getQuote(tenantId, id);
}

// Accepted: the quote becomes a load (status New, customer price = quoted price), in one transaction.
async function convertQuote(tenantId, id, { pickup, delivery, weight, actorId }) {
  assertTenant(tenantId);
  return withTransaction(async (transaction) => {
    const row = await transaction.get('SELECT * FROM quotes WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!row) throw httpError(404, 'Quote not found.');
    if (row.shipment_id) throw httpError(409, `This quote already became SHP-${row.shipment_id}.`);
    if (row.status === 'declined') throw httpError(409, 'A declined quote cannot become a load.');
    const result = await transaction.run(
      `INSERT INTO shipments (customer, origin, destination, pickup, delivery, status, weight, equipment, reference, customer_rate, currency, customer_phone, tenant_id)
       VALUES (?, ?, ?, ?, ?, 'New', ?, ?, ?, ?, ?, ?, ?)`,
      [row.customer, row.origin, row.destination, pickup, delivery, weight, row.equipment, `Q-${row.id}`, row.price, row.currency || await currencyOf(tenantId, transaction.get), row.customer_phone || null, tenantId]
    );
    await recordShipmentEvent(result.id, null, 'New', `Created from quote Q-${row.id}`, actorId, transaction.run);
    await transaction.run("UPDATE quotes SET status = 'accepted', shipment_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [result.id, id]);
    return result.id;
  });
}

// Prices on a lane before any load exists (for a quote): past loads and market prices.
async function getLanePriceData(tenantId, { origin, destination, equipment }) {
  assertTenant(tenantId);
  const history = await all(
    `SELECT rate, customer_rate AS customerRate, equipment FROM shipments
     WHERE tenant_id = ? AND status <> 'Cancelled' AND lower(origin) = lower(?) AND lower(destination) = lower(?)
       AND (rate IS NOT NULL OR customer_rate IS NOT NULL)
     ORDER BY id DESC LIMIT 200`,
    [tenantId, origin, destination]
  );
  const market = await all(
    `SELECT equipment, rate, updated_at AS updatedAt FROM market_rates
     WHERE tenant_id = ? AND lower(origin) = lower(?) AND lower(destination) = lower(?) AND (equipment = ? OR equipment = '')`,
    [tenantId, origin, destination, equipment || '']
  );
  const marketRate = market.find((row) => row.equipment) || market[0] || null;
  return {
    shipment: { equipment, rate: null, customer_rate: null },
    history,
    marketRate: marketRate ? { rate: Number(marketRate.rate), equipment: marketRate.equipment || null, updatedAt: marketRate.updatedAt } : null
  };
}

/* ---------------- map cache ---------------- */

async function getGeoPlace(key) {
  const row = await get('SELECT lat, lng FROM geo_places WHERE place_key = ?', [key]);
  return row ? { lat: row.lat, lng: row.lng } : undefined;
}

// lat / lng null = "looked up, not found" (so an unknown place is not asked again and again).
async function setGeoPlace(key, lat, lng) {
  await run('INSERT OR REPLACE INTO geo_places (place_key, lat, lng) VALUES (?, ?, ?)', [key, lat, lng]);
}

async function getGeoRoute(key) {
  const row = await get('SELECT distance_km, duration_h, points_json FROM geo_routes WHERE route_key = ?', [key]);
  return row ? { distanceKm: row.distance_km, durationHours: row.duration_h, points: JSON.parse(row.points_json) } : null;
}

async function setGeoRoute(key, { distanceKm, durationHours, points }) {
  await run('INSERT OR REPLACE INTO geo_routes (route_key, distance_km, duration_h, points_json) VALUES (?, ?, ?, ?)', [key, distanceKm, durationHours, JSON.stringify(points)]);
}

/* ---------------- ROUTE, PULSE and SENTINEL data ---------------- */

const EVENT_TIME = (status) => `(SELECT ${status === 'Delivered' ? 'MAX' : 'MIN'}(created_at) FROM shipment_events
  WHERE shipment_events.shipment_id = shipments.id AND shipment_events.to_status = '${status}')`;

// What ROUTE needs for one load: how long this lane took before, and trucks that end up near the pickup.
async function getRouteData(tenantId, shipmentId) {
  assertTenant(tenantId);
  const shipment = await getShipment(tenantId, shipmentId);
  if (!shipment) throw httpError(404, 'Shipment not found.');
  const lane = [shipment.origin, shipment.destination];
  const history = await all(
    `SELECT ${EVENT_TIME('In Transit')} AS startedAt, ${EVENT_TIME('Delivered')} AS deliveredAt FROM shipments
     WHERE tenant_id = ? AND id <> ? AND status = 'Delivered' AND lower(origin) = lower(?) AND lower(destination) = lower(?)
     ORDER BY id DESC LIMIT 50`,
    [tenantId, shipmentId, ...lane]
  );
  const started = await get(`SELECT ${EVENT_TIME('In Transit')} AS startedAt FROM shipments WHERE id = ? AND tenant_id = ?`, [shipmentId, tenantId]);
  const nearby = await all(
    `SELECT shipments.id, shipments.status, shipments.delivery, shipments.eta, shipments.origin, shipments.carrier_id AS carrierId,
       carriers.name AS carrierName, carriers.phone AS carrierPhone, carriers.mode AS carrierMode, ${EVENT_TIME('Delivered')} AS deliveredAt
     FROM shipments JOIN carriers ON carriers.id = shipments.carrier_id
     WHERE shipments.tenant_id = ? AND shipments.id <> ? AND lower(shipments.destination) = lower(?) AND carriers.status <> 'Inactive'
       AND (shipments.status IN ('Dispatched', 'In Transit')
         OR (shipments.status = 'Delivered' AND ${EVENT_TIME('Delivered')} >= datetime('now', '-3 days')))
     ORDER BY shipments.id DESC LIMIT 20`,
    [tenantId, shipmentId, shipment.origin]
  );
  return { shipment, history, startedAt: started?.startedAt || null, nearby };
}

// What PULSE needs for one load: prices paid and charged on the same lane before.
async function getPulseData(tenantId, shipmentId) {
  assertTenant(tenantId);
  const shipment = await getShipment(tenantId, shipmentId);
  if (!shipment) throw httpError(404, 'Shipment not found.');
  const history = await all(
    `SELECT rate, customer_rate AS customerRate, equipment FROM shipments
     WHERE tenant_id = ? AND id <> ? AND status <> 'Cancelled' AND lower(origin) = lower(?) AND lower(destination) = lower(?)
       AND (rate IS NOT NULL OR customer_rate IS NOT NULL)
     ORDER BY id DESC LIMIT 200`,
    [tenantId, shipmentId, shipment.origin, shipment.destination]
  );
  const market = await all(
    `SELECT equipment, rate, updated_at AS updatedAt FROM market_rates
     WHERE tenant_id = ? AND lower(origin) = lower(?) AND lower(destination) = lower(?) AND (equipment = ? OR equipment = '')`,
    [tenantId, shipment.origin, shipment.destination, shipment.equipment || '']
  );
  // A price for this trailer type beats one for any trailer.
  const marketRate = market.find((row) => row.equipment) || market[0] || null;
  return { shipment, history, marketRate: marketRate ? { rate: Number(marketRate.rate), equipment: marketRate.equipment || null, updatedAt: marketRate.updatedAt } : null };
}

// Everything the Global Tracking page shows for this company's booked loads: carrier, driver, the latest
// position and when the truck was booked, left and (for the last days) delivered.
async function listTrackingOverview(tenantId) {
  assertTenant(tenantId);
  const at = (status, fn = 'MIN') => `(SELECT ${fn}(created_at) FROM shipment_events WHERE shipment_events.shipment_id = shipments.id AND shipment_events.to_status = '${status}')`;
  const gps = (column) => `(SELECT ${column} FROM tracking_updates WHERE tracking_updates.shipment_id = shipments.id AND lat IS NOT NULL ORDER BY id DESC LIMIT 1)`;
  return all(
    `SELECT shipments.id, shipments.customer, shipments.origin, shipments.destination, shipments.pickup, shipments.delivery, shipments.status,
       shipments.weight, shipments.equipment, shipments.eta, shipments.last_location AS lastLocation, shipments.last_tracked_at AS lastTrackedAt,
       shipments.driver_name AS driverName, shipments.driver_phone AS driverPhone, shipments.truck_plate AS truckPlate,
       carriers.name AS carrierName, carriers.phone AS carrierPhone,
       ${gps('lat')} AS lat, ${gps('lng')} AS lng, ${gps('created_at')} AS gpsAt,
       ${at('Dispatched')} AS bookedAt, ${at('In Transit')} AS departedAt, ${at('Delivered', 'MAX')} AS deliveredAt
     FROM shipments LEFT JOIN carriers ON carriers.id = shipments.carrier_id
     WHERE shipments.tenant_id = ? AND (shipments.status IN ('Dispatched', 'In Transit', 'Exception')
       OR (shipments.status = 'Delivered' AND ${at('Delivered', 'MAX')} >= datetime('now', '-2 days')))
     ORDER BY CASE shipments.status WHEN 'Exception' THEN 0 WHEN 'In Transit' THEN 1 WHEN 'Dispatched' THEN 2 ELSE 3 END, shipments.id DESC
     LIMIT 500`,
    [tenantId]
  );
}

// Loads that are still open, with what SENTINEL checks. tenantId null = every company (system job only).
async function listSentinelLoads(tenantId) {
  const scoped = tenantId !== null;
  if (scoped) assertTenant(tenantId);
  return all(
    `SELECT id, tenant_id AS tenantId, customer, origin, destination, pickup, delivery, status, carrier_id AS carrierId,
       driver_phone AS driverPhone, truck_plate AS truckPlate, eta, ${LAST_SIGN_OF_LIFE} AS lastSignOfLife,
       (SELECT phone FROM carriers WHERE carriers.id = shipments.carrier_id) AS carrierPhone,
       (SELECT lat FROM tracking_updates WHERE tracking_updates.shipment_id = shipments.id AND source = 'gps' AND lat IS NOT NULL ORDER BY id DESC LIMIT 1) AS lastLat,
       (SELECT lng FROM tracking_updates WHERE tracking_updates.shipment_id = shipments.id AND source = 'gps' AND lat IS NOT NULL ORDER BY id DESC LIMIT 1) AS lastLng,
       (SELECT created_at FROM tracking_updates WHERE tracking_updates.shipment_id = shipments.id AND source = 'gps' AND lat IS NOT NULL ORDER BY id DESC LIMIT 1) AS lastGpsAt,
       (SELECT COUNT(*) FROM messages WHERE messages.shipment_id = shipments.id
          AND messages.delivery_status IN ('failed', 'undelivered') AND messages.created_at >= datetime('now', '-2 days')) AS failedMessages
     FROM shipments WHERE status NOT IN ('Delivered', 'Cancelled') AND leg_mode <> 'multi' ${scoped ? 'AND tenant_id = ?' : ''}
     ORDER BY id DESC LIMIT 5000`,
    scoped ? [tenantId] : []
  );
}

// How many times a load has reached a status: lets a rule run again when a load comes back to it.
async function countStatusReached(tenantId, shipmentId, status) {
  const row = await get(
    `SELECT COUNT(*) AS total FROM shipment_events JOIN shipments ON shipments.id = shipment_events.shipment_id
     WHERE shipment_events.shipment_id = ? AND shipments.tenant_id = ? AND shipment_events.to_status = ?`,
    [shipmentId, assertTenant(tenantId), status]
  );
  return Number(row?.total) || 0;
}

async function countShipmentExceptions(tenantId, shipmentId) {
  const row = await get(
    `SELECT COUNT(*) AS total FROM shipment_events JOIN shipments ON shipments.id = shipment_events.shipment_id
     WHERE shipment_events.shipment_id = ? AND shipments.tenant_id = ? AND shipment_events.to_status = 'Exception'`,
    [shipmentId, assertTenant(tenantId)]
  );
  return Number(row?.total) || 0;
}

/* ---------------- documents (VAULT) ---------------- */

function mapDocument(row) {
  const parse = (text) => {
    try {
      return text ? JSON.parse(text) : null;
    } catch (_) {
      return null;
    }
  };
  return {
    id: row.id,
    type: row.doc_type,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    extractionStatus: row.extraction_status,
    extracted: parse(row.extracted_json),
    comparison: parse(row.comparison_json),
    error: row.error,
    uploadedBy: row.uploadedBy || null,
    createdAt: row.created_at
  };
}

const DOCUMENT_COLUMNS = `documents.id, documents.doc_type, documents.filename, documents.mime, documents.size, documents.extraction_status,
  documents.extracted_json, documents.comparison_json, documents.error, documents.created_at, users.name AS uploadedBy`;

// Returns { document, duplicate }. The same file attached twice to one load is kept once.
async function addDocument(tenantId, shipmentId, { type, filename, mime, content, uploadedBy }) {
  assertTenant(tenantId);
  const crypto = require('crypto');
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  return withTransaction(async (transaction) => {
    const shipment = await transaction.get('SELECT id FROM shipments WHERE id = ? AND tenant_id = ?', [shipmentId, tenantId]);
    if (!shipment) throw httpError(404, 'Shipment not found.');
    const existing = await transaction.get('SELECT id FROM documents WHERE shipment_id = ? AND sha256 = ?', [shipmentId, sha256]);
    if (existing) return { id: existing.id, duplicate: true };
    const result = await transaction.run(
      `INSERT INTO documents (tenant_id, shipment_id, doc_type, filename, mime, size, sha256, content, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tenantId, shipmentId, type, filename, mime, content.length, sha256, content, uploadedBy || null]
    );
    return { id: result.id, duplicate: false };
  }).then(async (result) => ({ document: await getDocument(tenantId, shipmentId, result.id), duplicate: result.duplicate }));
}

async function getDocument(tenantId, shipmentId, id) {
  const row = await get(
    `SELECT ${DOCUMENT_COLUMNS} FROM documents LEFT JOIN users ON users.id = documents.uploaded_by
     WHERE documents.id = ? AND documents.shipment_id = ? AND documents.tenant_id = ?`,
    [id, shipmentId, assertTenant(tenantId)]
  );
  return row ? mapDocument(row) : null;
}

async function listDocuments(tenantId, shipmentId) {
  const rows = await all(
    `SELECT ${DOCUMENT_COLUMNS} FROM documents LEFT JOIN users ON users.id = documents.uploaded_by
     WHERE documents.shipment_id = ? AND documents.tenant_id = ? ORDER BY documents.id DESC`,
    [shipmentId, assertTenant(tenantId)]
  );
  return rows.map(mapDocument);
}

// The stored file itself (for download and for reading by VAULT).
async function getDocumentFile(tenantId, shipmentId, id) {
  return get(
    'SELECT id, filename, mime, doc_type AS type, content FROM documents WHERE id = ? AND shipment_id = ? AND tenant_id = ?',
    [id, shipmentId, assertTenant(tenantId)]
  );
}

async function updateDocumentExtraction(tenantId, id, { status, extracted, comparison, error }) {
  assertTenant(tenantId);
  await run(
    'UPDATE documents SET extraction_status = ?, extracted_json = ?, comparison_json = ?, error = ? WHERE id = ? AND tenant_id = ?',
    [status, extracted ? JSON.stringify(extracted) : null, comparison ? JSON.stringify(comparison) : null, error ? String(error).slice(0, 300) : null, id, tenantId]
  );
}

async function setDocumentType(tenantId, shipmentId, id, type) {
  assertTenant(tenantId);
  const result = await run('UPDATE documents SET doc_type = ? WHERE id = ? AND shipment_id = ? AND tenant_id = ?', [type, id, shipmentId, tenantId]);
  return result.changes === 1;
}

async function deleteDocument(tenantId, shipmentId, id) {
  assertTenant(tenantId);
  const result = await run('DELETE FROM documents WHERE id = ? AND shipment_id = ? AND tenant_id = ?', [id, shipmentId, tenantId]);
  return result.changes === 1;
}

/* ---------- Automation Studio ---------- */
function parseJsonList(text) {
  try {
    const value = JSON.parse(text || '[]');
    return Array.isArray(value) ? value : [];
  } catch (_) {
    return [];
  }
}

function mapWorkflow(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || null,
    trigger: row.trigger,
    triggerStatus: row.trigger_status || null,
    conditions: parseJsonList(row.conditions),
    actions: parseJsonList(row.actions),
    enabled: Boolean(row.enabled),
    createdBy: row.createdBy || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    runs30: Number(row.runs30 || 0),
    failed30: Number(row.failed30 || 0),
    lastRunAt: row.lastRunAt || null
  };
}

const WORKFLOW_SELECT = `SELECT workflows.*, users.name AS createdBy,
  (SELECT COUNT(*) FROM workflow_runs r WHERE r.workflow_id = workflows.id AND r.tenant_id = workflows.tenant_id AND r.created_at >= datetime('now', '-30 days')) AS runs30,
  (SELECT COUNT(*) FROM workflow_runs r WHERE r.workflow_id = workflows.id AND r.tenant_id = workflows.tenant_id AND r.status = 'failed' AND r.created_at >= datetime('now', '-30 days')) AS failed30,
  (SELECT MAX(created_at) FROM workflow_runs r WHERE r.workflow_id = workflows.id AND r.tenant_id = workflows.tenant_id) AS lastRunAt
  FROM workflows LEFT JOIN users ON users.id = workflows.created_by`;

async function listWorkflows(tenantId) {
  const rows = await all(`${WORKFLOW_SELECT} WHERE workflows.tenant_id = ? ORDER BY workflows.id`, [assertTenant(tenantId)]);
  return rows.map(mapWorkflow);
}

async function getWorkflow(tenantId, id) {
  const row = await get(`${WORKFLOW_SELECT} WHERE workflows.id = ? AND workflows.tenant_id = ?`, [id, assertTenant(tenantId)]);
  return row ? mapWorkflow(row) : null;
}

async function listActiveWorkflows(tenantId, trigger) {
  const rows = await all('SELECT * FROM workflows WHERE tenant_id = ? AND trigger = ? AND enabled = 1 ORDER BY id', [assertTenant(tenantId), trigger]);
  return rows.map(mapWorkflow);
}

async function createWorkflow(tenantId, fields, actorId, maxPerCompany = 50) {
  assertTenant(tenantId);
  const count = await get('SELECT COUNT(*) AS total FROM workflows WHERE tenant_id = ?', [tenantId]);
  if (count.total >= maxPerCompany) throw httpError(409, `A company can have at most ${maxPerCompany} workflows.`);
  const result = await run(
    'INSERT INTO workflows (tenant_id, name, description, trigger, trigger_status, conditions, actions, enabled, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [tenantId, fields.name, fields.description, fields.trigger, fields.triggerStatus, JSON.stringify(fields.conditions), JSON.stringify(fields.actions), fields.enabled ? 1 : 0, actorId || null]
  );
  return getWorkflow(tenantId, result.id);
}

async function updateWorkflow(tenantId, id, fields) {
  assertTenant(tenantId);
  const result = await run(
    `UPDATE workflows SET name = ?, description = ?, trigger = ?, trigger_status = ?, conditions = ?, actions = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND tenant_id = ?`,
    [fields.name, fields.description, fields.trigger, fields.triggerStatus, JSON.stringify(fields.conditions), JSON.stringify(fields.actions), fields.enabled ? 1 : 0, id, tenantId]
  );
  if (!result.changes) throw httpError(404, 'Workflow not found.');
  return getWorkflow(tenantId, id);
}

async function setWorkflowEnabled(tenantId, id, enabled) {
  const result = await run('UPDATE workflows SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?', [enabled ? 1 : 0, id, assertTenant(tenantId)]);
  if (!result.changes) throw httpError(404, 'Workflow not found.');
  return getWorkflow(tenantId, id);
}

async function deleteWorkflow(tenantId, id) {
  assertTenant(tenantId);
  const result = await run('DELETE FROM workflows WHERE id = ? AND tenant_id = ?', [id, tenantId]);
  if (!result.changes) throw httpError(404, 'Workflow not found.');
  await run('DELETE FROM workflow_runs WHERE workflow_id = ? AND tenant_id = ?', [id, tenantId]);
}

async function recordWorkflowRun(tenantId, { workflowId, shipmentId = null, status, detail = null }) {
  await run('INSERT INTO workflow_runs (tenant_id, workflow_id, shipment_id, status, detail) VALUES (?, ?, ?, ?, ?)', [assertTenant(tenantId), workflowId, shipmentId, status, detail]);
}

async function listWorkflowRuns(tenantId, limit = 50) {
  const rows = await all(
    `SELECT workflow_runs.*, workflows.name AS workflowName FROM workflow_runs
     LEFT JOIN workflows ON workflows.id = workflow_runs.workflow_id AND workflows.tenant_id = workflow_runs.tenant_id
     WHERE workflow_runs.tenant_id = ? ORDER BY workflow_runs.id DESC LIMIT ?`,
    [assertTenant(tenantId), limit]
  );
  return rows.map((row) => ({
    id: row.id,
    workflowId: row.workflow_id,
    workflowName: row.workflowName || 'Deleted workflow',
    shipmentId: row.shipment_id ? `SHP-${row.shipment_id}` : null,
    status: row.status,
    detail: row.detail || null,
    createdAt: row.created_at
  }));
}

async function getWorkflowStats(tenantId) {
  const row = await get(
    `SELECT COUNT(*) AS runs, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
     FROM workflow_runs WHERE tenant_id = ? AND created_at >= datetime('now', '-30 days')`,
    [assertTenant(tenantId)]
  );
  return { runs30: Number(row.runs || 0), failed30: Number(row.failed || 0) };
}

/* ---------- subscription plan ---------- */
// Loads created since the first day of this calendar month (UTC): what a plan's monthly limit counts.
async function countShipmentsThisMonth(tenantId) {
  const row = await get(
    "SELECT COUNT(*) AS total FROM shipments WHERE tenant_id = ? AND created_at >= strftime('%Y-%m-01 00:00:00', 'now')",
    [assertTenant(tenantId)]
  );
  return Number(row?.total) || 0;
}

// People who can sign in: disabled accounts do not take a seat.
async function countActiveUsers(tenantId) {
  const row = await get('SELECT COUNT(*) AS total FROM users WHERE tenant_id = ? AND disabled_at IS NULL', [assertTenant(tenantId)]);
  return Number(row?.total) || 0;
}

async function updateTenantPlan(tenantId, change) {
  assertTenant(tenantId);
  const sets = [];
  const params = [];
  if (change.plan) { sets.push('plan = ?'); params.push(change.plan); }
  if (change.status) { sets.push('plan_status = ?'); params.push(change.status); }
  if (change.trialDays) { sets.push("trial_ends_at = datetime('now', ?)"); params.push(`+${change.trialDays} days`); }
  if (change.userLimit !== undefined) { sets.push('user_limit = ?'); params.push(change.userLimit); }
  if (change.shipmentLimit !== undefined) { sets.push('shipment_limit = ?'); params.push(change.shipmentLimit); }
  const result = await run(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`, [...params, tenantId]);
  if (!result.changes) throw httpError(404, 'Company not found.');
  return getTenant(tenantId);
}

async function findTenantByPaddleSubscription(subscriptionId) {
  if (!subscriptionId) return null;
  const row = await get('SELECT id FROM tenants WHERE paddle_subscription_id = ?', [subscriptionId]);
  return row ? row.id : null;
}

// Applies a Paddle subscription change. Older news than what is stored is ignored (webhooks can arrive
// out of order). Returns false when nothing was changed.
async function applyPaddleSubscription(tenantId, { plan, period, status, customerId, subscriptionId, changedAt }) {
  assertTenant(tenantId);
  const stamp = changedAt && !Number.isNaN(Date.parse(changedAt)) ? new Date(changedAt).toISOString() : new Date().toISOString();
  const result = await run(
    `UPDATE tenants SET
       plan = COALESCE(?, plan),
       billing_period = COALESCE(?, billing_period),
       plan_status = COALESCE(?, plan_status),
       paddle_customer_id = COALESCE(?, paddle_customer_id),
       paddle_subscription_id = COALESCE(?, paddle_subscription_id),
       paddle_changed_at = ?
     WHERE id = ? AND (paddle_changed_at IS NULL OR paddle_changed_at <= ?)`,
    [plan || null, period || null, status || null, customerId || null, subscriptionId || null, stamp, tenantId, stamp]
  );
  return result.changes > 0;
}

/* ---------- region and data export ---------- */
async function setTenantRegion(tenantId, { currency, weightUnit, timeZone = null, locale = null }) {
  if (timeZone !== null && !timeLib.isValidTimeZone(timeZone)) throw httpError(400, 'Choose a valid time zone.');
  if (locale !== null && !timeLib.isValidLocale(locale)) throw httpError(400, 'Choose a supported language and number format.');
  // Time zone and locale are only changed when given.
  await run('UPDATE tenants SET currency = ?, weight_unit = ?, timezone = COALESCE(?, timezone), locale = COALESCE(?, locale) WHERE id = ?',
    [currency, weightUnit, timeZone, locale, assertTenant(tenantId)]);
  return getTenant(tenantId);
}

// Everything a company owns, for its own records or to move elsewhere (GDPR portability).
// Passwords, tokens and encrypted provider settings are never included; files are listed, not embedded.
async function exportTenantData(tenantId) {
  assertTenant(tenantId);
  const pick = (sql) => all(sql, [tenantId]);
  const tenant = await get('SELECT id, name, created_at, plan, plan_status, currency, weight_unit, terms_version, terms_accepted_at FROM tenants WHERE id = ?', [tenantId]);
  return {
    exportedAt: new Date().toISOString(),
    company: tenant,
    users: await pick('SELECT id, name, email, role, disabled_at FROM users WHERE tenant_id = ? ORDER BY id'),
    carriers: await pick('SELECT * FROM carriers WHERE tenant_id = ? ORDER BY id'),
    shipments: await pick('SELECT * FROM shipments WHERE tenant_id = ? ORDER BY id'),
    shipmentEvents: await pick('SELECT shipment_events.* FROM shipment_events JOIN shipments ON shipments.id = shipment_events.shipment_id WHERE shipments.tenant_id = ? ORDER BY shipment_events.id'),
    trackingUpdates: await pick('SELECT tracking_updates.* FROM tracking_updates JOIN shipments ON shipments.id = tracking_updates.shipment_id WHERE shipments.tenant_id = ? ORDER BY tracking_updates.id'),
    quotes: await pick('SELECT * FROM quotes WHERE tenant_id = ? ORDER BY id'),
    messages: await pick('SELECT * FROM messages WHERE tenant_id = ? ORDER BY id'),
    documents: await pick('SELECT id, shipment_id, filename, mime, size, created_at FROM documents WHERE tenant_id = ? ORDER BY id'),
    workflows: await pick('SELECT * FROM workflows WHERE tenant_id = ? ORDER BY id')
  };
}

/* ---------- shipment legs (lib/legs.js has the rules) ---------- */
// A load is one customer order. A classic single-truck load has no leg rows: it is shown as one ROAD leg built
// from the load itself. Adding a second leg (or creating a load with legs) turns it into a multi-leg load whose
// legs are stored; from then on its status, price and tracking come from the legs.
const LEG_SELECT = `SELECT l.id, l.shipment_id AS shipmentId, l.sequence, l.mode, l.status, l.carrier_id AS carrierId, carriers.name AS carrierName,
    l.origin, l.destination, l.scheduled_pickup AS scheduledPickup, l.scheduled_delivery AS scheduledDelivery, l.price, l.currency, l.reference,
    l.details, l.last_location AS lastLocation, l.eta, l.last_tracked_at AS lastTrackedAt, l.paid_at AS paidAt, l.created_at AS createdAt, l.updated_at AS updatedAt
  FROM shipment_legs l LEFT JOIN carriers ON carriers.id = l.carrier_id`;

function mapLeg(row) {
  let details = {};
  try {
    details = JSON.parse(row.details || '{}') || {};
  } catch (_) {
    details = {};
  }
  return {
    id: row.id, shipmentId: row.shipmentId, sequence: Number(row.sequence), mode: row.mode, status: row.status,
    carrierId: row.carrierId ?? null, carrierName: row.carrierName || null, origin: row.origin, destination: row.destination,
    scheduledPickup: row.scheduledPickup || null, scheduledDelivery: row.scheduledDelivery || null,
    price: row.price === null || row.price === undefined ? null : Number(row.price), currency: row.currency || null,
    reference: row.reference || null, details, lastLocation: row.lastLocation || null, eta: row.eta || null,
    lastTrackedAt: row.lastTrackedAt || null, paidAt: row.paidAt || null, createdAt: row.createdAt, updatedAt: row.updatedAt, synthetic: false
  };
}

// The classic load as its one ROAD leg (nothing is stored for it).
function syntheticLeg(row) {
  const details = {};
  for (const [key, column] of [['truckPlate', 'truck_plate'], ['driverName', 'driver_name'], ['driverPhone', 'driver_phone'], ['equipment', 'equipment']]) {
    if (row[column]) details[key] = String(row[column]);
  }
  return {
    id: null, shipmentId: row.id, sequence: 1, mode: 'ROAD', status: legsLib.LEG_STATUS_OF_SHIPMENT[row.status] || 'Planned',
    carrierId: row.carrier_id ?? null, carrierName: row.carrierName || null, origin: row.origin, destination: row.destination,
    scheduledPickup: row.pickup || null, scheduledDelivery: row.delivery || null,
    price: row.rate === null || row.rate === undefined ? null : Number(row.rate), currency: row.currency || null, reference: row.reference || null,
    details, lastLocation: row.last_location || null, eta: row.eta || null, lastTrackedAt: row.last_tracked_at || null, paidAt: row.carrier_paid_at || null,
    createdAt: row.created_at, updatedAt: row.created_at, synthetic: true
  };
}

async function getShipmentLegs(tenantId, shipmentId) {
  assertTenant(tenantId);
  const shipment = await get(
    'SELECT shipments.*, carriers.name AS carrierName FROM shipments LEFT JOIN carriers ON carriers.id = shipments.carrier_id WHERE shipments.id = ? AND shipments.tenant_id = ?',
    [shipmentId, tenantId]
  );
  if (!shipment) return null;
  const base = { shipmentId: shipment.id, status: shipment.status, currency: shipment.currency || null };
  if (shipment.leg_mode !== 'multi') return { ...base, multi: false, legs: [syntheticLeg(shipment)], handovers: [], events: [] };
  const [legs, handovers, events] = await Promise.all([
    all(`${LEG_SELECT} WHERE l.shipment_id = ? AND l.tenant_id = ? ORDER BY l.sequence`, [shipmentId, tenantId]),
    all('SELECT id, from_leg_id AS fromLegId, to_leg_id AS toLegId, location, received_by AS receivedBy, note, created_at AS createdAt FROM leg_handovers WHERE shipment_id = ? AND tenant_id = ? ORDER BY id', [shipmentId, tenantId]),
    all(`SELECT e.id, e.leg_id AS legId, e.from_status AS fromStatus, e.to_status AS toStatus, e.note, e.created_at AS createdAt, users.name AS actor
      FROM leg_events e LEFT JOIN users ON users.id = e.actor_id
      WHERE e.tenant_id = ? AND e.leg_id IN (SELECT id FROM shipment_legs WHERE shipment_id = ?) ORDER BY e.id DESC LIMIT 200`, [tenantId, shipmentId])
  ]);
  return { ...base, multi: true, legs: legs.map(mapLeg), handovers: handovers.map((row) => ({ ...row })), events: events.map((row) => ({ ...row })) };
}

async function getLeg(tenantId, legId) {
  assertTenant(tenantId);
  const row = await get(`${LEG_SELECT} WHERE l.id = ? AND l.tenant_id = ?`, [legId, tenantId]);
  return row ? mapLeg(row) : null;
}

async function recordLegEvent(tx, tenantId, legId, fromStatus, toStatus, note, actorId) {
  await tx.run('INSERT INTO leg_events (tenant_id, leg_id, from_status, to_status, note, actor_id) VALUES (?, ?, ?, ?, ?, ?)',
    [tenantId, legId, fromStatus || null, toStatus, note ? String(note).slice(0, 500) : null, actorId || null]);
}

async function insertLeg(tx, tenantId, shipment, sequence, input, actorId, { status = 'Planned' } = {}) {
  const currency = input.currency || shipment.currency || (await currencyOf(tenantId, tx.get));
  const price = input.price === null || input.price === undefined ? null : roundMoney(input.price, currency);
  if (input.carrierId) {
    if (!(await tx.get('SELECT id FROM carriers WHERE id = ? AND tenant_id = ?', [input.carrierId, tenantId]))) throw httpError(404, 'Carrier not found.');
  }
  const result = await tx.run(
    `INSERT INTO shipment_legs (tenant_id, shipment_id, sequence, mode, status, carrier_id, origin, destination, scheduled_pickup, scheduled_delivery, price, currency, reference, details, last_location, eta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [tenantId, shipment.id, sequence, input.mode, status, input.carrierId || null, input.origin, input.destination, input.scheduledPickup || null,
      input.scheduledDelivery || null, price, currency, input.reference || null, JSON.stringify(input.details || {}), input.lastLocation || null, input.eta || null]
  );
  await recordLegEvent(tx, tenantId, result.id, null, status, `Leg ${sequence} (${input.mode}) added`, actorId);
  return result.id;
}

// The load's own status and price follow its legs: status from the legs, price = the legs' prices when every leg
// that is still going has one in the load's currency (otherwise unknown, so left empty rather than guessed).
async function rollupShipment(tx, tenantId, shipmentId, actorId, note) {
  const shipment = await tx.get('SELECT id, status, currency FROM shipments WHERE id = ? AND tenant_id = ?', [shipmentId, tenantId]);
  const legs = await tx.all('SELECT status, price, currency FROM shipment_legs WHERE shipment_id = ? AND tenant_id = ? ORDER BY sequence', [shipmentId, tenantId]);
  const status = legsLib.rollupStatus(legs.map((leg) => leg.status));
  const live = legs.filter((leg) => leg.status !== 'Cancelled');
  const priced = live.filter((leg) => leg.price !== null && leg.price !== undefined && (leg.currency || shipment.currency) === shipment.currency);
  const rate = live.length && priced.length === live.length ? addMoney(shipment.currency, ...priced.map((leg) => Number(leg.price))) : null;
  await tx.run('UPDATE shipments SET status = ?, rate = ? WHERE id = ?', [status, rate, shipmentId]);
  if (status !== shipment.status) await recordShipmentEvent(shipmentId, shipment.status, status, note, actorId, tx.run);
  return { status, before: shipment.status };
}

// A new load made of several legs.
async function createShipmentWithLegs({ legs, ...fields }) {
  assertTenant(fields.tenantId);
  return withTransaction(async (tx) => {
    const created = await insertShipment(tx, { ...fields, status: 'New' });
    const shipmentId = Number(String(created.id).replace('SHP-', ''));
    await tx.run("UPDATE shipments SET leg_mode = 'multi' WHERE id = ?", [shipmentId]);
    let sequence = 0;
    for (const input of legs) {
      sequence += 1;
      await insertLeg(tx, fields.tenantId, { id: shipmentId, currency: created.currency }, sequence, input, fields.actorId);
    }
    await rollupShipment(tx, fields.tenantId, shipmentId, fields.actorId, 'Legs planned');
    return { ...created, id: `SHP-${shipmentId}`, shipmentId };
  });
}

// Adds a leg at the end. A classic load becomes a multi-leg load (allowed until its truck is booked).
async function addLeg(tenantId, shipmentId, input, actorId) {
  assertTenant(tenantId);
  return withTransaction(async (tx) => {
    const shipment = await tx.get('SELECT shipments.*, carriers.name AS carrierName FROM shipments LEFT JOIN carriers ON carriers.id = shipments.carrier_id WHERE shipments.id = ? AND shipments.tenant_id = ?', [shipmentId, tenantId]);
    if (!shipment) throw httpError(404, 'Shipment not found.');
    if (['Delivered', 'Cancelled'].includes(shipment.status)) throw httpError(409, `A ${shipment.status.toLowerCase()} load cannot get another leg.`);
    if (shipment.trip_id) throw httpError(409, `This load travels on trip T-${shipment.trip_id}; take it off the trip before splitting it into legs.`);
    if (shipment.leg_mode !== 'multi') {
      if (shipment.carrier_id || ['Dispatched', 'In Transit', 'Exception'].includes(shipment.status)) {
        throw httpError(409, 'A load whose truck is already booked cannot be split into legs. Add the legs before booking.');
      }
      const first = syntheticLeg(shipment);
      await insertLeg(tx, tenantId, shipment, 1, {
        mode: 'ROAD', origin: first.origin, destination: first.destination, carrierId: null, price: first.price, currency: first.currency,
        scheduledPickup: first.scheduledPickup, scheduledDelivery: first.scheduledDelivery, reference: first.reference, details: first.details,
        lastLocation: first.lastLocation, eta: first.eta
      }, actorId, { status: first.status });
      await tx.run("UPDATE shipments SET leg_mode = 'multi' WHERE id = ?", [shipmentId]);
    }
    const last = await tx.get('SELECT MAX(sequence) AS sequence FROM shipment_legs WHERE shipment_id = ? AND tenant_id = ?', [shipmentId, tenantId]);
    const sequence = Number(last?.sequence || 0) + 1;
    const id = await insertLeg(tx, tenantId, shipment, sequence, input, actorId);
    await rollupShipment(tx, tenantId, shipmentId, actorId, `Leg ${sequence} (${input.mode}) added`);
    return { id, sequence };
  });
}

const LEG_FIELDS = {
  mode: 'mode', origin: 'origin', destination: 'destination', carrierId: 'carrier_id', price: 'price', currency: 'currency',
  scheduledPickup: 'scheduled_pickup', scheduledDelivery: 'scheduled_delivery', reference: 'reference', eta: 'eta'
};

// Changes a leg that is not finished. The mode can only change while the leg is still planned.
async function updateLeg(tenantId, legId, changes, actorId) {
  assertTenant(tenantId);
  return withTransaction(async (tx) => {
    const leg = await tx.get('SELECT * FROM shipment_legs WHERE id = ? AND tenant_id = ?', [legId, tenantId]);
    if (!leg) throw httpError(404, 'Leg not found.');
    if (!legsLib.OPEN_LEG_STATUSES.includes(leg.status)) throw httpError(409, `A ${leg.status.toLowerCase()} leg can no longer be edited.`);
    if (changes.mode !== undefined && changes.mode !== leg.mode && leg.status !== 'Planned') throw httpError(409, 'The mode can only change while the leg is planned.');
    const shipment = await tx.get('SELECT id, currency FROM shipments WHERE id = ? AND tenant_id = ?', [leg.shipment_id, tenantId]);
    if (changes.carrierId) {
      if (!(await tx.get('SELECT id FROM carriers WHERE id = ? AND tenant_id = ?', [changes.carrierId, tenantId]))) throw httpError(404, 'Carrier not found.');
    }
    const sets = [];
    const params = [];
    const notes = [];
    const currency = changes.currency || leg.currency || shipment.currency;
    for (const [field, column] of Object.entries(LEG_FIELDS)) {
      if (changes[field] === undefined) continue;
      const value = field === 'price' && changes.price !== null ? roundMoney(changes.price, currency) : changes[field];
      if (String(value ?? '') === String(leg[column] ?? '')) continue;
      sets.push(`${column} = ?`);
      params.push(value);
      notes.push(field);
    }
    if (changes.details !== undefined) {
      sets.push('details = ?');
      params.push(JSON.stringify(changes.details));
      notes.push('details');
    }
    if (!sets.length) return { changed: [] };
    sets.push("updated_at = datetime('now')");
    await tx.run(`UPDATE shipment_legs SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`, [...params, legId, tenantId]);
    await recordLegEvent(tx, tenantId, legId, leg.status, leg.status, `Updated: ${notes.join(', ')}`, actorId);
    await rollupShipment(tx, tenantId, leg.shipment_id, actorId, `Leg ${leg.sequence} updated`);
    return { changed: notes };
  });
}

// Moves a leg along (Planned > Booked > In Transit > Delivered). A leg cannot start or finish before the one
// ahead of it is delivered. Delivering a leg records the handover to the next one.
async function setLegStatus(tenantId, legId, status, { note = null, handover = null } = {}, actorId) {
  assertTenant(tenantId);
  return withTransaction(async (tx) => {
    const leg = await tx.get('SELECT * FROM shipment_legs WHERE id = ? AND tenant_id = ?', [legId, tenantId]);
    if (!leg) throw httpError(404, 'Leg not found.');
    if (!(legsLib.LEG_TRANSITIONS[leg.status] || []).includes(status)) throw httpError(409, `Cannot move a leg from ${leg.status} to ${status}.`);
    const legs = await tx.all('SELECT id, sequence, mode, status FROM shipment_legs WHERE shipment_id = ? AND tenant_id = ? ORDER BY sequence', [leg.shipment_id, tenantId]);
    const blocked = legsLib.blockedByEarlierLeg(legs, leg, status);
    if (blocked) throw httpError(409, blocked);
    if (status === 'Booked' && !leg.carrier_id && !leg.reference) throw httpError(409, 'Add a carrier or a booking reference before booking this leg.');
    const updated = await tx.run("UPDATE shipment_legs SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = ?", [status, legId, leg.status]);
    if (updated.changes !== 1) throw httpError(409, 'The leg changed before the update could be applied.');
    await recordLegEvent(tx, tenantId, legId, leg.status, status, note, actorId);
    let handoverTo = null;
    if (status === 'Delivered') {
      const next = legs.find((other) => other.sequence > leg.sequence && other.status !== 'Cancelled');
      if (next) {
        handoverTo = next.id;
        await tx.run(
          'INSERT INTO leg_handovers (tenant_id, shipment_id, from_leg_id, to_leg_id, location, received_by, note, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [tenantId, leg.shipment_id, legId, next.id, handover?.location || leg.destination, handover?.receivedBy || null, handover?.note || null, actorId || null]
        );
      }
    }
    const rolled = await rollupShipment(tx, tenantId, leg.shipment_id, actorId, `Leg ${leg.sequence} (${leg.mode}): ${status}`);
    return { id: legId, shipmentId: leg.shipment_id, status, shipmentStatus: rolled.status, shipmentStatusBefore: rolled.before, handoverTo };
  });
}

// A position or ETA for one leg (kept on the leg and on the load so lists can show it).
async function addLegTracking(tenantId, legId, { location, eta, note }, actorId) {
  assertTenant(tenantId);
  return withTransaction(async (tx) => {
    const leg = await tx.get('SELECT id, shipment_id, sequence, status FROM shipment_legs WHERE id = ? AND tenant_id = ?', [legId, tenantId]);
    if (!leg) throw httpError(404, 'Leg not found.');
    if (!legsLib.TRACKABLE_LEG_STATUSES.includes(leg.status)) throw httpError(409, `Location updates are only possible while a leg is ${legsLib.TRACKABLE_LEG_STATUSES.join(', ')}.`);
    const result = await tx.run(
      "INSERT INTO tracking_updates (shipment_id, leg_id, actor_id, location, eta, note, source) VALUES (?, ?, ?, ?, ?, ?, 'manual')",
      [leg.shipment_id, legId, actorId || null, location, eta || null, note || null]
    );
    const created = await tx.get('SELECT created_at FROM tracking_updates WHERE id = ?', [result.id]);
    await tx.run('UPDATE shipment_legs SET last_location = ?, eta = COALESCE(?, eta), last_tracked_at = ? WHERE id = ?', [location, eta || null, created.created_at, legId]);
    await tx.run('UPDATE shipments SET last_location = ?, eta = COALESCE(?, eta), last_tracked_at = ? WHERE id = ?', [location, eta || null, created.created_at, leg.shipment_id]);
    return { id: result.id, legId, shipmentId: leg.shipment_id, location, eta: eta || null, note: note || null, source: 'manual', createdAt: created.created_at };
  });
}

// A delivered leg is paid to its carrier (or the payment is undone). The load's own "carrier paid" stamp follows:
// set when every leg that has a price is paid.
async function setLegPayment(tenantId, legId, paid, actorId) {
  assertTenant(tenantId);
  return withTransaction(async (tx) => {
    const leg = await tx.get('SELECT id, shipment_id, sequence, mode, status, price, paid_at FROM shipment_legs WHERE id = ? AND tenant_id = ?', [legId, tenantId]);
    if (!leg) throw httpError(404, 'Leg not found.');
    if (leg.status !== 'Delivered') throw httpError(409, 'A leg can be marked paid once it is delivered.');
    if (leg.price === null || leg.price === undefined) throw httpError(409, 'Enter the price of this leg first.');
    if (Boolean(leg.paid_at) === paid) return { id: legId, shipmentId: leg.shipment_id, paid, changed: false };
    await tx.run(`UPDATE shipment_legs SET paid_at = ${paid ? "datetime('now')" : 'NULL'}, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?`, [legId, tenantId]);
    await recordLegEvent(tx, tenantId, legId, leg.status, leg.status, paid ? 'Paid to the carrier' : 'Payment undone', actorId);
    const open = await tx.get(
      "SELECT COUNT(*) AS total FROM shipment_legs WHERE shipment_id = ? AND tenant_id = ? AND status <> 'Cancelled' AND price IS NOT NULL AND paid_at IS NULL",
      [leg.shipment_id, tenantId]
    );
    await tx.run(`UPDATE shipments SET carrier_paid_at = ${Number(open.total) === 0 ? "COALESCE(carrier_paid_at, datetime('now'))" : 'NULL'} WHERE id = ? AND tenant_id = ?`, [leg.shipment_id, tenantId]);
    return { id: legId, shipmentId: leg.shipment_id, paid, changed: true };
  });
}

// What NEXUS needs to react to a leg: the leg, its load and the carrier's phone.
async function getLegContext(tenantId, legId) {
  assertTenant(tenantId);
  const leg = await getLeg(tenantId, legId);
  if (!leg) return null;
  const shipment = await getShipment(tenantId, leg.shipmentId);
  if (!shipment) return null;
  const carrier = leg.carrierId ? await get('SELECT phone FROM carriers WHERE id = ? AND tenant_id = ?', [leg.carrierId, tenantId]) : null;
  return { leg, shipment, carrierPhone: carrier?.phone || null };
}

async function countLegExceptions(tenantId, legId) {
  const row = await get("SELECT COUNT(*) AS total FROM leg_events WHERE tenant_id = ? AND leg_id = ? AND to_status = 'Exception'", [assertTenant(tenantId), legId]);
  return Number(row?.total) || 0;
}

// The next leg of a load after this one (cancelled ones skipped), if any.
async function getNextLeg(tenantId, legId) {
  assertTenant(tenantId);
  const leg = await get('SELECT shipment_id, sequence FROM shipment_legs WHERE id = ? AND tenant_id = ?', [legId, tenantId]);
  if (!leg) return null;
  const next = await get(`${LEG_SELECT} WHERE l.shipment_id = ? AND l.tenant_id = ? AND l.sequence > ? AND l.status <> 'Cancelled' ORDER BY l.sequence LIMIT 1`, [leg.shipment_id, tenantId, leg.sequence]);
  return next ? mapLeg(next) : null;
}

// System job (NEXUS sweeper): legs on the way with no position for staleHours.
async function listStaleLegsAllTenants(staleHours) {
  return all(
    `SELECT l.id, l.tenant_id AS tenantId, l.shipment_id AS shipmentId, l.last_tracked_at AS lastTrackedAt
     FROM shipment_legs l JOIN shipments s ON s.id = l.shipment_id
     WHERE l.status = 'In Transit' AND s.status NOT IN ('Delivered', 'Cancelled') AND COALESCE(l.last_tracked_at, l.updated_at) < datetime('now', ?)`,
    [`-${Number(staleHours)} hours`]
  );
}

// Files a document under one leg of its own load (or back under the load, with legId null).
async function setDocumentLeg(tenantId, documentId, legId) {
  assertTenant(tenantId);
  return withTransaction(async (tx) => {
    const document = await tx.get('SELECT id, shipment_id FROM documents WHERE id = ? AND tenant_id = ?', [documentId, tenantId]);
    if (!document) throw httpError(404, 'Document not found.');
    if (legId !== null) {
      const leg = await tx.get('SELECT id FROM shipment_legs WHERE id = ? AND tenant_id = ? AND shipment_id = ?', [legId, tenantId, document.shipment_id]);
      if (!leg) throw httpError(404, "That leg does not belong to the document's load.");
    }
    await tx.run('UPDATE documents SET leg_id = ? WHERE id = ? AND tenant_id = ?', [legId, documentId, tenantId]);
    return { id: documentId, legId };
  });
}

async function listLegDocuments(tenantId, legId) {
  assertTenant(tenantId);
  return all(
    'SELECT id, shipment_id AS shipmentId, doc_type AS docType, filename, mime, size, created_at AS createdAt FROM documents WHERE tenant_id = ? AND leg_id = ? ORDER BY id',
    [tenantId, legId]
  );
}

/* ---------- trips: one truck run carrying several shipments (lib/trips.js has the rules) ---------- */
// A trip is booked with one carrier for one price; the shipments on it are ordinary loads (customers, documents,
// invoices, tracking pages) whose carrier, truck and status come from the trip and whose carrier cost is their
// weight's share of the truck's price. While a load is on a trip its status moves with the trip, not by hand.
const TRIP_SELECT = `SELECT t.id, t.status, t.carrier_id AS carrierId, carriers.name AS carrierName, carriers.phone AS carrierPhone,
    t.origin, t.destination, t.scheduled_pickup AS scheduledPickup, t.scheduled_delivery AS scheduledDelivery,
    t.capacity_weight_kg AS capacityWeightKg, t.capacity_pallets AS capacityPallets, t.cost, t.currency,
    t.truck_plate AS truckPlate, t.driver_name AS driverName, t.driver_phone AS driverPhone, t.notes,
    t.last_location AS lastLocation, t.eta, t.last_tracked_at AS lastTrackedAt, t.created_at AS createdAt, t.updated_at AS updatedAt
  FROM trips t LEFT JOIN carriers ON carriers.id = t.carrier_id`;
const TRIP_BOOKED = ['Booked', 'In Transit', 'Exception'];

function mapTrip(row) {
  return {
    id: row.id, number: `T-${row.id}`, status: row.status, carrierId: row.carrierId ?? null, carrierName: row.carrierName || null,
    carrierPhone: row.carrierPhone || null, origin: row.origin, destination: row.destination,
    scheduledPickup: row.scheduledPickup || null, scheduledDelivery: row.scheduledDelivery || null,
    capacityWeightKg: row.capacityWeightKg === null || row.capacityWeightKg === undefined ? null : Number(row.capacityWeightKg),
    capacityPallets: row.capacityPallets === null || row.capacityPallets === undefined ? null : Number(row.capacityPallets),
    cost: row.cost === null || row.cost === undefined ? null : Number(row.cost), currency: row.currency || null,
    truckPlate: row.truckPlate || null, driverName: row.driverName || null, driverPhone: row.driverPhone || null, notes: row.notes || null,
    lastLocation: row.lastLocation || null, eta: row.eta || null, lastTrackedAt: row.lastTrackedAt || null, createdAt: row.createdAt, updatedAt: row.updatedAt
  };
}

const ALLOCATION_SELECT = `SELECT ts.id, ts.shipment_id AS shipmentId, ts.weight_kg AS weightKg, ts.pallets, ts.pickup_seq AS pickupSeq, ts.drop_seq AS dropSeq,
    ts.cost_share AS costShare, ts.delivered_at AS deliveredAt, s.customer, s.origin, s.destination, s.status, s.weight,
    s.customer_rate AS customerRate, s.currency AS shipmentCurrency
  FROM trip_shipments ts JOIN shipments s ON s.id = ts.shipment_id`;

function mapAllocation(row) {
  return {
    shipmentId: `SHP-${row.shipmentId}`, weightKg: Number(row.weightKg), pallets: Number(row.pallets), pickupSeq: row.pickupSeq ?? null, dropSeq: row.dropSeq ?? null,
    costShare: row.costShare === null || row.costShare === undefined ? null : Number(row.costShare), deliveredAt: row.deliveredAt || null,
    customer: row.customer, origin: row.origin, destination: row.destination, status: row.status, weight: row.weight,
    customerRate: row.customerRate === null || row.customerRate === undefined ? null : Number(row.customerRate), currency: row.shipmentCurrency || null
  };
}

async function recordTripEvent(tx, tenantId, tripId, fromStatus, toStatus, note, actorId) {
  await tx.run('INSERT INTO trip_events (tenant_id, trip_id, from_status, to_status, note, actor_id) VALUES (?, ?, ?, ?, ?, ?)',
    [tenantId, tripId, fromStatus || null, toStatus, note ? String(note).slice(0, 500) : null, actorId || null]);
}

const activeAllocations = (tx, tenantId, tripId) => tx.all(
  `${ALLOCATION_SELECT} WHERE ts.trip_id = ? AND ts.tenant_id = ? AND ts.released_at IS NULL ORDER BY COALESCE(ts.pickup_seq, 9999), ts.id`, [tripId, tenantId]
);

async function loadTrip(tx, tenantId, tripId) {
  const trip = await tx.get('SELECT * FROM trips WHERE id = ? AND tenant_id = ?', [tripId, tenantId]);
  if (!trip) throw httpError(404, 'Trip not found.');
  return trip;
}

// The truck's price is shared among the loads on it by weight (to the minor unit; the shares add up to the price).
// Once the trip is booked each load's carrier cost is its share.
async function recomputeTripShares(tx, tenantId, trip) {
  const allocations = await tx.all('SELECT id, shipment_id, weight_kg FROM trip_shipments WHERE trip_id = ? AND tenant_id = ? AND released_at IS NULL ORDER BY id', [trip.id, tenantId]);
  if (!allocations.length) return;
  const priced = trip.cost !== null && trip.cost !== undefined;
  const shares = priced ? tripsLib.splitMoney(Number(trip.cost), trip.currency, allocations.map((row) => Number(row.weight_kg))) : allocations.map(() => null);
  for (const [index, row] of allocations.entries()) {
    await tx.run('UPDATE trip_shipments SET cost_share = ? WHERE id = ?', [shares[index], row.id]);
    if (TRIP_BOOKED.includes(trip.status)) await tx.run('UPDATE shipments SET rate = ?, currency = ? WHERE id = ? AND tenant_id = ?', [shares[index], trip.currency, row.shipment_id, tenantId]);
  }
}

// Puts one load on the trip's truck: carrier, driver, plate, its cost share and the Dispatched status.
async function bookShipmentOnTrip(tx, tenantId, trip, carrierName, shipmentId, actorId) {
  const share = await tx.get('SELECT cost_share FROM trip_shipments WHERE trip_id = ? AND shipment_id = ? AND released_at IS NULL', [trip.id, shipmentId]);
  const before = await tx.get('SELECT status FROM shipments WHERE id = ? AND tenant_id = ?', [shipmentId, tenantId]);
  const result = await tx.run(
    `UPDATE shipments SET carrier_id = ?, status = 'Dispatched', driver_name = ?, driver_phone = ?, truck_plate = ?, rate = ?, currency = ?, trip_id = ?
     WHERE id = ? AND tenant_id = ? AND status IN ('New', 'Sourcing', 'Pending Approval')`,
    [trip.carrier_id, trip.driver_name || null, trip.driver_phone || null, trip.truck_plate || null, share?.cost_share ?? null, trip.currency, trip.id, shipmentId, tenantId]
  );
  if (result.changes !== 1) throw httpError(409, `SHP-${shipmentId} is no longer waiting for a truck.`);
  await recordShipmentEvent(shipmentId, before.status, 'Dispatched', `Booked on trip T-${trip.id} with ${carrierName}${share?.cost_share !== null && share?.cost_share !== undefined ? ` (cost share ${Number(share.cost_share).toFixed(2)} ${trip.currency || ''})` : ''}`.trim(), actorId, tx.run);
}

// Gives the load back: it waits for a truck again (Sourcing), without carrier, truck or trip.
async function unbookShipment(tx, tenantId, tripId, shipmentId, actorId, note) {
  const before = await tx.get('SELECT status FROM shipments WHERE id = ? AND tenant_id = ?', [shipmentId, tenantId]);
  const result = await tx.run(
    `UPDATE shipments SET carrier_id = NULL, rate = NULL, driver_name = NULL, driver_phone = NULL, truck_plate = NULL, status = 'Sourcing', trip_id = NULL
     WHERE id = ? AND tenant_id = ? AND status IN ('Dispatched', 'New', 'Sourcing', 'Pending Approval')`, [shipmentId, tenantId]
  );
  if (result.changes !== 1) throw httpError(409, `SHP-${shipmentId} is already on the road and cannot be taken off the trip.`);
  if (before.status !== 'Sourcing') await recordShipmentEvent(shipmentId, before.status, 'Sourcing', note, actorId, tx.run);
}

async function releaseTripCarrier(tx, trip) {
  if (trip.carrier_id) await tx.run("UPDATE carriers SET status = 'Available' WHERE id = ? AND status = 'Busy'", [trip.carrier_id]);
}

async function createTrip(tenantId, input, actorId) {
  assertTenant(tenantId);
  return withTransaction(async (tx) => {
    const currency = input.currency || (await currencyOf(tenantId, tx.get));
    const cost = input.cost === null || input.cost === undefined ? null : roundMoney(input.cost, currency);
    if (input.carrierId && !(await tx.get('SELECT id FROM carriers WHERE id = ? AND tenant_id = ?', [input.carrierId, tenantId]))) throw httpError(404, 'Carrier not found.');
    const result = await tx.run(
      `INSERT INTO trips (tenant_id, carrier_id, origin, destination, scheduled_pickup, scheduled_delivery, capacity_weight_kg, capacity_pallets, cost, currency, truck_plate, driver_name, driver_phone, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tenantId, input.carrierId || null, input.origin, input.destination, input.scheduledPickup || null, input.scheduledDelivery || null,
        input.capacityWeightKg ?? null, input.capacityPallets ?? null, cost, currency, input.truckPlate || null, input.driverName || null, input.driverPhone || null, input.notes || null]
    );
    await recordTripEvent(tx, tenantId, result.id, null, 'Planned', 'Trip created', actorId);
    return result.id;
  });
}

async function getTrip(tenantId, tripId) {
  assertTenant(tenantId);
  const row = await get(`${TRIP_SELECT} WHERE t.id = ? AND t.tenant_id = ?`, [tripId, tenantId]);
  if (!row) return null;
  const trip = mapTrip(row);
  const [allocations, events] = await Promise.all([
    all(`${ALLOCATION_SELECT} WHERE ts.trip_id = ? AND ts.tenant_id = ? AND ts.released_at IS NULL ORDER BY COALESCE(ts.pickup_seq, 9999), ts.id`, [tripId, tenantId]),
    all('SELECT e.id, e.from_status AS fromStatus, e.to_status AS toStatus, e.note, e.created_at AS createdAt, users.name AS actor FROM trip_events e LEFT JOIN users ON users.id = e.actor_id WHERE e.tenant_id = ? AND e.trip_id = ? ORDER BY e.id DESC LIMIT 100', [tenantId, tripId])
  ]);
  const shipments = allocations.map(mapAllocation);
  const weight = shipments.reduce((sum, item) => sum + item.weightKg, 0);
  const pallets = shipments.reduce((sum, item) => sum + item.pallets, 0);
  const sameCurrency = shipments.every((item) => item.customerRate !== null && (item.currency || trip.currency) === trip.currency);
  const revenue = shipments.length && sameCurrency ? addMoney(trip.currency, ...shipments.map((item) => item.customerRate)) : null;
  trip.totals = {
    shipments: shipments.length, weightKg: Math.round(weight * 1000) / 1000, pallets,
    weightUtilization: trip.capacityWeightKg ? Math.round((weight / trip.capacityWeightKg) * 1000) / 1000 : null,
    palletUtilization: trip.capacityPallets ? Math.round((pallets / trip.capacityPallets) * 1000) / 1000 : null,
    revenue, margin: revenue !== null && trip.cost !== null ? addMoney(trip.currency, revenue, -trip.cost) : null
  };
  return { trip, shipments, events: events.map((event) => ({ ...event })) };
}

async function listTrips(tenantId, { status = null, limit = 50 } = {}) {
  assertTenant(tenantId);
  const rows = await all(
    `${TRIP_SELECT.replace('FROM trips t', ", (SELECT COUNT(*) FROM trip_shipments ts WHERE ts.trip_id = t.id AND ts.released_at IS NULL) AS shipmentCount, (SELECT COALESCE(SUM(ts.weight_kg), 0) FROM trip_shipments ts WHERE ts.trip_id = t.id AND ts.released_at IS NULL) AS weightKg FROM trips t")}
     WHERE t.tenant_id = ? ${status ? 'AND t.status = ?' : ''} ORDER BY t.id DESC LIMIT ?`,
    status ? [tenantId, status, limit] : [tenantId, limit]
  );
  return rows.map((row) => ({ ...mapTrip(row), shipmentCount: Number(row.shipmentCount) || 0, allocatedWeightKg: Number(row.weightKg) || 0 }));
}

const TRIP_FIELDS = {
  carrierId: 'carrier_id', origin: 'origin', destination: 'destination', scheduledPickup: 'scheduled_pickup', scheduledDelivery: 'scheduled_delivery',
  capacityWeightKg: 'capacity_weight_kg', capacityPallets: 'capacity_pallets', cost: 'cost', currency: 'currency', truckPlate: 'truck_plate',
  driverName: 'driver_name', driverPhone: 'driver_phone', notes: 'notes'
};

async function updateTrip(tenantId, tripId, changes, actorId) {
  assertTenant(tenantId);
  return withTransaction(async (tx) => {
    const trip = await loadTrip(tx, tenantId, tripId);
    if (!tripsLib.EDITABLE_TRIP_STATUSES.includes(trip.status)) throw httpError(409, `A trip that is ${trip.status.toLowerCase()} can no longer be edited.`);
    if (trip.status === 'Booked' && changes.carrierId !== undefined && changes.carrierId !== trip.carrier_id) throw httpError(409, 'The carrier of a booked trip cannot change. Take it back to planned first.');
    if (trip.status === 'Booked' && changes.currency !== undefined && changes.currency !== trip.currency) throw httpError(409, "The currency of a booked trip cannot change.");
    if (changes.carrierId && !(await tx.get('SELECT id FROM carriers WHERE id = ? AND tenant_id = ?', [changes.carrierId, tenantId]))) throw httpError(404, 'Carrier not found.');
    const used = await tx.get('SELECT COALESCE(SUM(weight_kg), 0) AS weight, COALESCE(SUM(pallets), 0) AS pallets FROM trip_shipments WHERE trip_id = ? AND tenant_id = ? AND released_at IS NULL', [tripId, tenantId]);
    if (changes.capacityWeightKg && Number(used.weight) > changes.capacityWeightKg + 0.0005) throw httpError(409, `The shipments on this trip weigh ${Number(used.weight)} kg, more than ${changes.capacityWeightKg} kg.`);
    if (changes.capacityPallets && Number(used.pallets) > changes.capacityPallets) throw httpError(409, `The shipments on this trip need ${Number(used.pallets)} pallet places, more than ${changes.capacityPallets}.`);
    const currency = changes.currency || trip.currency;
    const sets = [];
    const params = [];
    const notes = [];
    for (const [field, column] of Object.entries(TRIP_FIELDS)) {
      if (changes[field] === undefined) continue;
      const value = field === 'cost' && changes.cost !== null ? roundMoney(changes.cost, currency) : changes[field];
      if (String(value ?? '') === String(trip[column] ?? '')) continue;
      sets.push(`${column} = ?`);
      params.push(value);
      notes.push(field);
    }
    if (!sets.length) return { changed: [], shipmentIds: [] };
    sets.push("updated_at = datetime('now')");
    await tx.run(`UPDATE trips SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`, [...params, tripId, tenantId]);
    const updated = await loadTrip(tx, tenantId, tripId);
    if (notes.includes('cost') || notes.includes('currency')) await recomputeTripShares(tx, tenantId, updated);
    // The truck's details follow onto the loads once it is booked.
    if (TRIP_BOOKED.includes(updated.status) && notes.some((field) => ['truckPlate', 'driverName', 'driverPhone'].includes(field))) {
      await tx.run('UPDATE shipments SET truck_plate = ?, driver_name = ?, driver_phone = ? WHERE trip_id = ? AND tenant_id = ?', [updated.truck_plate, updated.driver_name, updated.driver_phone, tripId, tenantId]);
    }
    await recordTripEvent(tx, tenantId, tripId, trip.status, trip.status, `Updated: ${notes.join(', ')}`, actorId);
    const shipmentIds = (await tx.all('SELECT shipment_id FROM trip_shipments WHERE trip_id = ? AND tenant_id = ? AND released_at IS NULL', [tripId, tenantId])).map((row) => row.shipment_id);
    return { changed: notes, shipmentIds };
  });
}

// Puts a load on a trip. It must not be booked yet, must fit the truck and (once the trip is booked) is booked with it.
async function allocateShipment(tenantId, tripId, input, actorId) {
  assertTenant(tenantId);
  return withTransaction(async (tx) => {
    const trip = await loadTrip(tx, tenantId, tripId);
    if (!tripsLib.EDITABLE_TRIP_STATUSES.includes(trip.status)) throw httpError(409, 'Loads can only be added while the trip is planned or booked.');
    const shipment = await tx.get('SELECT id, status, weight, leg_mode, trip_id, carrier_id, customer_rate, currency FROM shipments WHERE id = ? AND tenant_id = ?', [input.shipmentId, tenantId]);
    if (!shipment) throw httpError(404, 'Shipment not found.');
    if (shipment.leg_mode === 'multi') throw httpError(409, 'A load with several legs cannot go on a trip.');
    if (shipment.trip_id) throw httpError(409, `SHP-${shipment.id} is already on trip T-${shipment.trip_id}.`);
    if (!tripsLib.ALLOCATABLE_SHIPMENT_STATUSES.includes(shipment.status) || shipment.carrier_id) throw httpError(409, `SHP-${shipment.id} already has a truck or is finished. Only loads still waiting for a truck can go on a trip.`);
    if (shipment.customer_rate !== null && shipment.customer_rate !== undefined && shipment.currency && trip.currency && shipment.currency !== trip.currency) {
      throw httpError(409, `SHP-${shipment.id} is priced in ${shipment.currency} and this trip in ${trip.currency}.`);
    }
    const weightKg = input.weightKg ?? tripsLib.weightToKg(shipment.weight);
    if (weightKg === null || weightKg === undefined) throw httpError(400, 'The weight of the load could not be read. Give weightKg.');
    const pallets = input.pallets ?? 0;
    const used = await tx.get('SELECT COALESCE(SUM(weight_kg), 0) AS weight, COALESCE(SUM(pallets), 0) AS pallets FROM trip_shipments WHERE trip_id = ? AND tenant_id = ? AND released_at IS NULL', [tripId, tenantId]);
    if (trip.capacity_weight_kg && Number(used.weight) + weightKg > Number(trip.capacity_weight_kg) + 0.0005) {
      throw httpError(409, `It does not fit: the truck takes ${Number(trip.capacity_weight_kg)} kg, ${Number(used.weight)} kg are on it and this load is ${weightKg} kg.`);
    }
    if (trip.capacity_pallets && Number(used.pallets) + pallets > Number(trip.capacity_pallets)) {
      throw httpError(409, `It does not fit: the truck has ${Number(trip.capacity_pallets)} pallet places, ${Number(used.pallets)} are used and this load needs ${pallets}.`);
    }
    const next = await tx.get('SELECT COALESCE(MAX(pickup_seq), 0) AS pickup, COALESCE(MAX(drop_seq), 0) AS drop_seq FROM trip_shipments WHERE trip_id = ? AND tenant_id = ? AND released_at IS NULL', [tripId, tenantId]);
    await tx.run(
      'INSERT INTO trip_shipments (tenant_id, trip_id, shipment_id, weight_kg, pallets, pickup_seq, drop_seq) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [tenantId, tripId, shipment.id, weightKg, pallets, input.pickupSeq ?? Number(next.pickup) + 1, input.dropSeq ?? Number(next.drop_seq) + 1]
    );
    await tx.run('UPDATE shipments SET trip_id = ? WHERE id = ? AND tenant_id = ?', [tripId, shipment.id, tenantId]);
    await recomputeTripShares(tx, tenantId, trip);
    if (trip.status === 'Booked') {
      const carrier = await tx.get('SELECT name FROM carriers WHERE id = ?', [trip.carrier_id]);
      await bookShipmentOnTrip(tx, tenantId, trip, carrier?.name || 'the carrier', shipment.id, actorId);
    }
    await recordTripEvent(tx, tenantId, tripId, trip.status, trip.status, `SHP-${shipment.id} added (${weightKg} kg)`, actorId);
    return { shipmentId: shipment.id, weightKg };
  });
}

// Takes a load off a planned or booked trip; it waits for a truck again.
async function releaseShipment(tenantId, tripId, shipmentId, actorId) {
  assertTenant(tenantId);
  return withTransaction(async (tx) => {
    const trip = await loadTrip(tx, tenantId, tripId);
    if (!tripsLib.EDITABLE_TRIP_STATUSES.includes(trip.status)) throw httpError(409, 'Loads can only be taken off while the trip is planned or booked.');
    const allocation = await tx.get('SELECT id FROM trip_shipments WHERE trip_id = ? AND shipment_id = ? AND tenant_id = ? AND released_at IS NULL', [tripId, shipmentId, tenantId]);
    if (!allocation) throw httpError(404, 'That load is not on this trip.');
    await tx.run("UPDATE trip_shipments SET released_at = datetime('now'), cost_share = NULL WHERE id = ?", [allocation.id]);
    await unbookShipment(tx, tenantId, tripId, shipmentId, actorId, `Taken off trip T-${tripId}`);
    await recomputeTripShares(tx, tenantId, trip);
    await recordTripEvent(tx, tenantId, tripId, trip.status, trip.status, `SHP-${shipmentId} taken off`, actorId);
    return { shipmentId };
  });
}

// Planned > Booked > In Transit > (each load delivered) > Delivered; Exception and back; cancel or un-book before it leaves.
async function setTripStatus(tenantId, tripId, status, { note = null } = {}, actorId) {
  assertTenant(tenantId);
  return withTransaction(async (tx) => {
    const trip = await loadTrip(tx, tenantId, tripId);
    if (status === 'Delivered') {
      const open = await tx.get("SELECT COUNT(*) AS total FROM trip_shipments WHERE trip_id = ? AND tenant_id = ? AND released_at IS NULL AND delivered_at IS NULL", [tripId, tenantId]);
      if (trip.status !== 'In Transit' || Number(open.total) > 0) throw httpError(409, 'A trip is delivered when every load on it is delivered. Deliver the loads one by one.');
    } else if (!(tripsLib.TRIP_TRANSITIONS[trip.status] || []).includes(status)) {
      throw httpError(409, `Cannot move a trip from ${trip.status} to ${status}.`);
    }
    const allocations = await tx.all('SELECT shipment_id, delivered_at FROM trip_shipments WHERE trip_id = ? AND tenant_id = ? AND released_at IS NULL ORDER BY id', [tripId, tenantId]);
    const moved = [];
    const carrier = trip.carrier_id ? await tx.get('SELECT id, name, status FROM carriers WHERE id = ? AND tenant_id = ?', [trip.carrier_id, tenantId]) : null;

    if (status === 'Booked') {
      if (!carrier) throw httpError(409, 'Choose the carrier before booking the trip.');
      if (!allocations.length) throw httpError(409, 'Put at least one load on the trip before booking it.');
      if (carrier.status !== 'Available') throw httpError(409, 'The carrier is not available.');
      const claimed = await tx.run("UPDATE carriers SET status = 'Busy' WHERE id = ? AND status = 'Available'", [carrier.id]);
      if (claimed.changes !== 1) throw httpError(409, 'The carrier is no longer available.');
      await recomputeTripShares(tx, tenantId, { ...trip, status: 'Booked' });
      for (const row of allocations) {
        await bookShipmentOnTrip(tx, tenantId, trip, carrier.name, row.shipment_id, actorId);
        moved.push({ shipmentId: row.shipment_id, status: 'Dispatched' });
      }
    } else if (status === 'Planned' || status === 'Cancelled') {
      if (trip.status === 'Booked') {
        // The loads wait for a truck again and the carrier is free.
        for (const row of allocations) {
          await unbookShipment(tx, tenantId, tripId, row.shipment_id, actorId, status === 'Planned' ? `Trip T-${tripId} taken back to planned` : `Trip T-${tripId} cancelled`);
          moved.push({ shipmentId: row.shipment_id, status: 'Sourcing' });
        }
        await releaseTripCarrier(tx, trip);
      }
      if (status === 'Planned') {
        // The loads stay on the planned trip.
        await tx.run('UPDATE shipments SET trip_id = ? WHERE id IN (SELECT shipment_id FROM trip_shipments WHERE trip_id = ? AND tenant_id = ? AND released_at IS NULL) AND tenant_id = ?', [tripId, tripId, tenantId, tenantId]);
      } else {
        await tx.run("UPDATE trip_shipments SET released_at = datetime('now'), cost_share = NULL WHERE trip_id = ? AND tenant_id = ? AND released_at IS NULL", [tripId, tenantId]);
        await tx.run('UPDATE shipments SET trip_id = NULL WHERE trip_id = ? AND tenant_id = ?', [tripId, tenantId]);
      }
    } else if (status === 'In Transit' || status === 'Exception') {
      if (status === 'In Transit' && trip.status === 'Booked' && !allocations.length) throw httpError(409, 'The trip has no loads.');
      const from = status === 'In Transit' ? (trip.status === 'Booked' ? 'Dispatched' : 'Exception') : 'In Transit';
      for (const row of allocations) {
        if (row.delivered_at) continue;
        const result = await tx.run('UPDATE shipments SET status = ? WHERE id = ? AND tenant_id = ? AND status = ?', [status, row.shipment_id, tenantId, from]);
        if (result.changes === 1) {
          await recordShipmentEvent(row.shipment_id, from, status, note || `Trip T-${tripId}: ${status}`, actorId, tx.run);
          moved.push({ shipmentId: row.shipment_id, status });
        }
      }
    }
    await tx.run("UPDATE trips SET status = ?, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?", [status, tripId, tenantId]);
    await recordTripEvent(tx, tenantId, tripId, trip.status, status, note, actorId);
    return { id: tripId, status, moved };
  });
}

// One load of the trip is delivered. When the last one is, the trip is delivered and its carrier is free again.
async function deliverTripShipment(tenantId, tripId, shipmentId, { note = null } = {}, actorId) {
  assertTenant(tenantId);
  return withTransaction(async (tx) => {
    const trip = await loadTrip(tx, tenantId, tripId);
    if (trip.status !== 'In Transit') throw httpError(409, 'Loads are delivered while the trip is in transit.');
    const allocation = await tx.get('SELECT id, delivered_at FROM trip_shipments WHERE trip_id = ? AND shipment_id = ? AND tenant_id = ? AND released_at IS NULL', [tripId, shipmentId, tenantId]);
    if (!allocation) throw httpError(404, 'That load is not on this trip.');
    if (allocation.delivered_at) throw httpError(409, 'That load is already delivered.');
    const result = await tx.run("UPDATE shipments SET status = 'Delivered' WHERE id = ? AND tenant_id = ? AND status = 'In Transit'", [shipmentId, tenantId]);
    if (result.changes !== 1) throw httpError(409, 'That load is not in transit.');
    await tx.run("UPDATE trip_shipments SET delivered_at = datetime('now') WHERE id = ?", [allocation.id]);
    await recordShipmentEvent(shipmentId, 'In Transit', 'Delivered', note || `Delivered from trip T-${tripId}`, actorId, tx.run);
    const open = await tx.get('SELECT COUNT(*) AS total FROM trip_shipments WHERE trip_id = ? AND tenant_id = ? AND released_at IS NULL AND delivered_at IS NULL', [tripId, tenantId]);
    let tripStatus = trip.status;
    if (Number(open.total) === 0) {
      tripStatus = 'Delivered';
      await tx.run("UPDATE trips SET status = 'Delivered', updated_at = datetime('now') WHERE id = ?", [tripId]);
      await releaseTripCarrier(tx, trip);
      await recordTripEvent(tx, tenantId, tripId, 'In Transit', 'Delivered', 'Every load delivered', actorId);
    } else {
      await recordTripEvent(tx, tenantId, tripId, 'In Transit', 'In Transit', `SHP-${shipmentId} delivered`, actorId);
    }
    return { shipmentId, tripStatus };
  });
}

// Loads still waiting for a truck that could be pooled on one (tenantId null = every company, for the NEXUS sweep).
async function listPoolableLoads(tenantId = null) {
  const scoped = tenantId !== null;
  if (scoped) assertTenant(tenantId);
  const rows = await all(
    `SELECT id, tenant_id AS tenantId, customer, origin, destination, pickup, delivery, weight FROM shipments
     WHERE status IN ('New', 'Sourcing', 'Pending Approval') AND carrier_id IS NULL AND trip_id IS NULL AND leg_mode <> 'multi' ${scoped ? 'AND tenant_id = ?' : ''}
     ORDER BY id LIMIT 5000`,
    scoped ? [tenantId] : []
  );
  return rows.map((row) => ({ id: row.id, tenantId: row.tenantId, customer: row.customer, origin: row.origin, destination: row.destination, pickup: row.pickup, delivery: row.delivery, weightKg: tripsLib.weightToKg(row.weight) }))
    .filter((load) => load.weightKg !== null);
}

async function countTripExceptions(tenantId, tripId) {
  const row = await get("SELECT COUNT(*) AS total FROM trip_events WHERE tenant_id = ? AND trip_id = ? AND to_status = 'Exception'", [assertTenant(tenantId), tripId]);
  return Number(row?.total) || 0;
}

// System job (NEXUS sweeper): trips on the road with no position for staleHours.
async function listStaleTripsAllTenants(staleHours) {
  return all(
    "SELECT id, tenant_id AS tenantId, last_tracked_at AS lastTrackedAt FROM trips WHERE status = 'In Transit' AND COALESCE(last_tracked_at, updated_at) < datetime('now', ?)",
    [`-${Number(staleHours)} hours`]
  );
}

// A position for the truck: it is the position of every load still on it.
async function addTripTracking(tenantId, tripId, { location, eta, note }, actorId) {
  assertTenant(tenantId);
  return withTransaction(async (tx) => {
    const trip = await loadTrip(tx, tenantId, tripId);
    if (!tripsLib.TRACKABLE_TRIP_STATUSES.includes(trip.status)) throw httpError(409, `Location updates are only possible while a trip is ${tripsLib.TRACKABLE_TRIP_STATUSES.join(', ')}.`);
    const onBoard = await tx.all('SELECT shipment_id FROM trip_shipments WHERE trip_id = ? AND tenant_id = ? AND released_at IS NULL AND delivered_at IS NULL', [tripId, tenantId]);
    let stamp = null;
    for (const row of onBoard) {
      const result = await tx.run(
        "INSERT INTO tracking_updates (shipment_id, actor_id, location, eta, note, source) VALUES (?, ?, ?, ?, ?, 'manual')",
        [row.shipment_id, actorId || null, location, eta || null, note || null]
      );
      const created = await tx.get('SELECT created_at FROM tracking_updates WHERE id = ?', [result.id]);
      stamp = created.created_at;
      await tx.run('UPDATE shipments SET last_location = ?, eta = COALESCE(?, eta), last_tracked_at = ? WHERE id = ? AND tenant_id = ?', [location, eta || null, created.created_at, row.shipment_id, tenantId]);
    }
    await tx.run("UPDATE trips SET last_location = ?, eta = COALESCE(?, eta), last_tracked_at = COALESCE(?, datetime('now')) WHERE id = ?", [location, eta || null, stamp, tripId]);
    return { tripId, location, eta: eta || null, loads: onBoard.length };
  });
}


/* ---------- durable background jobs (lib/job-queue.js runs them) ---------- */
// A job is one unit of background work. It is saved before it runs, retried with growing delays when it
// fails, never added twice under the same idempotency key, and kept as a "dead" row when it gives up.
// Jobs of one company and lane run strictly in the order they were added.
const JOB_COLUMNS = 'id, tenant_id AS tenantId, kind, lane, payload, idempotency_key AS idempotencyKey, status, attempts, max_attempts AS maxAttempts, run_at AS runAt, last_error AS lastError, created_at AS createdAt, finished_at AS finishedAt';

async function enqueueJob({ tenantId, kind, payload = {}, lane = 'default', idempotencyKey = null, delaySeconds = 0, maxAttempts = 5 }) {
  assertTenant(tenantId);
  if (!kind) throw new Error('A job needs a kind.');
  const result = await run(
    `INSERT OR IGNORE INTO jobs (tenant_id, kind, lane, payload, idempotency_key, max_attempts, run_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))`,
    [tenantId, kind, lane, JSON.stringify(payload ?? {}), idempotencyKey, maxAttempts, `+${Math.max(0, Math.floor(Number(delaySeconds) || 0))} seconds`]
  );
  return { created: result.changes === 1, id: result.changes === 1 ? result.id : null };
}

// Takes the oldest due job that has nothing earlier waiting in its company and lane. Safe with several servers:
// only the one whose UPDATE still finds the job "queued" wins it.
async function claimJob(workerId) {
  const candidate = await get(`
    SELECT id FROM jobs
    WHERE status = 'queued' AND run_at <= datetime('now')
      AND NOT EXISTS (
        SELECT 1 FROM jobs earlier
        WHERE earlier.tenant_id = jobs.tenant_id AND earlier.lane = jobs.lane
          AND earlier.id < jobs.id AND earlier.status IN ('queued', 'running'))
    ORDER BY run_at, id LIMIT 1`);
  if (!candidate) return null;
  const claimed = await run(
    "UPDATE jobs SET status = 'running', locked_at = datetime('now'), locked_by = ?, attempts = attempts + 1, updated_at = datetime('now') WHERE id = ? AND status = 'queued'",
    [workerId, candidate.id]
  );
  if (claimed.changes !== 1) return null;
  return get(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`, [candidate.id]);
}

async function completeJob(id) {
  await run("UPDATE jobs SET status = 'done', locked_at = NULL, locked_by = NULL, last_error = NULL, finished_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", [id]);
}

// Failed: try again after baseDelaySeconds * 2^(attempt-1) (at most 15 minutes), or give up as "dead".
async function failJob(job, error, { baseDelaySeconds = 30, permanent = false } = {}) {
  const message = String(error?.message || error || 'Failed').slice(0, 500);
  if (permanent || job.attempts >= job.maxAttempts) {
    await run("UPDATE jobs SET status = 'dead', locked_at = NULL, locked_by = NULL, last_error = ?, finished_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", [message, job.id]);
    return 'dead';
  }
  const delay = Math.min(900, baseDelaySeconds * 2 ** (job.attempts - 1));
  await run(
    "UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL, last_error = ?, run_at = datetime('now', ?), updated_at = datetime('now') WHERE id = ?",
    [message, `+${Math.round(delay)} seconds`, job.id]
  );
  return 'retry';
}

// A server that died mid-job leaves it "running"; after the visibility time it is queued again (or given up).
async function recoverStuckJobs(visibilitySeconds = 600) {
  const cutoff = `-${Math.max(1, Math.floor(visibilitySeconds))} seconds`;
  const dead = await run(
    "UPDATE jobs SET status = 'dead', locked_at = NULL, locked_by = NULL, last_error = COALESCE(last_error, 'The server stopped while running this job.'), finished_at = datetime('now') WHERE status = 'running' AND locked_at < datetime('now', ?) AND attempts >= max_attempts",
    [cutoff]
  );
  const requeued = await run(
    "UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL, last_error = 'The server stopped while running this job.' WHERE status = 'running' AND locked_at < datetime('now', ?)",
    [cutoff]
  );
  return { dead: dead.changes, requeued: requeued.changes };
}

async function pruneJobs(days = 7) {
  const result = await run("DELETE FROM jobs WHERE status = 'done' AND finished_at < datetime('now', ?)", [`-${Math.max(1, Math.floor(days))} days`]);
  return result.changes;
}

async function listJobs(tenantId, { status = null, limit = 50 } = {}) {
  assertTenant(tenantId);
  const rows = await all(
    `SELECT ${JOB_COLUMNS} FROM jobs WHERE tenant_id = ? ${status ? 'AND status = ?' : ''} ORDER BY id DESC LIMIT ?`,
    status ? [tenantId, status, limit] : [tenantId, limit]
  );
  return rows.map((row) => ({ ...row, payload: undefined }));
}

async function jobStats(tenantId) {
  assertTenant(tenantId);
  const counts = { queued: 0, running: 0, done: 0, dead: 0 };
  for (const row of await all('SELECT status, COUNT(*) AS total FROM jobs WHERE tenant_id = ? GROUP BY status', [tenantId])) counts[row.status] = Number(row.total);
  return counts;
}

// Gives a dead job a fresh set of attempts.
async function retryJob(tenantId, id) {
  const result = await run(
    "UPDATE jobs SET status = 'queued', attempts = 0, run_at = datetime('now'), finished_at = NULL, updated_at = datetime('now') WHERE id = ? AND tenant_id = ? AND status = 'dead'",
    [id, assertTenant(tenantId)]
  );
  return result.changes === 1;
}

module.exports = {
  isPostgres,
  listPoolableLoads,
  countTripExceptions,
  listStaleTripsAllTenants,
  createTrip,
  getTrip,
  listTrips,
  updateTrip,
  allocateShipment,
  releaseShipment,
  setTripStatus,
  deliverTripShipment,
  addTripTracking,
  getShipmentLegs,
  getLeg,
  setLegPayment,
  getLegContext,
  countLegExceptions,
  getNextLeg,
  listStaleLegsAllTenants,
  createShipmentWithLegs,
  addLeg,
  updateLeg,
  setLegStatus,
  addLegTracking,
  setDocumentLeg,
  listLegDocuments,
  enqueueJob,
  claimJob,
  completeJob,
  failJob,
  recoverStuckJobs,
  pruneJobs,
  listJobs,
  jobStats,
  retryJob,
  pgSchema,
  MIGRATIONS,
  enforceRowLevelSecurity,
  isRowLevelSecurityEnforced: () => rlsEnforced,
  migrate,
  migrationRunner,
  db,
  sql: { run, get, all }, // context-aware statements, for scripts and tests
  DB_PATH,
  getUserPasswordHash,
  setUserPassword,
  recordAudit,
  listAudit,
  backupTo,
  updateShipmentDetails,
  setShipmentPayment,
  getFinanceSummary,
  setShipmentShareTokenHash,
  findSharedShipment,
  BCRYPT_COST,
  DEFAULT_TENANT_ID,
  ALLOWED_ROLES,
  TRACKABLE_STATUSES,
  CARRIER_MODES,
  CARRIER_MANUAL_STATUSES,
  initialize,
  checkIntegrity,
  getTenant,
  listTenants,
  createTenantWithAdmin,
  setTenantGpsTokenHash,
  findTenantByGpsTokenHash,
  setTenantInboxTokenHash,
  findTenantByInboxTokenHash,
  setTenantInboxAllowedSenders,
  setTenantMessagingSettings,
  setTenantImapSettings,
  setTenantImapState,
  setTenantAutomationSettings,
  getCommandCenterStats,
  listTenantIdsWithImap,
  createInboxItem,
  addInboxAttachment,
  listInboxAttachments,
  getInboxAttachmentFile,
  deleteInboxAttachments,
  setDocumentType,
  listMarketRates,
  createQuote,
  getQuote,
  listQuotes,
  updateQuote,
  convertQuote,
  getLanePriceData,
  listBorderWaits,
  upsertBorderWait,
  deleteBorderWait,
  getBorderWait,
  upsertMarketRate,
  deleteMarketRate,
  getGeoPlace,
  setGeoPlace,
  getGeoRoute,
  setGeoRoute,
  moveInboxAttachmentsToShipment,
  findShipmentIdsByReference,
  findMessageByCallbackTokenHash,
  recordMessageDelivery,
  listOpenTasksByKeyPrefix,
  getRouteData,
  getPulseData,
  listSentinelLoads,
  listTrackingOverview,
  countStatusReached,
  countShipmentsThisMonth,
  setTenantRegion,
  exportTenantData,
  findTenantByPaddleSubscription,
  applyPaddleSubscription,
  countActiveUsers,
  updateTenantPlan,
  listWorkflows,
  getWorkflow,
  listActiveWorkflows,
  createWorkflow,
  updateWorkflow,
  setWorkflowEnabled,
  deleteWorkflow,
  recordWorkflowRun,
  listWorkflowRuns,
  getWorkflowStats,
  getInboxItem,
  listInboxItems,
  countInboxItemsToday,
  updateInboxItem,
  createTask,
  listTasks,
  getTask,
  resolveTask,
  resolveTasksByKey,
  resolveTasksForShipment,
  countAgentTasksToday,
  listStaleLoadsAllTenants,
  countShipmentExceptions,
  addDocument,
  getDocument,
  listDocuments,
  getDocumentFile,
  updateDocumentExtraction,
  deleteDocument,
  findUserByEmail,
  findUserById,
  updateUser,
  createUser,
  listUsers,
  createAuthSession,
  isAuthSessionActive,
  revokeAuthSession,
  revokeUserSessions,
  getRateLimitStatus,
  consumeRateLimit,
  recordRateLimitAttempts,
  clearRateLimitAttempts,
  listShipments,
  searchShipments,
  getShipment,
  updateShipmentStatus,
  createShipment,
  dispatchShipment,
  addTrackingUpdate,
  recordGpsPositions,
  listTrackingUpdates,
  listShipmentEvents,
  createMessage,
  listMessages,
  recordAgentTask,
  getAgentUsage,
  listCarriers,
  listCarriersWithStats,
  getScoutData,
  createCarrier,
  updateCarrierStatus,
  getAnalyticsPayload,
  getAnalyticsReport,
  getDashboardPayload,
  getAlerts
};
