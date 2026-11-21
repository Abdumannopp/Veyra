// Copy a Veyra SQLite database into an empty PostgreSQL database, then prove the copy is exact.
//
//   SQLITE_PATH=./data/veyra.db DATABASE_URL=postgres://... npm run migrate:postgres
//   ... npm run migrate:postgres -- --dry-run     (copy and check, then undo everything)
//
// 1. Creates Veyra's schema in PostgreSQL with the versioned migrations (no demo data).
// 2. Refuses to run if the PostgreSQL tables already hold data.
// 3. Copies every table in foreign-key order inside ONE transaction, keeping ids.
// 4. Compares row counts and a content checksum per table (source vs copy, read back
//    inside the same transaction). Any difference rolls the whole copy back.
// The SQLite file is opened read-only and is never changed.
require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dryRun = process.argv.includes('--dry-run');
const SQLITE_PATH = path.resolve(process.env.SQLITE_PATH || process.env.DATABASE_PATH || './data/veyra.db');
const DATABASE_URL = String(process.env.DATABASE_URL || '');
const BATCH = 300;
const MONEY_COLUMNS = { shipments: ['rate', 'customer_rate'], quotes: ['price', 'carrier_cost'], market_rates: ['rate'] };

function fail(message) {
  console.error(`Copy stopped: ${message}`);
  process.exit(1);
}

if (!/^postgres(ql)?:\/\//i.test(DATABASE_URL)) fail('set DATABASE_URL to the PostgreSQL database to copy into.');
if (!fs.existsSync(SQLITE_PATH)) fail(`no SQLite file at ${SQLITE_PATH} (set SQLITE_PATH).`);

// Values compared the same way on both sides: numbers as numbers, files as hex, empty as null.
function normal(value) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `hex:${Buffer.from(value).toString('hex')}`;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '' && /^-?\d+(\.\d+)?$/.test(value)) return value;
  return value;
}

// Order-independent checksum of a table's rows over the given columns.
function checksum(rows, columns) {
  const hashes = rows.map((row) => crypto.createHash('sha256').update(JSON.stringify(columns.map((c) => normal(row[c])))).digest('hex')).sort();
  return crypto.createHash('sha256').update(hashes.join('')).digest('hex');
}

// Parents before children, from the foreign keys PostgreSQL knows about.
function dependencyOrder(tables, edges) {
  const order = [];
  const state = new Map();
  const visit = (table) => {
    if (state.get(table) === 'done') return;
    if (state.get(table) === 'visiting') return; // a self or circular reference: keep going, ids are kept
    state.set(table, 'visiting');
    for (const parent of edges.get(table) || []) if (tables.includes(parent) && parent !== table) visit(parent);
    state.set(table, 'done');
    order.push(table);
  };
  tables.slice().sort().forEach(visit);
  return order;
}

