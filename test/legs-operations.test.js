// Multi-leg loads in daily operations: NEXUS reacts per leg (booking message, exception, next-leg reminder,
// quiet leg), the old whole-load checks leave them alone, and carriers are paid leg by leg in Finance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-legs-ops-'));
Object.assign(process.env, { NODE_ENV: 'development', DATABASE_PATH: path.join(dir, 'o.db'), PORT: '0', BCRYPT_COST: '10', API_RATE_LIMIT_MAX: '5000', CURRENCY: 'USD' });
delete process.env.OPENROUTER_API_KEY;

const database = require('../database');
const { runAsSystem, runAsTenant } = require('../lib/tenant-context');
const { app, initialize } = require('../server');
const nexus = require('../agents/nexus');
const { db } = database;

let server; let base; let admin; let operator; let other; let carrierRoad; let carrierSea;
const call = (cookie, method, url, body) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
const json = async (...args) => { const res = await call(...args); return { status: res.status, body: await res.json() }; };
const sql = (text, params) => runAsSystem(() => database.sql.run(text, params));
const tasks = async (cookie = admin) => (await json(cookie, 'GET', '/api/tasks')).body.tasks;
async function login(email, password) {
  const res = await call(null, 'POST', '/api/login', { email, password });
  assert.equal(res.status, 200, email);
  return res.headers.get('set-cookie').split(';')[0];
}
const move = (legId, status, extra = {}) => json(admin, 'POST', `/api/v2/legs/${legId}/status`, { status, ...extra });

