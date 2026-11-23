// Retention (Phase 6.2): companies choose how long old detail is kept. Saving removes nothing; a run removes
// only what is older than the days and only from finished loads; loads themselves always stay.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-retention-'));
Object.assign(process.env, { NODE_ENV: 'development', DATABASE_PATH: path.join(dir, 'r.db'), PORT: '0', BCRYPT_COST: '10', API_RATE_LIMIT_MAX: '5000', NEXUS_ENABLED: 'false' });

const rules = require('../lib/retention');
const database = require('../database');
const { runAsSystem } = require('../lib/tenant-context');
const { app, initialize } = require('../server');
const nexus = require('../agents/nexus');
const { db } = database;

let server; let base; let admin; let operator; let other; let oldLoad; let openLoad;
const call = (cookie, method, url, body) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
const json = async (...args) => { const res = await call(...args); return { status: res.status, body: await res.json() }; };
const sql = (text, params) => runAsSystem(() => database.sql.run(text, params));
const count = async (text, params) => Number((await runAsSystem(() => database.sql.get(text, params))).total);
const pdf = (marker) => Buffer.concat([Buffer.from(`%PDF-1.4\n% ${marker}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`), Buffer.alloc(64, 1)]);
async function login(email, password) {
  const res = await call(null, 'POST', '/api/login', { email, password });
  assert.equal(res.status, 200, email);
  return res.headers.get('set-cookie').split(';')[0];
}
async function newLoad(customer) {
  const res = await json(admin, 'POST', '/api/shipments', { customer, origin: 'A', destination: 'B', pickup: '2026-10-01', delivery: '2026-10-02', weight: 1000, equipment: 'Dry Van' });
  return Number(res.body.shipment.id.replace('SHP-', ''));
}

before(async () => {
  await initialize();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await login('admin@veyra.ai', 'admin123');
  operator = await login('demo@veyra.ai', 'demo123');
  await call(admin, 'POST', '/api/platform/tenants', { companyName: 'Other Keep', adminName: 'Olga', adminEmail: 'olga@keep.example', adminPassword: 'OtherPass2026' });
  other = await login('olga@keep.example', 'OtherPass2026');
  oldLoad = await newLoad('Old Customer');
  openLoad = await newLoad('Open Customer');
  for (const id of [oldLoad, openLoad]) {
    await sql("INSERT INTO tracking_updates (shipment_id, location, source) VALUES (?, 'Somewhere', 'manual')", [id]);
    await fetch(`${base}/api/shipments/${id}/documents?type=cmr&filename=cmr.pdf`, { method: 'POST', headers: { 'content-type': 'application/pdf', cookie: admin }, body: pdf(`load-${id}`) });
  }
  // The old load finished long ago; everything on both loads is 400 days old.
  await sql("UPDATE shipments SET status = 'Delivered' WHERE id = ?", [oldLoad]);
  for (const table of ['tracking_updates', 'documents']) await sql(`UPDATE ${table} SET created_at = datetime('now', '-400 days') WHERE shipment_id IN (?, ?)`, [oldLoad, openLoad]);
  await sql("UPDATE audit_log SET created_at = datetime('now', '-400 days')");
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => db.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rules: every category is off until set; minimum days are enforced; auto needs something to do', () => {
  assert.deepEqual(rules.readSettings({}), { auto: false, trackingDays: null, messagesDays: null, documentsDays: null, tasksDays: null, auditDays: null });
  assert.throws(() => rules.readSettings({ trackingDays: 5 }), /at least 30/);
  assert.throws(() => rules.readSettings({ auditDays: 100 }), /at least 365/);
  assert.throws(() => rules.readSettings({ documentsDays: 1.5 }), /at least 90/);
  assert.equal(rules.readSettings({ auto: true }).auto, false);
  assert.equal(rules.parseStored('not json').auto, false);
});

test('only administrators manage retention; saving removes nothing and shows a preview', async () => {
  assert.equal((await json(operator, 'GET', '/api/settings/retention')).status, 403);
  const start = await json(admin, 'GET', '/api/settings/retention');
  assert.equal(start.body.preview.trackingDays, null, 'off by default');
  assert.equal((await json(admin, 'PUT', '/api/settings/retention', { trackingDays: 3 })).status, 400);
  const saved = await json(admin, 'PUT', '/api/settings/retention', { trackingDays: 30, documentsDays: 90, auditDays: 365 });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.preview.trackingDays, 1, 'only the finished load');
  assert.equal(saved.body.preview.documentsDays, 1);
  assert.ok(saved.body.preview.auditDays >= 1);
  assert.equal(await count('SELECT COUNT(*) AS total FROM tracking_updates WHERE shipment_id = ?', [oldLoad]), 1, 'nothing removed yet');
  assert.equal((await json(other, 'GET', '/api/settings/retention')).body.preview.trackingDays, null, 'another company has its own settings');
});

test('a run needs confirm, removes only old detail of finished loads, keeps the loads, and is logged', async () => {
  assert.equal((await json(admin, 'POST', '/api/settings/retention/run', {})).status, 400);
  const run = await json(admin, 'POST', '/api/settings/retention/run', { confirm: true });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.removed.trackingDays, 1);
  assert.equal(run.body.removed.documentsDays, 1);
  assert.equal(await count('SELECT COUNT(*) AS total FROM tracking_updates WHERE shipment_id = ?', [oldLoad]), 0);
  assert.equal(await count('SELECT COUNT(*) AS total FROM documents WHERE shipment_id = ?', [oldLoad]), 0);
  assert.equal(await count('SELECT COUNT(*) AS total FROM tracking_updates WHERE shipment_id = ?', [openLoad]), 1, 'an open load keeps everything');
  assert.equal(await count('SELECT COUNT(*) AS total FROM documents WHERE shipment_id = ?', [openLoad]), 1);
  assert.equal(await count('SELECT COUNT(*) AS total FROM shipments WHERE id = ?', [oldLoad]), 1, 'the load itself stays');
  assert.ok(run.body.lastRun);
  const log = (await json(admin, 'GET', '/api/audit')).body;
  assert.ok(JSON.stringify(log).includes('retention.run'), 'the run is in the activity log');
});

test('automatic removal runs once a day for companies that switched it on', async () => {
  await sql("UPDATE tracking_updates SET created_at = datetime('now', '-400 days')");
  await sql("UPDATE shipments SET status = 'Cancelled' WHERE id = ?", [openLoad]);
  assert.equal(await nexus.retentionSweep(), 0, 'off: and the last run was just now');
  await json(admin, 'PUT', '/api/settings/retention', { trackingDays: 30, auto: true });
  await sql("UPDATE tenants SET retention_last_run = datetime('now', '-2 days')");
  assert.equal(await nexus.retentionSweep(), 1);
  assert.equal(await count('SELECT COUNT(*) AS total FROM tracking_updates WHERE shipment_id = ?', [openLoad]), 0);
  assert.equal(await nexus.retentionSweep(), 0, 'not again the same day');
});
