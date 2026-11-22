// Shipment legs: one order moving in several legs (road, ocean, air, rail, warehouse, last mile).
// A classic single-truck load is one ROAD leg; a multi-leg load is driven through its legs only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-legs-'));
Object.assign(process.env, { NODE_ENV: 'development', DATABASE_PATH: path.join(dir, 'l.db'), PORT: '0', BCRYPT_COST: '10', API_RATE_LIMIT_MAX: '5000', NEXUS_ENABLED: 'false' });

const legsLib = require('../lib/legs');
const database = require('../database');
const { runAsSystem } = require('../lib/tenant-context');
const { app, initialize } = require('../server');
const { db } = database;

let server; let base; let admin; let operator; let other;
const call = (cookie, method, url, body) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
const json = async (...args) => { const res = await call(...args); return { status: res.status, body: await res.json() }; };
async function login(email, password) {
  const res = await call(null, 'POST', '/api/login', { email, password });
  assert.equal(res.status, 200, email);
  return res.headers.get('set-cookie').split(';')[0];
}

const header = { customer: 'Silk Road Foods', origin: 'Tashkent', destination: 'Hamburg', pickup: '2026-12-01', delivery: '2026-12-30', weight: 18000, equipment: 'Reefer' };
const threeLegs = () => [
  { mode: 'road', origin: 'Tashkent', destination: 'Poti Port', price: 1500, scheduledPickup: '2026-12-01', details: { truckPlate: '01 A 123 BC', driverName: 'Aziz' } },
  { mode: 'OCEAN', origin: 'Poti Port', destination: 'Hamburg Port', price: 2200.555, reference: 'BL-7788', details: { vessel: 'MSC Aurora', containerNo: 'MSCU1234566' } },
  { mode: 'LAST_MILE', origin: 'Hamburg Port', destination: 'Hamburg warehouse', price: 300, scheduledDelivery: '2026-12-29T09:30' }
];

before(async () => {
  await initialize();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await login('admin@veyra.ai', 'admin123');
  operator = await login('demo@veyra.ai', 'demo123');
  await call(admin, 'POST', '/api/platform/tenants', { companyName: 'Other Freight', adminName: 'Olga', adminEmail: 'olga@other.example', adminPassword: 'OtherPass2026' });
  other = await login('olga@other.example', 'OtherPass2026');
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => db.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rules: statuses roll up from legs, details belong to the mode, bad input is refused', () => {
  assert.equal(legsLib.rollupStatus(['Planned', 'Planned']), 'New');
  assert.equal(legsLib.rollupStatus(['Booked', 'Planned']), 'Dispatched');
  assert.equal(legsLib.rollupStatus(['Delivered', 'Planned']), 'In Transit');
  assert.equal(legsLib.rollupStatus(['Delivered', 'Cancelled']), 'Delivered');
  assert.equal(legsLib.rollupStatus(['In Transit', 'Exception']), 'Exception');
  assert.equal(legsLib.rollupStatus(['Cancelled']), 'Cancelled');
  assert.throws(() => legsLib.readLegInput({ mode: 'SPACE', origin: 'A', destination: 'B' }), /Mode must be one of/);
  assert.throws(() => legsLib.readLegInput({ mode: 'AIR', origin: 'A', destination: 'B', details: { vessel: 'x' } }), /not a AIR detail/);
  assert.throws(() => legsLib.readLegInput({ mode: 'AIR', origin: 'A', destination: 'B', scheduledPickup: 'tomorrow' }), /date/);
  assert.equal(legsLib.readLegInput({ mode: 'air', origin: 'A', destination: 'B', scheduledPickup: '2026-12-01T08:00' }).scheduledPickup, '2026-12-01 08:00:00');
});

test('a load is created with legs; its status and total price follow the legs', async () => {
  assert.equal((await json(admin, 'POST', '/api/v2/shipments', { ...header, legs: [] })).status, 400);
  assert.equal((await json(admin, 'POST', '/api/v2/shipments', { ...header, legs: [{ mode: 'SPACE', origin: 'A', destination: 'B' }] })).status, 400);
  const created = await json(admin, 'POST', '/api/v2/shipments', { ...header, legs: threeLegs() });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.shipment.multi, true);
  assert.equal(created.body.shipment.status, 'New');
  assert.deepEqual(created.body.legs.map((leg) => [leg.sequence, leg.mode, leg.status]), [[1, 'ROAD', 'Planned'], [2, 'OCEAN', 'Planned'], [3, 'LAST_MILE', 'Planned']]);
  assert.equal(created.body.legs[1].price, 2200.56, 'prices are rounded to the currency');
  assert.equal(created.body.legs[0].details.truckPlate, '01 A 123 BC');
  assert.equal(created.body.legs[2].scheduledDelivery, '2026-12-29 09:30:00');
  const id = created.body.shipment.id;
  const classic = (await json(admin, 'GET', '/api/admin/shipments')).body.shipments.find((shipment) => shipment.id === id);
  assert.equal(classic.legMode, 'multi');
  assert.equal(classic.rate, 4000.56, 'the load price is the sum of its legs');
});

