// Warehouse (Phase 5.2): goods received into a warehouse leg (pieces, damage), stored (free days, charge)
// and released to the next leg. Entered by warehouse staff; no warehouse system is connected.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-warehouse-'));
Object.assign(process.env, { NODE_ENV: 'development', DATABASE_PATH: path.join(dir, 'w.db'), PORT: '0', BCRYPT_COST: '10', API_RATE_LIMIT_MAX: '5000' });
delete process.env.GEMINI_API_KEY;

const rules = require('../lib/warehouse');
const { app, initialize } = require('../server');
const { db } = require('../database');
const nexus = require('../agents/nexus');

let server; let base; let admin; let other; let load;
const call = (cookie, method, url, body) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
const json = async (...args) => { const res = await call(...args); return { status: res.status, body: await res.json() }; };
const whTasks = async (cookie = admin) => (await json(cookie, 'GET', '/api/tasks')).body.tasks.filter((task) => /warehouse/i.test(task.title));
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
  await call(admin, 'POST', '/api/platform/tenants', { companyName: 'Other Store', adminName: 'Olga', adminEmail: 'olga@store2.example', adminPassword: 'OtherPass2026' });
  other = await login('olga@store2.example', 'OtherPass2026');
  const carrier = (await json(admin, 'POST', '/api/carriers', { name: 'Road Co', mode: 'Truckload' })).body.carrier.id;
  const created = await json(admin, 'POST', '/api/v2/shipments', {
    customer: 'Store Foods', origin: 'Tashkent', destination: 'Almaty', pickup: '2026-12-01', delivery: '2026-12-20', weight: 5000, equipment: 'Dry Van',
    legs: [
      { mode: 'ROAD', origin: 'Tashkent', destination: 'Tashkent warehouse', carrierId: carrier },
      { mode: 'WAREHOUSE', origin: 'Tashkent warehouse', destination: 'Tashkent warehouse', reference: 'WH-1', details: { warehouseName: 'North Hub', storageDays: '3' } },
      { mode: 'ROAD', origin: 'Tashkent warehouse', destination: 'Almaty', carrierId: carrier }
    ]
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  load = { id: created.body.shipment.id, legs: created.body.legs };
});
after(async () => {
  await nexus.idle();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => db.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rules: receipts and releases are checked; storage days and charge after the free days', () => {
  const now = new Date('2026-11-20T12:00:00Z');
  assert.throws(() => rules.readReceive({}, { now }), /piecesReceived is required/);
  assert.throws(() => rules.readReceive({ piecesReceived: 5, damagedPieces: 6 }, { now }), /cannot be more/);
  assert.throws(() => rules.readReceive({ piecesReceived: 2.5 }, { now }), /whole number/);
  assert.throws(() => rules.readReceive({ piecesReceived: 5, receivedAt: '2026-12-30T10:00' }, { now }), /future/);
  const receipt = rules.readReceive({ piecesExpected: 20, piecesReceived: 18, damagedPieces: 1, freeDays: 3, dailyRate: 12.5, receivedAt: '2026-11-10T08:00Z' }, { now });
  assert.equal(receipt.receivedAt, '2026-11-10 08:00:00');
  const stay = { ...receipt };
  assert.deepEqual(rules.storage(stay, { now }), { days: 11, freeDays: 3, chargeableDays: 8, charge: 100, overFreeDays: true, shortPieces: 2, overPieces: 0, damagedPieces: 1, released: false });
  assert.equal(rules.readRelease({}, stay, { now }).piecesReleased, 17, 'the good pieces by default');
  assert.throws(() => rules.readRelease({ releasedAt: '2026-11-01T00:00Z' }, stay, { now }), /before the goods were received/);
  assert.throws(() => rules.readRelease({ piecesReleased: 30 }, stay, { now }), /from 0 to 18/);
  assert.equal(rules.storage({ receivedAt: '2026-11-20 11:00:00', freeDays: 0, dailyRate: null, piecesReceived: 1 }, { now }).days, 1, 'a started day counts');
});

test('API: only a booked warehouse leg receives; the leg goes in storage; damage and short pieces make one task', async () => {
  const [road, store] = load.legs;
  assert.equal((await json(admin, 'POST', `/api/v2/legs/${road.id}/warehouse/receive`, { piecesReceived: 5 })).status, 409, 'not a warehouse leg');
  assert.equal((await json(admin, 'POST', `/api/v2/legs/${store.id}/warehouse/receive`, { piecesReceived: 5 })).status, 409, 'not booked yet');
  assert.equal((await json(admin, 'POST', `/api/v2/legs/${store.id}/warehouse/release`, {})).status, 409, 'nothing received');
  for (const status of ['Booked', 'In Transit', 'Delivered']) assert.equal((await json(admin, 'POST', `/api/v2/legs/${road.id}/status`, { status })).status, 200, status);
  assert.equal((await json(admin, 'POST', `/api/v2/legs/${store.id}/status`, { status: 'Booked' })).status, 200);
  assert.equal((await json(other, 'POST', `/api/v2/legs/${store.id}/warehouse/receive`, { piecesReceived: 5 })).status, 404);
  assert.equal((await json(admin, 'POST', `/api/v2/legs/${store.id}/warehouse/receive`, { piecesReceived: 'many' })).status, 400);
  const received = await json(admin, 'POST', `/api/v2/legs/${store.id}/warehouse/receive`, { piecesExpected: 20, piecesReceived: 18, damagedPieces: 1, freeDays: 3, dailyRate: 10 });
  assert.equal(received.status, 200, JSON.stringify(received.body));
  const leg = received.body.legs.find((item) => item.id === store.id);
  assert.equal(leg.status, 'In Transit');
  assert.equal(leg.warehouse.piecesReceived, 18);
  assert.equal(leg.warehouse.storage.shortPieces, 2);
  assert.equal((await json(admin, 'POST', `/api/v2/legs/${store.id}/warehouse/receive`, { piecesReceived: 18 })).status, 409, 'once only');
  await nexus.idle();
  const tasks = await whTasks();
  assert.equal(tasks.length, 1);
  assert.match(tasks[0].title, /received with 2 piece\(s\) missing \(18 of 20\), 1 piece\(s\) damaged/);
  assert.equal((await whTasks(other)).length, 0);
});

test('NEXUS: goods stored past the free days make one task, closed when they are released to the next leg', async () => {
  const store = load.legs[1];
  const now = new Date(Date.now() + 5 * 86400000);
  assert.equal(await nexus.warehouseSweep(new Date()), 0, 'within the free days');
  assert.equal(await nexus.warehouseSweep(now), 1);
  assert.equal(await nexus.warehouseSweep(now), 0, 'not again');
  assert.ok((await whTasks()).some((task) => /past the 3 free day\(s\)/.test(task.title)));
  const released = await json(admin, 'POST', `/api/v2/legs/${store.id}/warehouse/release`, { note: 'Collected by Road Co' });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  const leg = released.body.legs.find((item) => item.id === store.id);
  assert.equal(leg.status, 'Delivered');
  assert.equal(leg.warehouse.piecesReleased, 17);
  assert.ok(released.body.handovers.some((item) => item.fromLegId === store.id), 'handed over to the next leg');
  assert.equal((await json(admin, 'POST', `/api/v2/legs/${store.id}/warehouse/release`, {})).status, 409);
  await nexus.warehouseSweep(now);
  assert.equal((await whTasks()).filter((task) => /free day/.test(task.title)).length, 0);
});
