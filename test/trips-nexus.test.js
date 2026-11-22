// Trips and NEXUS: one manifest message to the carrier and driver when a truck is booked, one task per problem or
// silence on the trip (not one per load), and suggestions for loads that could share one truck.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-trips-nexus-'));
Object.assign(process.env, { NODE_ENV: 'development', DATABASE_PATH: path.join(dir, 'n.db'), PORT: '0', BCRYPT_COST: '10', API_RATE_LIMIT_MAX: '5000', CURRENCY: 'USD' });
delete process.env.OPENROUTER_API_KEY;

const tripsLib = require('../lib/trips');
const database = require('../database');
const { runAsSystem } = require('../lib/tenant-context');
const { app, initialize } = require('../server');
const nexus = require('../agents/nexus');
const { db } = database;

let server; let base; let admin; let operator; let other; let carrier; let tripId; let loads;
const call = (cookie, method, url, body) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
const json = async (...args) => { const res = await call(...args); return { status: res.status, body: await res.json() }; };
const sql = (text, params) => runAsSystem(() => database.sql.run(text, params));
const tasks = async (cookie = admin) => (await json(cookie, 'GET', '/api/tasks')).body.tasks;
async function login(email, password) {
  const res = await call(null, 'POST', '/api/login', { email, password });
  assert.equal(res.status, 200, email);
  return res.headers.get('set-cookie').split(';')[0];
}
let counter = 0;
async function load(weight, extra = {}) {
  counter += 1;
  const created = await json(admin, 'POST', '/api/shipments', {
    customer: `Pool Customer ${counter}`, origin: 'Samarkand', destination: 'Khiva', pickup: '2026-12-01', delivery: '2026-12-03', weight, equipment: 'LTL', customerRate: 100,
    customerPhone: `+998 90 000 00 0${counter}`, ...extra
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.shipment.id;
}

before(async () => {
  await initialize();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await login('admin@veyra.ai', 'admin123');
  operator = await login('demo@veyra.ai', 'demo123');
  await call(admin, 'POST', '/api/platform/tenants', { companyName: 'Other Pools', adminName: 'Olga', adminEmail: 'olga@pools.example', adminPassword: 'OtherPass2026' });
  other = await login('olga@pools.example', 'OtherPass2026');
  carrier = (await json(admin, 'POST', '/api/carriers', { name: 'LTL Express', mode: 'LTL', phone: '+1 214 555 0111' })).body.carrier.id;
});
after(async () => {
  await nexus.idle();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => db.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rules: loads on one lane with close pickups are packed into trucks; a single load is no suggestion', () => {
  const make = (id, weightKg, pickup, origin = 'Tashkent', destination = 'Almaty') => ({ id, customer: `C${id}`, origin, destination, pickup, delivery: pickup, weightKg });
  const pools = tripsLib.suggestPools([
    make(1, 3000, '2026-12-01'), make(2, 6000, '2026-12-02'), make(3, 12000, '2026-12-02'),
    make(4, 500, '2026-12-20'), make(5, 400, '2026-12-21', ' tashkent ', 'ALMATY'),
    make(6, 9000, '2026-12-01', 'Tashkent', 'Bukhara'), make(7, 25000, '2026-12-01')
  ], { capacityKg: 20000 });
  assert.deepEqual(pools.map((pool) => pool.loads.map((entry) => entry.id)), [[2, 3], [4, 5]], 'ignoring case and spaces; far pickups apart; too heavy or alone: none');
  assert.equal(pools[0].utilization, 0.9);
  assert.equal(pools[0].totalWeightKg, 18000);
  assert.deepEqual(tripsLib.suggestPools([make(1, 100, '2026-12-01'), make(2, 100, '2026-12-09')], { capacityKg: 1000, windowDays: 3 }), []);
  assert.equal(tripsLib.suggestPools([make(1, 100, '2026-12-01'), make(2, 100, '2026-12-09')], { capacityKg: 1000, windowDays: 10 }).length, 1);
});

test('booking a trip drafts one manifest message to the carrier and one to the driver, not one per load', async () => {
  loads = [await load(3000), await load(6000), await load(1000)];
  tripId = (await json(admin, 'POST', '/api/v2/trips', {
    origin: 'Samarkand', destination: 'Khiva', capacityWeightKg: 20000, cost: 900, carrierId: carrier, truckPlate: '01 A 777 BC', driverName: 'Aziz', driverPhone: '+998 90 111 22 33', scheduledPickup: '2026-12-01'
  })).body.trip.id;
  for (const id of loads) assert.equal((await json(admin, 'POST', `/api/v2/trips/${tripId}/shipments`, { shipmentId: id })).status, 201);
  assert.equal((await json(admin, 'POST', `/api/v2/trips/${tripId}/status`, { status: 'Booked' })).status, 200);
  await nexus.idle();

  const messages = (await tasks()).filter((task) => task.kind === 'message' && task.payload.tripId === tripId);
  assert.deepEqual(messages.map((task) => [task.payload.recipient, task.payload.purpose]).sort(), [['carrier', 'booking_confirmation'], ['driver', 'pickup_details']]);
  const toCarrier = messages.find((task) => task.payload.recipient === 'carrier');
  assert.equal(toCarrier.payload.to, '+1 214 555 0111');
  for (const id of loads) assert.ok(toCarrier.payload.body.includes(id), `the manifest names ${id}`);
  assert.match(toCarrier.payload.body, new RegExp(`trip T-${tripId} booked with LTL Express`));
  assert.match(toCarrier.payload.body, /truck 01 A 777 BC, driver Aziz/);
  assert.match(toCarrier.payload.body, /3 loads, 10000 kg/);
  assert.match(toCarrier.payload.body, /Price \$900\.00/);
  const toDriver = messages.find((task) => task.payload.recipient === 'driver');
  assert.equal(toDriver.payload.to, '+998 90 111 22 33');
  assert.match(toDriver.payload.body, /Hello Aziz, trip T-\d+/);

  // Each customer is told their own load is booked; the carrier gets no message per load.
  const perLoad = (await tasks()).filter((task) => task.kind === 'message' && !task.payload.tripId && loads.includes(task.shipmentId));
  assert.deepEqual(perLoad.map((task) => task.payload.recipient).sort(), ['customer', 'customer', 'customer']);
});

test('a trip in Exception raises one task for the trip, which closes when it resumes', async () => {
  await json(admin, 'POST', `/api/v2/trips/${tripId}/status`, { status: 'In Transit' });
  await json(admin, 'POST', `/api/v2/trips/${tripId}/status`, { status: 'Exception' });
  await nexus.idle();
  const raised = (await tasks()).filter((task) => /is in Exception/.test(task.title) && (task.title.includes(`T-${tripId}`) || loads.includes(task.shipmentId)));
  assert.equal(raised.length, 1, 'one task for the trip, not three for its loads');
  assert.match(raised[0].title, new RegExp(`Trip T-${tripId} is in Exception · 3 loads`));
  await json(admin, 'POST', `/api/v2/trips/${tripId}/status`, { status: 'In Transit' });
  await nexus.idle();
  assert.equal((await tasks()).some((task) => /is in Exception/.test(task.title)), false);
});

test('a trip on the road with no position is flagged once per silence, as one task for the whole truck', async () => {
  assert.equal(await nexus.sweep(), 0, 'it just left');
  await sql("UPDATE trips SET updated_at = datetime('now', '-1 day') WHERE id = ?", [tripId]);
  await sql("UPDATE shipments SET last_tracked_at = datetime('now', '-1 day') WHERE trip_id = ?", [tripId]);
  assert.equal(await nexus.sweep(), 1, 'one message for the truck, not one per load');
  const quiet = (await tasks()).filter((task) => /no update for/.test(task.title));
  assert.equal(quiet.length, 1);
  assert.match(quiet[0].title, new RegExp(`trip T-${tripId}`));
  assert.equal(quiet[0].payload.recipient, 'driver');
  assert.equal(quiet[0].payload.purpose, 'location_request');
  assert.equal(await nexus.sweep(), 0, 'not again for the same silence');
  assert.equal((await tasks()).some((task) => /call the driver/.test(task.title)), false, 'no whole-load reminders on top');
});

test('delivering the whole trip closes its tasks', async () => {
  for (const id of loads) await json(admin, 'POST', `/api/v2/trips/${tripId}/shipments/${id}/deliver`, {});
  await nexus.idle();
  assert.equal((await tasks()).some((task) => /no update for/.test(task.title)), false, 'the quiet-truck task is closed');
});

let poolIds;
test('loads that could share one truck become one task, which closes by itself when they are pooled', async () => {
  poolIds = [await load(3000, { origin: 'Bukhara', destination: 'Nukus' }), await load(6000, { origin: 'Bukhara', destination: 'Nukus' }), await load(1000, { origin: 'Bukhara', destination: 'Nukus' })];
  await load(500, { origin: 'Bukhara', destination: 'Urgench' });
  assert.equal(await nexus.poolingSweep(), 1);
  const pooled = (await tasks()).filter((task) => /can share one truck/.test(task.title));
  assert.equal(pooled.length, 1);
  assert.match(pooled[0].title, /3 loads can share one truck · Bukhara → Nukus/);
  assert.deepEqual(pooled[0].payload.shipmentIds, poolIds.map((id) => Number(id.replace('SHP-', ''))));
  assert.equal(await nexus.poolingSweep(), 0, 'once per group');

  // Putting one of them on a trip changes the group: the old task closes, the remaining two are suggested.
  const trip = (await json(admin, 'POST', '/api/v2/trips', { origin: 'Bukhara', destination: 'Nukus', capacityWeightKg: 20000 })).body.trip.id;
  await json(admin, 'POST', `/api/v2/trips/${trip}/shipments`, { shipmentId: poolIds[0] });
  assert.equal(await nexus.poolingSweep(), 1);
  const now = (await tasks()).filter((task) => /can share one truck/.test(task.title));
  assert.equal(now.length, 1);
  assert.match(now[0].title, /2 loads can share one truck/);
  await json(admin, 'POST', `/api/v2/trips/${trip}/shipments`, { shipmentId: poolIds[1] });
  assert.equal(await nexus.poolingSweep(), 0);
  assert.equal((await tasks()).some((task) => /can share one truck/.test(task.title)), false, 'one load left: nothing to pool');
  await json(admin, 'POST', `/api/v2/trips/${trip}/status`, { status: 'Cancelled' });
});

test('the suggestions can be switched off, and are visible through the API only to the company\'s own people', async () => {
  const api = await json(admin, 'GET', '/api/v2/trips/suggestions');
  assert.equal(api.status, 200);
  assert.equal(api.body.capacityKg, 20000);
  const pool = api.body.suggestions.find((entry) => entry.origin === 'Bukhara' && entry.destination === 'Nukus');
  assert.deepEqual(pool.loads.map((entry) => entry.shipmentId), poolIds);
  assert.equal(pool.totalWeightKg, 10000);
  const small = (await json(admin, 'GET', '/api/v2/trips/suggestions?capacityKg=7000')).body.suggestions.find((entry) => entry.origin === 'Bukhara');
  assert.deepEqual(small.loads.map((entry) => entry.shipmentId), [poolIds[1], poolIds[2]], 'a smaller truck takes fewer loads (the heaviest first)');
  assert.equal((await json(operator, 'GET', '/api/v2/trips/suggestions')).status, 200);
  assert.deepEqual((await json(other, 'GET', '/api/v2/trips/suggestions')).body.suggestions, []);

  assert.ok(Object.keys(nexus.AUTOMATIONS).includes('pooling'), 'a switch for pooling exists');
  assert.equal((await json(admin, 'PUT', '/api/settings/automations', { pooling: false })).status, 200);
  const extra = await load(2000, { origin: 'Bukhara', destination: 'Nukus' });
  assert.ok(extra);
  assert.equal(await nexus.poolingSweep(), 0, 'switched off: no new suggestion');
  await json(admin, 'PUT', '/api/settings/automations', { pooling: true });
});

test('the Trips page offers the suggestions', async () => {
  const script = await (await fetch(`${base}/trips.js`)).text();
  assert.ok(script.includes('/api/v2/trips/suggestions') && script.includes('Plan this trip'));
});
