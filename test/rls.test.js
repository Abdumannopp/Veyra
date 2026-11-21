// PostgreSQL row level security: the database itself keeps one company away from another's rows,
// even if application code forgot a tenant filter. Runs only on PostgreSQL.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const skip = /^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL || '') ? false : 'needs PostgreSQL (DATABASE_URL)';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-rls-'));
Object.assign(process.env, { NODE_ENV: 'development', DATABASE_PATH: path.join(dir, 'r.db'), BCRYPT_COST: '10', NEXUS_ENABLED: 'false' });
delete process.env.DB_RLS;

const database = require('../database');
const { runAsSystem, runAsTenant } = require('../lib/tenant-context');
const { db, initialize, sql } = database;
const { run, all, get } = sql;

let a;
let b;
const shipmentOf = (tenantId, customer) => run(
  "INSERT INTO shipments (tenant_id, customer, origin, destination, status) VALUES (?, ?, 'Tashkent', 'Berlin', 'Pending')", [tenantId, customer]
);

before(async () => {
  if (skip) return;
  await initialize();
  await runAsSystem(async () => {
    a = (await run("INSERT INTO tenants (name) VALUES ('Company A')")).id;
    b = (await run("INSERT INTO tenants (name) VALUES ('Company B')")).id;
    const sa = await shipmentOf(a, 'Customer of A');
    const sb = await shipmentOf(b, 'Customer of B');
    await run("INSERT INTO shipment_events (shipment_id, to_status) VALUES (?, 'Pending')", [sa.id]);
    await run("INSERT INTO shipment_events (shipment_id, to_status) VALUES (?, 'Pending')", [sb.id]);
    await run("INSERT INTO tracking_updates (shipment_id, location) VALUES (?, 'Samarkand')", [sb.id]);
  });
});
after(async () => {
  await new Promise((resolve) => db.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the app runs as the restricted role and the policies are active', { skip }, async () => {
  assert.equal(database.isRowLevelSecurityEnforced(), true);
  const row = await runAsSystem(() => get('SELECT current_user AS who, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass'));
  assert.equal(row.who, 'veyra_app');
  assert.equal(row.bypass, false);
});

test('a company sees only its own rows, including through a query with no tenant filter', { skip }, async () => {
  const seenByA = await runAsTenant(a, () => all('SELECT customer FROM shipments'));
  assert.deepEqual(seenByA.map((r) => r.customer), ['Customer of A']);
  const seenByB = await runAsTenant(b, () => all('SELECT customer FROM shipments'));
  assert.deepEqual(seenByB.map((r) => r.customer), ['Customer of B']);
  assert.equal((await runAsTenant(a, () => all('SELECT id FROM tenants'))).length, 1);
});

test('events and tracking follow their shipment', { skip }, async () => {
  assert.equal((await runAsTenant(a, () => all('SELECT id FROM shipment_events'))).length, 1);
  assert.equal((await runAsTenant(a, () => all('SELECT id FROM tracking_updates'))).length, 0);
  assert.equal((await runAsTenant(b, () => all('SELECT id FROM tracking_updates'))).length, 1);
});

test('without any context nothing is visible (fail closed); system work sees everything', { skip }, async () => {
  assert.equal((await all('SELECT id FROM shipments')).length, 0);
  assert.equal((await all('SELECT id FROM tenants')).length, 0);
  assert.ok((await runAsSystem(() => all('SELECT id FROM shipments'))).length >= 2);
});

test('a company cannot change or add rows for another company', { skip }, async () => {
  const changed = await runAsTenant(a, () => run("UPDATE shipments SET customer = 'hacked' WHERE tenant_id = ?", [b]));
  assert.equal(changed.changes, 0);
  const deleted = await runAsTenant(a, () => run('DELETE FROM shipments WHERE tenant_id = ?', [b]));
  assert.equal(deleted.changes, 0);
  await assert.rejects(runAsTenant(a, () => shipmentOf(b, 'planted')), /row-level security/);
  const otherShipment = await runAsSystem(() => get("SELECT id FROM shipments WHERE customer = 'Customer of B'"));
  await assert.rejects(runAsTenant(a, () => run("INSERT INTO shipment_events (shipment_id, to_status) VALUES (?, 'planted')", [otherShipment.id])), /row-level security/);
  const intact = await runAsSystem(() => get("SELECT COUNT(*) AS n FROM shipments WHERE customer = 'Customer of B'"));
  assert.equal(Number(intact.n), 1);
});

test('contexts do not leak between overlapping requests', { skip }, async () => {
  const results = await Promise.all([a, b, a, b, a, b].map((id) => runAsTenant(id, async () => {
    const first = await all('SELECT customer FROM shipments');
    await new Promise((resolve) => setImmediate(resolve));
    const second = await get('SELECT COUNT(*) AS n FROM shipments');
    return [first.map((r) => r.customer).join(), Number(second.n)];
  })));
  results.forEach(([customer, count], index) => {
    assert.equal(customer, index % 2 === 0 ? 'Customer of A' : 'Customer of B');
    assert.equal(count, 1);
  });
});

test('every table that carries a tenant_id has a policy (a new table cannot slip through)', { skip }, async () => {
  const unprotected = await runAsSystem(() => all(`
    SELECT c.table_name FROM information_schema.columns c
    WHERE c.table_schema = current_schema() AND c.column_name = 'tenant_id'
      AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = current_schema() AND p.tablename = c.table_name)`));
  assert.deepEqual(unprotected, []);
});