(async () => {
  // Step 1: schema in PostgreSQL from Veyra's own migrations.
  const database = require('../database');
  if (!database.isPostgres) fail('DATABASE_URL is not a PostgreSQL address.');
  await database.migrate();
  await new Promise((resolve) => database.db.close(resolve));

  const { DatabaseSync } = require('node:sqlite');
  const source = new DatabaseSync(SQLITE_PATH, { readOnly: true });
  const { Client } = require('pg');
  const target = new Client({ connectionString: DATABASE_URL, application_name: 'veyra-copy' });
  await target.connect();
  await target.query("SET TIME ZONE 'UTC'");
  await target.query(`SET search_path TO ${database.pgSchema}`);
  await target.query("SELECT set_config('veyra.system', 'on', false)"); // the copy spans every company

  try {
    const targetTables = (await target.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations'"
    )).rows.map((r) => r.table_name);
    const sourceTables = source.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'").all().map((r) => r.name);

    const unknown = sourceTables.filter((t) => !targetTables.includes(t));
    if (unknown.length) fail(`these SQLite tables have no place in the PostgreSQL schema: ${unknown.join(', ')}. Update Veyra first.`);

    // Step 2: the target must be empty. The schema migration itself adds one placeholder
    // company (id 1); that row is replaced by the real one from SQLite.
    for (const table of targetTables) {
      const placeholder = table === 'tenants' ? ' WHERE id <> 1' : '';
      const { rows } = await target.query(`SELECT COUNT(*)::int AS n FROM ${table}${placeholder}`);
      if (rows[0].n > 0) fail(`PostgreSQL table "${table}" already has ${rows[0].n} rows. Copy only into an empty database.`);
    }

    const fkRows = (await target.query(`
      SELECT tc.table_name AS child, ccu.table_name AS parent
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = current_schema()`)).rows;
    const edges = new Map();
    for (const { child, parent } of fkRows) edges.set(child, [...(edges.get(child) || []), parent]);
    const order = dependencyOrder(sourceTables, edges);

    const report = [];
    const skipped = [];
    await target.query('BEGIN');
    await target.query('DELETE FROM tenants WHERE id = 1');

    // Step 3: copy, keeping ids.
    for (const table of order) {
      const targetColumns = (await target.query(
        'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1', [table]
      )).rows.map((r) => r.column_name);
      const sourceColumns = source.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
      const columns = sourceColumns.filter((c) => targetColumns.includes(c));
      for (const c of sourceColumns.filter((c) => !targetColumns.includes(c))) skipped.push(`${table}.${c}`);

      const rows = source.prepare(`SELECT ${columns.map((c) => `"${c}"`).join(', ')} FROM ${table}`).all();
      // Money was stored as floating point; PostgreSQL keeps it as NUMERIC(18,4). Round to that first so both sides compare exactly.
      for (const column of MONEY_COLUMNS[table] || []) {
        for (const row of rows) if (typeof row[column] === 'number') row[column] = Math.round((row[column] + Number.EPSILON) * 1e4) / 1e4;
      }
      for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH);
        const values = [];
        const tuples = chunk.map((row) => `(${columns.map((c) => {
          const v = row[c];
          values.push(v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v) : v);
          return `$${values.length}`;
        }).join(', ')})`);
        await target.query(`INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(', ')}) VALUES ${tuples.join(', ')}`, values);
      }
      if (targetColumns.includes('id')) {
        const seq = (await target.query('SELECT pg_get_serial_sequence($1, $2) AS seq', [table, 'id'])).rows[0].seq;
        if (seq && rows.length) await target.query(`SELECT setval($1::regclass, (SELECT MAX(id) FROM ${table}))`, [seq]);
      }

      // Step 4: read it back and compare.
      const copied = (await target.query(`SELECT ${columns.map((c) => `"${c}"`).join(', ')} FROM ${table}`)).rows;
      const same = rows.length === copied.length && checksum(rows, columns) === checksum(copied, columns);
      report.push({ table, rows: rows.length, copied: copied.length, checksum: same ? 'match' : 'DIFFERENT' });
    }

    const bad = report.filter((r) => r.checksum !== 'match');
    console.table(report);
    if (skipped.length) console.log(`Old columns not carried over (no longer used by Veyra): ${skipped.join(', ')}`);
    if (bad.length) {
      await target.query('ROLLBACK');
      fail(`${bad.length} table(s) differ after copying: ${bad.map((r) => r.table).join(', ')}. Nothing was kept.`);
    }
    if (dryRun) {
      await target.query('ROLLBACK');
      console.log(`Dry run: all ${report.length} tables copied and matched, then undone. PostgreSQL is unchanged.`);
    } else {
      await target.query('COMMIT');
      const total = report.reduce((sum, r) => sum + r.rows, 0);
      console.log(`Done: ${total} rows in ${report.length} tables copied and verified. Now point the app at DATABASE_URL.`);
    }
    await target.end();
    source.close();
    process.exit(0);
  } catch (error) {
    await target.query('ROLLBACK').catch(() => {});
    await target.end().catch(() => {});
    fail(`${error.message}. Nothing was kept.`);
  }
})().catch((error) => fail(error.message));