let load; // { id: 'SHP-n', number, legs: [...] }
before(async () => {
  await initialize();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await login('admin@veyra.ai', 'admin123');
  operator = await login('demo@veyra.ai', 'demo123');
  await call(admin, 'POST', '/api/platform/tenants', { companyName: 'Other Ops', adminName: 'Olga', adminEmail: 'olga@ops.example', adminPassword: 'OtherPass2026' });
  other = await login('olga@ops.example', 'OtherPass2026');
  carrierRoad = (await json(admin, 'POST', '/api/carriers', { name: 'Road Co', mode: 'Truckload', phone: '+1 214 555 0100' })).body.carrier.id;
  carrierSea = (await json(admin, 'POST', '/api/carriers', { name: 'Sea Co', mode: 'Intermodal', phone: '+1 214 555 0199' })).body.carrier.id;
  const created = await json(admin, 'POST', '/api/v2/shipments', {
    customer: 'Ops Foods', origin: 'Tashkent', destination: 'Hamburg', pickup: '2026-12-01', delivery: '2026-12-30', weight: 18000, equipment: 'Reefer',
    legs: [
      { mode: 'ROAD', origin: 'Tashkent', destination: 'Poti Port', carrierId: carrierRoad, price: 1500, details: { truckPlate: '01 A 123 BC', driverName: 'Aziz', driverPhone: '+998 90 123 45 67' } },
      { mode: 'OCEAN', origin: 'Poti Port', destination: 'Hamburg Port', carrierId: carrierSea, price: 2200.5, reference: 'BL-7788' },
      { mode: 'LAST_MILE', origin: 'Hamburg Port', destination: 'Hamburg warehouse', price: 300, reference: 'PARCEL-1' }
    ]
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  load = { id: created.body.shipment.id, number: Number(created.body.shipment.id.replace('SHP-', '')), legs: created.body.legs };
});
after(async () => {
  await nexus.idle();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => db.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('booking a leg drafts a message to that leg\'s carrier, naming the leg', async () => {
  assert.equal((await move(load.legs[0].id, 'Booked')).status, 200);
  await nexus.idle();
  const message = (await tasks()).find((task) => task.kind === 'message' && task.shipmentId === load.id);
  assert.ok(message, 'a message was drafted');
  assert.match(message.title, /SHP-\d+ leg 1 \(road\)/);
  assert.equal(message.payload.recipient, 'carrier');
  assert.equal(message.payload.to, '+1 214 555 0100');
  assert.match(message.payload.body, /leg 1 \(road\)/);
  assert.match(message.payload.body, /Rate \$1,500\.00/);
});

test('a leg in Exception raises one task for that leg, which closes when the leg resumes', async () => {
  await move(load.legs[0].id, 'In Transit');
  await move(load.legs[0].id, 'Exception');
  await nexus.idle();
  const raised = (await tasks()).filter((task) => task.shipmentId === load.id && /is in Exception/.test(task.title));
  assert.equal(raised.length, 1, 'only the leg task, not a second one for the whole load');
  assert.match(raised[0].title, /leg 1 \(road\) is in Exception/);
  await move(load.legs[0].id, 'In Transit');
  await nexus.idle();
  assert.equal((await tasks()).some((task) => /is in Exception/.test(task.title) && task.shipmentId === load.id), false);
});

test('delivering a leg reminds people about the next one; the reminder closes once that leg is booked', async () => {
  assert.equal((await move(load.legs[0].id, 'Delivered', { handover: { location: 'Poti Port gate', receivedBy: 'Nika' } })).status, 200);
  await nexus.idle();
  const reminder = (await tasks()).find((task) => task.shipmentId === load.id && /leg 2 \(ocean\) is next/.test(task.title));
  assert.ok(reminder);
  assert.match(reminder.payload.text, /Book the next leg/);
  await move(load.legs[1].id, 'Booked');
  await nexus.idle();
  assert.equal((await tasks()).some((task) => /is next/.test(task.title) && task.shipmentId === load.id), false);
});

test('a leg on the way with no position is flagged once per silence; the whole-load checks skip multi-leg loads', async () => {
  await move(load.legs[1].id, 'In Transit');
  await nexus.idle();
  const before = (await tasks()).length;
  assert.equal(await nexus.sweep(), 0, 'it just started');
  await sql("UPDATE shipment_legs SET updated_at = datetime('now', '-1 day') WHERE id = ?", [load.legs[1].id]);
  await sql("UPDATE shipments SET last_tracked_at = datetime('now', '-1 day') WHERE id = ?", [load.number]);
  assert.equal(await nexus.sweep(), 1);
  const quiet = (await tasks()).filter((task) => task.shipmentId === load.id && /leg 2 \(ocean\): no position update/.test(task.title));
  assert.equal(quiet.length, 1);
  assert.equal(quiet[0].payload.carrierPhone, '+1 214 555 0199');
  assert.equal(await nexus.sweep(), 0, 'not again for the same silence');
  assert.equal((await tasks()).length, before + 1, 'no whole-load "call the driver" reminder on top');
  const sentinel = await runAsTenant(1, () => database.listSentinelLoads(1));
  assert.equal(sentinel.some((entry) => entry.id === load.number), false, 'risk watch looks at classic loads only');
  await move(load.legs[1].id, 'Delivered');
  await nexus.idle();
  assert.equal((await tasks()).some((task) => /no position update/.test(task.title) && task.shipmentId === load.id), false, 'closed when the leg is delivered');
});

test('Finance: carriers are owed per delivered leg and are paid leg by leg', async () => {
  let summary = (await json(admin, 'GET', '/api/finance/summary')).body;
  assert.equal(summary.payable, 3700.5, 'the two delivered legs; the last leg is not delivered yet');
  assert.deepEqual(summary.openLegs.map((leg) => [leg.sequence, leg.mode, leg.carrierName, leg.price]), [[1, 'ROAD', 'Road Co', 1500], [2, 'OCEAN', 'Sea Co', 2200.5]]);
  assert.equal(summary.open.some((row) => row.id === load.id), false, 'the load is not delivered, and carriers are not owed as one lump');

  assert.equal((await json(operator, 'PUT', `/api/v2/legs/${load.legs[0].id}/payment`, { paid: true })).status, 403);
  assert.equal((await json(other, 'PUT', `/api/v2/legs/${load.legs[0].id}/payment`, { paid: true })).status, 404);
  assert.equal((await json(admin, 'PUT', `/api/v2/legs/${load.legs[2].id}/payment`, { paid: true })).status, 409, 'not delivered yet');
  assert.equal((await json(admin, 'PUT', `/api/v2/legs/${load.legs[0].id}/payment`, { paid: 'yes' })).status, 400);

  const paid = await json(admin, 'PUT', `/api/v2/legs/${load.legs[0].id}/payment`, { paid: true });
  assert.equal(paid.status, 200);
  assert.ok(paid.body.legs[0].paidAt);
  summary = (await json(admin, 'GET', '/api/finance/summary')).body;
  assert.equal(summary.payable, 2200.5);
  assert.equal(summary.payableLoads, 1);
  assert.equal((await json(admin, 'PUT', `/api/v2/legs/${load.legs[0].id}/payment`, { paid: false })).status, 200, 'a payment can be undone');
  assert.equal((await json(admin, 'GET', '/api/finance/summary')).body.payable, 3700.5);
  await json(admin, 'PUT', `/api/v2/legs/${load.legs[0].id}/payment`, { paid: true });

  const classic = await json(admin, 'PATCH', `/api/shipments/${load.id}/payment`, { carrierPaid: true });
  assert.equal(classic.status, 409, 'the whole-load "carrier paid" switch is refused');
});

test('delivering the last leg delivers the load, closes its tasks and leaves the customer owing; the last leg is paid too', async () => {
  await move(load.legs[2].id, 'Booked');
  await move(load.legs[2].id, 'In Transit');
  const done = await move(load.legs[2].id, 'Delivered');
  assert.equal(done.body.shipment.status, 'Delivered');
  await nexus.idle();
  assert.equal((await tasks()).some((task) => task.shipmentId === load.id && /leg \d/.test(task.title)), false, 'no leg task is left open on a delivered load');

  await json(admin, 'PUT', `/api/v2/legs/${load.legs[1].id}/payment`, { paid: true });
  let summary = (await json(admin, 'GET', '/api/finance/summary')).body;
  assert.equal(summary.payable, 300, 'only the last leg is still owed');
  const lastPaid = await json(admin, 'PUT', `/api/v2/legs/${load.legs[2].id}/payment`, { paid: true });
  assert.equal(lastPaid.status, 200);
  summary = (await json(admin, 'GET', '/api/finance/summary')).body;
  assert.equal(summary.payable, 0);
  assert.deepEqual(summary.openLegs, []);
  const row = await runAsSystem(() => database.sql.get('SELECT carrier_paid_at AS paid FROM shipments WHERE id = ?', [load.number]));
  assert.ok(row.paid, 'the load shows its carriers as paid once every leg is');
});

test('a cancelled load owes nothing for its legs', async () => {
  const created = await json(admin, 'POST', '/api/v2/shipments', {
    customer: 'Cancel Foods', origin: 'A', destination: 'B', pickup: '2026-12-01', delivery: '2026-12-02', weight: 100, equipment: 'Dry Van',
    legs: [{ mode: 'ROAD', origin: 'A', destination: 'B', price: 999, reference: 'R-1' }]
  });
  const leg = created.body.legs[0];
  await move(leg.id, 'Booked');
  await move(leg.id, 'In Transit');
  await move(leg.id, 'Delivered');
  assert.equal((await json(admin, 'GET', '/api/finance/summary')).body.payable, 999);
  await sql("UPDATE shipments SET status = 'Cancelled' WHERE id = ?", [Number(created.body.shipment.id.replace('SHP-', ''))]);
  assert.equal((await json(admin, 'GET', '/api/finance/summary')).body.payable, 0);
});
