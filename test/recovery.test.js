// Recovery and load (Phase 6.3): a real backup is restored into a copy and checked; the load test measures a
// running server. The restore drill runs in its own process, as it would on the server.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-recovery-'));
Object.assign(process.env, { NODE_ENV: 'development', DATABASE_PATH: path.join(dir, 'live.db'), PORT: '0', BCRYPT_COST: '10', API_RATE_LIMIT_MAX: '100000', NEXUS_ENABLED: 'false', BACKUP_DIR: path.join(dir, 'backups') });
delete process.env.DATABASE_URL;

const { app, initialize } = require('../server');
const database = require('../database');
const loadTest = require('../scripts/load-check');

let server; let base; let admin;
const drill = (args, env = {}) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'restore-drill.js'), ...args], {
  env: { ...process.env, DATABASE_URL: '', ...env }, encoding: 'utf8'
});

before(async () => {
  await initialize();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@veyra.ai', password: 'admin123' }) });
  admin = res.headers.get('set-cookie').split(';')[0];
  const created = await (await fetch(`${base}/api/shipments`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: admin }, body: JSON.stringify({ customer: 'Backup Co', origin: 'A', destination: 'B', pickup: '2026-12-01', delivery: '2026-12-02', weight: 1000, equipment: 'Dry Van' }) })).json();
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n% drill\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF'), Buffer.alloc(64, 1)]);
  await fetch(`${base}/api/shipments/${created.shipment.id}/documents?type=cmr&filename=cmr.pdf`, { method: 'POST', headers: { 'content-type': 'application/pdf', cookie: admin }, body: pdf });
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => database.db.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a fresh backup restores into a copy and passes every check; the backup file is left unchanged', async () => {
  const made = await (await fetch(`${base}/api/platform/backups`, { method: 'POST', headers: { cookie: admin } })).json();
  assert.ok(made.backup, JSON.stringify(made));
  const file = path.join(dir, 'backups', made.backup.name);
  const before = fs.readFileSync(file);
  const result = drill([file]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS {2}schema upgraded to this version/);
  assert.match(result.stdout, /PASS {2}integrity/);
  assert.match(result.stdout, /PASS {2}every company has an administrator/);
  assert.match(result.stdout, /PASS {2}document files can be read — 1 of 1 sampled/);
  assert.match(result.stdout, /Restore drill PASSED/);
  assert.ok(fs.readFileSync(file).equals(before), 'the backup itself was not changed');
  const newest = drill([]);
  assert.equal(newest.status, 0, 'with no path it takes the newest backup');
});

test('a broken backup fails the drill; a missing file or the live database URL stops it', () => {
  const broken = path.join(dir, 'broken.db');
  fs.writeFileSync(broken, 'this is not a database');
  const result = drill([broken]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /FAIL {2}database opens/);
  assert.equal(drill([path.join(dir, 'nope.db')]).status, 2);
  const live = drill([], { DATABASE_URL: 'postgres://u:p@localhost/live', RESTORE_DATABASE_URL: 'postgres://u:p@localhost/live' });
  assert.equal(live.status, 2);
  assert.match(live.stderr, /separate database/);
});

test('the load test reports throughput, errors and response times against a running server', async () => {
  const report = await loadTest.run({ url: base, email: 'admin@veyra.ai', password: 'admin123', users: 4, seconds: 1 });
  assert.ok(report.requests > 0);
  assert.equal(report.errorRate, 0, report.firstErrors.join('; '));
  assert.ok(report.ms.p95 >= report.ms.median);
  await assert.rejects(loadTest.run({ url: base, email: 'admin@veyra.ai', password: 'wrong', users: 1, seconds: 1 }), /Login failed/);
  await assert.rejects(loadTest.run({ url: 'localhost', email: 'a', password: 'b' }), /LOAD_TEST_URL/);
});