test('legs move in order: booking needs a carrier or reference, a leg waits for the one before it, handovers are recorded', async () => {
  const created = await json(admin, 'POST', '/api/v2/shipments', { ...header, customer: 'Ordered Co', legs: threeLegs() });
  const id = created.body.shipment.id;
  const [road, ocean, last] = created.body.legs;

  assert.equal((await json(admin, 'POST', `/api/v2/legs/${road.id}/status`, { status: 'Booked' })).status, 409, 'no carrier or reference yet');
  const carrier = (await json(admin, 'POST', '/api/carriers', { name: 'Leg Trucking', mode: 'Truckload' })).body.carrier.id;
  assert.equal((await json(admin, 'PATCH', `/api/v2/legs/${road.id}`, { carrierId: carrier })).status, 200);
  assert.equal((await json(operator, 'POST', `/api/v2/legs/${road.id}/status`, { status: 'Booked' })).status, 403, 'booking is a dispatcher decision');
  const booked = await json(admin, 'POST', `/api/v2/legs/${road.id}/status`, { status: 'Booked' });
  assert.equal(booked.body.shipment.status, 'Dispatched');

  assert.equal((await json(admin, 'POST', `/api/v2/legs/${ocean.id}/status`, { status: 'Booked' })).status, 200);
  const early = await json(admin, 'POST', `/api/v2/legs/${ocean.id}/status`, { status: 'In Transit' });
  assert.equal(early.status, 409);
  assert.match(early.body.message, /Leg 1 \(ROAD\) is not delivered yet/);

  assert.equal((await json(admin, 'POST', `/api/v2/legs/${road.id}/status`, { status: 'In Transit' })).body.shipment.status, 'In Transit');
  const position = await json(operator, 'POST', `/api/v2/legs/${road.id}/tracking`, { location: 'Border post Bekabad', eta: '2026-12-03T18:00' });
  assert.equal(position.status, 201);
  assert.equal((await json(operator, 'POST', `/api/v2/legs/${ocean.id}/tracking`, { location: 'Poti' })).status, 201, 'a booked leg can be tracked');

  const delivered = await json(admin, 'POST', `/api/v2/legs/${road.id}/status`, { status: 'Delivered', handover: { location: 'Poti Port gate', receivedBy: 'Port agent Nika', note: '18 pallets' } });
  assert.equal(delivered.status, 200);
  assert.equal(delivered.body.handoverTo, ocean.id);
  assert.equal(delivered.body.handovers.length, 1);
  assert.deepEqual([delivered.body.handovers[0].fromLegId, delivered.body.handovers[0].toLegId, delivered.body.handovers[0].location, delivered.body.handovers[0].receivedBy], [road.id, ocean.id, 'Poti Port gate', 'Port agent Nika']);
  assert.equal(delivered.body.legs[0].lastLocation, 'Border post Bekabad');

  assert.equal((await json(admin, 'POST', `/api/v2/legs/${ocean.id}/status`, { status: 'In Transit' })).status, 200);
  assert.equal((await json(admin, 'POST', `/api/v2/legs/${ocean.id}/status`, { status: 'Delivered' })).body.handovers.length, 2, 'a default handover at the leg destination');
  await json(admin, 'PATCH', `/api/v2/legs/${last.id}`, { reference: 'PARCEL-1' });
  await json(admin, 'POST', `/api/v2/legs/${last.id}/status`, { status: 'Booked' });
  await json(admin, 'POST', `/api/v2/legs/${last.id}/status`, { status: 'In Transit' });
  const done = await json(admin, 'POST', `/api/v2/legs/${last.id}/status`, { status: 'Delivered' });
  assert.equal(done.body.shipment.status, 'Delivered');
  assert.equal(done.body.handovers.length, 2, 'the last leg has nothing to hand over to');

  const history = (await json(admin, 'GET', `/api/shipments/${id}/events`)).body;
  const statuses = (history.events || history.history || []).map((event) => event.toStatus || event.to_status || event.status);
  assert.ok(statuses.includes('Delivered') && statuses.includes('Dispatched'), JSON.stringify(history).slice(0, 300));
  assert.equal((await json(admin, 'PATCH', `/api/v2/legs/${road.id}`, { reference: 'late' })).status, 409, 'a delivered leg is closed');
  const detail = await json(admin, 'GET', `/api/v2/legs/${road.id}`);
  assert.deepEqual(detail.body.events.map((event) => event.toStatus).reverse(), ['Planned', 'Planned', 'Booked', 'In Transit', 'Delivered']);
});

