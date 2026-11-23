// Cold chain (Phase 5.1): a temperature range per load, readings typed by people, stretches outside the range,
// and one NEXUS task per stretch. Readings are manual; there is no sensor connection.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-cold-'));
Object.assign(process.env, { NODE_ENV: 'development', DATABASE_PATH: path.join(dir, 'c.db'), PORT: '0', BCRYPT_COST: '10', API_RATE_LIMIT_MAX: '5000' });
delete process.env.OPENROUTER_API_KEY;

const rules = require('../lib/cold-chain');
const { app, initialize } = require('../server');
const { db } = require('../database');
const nexus = require('../agents/nexus');

let server; let base; let admin; let operator; let other; let id;
const call = (cookie, method, url, body) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
const json = async (...args) => { const res = await call(...args); return { status: res.status, body: await res.json() }; };
const coldTasks = async (cookie = admin) => (await json(cookie, 'GET', '/api/tasks')).body.tasks.filter((task) => /too (warm|cold)/.test(task.title));
async function login(email, password) {
  const res = await call(null, 'POST', '/api/login', { email, password });
  assert.equal(res.status, 200, email);
  return res.headers.get('set-cookie').split(';')[0];
}

before(async () => {
  await initialize();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await login('admin@veyra.ai', 'admin123');
  operator = await login('demo@veyra.ai', 'demo123');
  await call(admin, 'POST', '/api/platform/tenants', { companyName: 'Other Cold', adminName: 'Olga', adminEmail: 'olga@cold.example', adminPassword: 'OtherPass2026' });
  other = await login('olga@cold.example', 'OtherPass2026');
  const created = await json(admin, 'POST', '/api/shipments', { customer: 'Fresh Fruit', origin: 'Tashkent', destination: 'Moscow', pickup: '2026-12-01', delivery: '2026-12-06', weight: 18000, equipment: 'Reefer' });
  id = created.body.shipment.id;
});
after(async () => {
  await nexus.idle();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => db.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rules: ranges and readings are checked; stretches outside the range are found', () => {
  assert.deepEqual(rules.readRange({ min: '2', max: '8,5' }), { min: 2, max: 8.5 });
  assert.equal(rules.readRange({ min: null, max: null }), null);
  assert.throws(() => rules.readRange({ min: 8, max: 2 }), /above min/);
  assert.throws(() => rules.readRange({ min: -80, max: 2 }), /between -40 and 40/);
  assert.throws(() => rules.readReading({ celsius: 'cold' }), /celsius/);
  assert.throws(() => rules.readReading({ celsius: 4, recordedAt: '2099-01-01T00:00' }, { now: new Date('2026-12-02T00:00Z') }), /future/);
  assert.equal(rules.readReading({ celsius: 4, recordedAt: '2026-11-01T10:00' }).recordedAt, '2026-11-01 10:00:00');
  const at = (n, celsius) => ({ id: n, celsius, recordedAt: `2026-12-01 ${String(n).padStart(2, '0')}:00:00` });
  const found = rules.excursions([at(1, 4), at(2, 9), at(3, 11), at(4, 5), at(5, 1), at(6, 0.5)], { min: 2, max: 8 });
  assert.deepEqual(found.map((item) => [item.direction, item.peak, item.minutes, item.open]), [['too_warm', 11, 120, false], ['too_cold', 0.5, null, true]]);
  assert.deepEqual(rules.excursions([at(1, 30)], null), []);
});

test('API: set a range, add readings; other companies and people without the right cannot', async () => {
  assert.equal((await json(admin, 'PUT', `/api/v2/shipments/${id}/temperature-range`, { min: 8, max: 2 })).status, 400);
  const set = await json(admin, 'PUT', `/api/v2/shipments/${id}/temperature-range`, { min: 2, max: 8 });
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.range, { min: 2, max: 8 });
  assert.equal((await json(other, 'PUT', `/api/v2/shipments/${id}/temperature-range`, { min: 0, max: 4 })).status, 404);
  assert.equal((await json(other, 'GET', `/api/v2/shipments/${id}/temperatures`)).status, 404);
  assert.equal((await json(other, 'POST', `/api/v2/shipments/${id}/temperatures`, { celsius: 4 })).status, 404);
  assert.equal((await json(admin, 'POST', `/api/v2/shipments/${id}/temperatures`, { celsius: 99 })).status, 400);
  assert.equal((await json(admin, 'POST', `/api/v2/shipments/${id}/temperatures`, { celsius: 4, legId: 99999 })).status, 404);
  const added = await json(admin, 'POST', `/api/v2/shipments/${id}/temperatures`, { celsius: 4.2, recordedAt: '2026-11-20T08:00Z', note: 'At loading' });
  assert.equal(added.status, 201);
  assert.equal(added.body.readings.length, 1);
  assert.equal(added.body.readings[0].celsius, 4.2);
  assert.deepEqual(added.body.excursions, []);
});

test('NEXUS: one task per stretch outside the range, not one per reading; a new stretch is a new task', async () => {
  await nexus.idle();
  assert.equal((await coldTasks()).length, 0);
  const warm = await json(admin, 'POST', `/api/v2/shipments/${id}/temperatures`, { celsius: 9.5, recordedAt: '2026-11-20T10:00Z' });
  assert.equal(warm.body.excursions[0].open, true);
  await json(admin, 'POST', `/api/v2/shipments/${id}/temperatures`, { celsius: 12, recordedAt: '2026-11-20T11:00Z' });
  await nexus.idle();
  const tasks = await coldTasks();
  assert.equal(tasks.length, 1, 'still the same stretch');
  assert.match(tasks[0].title, /too warm — (9.5|12) °C \(range 2 to 8 °C\)/);
  assert.equal((await coldTasks(other)).length, 0);
  await json(admin, 'POST', `/api/v2/shipments/${id}/temperatures`, { celsius: 5, recordedAt: '2026-11-20T12:00Z' });
  await json(admin, 'POST', `/api/v2/shipments/${id}/temperatures`, { celsius: 1, recordedAt: '2026-11-20T13:00Z' });
  await nexus.idle();
  const after = await coldTasks();
  assert.equal(after.length, 2);
  assert.ok(after.some((task) => /too cold — 1 °C/.test(task.title)));
  const data = (await json(admin, 'GET', `/api/v2/shipments/${id}/temperatures`)).body;
  assert.deepEqual(data.excursions.map((item) => [item.direction, item.peak, item.minutes]), [['too_warm', 12, 120], ['too_cold', 1, null]]);
});

test('without a range, readings are kept but raise nothing', async () => {
  const created = await json(admin, 'POST', '/api/shipments', { customer: 'Dry Goods', origin: 'A', destination: 'B', pickup: '2026-12-01', delivery: '2026-12-02', weight: 1000, equipment: 'Dry Van' });
  const other = created.body.shipment.id;
  const before = (await coldTasks()).length;
  assert.equal((await json(admin, 'POST', `/api/v2/shipments/${other}/temperatures`, { celsius: 30 })).status, 201);
  await nexus.idle();
  assert.equal((await coldTasks()).length, before);
});
