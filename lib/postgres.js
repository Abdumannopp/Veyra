/* =========================================================
   PostgreSQL behind the same small callback API as lib/sqlite.js
   (run / get / all / exec / close / configure), so database.js runs unchanged.

   Veyra's SQL is written for SQLite. Each statement is translated once and cached:
   ? placeholders → $1..$n, SQLite date functions → veyra_* functions created below
   (timestamps stay "YYYY-MM-DD HH:MM:SS" text in UTC, exactly as before),
   INSERT OR IGNORE / OR REPLACE → ON CONFLICT, LIKE → ILIKE (SQLite's LIKE ignores case),
   REAL → DOUBLE PRECISION, BLOB → BYTEA, and INSERTs return the new id.

   One connection runs one statement at a time, in order, like the SQLite file did:
   database.js already queues queries and runs transactions on that single connection.
   ========================================================= */
const { Client, types } = require('pg');

// COUNT/SUM come back as bigint and AVG as numeric; Veyra's numbers are well inside JS range.
types.setTypeParser(20, (value) => (value === null ? null : Number.parseInt(value, 10)));
types.setTypeParser(1700, (value) => (value === null ? null : Number.parseFloat(value)));

const SHIM = (schema) => `
CREATE OR REPLACE FUNCTION ${schema}.veyra_ts(t timestamp) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT to_char(t, 'YYYY-MM-DD HH24:MI:SS') $$;
CREATE OR REPLACE FUNCTION ${schema}.veyra_now() RETURNS text LANGUAGE sql STABLE AS $$ SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') $$;
CREATE OR REPLACE FUNCTION ${schema}.veyra_base(t text) RETURNS timestamp LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN t IS NULL THEN NULL WHEN lower(t) = 'now' THEN (now() AT TIME ZONE 'UTC') ELSE replace(replace(t, 'T', ' '), 'Z', '')::timestamp END $$;
CREATE OR REPLACE FUNCTION ${schema}.veyra_shift(t text, m text) RETURNS timestamp LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN m IS NULL THEN ${schema}.veyra_base(t)
              WHEN lower(m) = 'start of month' THEN date_trunc('month', ${schema}.veyra_base(t))
              WHEN lower(m) = 'start of day' THEN date_trunc('day', ${schema}.veyra_base(t))
              ELSE ${schema}.veyra_base(t) + m::interval END $$;
CREATE OR REPLACE FUNCTION ${schema}.veyra_datetime(t text, m text DEFAULT NULL) RETURNS text LANGUAGE sql STABLE AS $$ SELECT ${schema}.veyra_ts(${schema}.veyra_shift(t, m)) $$;
CREATE OR REPLACE FUNCTION ${schema}.veyra_date(t text, m text DEFAULT NULL) RETURNS text LANGUAGE sql STABLE AS $$ SELECT to_char(${schema}.veyra_shift(t, m), 'YYYY-MM-DD') $$;
CREATE OR REPLACE FUNCTION ${schema}.veyra_julianday(t text) RETURNS double precision LANGUAGE sql STABLE AS $$
  SELECT extract(epoch FROM ${schema}.veyra_base(t))::double precision / 86400.0 + 2440587.5 $$;
CREATE OR REPLACE FUNCTION ${schema}.veyra_strftime(f text, t text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT replace(replace(replace(replace(replace(replace(f,
    '%Y', to_char(${schema}.veyra_base(t), 'YYYY')), '%m', to_char(${schema}.veyra_base(t), 'MM')), '%d', to_char(${schema}.veyra_base(t), 'DD')),
    '%H', to_char(${schema}.veyra_base(t), 'HH24')), '%M', to_char(${schema}.veyra_base(t), 'MI')), '%S', to_char(${schema}.veyra_base(t), 'SS')) $$;
`;

// The `sqlite3` error codes Veyra checks, from PostgreSQL's SQLSTATE.
function asSqliteError(error) {
  const state = String(error?.code || '');
  if (state === '23505' || state === '23503' || state === '23502' || state === '23514') {
    error.code = 'SQLITE_CONSTRAINT';
    const kind = state === '23503' ? 'FOREIGN KEY' : state === '23505' ? 'UNIQUE' : state === '23502' ? 'NOT NULL' : 'CHECK';
    error.message = `SQLITE_CONSTRAINT: ${kind} constraint failed (${error.message})`;
  } else if (state === '40P01' || state === '55P03') {
    error.code = 'SQLITE_BUSY';
  }
  return error;
}

function bindValue(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  return value;
}

// Replace ? outside quoted strings with $1, $2, ...
function numberPlaceholders(sql) {
  let out = '';
  let n = 0;
  let quote = null;
  for (const ch of sql) {
    if (quote) {
      if (ch === quote) quote = null;
      out += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
    } else if (ch === '?') {
      n += 1;
      out += `$${n}`;
    } else out += ch;
  }
  return out;
}