test('the classic single-truck actions are refused on a multi-leg load', async () => {
  const created = await json(admin, 'POST', '/api/v2/shipments', { ...header, customer: 'Guard Co', legs: threeLegs() });
  const id = created.body.shipment.id;
  assert.equal((await json(admin, 'PATCH', `/api/admin/shipments/${id}/status`, { status: 'Sourcing' })).status, 409);
  assert.equal((await json(admin, 'POST', `/api/admin/shipments/${id}/dispatch`, { carrierId: 1, rate: 1000 })).status, 409);
  assert.equal((await json(admin, 'POST', `/api/shipments/${id}/tracking`, { location: 'Somewhere' })).status, 409);
});

test('a classic load is one ROAD leg; legs can be added until its truck is booked', async () => {
  const classic = await json(admin, 'POST', '/api/shipments', { ...header, customer: 'Classic Co', pickup: '2026-12-02', delivery: '2026-12-04', origin: 'Tashkent', destination: 'Almaty', customerRate: 900 });
  const id = classic.body.shipment.id;
  const view = (await json(admin, 'GET', `/api/v2/shipments/${id}`)).body;
  assert.equal(view.shipment.multi, false);
  assert.equal(view.legs.length, 1);
  assert.deepEqual([view.legs[0].mode, view.legs[0].status, view.legs[0].synthetic, view.legs[0].origin, view.legs[0].destination], ['ROAD', 'Planned', true, 'Tashkent', 'Almaty']);

  const added = await json(admin, 'POST', `/api/v2/shipments/${id}/legs`, { mode: 'RAIL', origin: 'Almaty', destination: 'Xi an', details: { trainNo: 'T-91' } });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.shipment.multi, true);
  assert.deepEqual(added.body.legs.map((leg) => [leg.sequence, leg.mode, leg.synthetic]), [[1, 'ROAD', false], [2, 'RAIL', false]]);
  assert.equal(added.body.legs[0].origin, 'Tashkent', 'the first leg is the original load');

  const booked = await json(admin, 'POST', '/api/shipments', { ...header, customer: 'Booked Co' });
  const bookedId = booked.body.shipment.id;
  await json(admin, 'PATCH', `/api/admin/shipments/${bookedId}/status`, { status: 'Sourcing' });
  const carrier = (await json(admin, 'POST', '/api/carriers', { name: 'Booked Trucking', mode: 'Truckload' })).body.carrier.id;
  assert.equal((await json(admin, 'POST', `/api/admin/shipments/${bookedId}/dispatch`, { carrierId: carrier, rate: 1000 })).status, 200);
  const refused = await json(admin, 'POST', `/api/v2/shipments/${bookedId}/legs`, { mode: 'OCEAN', origin: 'A', destination: 'B' });
  assert.equal(refused.status, 409);
  assert.match(refused.body.message, /truck is already booked/);
  const view2 = (await json(admin, 'GET', `/api/v2/shipments/${bookedId}`)).body;
  assert.deepEqual([view2.legs[0].status, view2.legs[0].carrierId, view2.legs[0].price], ['Booked', carrier, 1000]);
});

test('operators cannot add legs; another company sees none of them', async () => {
  const created = await json(admin, 'POST', '/api/v2/shipments', { ...header, customer: 'Private Co', legs: threeLegs() });
  const id = created.body.shipment.id;
  const legId = created.body.legs[0].id;
  assert.equal((await json(operator, 'POST', `/api/v2/shipments/${id}/legs`, { mode: 'AIR', origin: 'A', destination: 'B' })).status, 403);
  assert.equal((await json(other, 'GET', `/api/v2/shipments/${id}`)).status, 404);
  assert.equal((await json(other, 'GET', `/api/v2/legs/${legId}`)).status, 404);
  assert.equal((await json(other, 'POST', `/api/v2/legs/${legId}/status`, { status: 'Cancelled' })).status, 404);
  assert.equal((await json(other, 'PATCH', `/api/v2/legs/${legId}`, { reference: 'x' })).status, 404);
  assert.equal((await json(admin, 'GET', `/api/v2/legs/${legId}`)).status, 200);
});

