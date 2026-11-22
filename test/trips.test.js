// Trips (LTL): one truck run that carries several shipments. Capacity is checked, the truck's price is shared
// by weight, loads on a trip move with it (booked, in transit, delivered one by one), and the carrier is freed at the end.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-trips-'));
Object.assign(process.env, { NODE_ENV: 'development', DATABASE_PATH: path.join(dir, 't.db'), PORT: '0', BCRYPT_COST: '10', API_RATE_LIMIT_MAX: '5000', NEXUS_ENABLED: 'false', CURRENCY: 'USD' });

const trips = require('../lib/trips');
const database = require('../database');
const { runAsTenant } = require('../lib/tenant-context');
const { app, initialize } = require('../server');
const { db } = database;

let server; let base; let admin; let operator; let other; let carrier;
const call = (cookie, method, url, body) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
const json = async (...args) => { const res = await call(...args); return { status: res.status, body: await res.json() }; };
async function login(email, password) {
  const res = await call(null, 'POST', '/api/login', { email, password });
  assert.equal(res.status, 200, email);
  return res.headers.get('set-cookie').split(';')[0];
}
let counter = 0;
async function ltl(weight, customerRate, extra = {}) {
  counter += 1;
  const created = await json(admin, 'POST', '/api/shipments', {
    customer: `LTL Customer ${counter}`, origin: 'Tashkent', destination: extra.destination || 'Almaty', pickup: '2026-12-01', delivery: '2026-12-03',
    weight, equipment: 'LTL', customerRate, ...extra.body
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.shipment.id;
}
const shipmentRow = async (id) => (await json(admin, 'GET', `/api/shipments/${id}`)).body;
const carrierStatus = async (id) => (await json(admin, 'GET', '/api/carriers')).body.find((entry) => entry.id === id).status;

before(async () => {
  await initialize();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await login('admin@veyra.ai', 'admin123');
  operator = await login('demo@veyra.ai', 'demo123');
  await call(admin, 'POST', '/api/platform/tenants', { companyName: 'Other Trips', adminName: 'Olga', adminEmail: 'olga@trips.example', adminPassword: 'OtherPass2026' });
  other = await login('olga@trips.example', 'OtherPass2026');
  carrier = (await json(admin, 'POST', '/api/carriers', { name: 'LTL Express', mode: 'LTL', phone: '+1 214 555 0111' })).body.carrier.id;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => db.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rules: weights in kilograms, and a price shared by weight that always adds up', () => {
  assert.equal(trips.weightToKg('18000 kg'), 18000);
  assert.equal(trips.weightToKg('5400 lb'), 2449.399);
  assert.equal(trips.weightToKg('20 t'), 20000);
  assert.equal(trips.weightToKg('abc'), null);
  assert.deepEqual(trips.splitMoney(1000, 'USD', [3000, 6000, 1000]), [300, 600, 100]);
  assert.deepEqual(trips.splitMoney(100, 'USD', [1, 1, 1]), [33.34, 33.33, 33.33]);
  assert.deepEqual(trips.splitMoney(1000, 'JPY', [3, 3, 4]), [300, 300, 400]);
  assert.deepEqual(trips.splitMoney(10, 'USD', [0, 0]), [5, 5], 'equal shares when no weight is known');
  assert.equal(trips.splitMoney(1234.57, 'EUR', [333.333, 666.667, 0.5]).reduce((a, b) => a + b, 0).toFixed(2), '1234.57');
  assert.throws(() => trips.readTripInput({ origin: 'A' }), /Destination is required/);
  assert.throws(() => trips.readAllocationInput({ shipmentId: 'x' }), /shipment number/);
});

let tripId; let s1; let s2; let s3;
test('a trip takes loads until the truck is full, and the price is shared by weight', async () => {
  const created = await json(admin, 'POST', '/api/v2/trips', { origin: 'Tashkent', destination: 'Almaty', capacityWeightKg: 10000, capacityPallets: 20, cost: 1000, truckPlate: '01 A 777 BC', driverName: 'Aziz', driverPhone: '+998 90 111 22 33' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  tripId = created.body.trip.id;
  assert.equal(created.body.trip.number, `T-${tripId}`);
  assert.equal(created.body.trip.status, 'Planned');
  assert.equal(created.body.trip.currency, 'USD');

  s1 = await ltl(3000, 500);
  s2 = await ltl(6000, 900);
  s3 = await ltl(2000, 200);
  assert.equal((await json(operator, 'POST', `/api/v2/trips/${tripId}/shipments`, { shipmentId: s1 })).status, 403, 'putting loads on a truck is a dispatcher decision');
  assert.equal((await json(admin, 'POST', `/api/v2/trips/${tripId}/shipments`, { shipmentId: s1, pallets: 6 })).status, 201);
  assert.equal((await json(admin, 'POST', `/api/v2/trips/${tripId}/shipments`, { shipmentId: s2, pallets: 10 })).status, 201);
  const tooHeavy = await json(admin, 'POST', `/api/v2/trips/${tripId}/shipments`, { shipmentId: s3 });
  assert.equal(tooHeavy.status, 409);
  assert.match(tooHeavy.body.message, /does not fit: the truck takes 10000 kg, 9000 kg are on it and this load is 2000 kg/);
  const tooBulky = await json(admin, 'POST', `/api/v2/trips/${tripId}/shipments`, { shipmentId: s3, weightKg: 1000, pallets: 5 });
  assert.equal(tooBulky.status, 409);
  assert.match(tooBulky.body.message, /pallet places/);
  const fits = await json(admin, 'POST', `/api/v2/trips/${tripId}/shipments`, { shipmentId: s3, weightKg: 1000, pallets: 4 });
  assert.equal(fits.status, 201);
  assert.equal((await json(admin, 'POST', `/api/v2/trips/${tripId}/shipments`, { shipmentId: s3 })).status, 409, 'already on the trip');

  const view = fits.body;
  assert.deepEqual(view.shipments.map((item) => [item.shipmentId, item.weightKg, item.costShare]), [[s1, 3000, 300], [s2, 6000, 600], [s3, 1000, 100]]);
  assert.equal(view.trip.totals.weightKg, 10000);
  assert.equal(view.trip.totals.weightUtilization, 1);
  assert.equal(view.trip.totals.revenue, 1600);
  assert.equal(view.trip.totals.margin, 600, 'what the customers pay minus the truck');
  assert.equal((await shipmentRow(s1)).status, 'New', 'not booked yet');
});

test('booking puts every load on the truck: carrier, plate, cost share and Dispatched; the carrier is busy', async () => {
  assert.equal((await json(admin, 'POST', `/api/v2/trips/${tripId}/status`, { status: 'Booked' })).status, 409, 'no carrier yet');
  assert.equal((await json(admin, 'PATCH', `/api/v2/trips/${tripId}`, { carrierId: carrier })).status, 200);
  assert.equal((await json(operator, 'POST', `/api/v2/trips/${tripId}/status`, { status: 'Booked' })).status, 403);
  const booked = await json(admin, 'POST', `/api/v2/trips/${tripId}/status`, { status: 'Booked' });
  assert.equal(booked.status, 200, JSON.stringify(booked.body));
  assert.equal(booked.body.trip.status, 'Booked');
  for (const [id, share] of [[s1, 300], [s2, 600], [s3, 100]]) {
    const row = await shipmentRow(id);
    assert.deepEqual([row.status, row.carrierId, row.rate, row.truckPlate, row.driverName, row.currency], ['Dispatched', carrier, share, '01 A 777 BC', 'Aziz', 'USD'], id);
  }
  assert.equal(await carrierStatus(carrier), 'Busy');

  // The ordinary single-truck actions are refused on a load that travels on a trip.
  for (const [method, url, body] of [
    ['PATCH', `/api/admin/shipments/${s1}/status`, { status: 'Cancelled' }],
    ['POST', `/api/admin/shipments/${s1}/dispatch`, { carrierId: carrier, rate: 100 }],
    ['POST', `/api/shipments/${s1}/tracking`, { location: 'Somewhere' }]
  ]) {
    const refused = await json(admin, method, url, body);
    assert.equal(refused.status, 409, url);
    assert.match(refused.body.message, new RegExp(`trip T-${tripId}`));
  }
  const another = await ltl(500, 50);
  await json(admin, 'PATCH', `/api/admin/shipments/${another}/status`, { status: 'Sourcing' });
  assert.equal((await json(admin, 'POST', `/api/admin/shipments/${another}/dispatch`, { carrierId: carrier, rate: 100 })).status, 409, 'the busy carrier cannot take another load');
});

test('a load can be added to or taken off a booked trip; the shares follow', async () => {
  const late = await ltl(500, 50);
  assert.equal((await json(admin, 'POST', `/api/v2/trips/${tripId}/shipments`, { shipmentId: late })).status, 409, 'the truck is full');
  const off = await json(admin, 'DELETE', `/api/v2/trips/${tripId}/shipments/${s3}`);
  assert.equal(off.status, 200);
  assert.deepEqual(off.body.shipments.map((item) => [item.shipmentId, item.costShare]), [[s1, 333.33], [s2, 666.67]]);
  const freed = await shipmentRow(s3);
  assert.deepEqual([freed.status, freed.carrierId, freed.rate, freed.truckPlate], ['Sourcing', null, null, null], 'it waits for a truck again');
  assert.equal((await shipmentRow(s1)).rate, 333.33);

  const added = await json(admin, 'POST', `/api/v2/trips/${tripId}/shipments`, { shipmentId: late });
  assert.equal(added.status, 201);
  assert.deepEqual(added.body.shipments.map((item) => item.costShare), [315.79, 631.58, 52.63], '3000:6000:500 of 1000');
  assert.equal(added.body.shipments.reduce((sum, item) => sum + item.costShare, 0).toFixed(2), '1000.00');
  const row = await shipmentRow(late);
  assert.deepEqual([row.status, row.carrierId, row.rate], ['Dispatched', carrier, 52.63], 'booked with the trip at once');
  assert.equal(added.body.trip.totals.weightKg, 9500);
  s3 = late;
  const edited = await json(admin, 'PATCH', `/api/v2/trips/${tripId}`, { cost: 1200 });
  assert.equal(edited.status, 200);
  assert.equal((await shipmentRow(s1)).rate, 378.95, 'a new truck price reaches the loads');
  assert.equal((await json(admin, 'PATCH', `/api/v2/trips/${tripId}`, { carrierId: null })).status, 409, 'the carrier of a booked trip cannot change');
  assert.equal((await json(admin, 'PATCH', `/api/v2/trips/${tripId}`, { capacityWeightKg: 5000 })).status, 409, 'not below what is on it');
  await json(admin, 'PATCH', `/api/v2/trips/${tripId}`, { cost: 1000 });
});

test('the trip leaves: loads are in transit, one position covers them all, GPS reaches every load of the truck', async () => {
  assert.equal((await json(admin, 'POST', `/api/v2/trips/${tripId}/status`, { status: 'In Transit' })).status, 200);
  for (const id of [s1, s2, s3]) assert.equal((await shipmentRow(id)).status, 'In Transit');

  assert.equal((await json(operator, 'POST', `/api/v2/trips/${tripId}/tracking`, { location: 'Chimkent', eta: '2026-12-02' })).status, 201);
  for (const id of [s1, s2, s3]) {
    const updates = (await json(admin, 'GET', `/api/shipments/${id}/tracking`)).body.updates;
    assert.equal(updates[0].location, 'Chimkent', `${id} shows the truck's position`);
    assert.equal((await shipmentRow(id)).lastLocation, 'Chimkent');
  }
  const gps = await runAsTenant(1, () => database.recordGpsPositions(1, [{ truckPlate: '01 A 777 BC', lat: 42.9, lng: 71.4 }], { minIntervalMinutes: 0 }));
  assert.equal(gps.accepted, 3, 'the one truck reports for its three loads');

  assert.equal((await json(admin, 'POST', `/api/v2/trips/${tripId}/status`, { status: 'Exception', note: 'Border queue' })).status, 200);
  assert.equal((await shipmentRow(s2)).status, 'Exception');
  assert.equal((await json(admin, 'POST', `/api/v2/trips/${tripId}/status`, { status: 'In Transit' })).status, 200);
  assert.equal((await shipmentRow(s2)).status, 'In Transit');
  assert.equal((await json(admin, 'POST', `/api/v2/trips/${tripId}/shipments`, { shipmentId: await ltl(100, 10) })).status, 409, 'too late to add a load');
});

test('loads are delivered one by one; the last delivery delivers the trip and frees the carrier', async () => {
  const early = await json(admin, 'POST', `/api/v2/trips/${tripId}/status`, { status: 'Delivered' });
  assert.equal(early.status, 409, 'not every load is delivered');
  const first = await json(admin, 'POST', `/api/v2/trips/${tripId}/shipments/${s1}/deliver`, { note: 'Signed by Anna' });
  assert.equal(first.status, 200);
  assert.equal(first.body.trip.status, 'In Transit');
  assert.equal((await shipmentRow(s1)).status, 'Delivered');
  assert.equal((await json(admin, 'POST', `/api/v2/trips/${tripId}/shipments/${s1}/deliver`, {})).status, 409, 'already delivered');
  assert.equal((await json(admin, 'POST', `/api/v2/trips/${tripId}/shipments`, { shipmentId: s1 })).status, 409);
  await json(admin, 'POST', `/api/v2/trips/${tripId}/shipments/${s2}/deliver`, {});
  assert.equal(await carrierStatus(carrier), 'Busy', 'still carrying one load');
  const last = await json(admin, 'POST', `/api/v2/trips/${tripId}/shipments/${s3}/deliver`, {});
  assert.equal(last.body.trip.status, 'Delivered');
  assert.equal(await carrierStatus(carrier), 'Available');
  assert.ok(last.body.events.some((event) => event.toStatus === 'Delivered'));
});

test('Finance: the carrier is owed each load\'s share, and is paid load by load', async () => {
  let summary = (await json(admin, 'GET', '/api/finance/summary')).body;
  assert.equal(summary.payable, 1000, 'the truck price, shared among the three delivered loads');
  assert.equal(summary.payableLoads, 3);
  const row = summary.open.find((entry) => entry.id === s1);
  assert.equal(row.rate, 315.79);
  const paid = await json(admin, 'PATCH', `/api/shipments/${s1}/payment`, { carrierPaid: true });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  summary = (await json(admin, 'GET', '/api/finance/summary')).body;
  assert.equal(summary.payable, 684.21);
});

test('cancelling a booked trip gives the loads back and frees the carrier; they can go on another trip', async () => {
  const a = await ltl(1000, 100);
  const b = await ltl(2000, 200);
  const trip = (await json(admin, 'POST', '/api/v2/trips', { origin: 'Tashkent', destination: 'Almaty', capacityWeightKg: 5000, carrierId: carrier, cost: 300 })).body.trip.id;
  await json(admin, 'POST', `/api/v2/trips/${trip}/shipments`, { shipmentId: a });
  await json(admin, 'POST', `/api/v2/trips/${trip}/shipments`, { shipmentId: b });
  assert.equal((await json(admin, 'POST', `/api/v2/trips/${trip}/status`, { status: 'Booked' })).status, 200);
  assert.equal(await carrierStatus(carrier), 'Busy');
  const back = await json(admin, 'POST', `/api/v2/trips/${trip}/status`, { status: 'Planned' });
  assert.equal(back.status, 200);
  assert.equal(await carrierStatus(carrier), 'Available');
  assert.equal((await shipmentRow(a)).status, 'Sourcing');
  assert.equal(back.body.shipments.length, 2, 'the loads stay on the planned trip');
  assert.equal((await json(admin, 'PATCH', `/api/admin/shipments/${a}/status`, { status: 'Sourcing' })).status, 409, 'still on a trip');

  await json(admin, 'POST', `/api/v2/trips/${trip}/status`, { status: 'Booked' });
  const cancelled = await json(admin, 'POST', `/api/v2/trips/${trip}/status`, { status: 'Cancelled' });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.shipments.length, 0);
  assert.equal(await carrierStatus(carrier), 'Available');
  const row = await shipmentRow(a);
  assert.deepEqual([row.status, row.carrierId, row.rate], ['Sourcing', null, null]);
  assert.equal((await json(admin, 'PATCH', `/api/admin/shipments/${a}/status`, { status: 'Pending Approval' })).status, 200, 'an ordinary load again');
  const second = (await json(admin, 'POST', '/api/v2/trips', { origin: 'Tashkent', destination: 'Bukhara' })).body.trip.id;
  assert.equal((await json(admin, 'POST', `/api/v2/trips/${second}/shipments`, { shipmentId: a })).status, 201);
  assert.equal((await json(admin, 'POST', `/api/v2/trips/${second}/status`, { status: 'Cancelled' })).status, 200, 'a planned trip can be cancelled too');
});

test('what may not go on a trip, and who can see trips', async () => {
  const trip = (await json(admin, 'POST', '/api/v2/trips', { origin: 'A', destination: 'B' })).body.trip.id;
  const multi = await json(admin, 'POST', '/api/v2/shipments', {
    customer: 'Multi Co', origin: 'A', destination: 'B', pickup: '2026-12-01', delivery: '2026-12-02', weight: 100, equipment: 'Dry Van',
    legs: [{ mode: 'ROAD', origin: 'A', destination: 'B' }]
  });
  assert.equal((await json(admin, 'POST', `/api/v2/trips/${trip}/shipments`, { shipmentId: multi.body.shipment.id })).status, 409, 'a multi-leg load');
  const booked = await ltl(100, 10);
  await json(admin, 'PATCH', `/api/admin/shipments/${booked}/status`, { status: 'Sourcing' });
  const carrier2 = (await json(admin, 'POST', '/api/carriers', { name: 'Own Truck', mode: 'Truckload' })).body.carrier.id;
  await json(admin, 'POST', `/api/admin/shipments/${booked}/dispatch`, { carrierId: carrier2, rate: 100 });
  assert.equal((await json(admin, 'POST', `/api/v2/trips/${trip}/shipments`, { shipmentId: booked })).status, 409, 'it already has a truck');
  assert.equal((await json(admin, 'POST', `/api/v2/trips/${trip}/shipments`, { shipmentId: 999999 })).status, 404);
  assert.equal((await json(admin, 'POST', `/api/v2/trips/${trip}/shipments`, { shipmentId: 'nope' })).status, 400);

  assert.equal((await json(other, 'GET', `/api/v2/trips/${trip}`)).status, 404);
  assert.equal((await json(other, 'POST', `/api/v2/trips/${trip}/shipments`, { shipmentId: 1 })).status, 404);
  assert.equal((await json(other, 'POST', `/api/v2/trips/${trip}/status`, { status: 'Cancelled' })).status, 404);
  const own = (await json(other, 'GET', '/api/v2/trips')).body.trips;
  assert.deepEqual(own, [], "another company sees none of this company's trips");
  const list = (await json(admin, 'GET', '/api/v2/trips')).body.trips;
  assert.ok(list.length >= 3 && list[0].shipmentCount !== undefined);
  assert.equal((await json(operator, 'GET', `/api/v2/trips/${tripId}`)).status, 200, 'operators can look');
  assert.equal((await json(admin, 'POST', '/api/v2/trips', { origin: 'A' })).status, 400);
  assert.equal((await json(admin, 'POST', '/api/v2/trips', { origin: 'A', destination: 'B', carrierId: 999999 })).status, 404);
});