// CAST(x AS INTEGER) truncates in SQLite but rounds in PostgreSQL.
function truncateCasts(sql) {
  let out = sql;
  let at = out.search(/CAST\(/i);
  while (at !== -1) {
    let depth = 0;
    let end = -1;
    for (let i = at + 4; i < out.length; i += 1) {
      if (out[i] === '(') depth += 1;
      else if (out[i] === ')') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) break;
    const inner = out.slice(at + 5, end);
    const match = /^(.*)\s+AS\s+INTEGER\s*$/is.exec(inner);
    const replacement = match ? `trunc(${match[1]})::integer` : `CAST(${inner})`;
    out = out.slice(0, at) + replacement + out.slice(end + 1);
    const next = out.slice(at + replacement.length).search(/CAST\(/i);
    at = next === -1 ? -1 : at + replacement.length + next;
  }
  return out;
}

// PostgreSQL folds unquoted names to lower case, so "AS tenantId" would come back as "tenantid".
// Every camelCase alias is quoted, and so is every later use of it (ORDER BY lastRunAt).
function quoteCamelAliases(sql) {
  const aliases = new Set();
  for (const match of sql.matchAll(/\bAS\s+([a-z][a-z0-9]*[A-Z][A-Za-z0-9]*)\b/g)) aliases.add(match[1]);
  if (!aliases.size) return sql;
  const pattern = new RegExp(`(?<![\\w."])(${[...aliases].join('|')})(?![\\w"])`, 'g');
  let out = '';
  let quote = null;
  let chunk = '';
  for (const ch of sql) {
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
    } else if (ch === "'") {
      out += chunk.replace(pattern, '"$1"') + ch;
      chunk = '';
      quote = ch;
    } else chunk += ch;
  }
  return out + chunk.replace(pattern, '"$1"');
}

function translate(sql) {
  let s = String(sql).trim().replace(/;\s*$/, '');
  if (/^BEGIN\b/i.test(s)) return { text: 'BEGIN' };
  const pragma = /^PRAGMA\s+(\w+)(?:\((\w+)\))?/i.exec(s);
  if (pragma) {
    const name = pragma[1].toLowerCase();
    if (name === 'table_info') {
      return { text: "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position", fixed: [pragma[2].toLowerCase()] };
    }
    if (name === 'integrity_check') return { text: "SELECT 'ok' AS integrity_check" };
    // PostgreSQL always enforces foreign keys.
    if (name === 'foreign_keys') return { text: 'SELECT 1 AS foreign_keys' };
    if (name === 'foreign_key_check') return { text: 'SELECT 1 WHERE false' };
    return { text: 'SELECT 1 WHERE false' };
  }
  // The list of indexes, as SQLite's catalog answers it.
  if (/FROM\s+sqlite_master\s+WHERE\s+type\s*=\s*'index'/i.test(s)) {
    return { text: 'SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema()' };
  }
  if (/^VACUUM\b/i.test(s)) {
    const error = new Error('Backups of a PostgreSQL database are made by the database provider, not by Veyra.');
    error.statusCode = 409;
    throw error;
  }
  s = s
    .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, 'BIGSERIAL PRIMARY KEY')
    .replace(/\bBLOB\b/g, 'BYTEA')
    .replace(/\bREAL\b/g, 'DOUBLE PRECISION')
    .replace(/\bCURRENT_TIMESTAMP\b/g, 'veyra_now()')
    .replace(/\b(datetime|date|julianday|strftime)\(/gi, (m, fn) => `veyra_${fn.toLowerCase()}(`)
    .replace(/(\S+)\s+COLLATE NOCASE/gi, 'lower($1)')
    .replace(/\bNOT LIKE\b/g, 'NOT ILIKE')
    .replace(/(?<!NOT )\bLIKE\b/g, 'ILIKE');
  // SQLite's INTEGER holds 64 bits (Veyra stores millisecond times in some), PostgreSQL's only 32.
  if (/^(CREATE\s+TABLE|ALTER\s+TABLE)/i.test(s)) s = s.replace(/\bINTEGER\b/g, 'BIGINT');
  s = truncateCasts(s);
  s = quoteCamelAliases(s);
  let table = null;
  const insert = /^INSERT\s+(OR\s+(IGNORE|REPLACE)\s+)?INTO\s+(\w+)\s*\(([^)]*)\)/i.exec(s);
  if (insert) {
    table = insert[3].toLowerCase();
    const mode = (insert[2] || '').toUpperCase();
    s = s.replace(/^INSERT\s+OR\s+(IGNORE|REPLACE)\s+INTO/i, 'INSERT INTO');
    if (mode === 'IGNORE') s += ' ON CONFLICT DO NOTHING';
    if (mode === 'REPLACE') {
      const columns = insert[4].split(',').map((c) => c.trim());
      s += ` ON CONFLICT (${columns[0]}) DO UPDATE SET ${columns.slice(1).map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`;
    }
  }
  // An INSERT that sets the id itself (the default company is id 1) must move the id counter past it.
  const explicitId = Boolean(insert && insert[4].split(',').some((c) => c.trim().toLowerCase() === 'id'));
  return { text: numberPlaceholders(s), insertTable: table, explicitId };
}