test('a leg uses only the company\'s own carriers; documents can be filed under a leg of their own load', async () => {
  const created = await json(admin, 'POST', '/api/v2/shipments', { ...header, customer: 'Docs Co', legs: threeLegs() });
  const shipmentId = Number(created.body.shipment.id.replace('SHP-', ''));
  const legs = created.body.legs;
  const foreignCarrier = (await json(other, 'POST', '/api/carriers', { name: 'Foreign Trucking', mode: 'Truckload' })).body.carrier.id;
  assert.equal((await json(admin, 'PATCH', `/api/v2/legs/${legs[0].id}`, { carrierId: foreignCarrier })).status, 404);

  const docId = (await runAsSystem(() => database.sql.run(
    "INSERT INTO documents (tenant_id, shipment_id, doc_type, filename, mime, size, sha256, content) VALUES (1, ?, 'cmr', 'cmr.pdf', 'application/pdf', 3, 'abc', ?)",
    [shipmentId, Buffer.from('pdf')]
  ))).id;
  assert.equal((await json(admin, 'PUT', `/api/v2/documents/${docId}/leg`, { legId: 999999 })).status, 404);
  assert.equal((await json(admin, 'PUT', `/api/v2/documents/${docId}/leg`, { legId: legs[0].id })).status, 200);
  assert.deepEqual((await json(admin, 'GET', `/api/v2/legs/${legs[0].id}`)).body.documents.map((doc) => doc.filename), ['cmr.pdf']);
  assert.equal((await json(other, 'PUT', `/api/v2/documents/${docId}/leg`, { legId: null })).status, 404);
});

test('cancelling every leg cancels the load; a cancelled leg is skipped by the handover', async () => {
  const created = await json(admin, 'POST', '/api/v2/shipments', { ...header, customer: 'Cancel Co', legs: threeLegs() });
  const legs = created.body.legs;
  await json(admin, 'POST', `/api/v2/legs/${legs[1].id}/status`, { status: 'Cancelled' });
  await json(admin, 'PATCH', `/api/v2/legs/${legs[0].id}`, { reference: 'BOOK-1' });
  await json(admin, 'POST', `/api/v2/legs/${legs[0].id}/status`, { status: 'Booked' });
  await json(admin, 'POST', `/api/v2/legs/${legs[0].id}/status`, { status: 'In Transit' });
  const delivered = await json(admin, 'POST', `/api/v2/legs/${legs[0].id}/status`, { status: 'Delivered' });
  assert.equal(delivered.body.handoverTo, legs[2].id, 'the cancelled ocean leg is skipped');
  let last = delivered;
  for (const leg of [legs[2]]) last = await json(admin, 'POST', `/api/v2/legs/${leg.id}/status`, { status: 'Cancelled' });
  assert.equal(last.body.shipment.status, 'Delivered', 'delivered leg 1 and nothing else going');
  const second = await json(admin, 'POST', '/api/v2/shipments', { ...header, customer: 'Cancel Two', legs: threeLegs().slice(0, 2) });
  for (const leg of second.body.legs) await json(admin, 'POST', `/api/v2/legs/${leg.id}/status`, { status: 'Cancelled' });
  assert.equal((await json(admin, 'GET', `/api/v2/shipments/${second.body.shipment.id}`)).body.shipment.status, 'Cancelled');
});

test('the screens for legs are served and wired into the page', async () => {
  const page = await (await fetch(`${base}/`)).text();
  for (const marker of ['id="legsSection"', 'id="legPlannerModal"', 'data-plan-legs', 'src="legs.js"', 'href="legs.css"']) assert.ok(page.includes(marker), marker);
  for (const file of ['legs.js', 'legs.css']) assert.equal((await fetch(`${base}/${file}`)).status, 200, file);
  const list = (await json(admin, 'GET', '/api/admin/shipments')).body.shipments;
  assert.ok(list.every((shipment) => ['single', 'multi'].includes(shipment.legMode)), 'every load says how it moves');
});