class Database {
  constructor(url, { schema = 'public' } = {}) {
    this.url = url;
    this.schema = /^[a-z_][a-z0-9_]{0,62}$/.test(schema) ? schema : 'public';
    this.cache = new Map();
    this.idTables = new Map();
    this.chain = Promise.resolve();
    this.client = null;
    this.role = null;
    this.settingsKey = null;
  }

  async connect() {
    if (this.client) return this.client;
    // After close() nothing may reopen the connection (a late background job would keep the process alive).
    if (this.closed) throw new Error('The database connection is closed.');
    const client = new Client({ connectionString: this.url, application_name: 'veyra' });
    client.on('error', (error) => {
      console.error('[db] connection lost:', error.message);
      if (this.client === client) this.client = null;
    });
    await client.connect();
    await client.query("SET TIME ZONE 'UTC'");
    if (this.schema !== 'public') await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
    await client.query(`SET search_path TO ${this.schema}`);
    await client.query(SHIM(this.schema));
    this.settingsKey = null;
    if (this.role) await client.query(`SET ROLE ${this.role}`);
    this.client = client;
    return client;
  }

  // Row level security only binds a role that is not the owner or a superuser, so the app works as `role`.
  async enforceRole(role) {
    this.role = /^[a-z_][a-z0-9_]{0,62}$/.test(role) ? role : null;
    const client = await this.connect();
    if (this.role) await client.query(`SET ROLE ${this.role}`);
  }

  // Tells PostgreSQL which company (or system work) the next statements are for. Called in query order.
  async useContext({ tenantId, system }) {
    if (!this.role) return;
    const key = `${tenantId}|${system}`;
    const client = await this.connect();
    if (this.settingsKey === key) return;
    await client.query("SELECT set_config('veyra.tenant_id', $1, false), set_config('veyra.system', $2, false)", [tenantId, system]);
    this.settingsKey = key;
  }

  async hasId(table) {
    if (!this.idTables.has(table)) {
      const client = await this.connect();
      const result = await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'id'", [table]);
      this.idTables.set(table, result.rowCount > 0);
    }
    return this.idTables.get(table);
  }

  async query(sql, params) {
    let plan = this.cache.get(sql);
    if (!plan) {
      plan = translate(sql);
      if (this.cache.size >= 1000) this.cache.clear();
      this.cache.set(sql, plan);
    }
    const client = await this.connect();
    let text = plan.text;
    if (plan.insertTable && (await this.hasId(plan.insertTable))) text += ' RETURNING id';
    const values = plan.fixed || params.map(bindValue);
    const result = await client.query(text, values);
    if (plan.explicitId && result.rowCount) {
      // Only tables whose id comes from a counter (a text id has none).
      const seq = (await client.query('SELECT pg_get_serial_sequence($1, $2) AS seq', [plan.insertTable, 'id'])).rows[0]?.seq;
      if (seq) await client.query(`SELECT setval($1::regclass, (SELECT MAX(id) FROM ${plan.insertTable}))`, [seq]);
    }
    if (/^\s*(CREATE|ALTER|DROP)\b/i.test(sql)) this.idTables.clear();
    return result;
  }

  // Every call goes through one ordered chain, like SQLite's single connection.
  call(work, callback, context = null) {
    const step = this.chain.then(work);
    this.chain = step.then(() => undefined, () => undefined);
    step.then(
      (result) => { if (typeof callback === 'function') callback.call(context ? context(result) : null, null, result); },
      (error) => {
        const failure = asSqliteError(error);
        if (typeof callback === 'function') callback.call(null, failure);
        else console.error('[db] failed:', failure.message);
      }
    );
  }

  configure() {
    return this;
  }

  run(sql, params, callback) {
    if (typeof params === 'function') [callback, params] = [params, []];
    const values = Array.isArray(params) ? params : params === undefined ? [] : [params];
    this.call(
      () => this.query(sql, values),
      callback ? function done(error) { callback.call(this, error); } : null,
      (result) => ({ lastID: result.rows?.[0]?.id ?? null, changes: result.rowCount ?? 0 })
    );
    return this;
  }

  get(sql, params, callback) {
    if (typeof params === 'function') [callback, params] = [params, []];
    const values = Array.isArray(params) ? params : params === undefined ? [] : [params];
    this.call(async () => (await this.query(sql, values)).rows[0], callback ? (error, row) => callback(error, row) : null);
    return this;
  }

  all(sql, params, callback) {
    if (typeof params === 'function') [callback, params] = [params, []];
    const values = Array.isArray(params) ? params : params === undefined ? [] : [params];
    this.call(async () => (await this.query(sql, values)).rows, callback ? (error, rows) => callback(error, rows) : null);
    return this;
  }

  exec(sql, callback) {
    this.call(() => this.query(sql, []), callback ? (error) => callback(error) : null);
    return this;
  }

  close(callback) {
    this.closed = true;
    this.call(async () => {
      if (this.client) await this.client.end();
      this.client = null;
    }, callback ? (error) => callback(error) : null);
  }
}

module.exports = { Database, translate, verbose: () => module.exports };
