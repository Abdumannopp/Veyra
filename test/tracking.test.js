// Global Tracking: booked loads with GPS and city positions, on-time state, alerts, company isolation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-track-'));
Object.assign(process.env, { NODE_ENV: 'development', DATABASE_PATH: path.join(dir, 't.db'), PORT: '0', BCRYPT_COST: '10', API_RATE_LIMIT_MAX: '5000', NEXUS_ENABLED: 'false', GEO_PROVIDER: 'osm' });
const { app, initialize } = require('../server');
const { db } = require('../database');
const geo = require('../integrations/geo');

let server; let base; let admin; let other; let lookups = [];
const call = (cookie, method, url, body, headers = {}) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
const json = async (...args) => (await call(...args)).json();
async function login(email, password) { return (await call(null, 'POST', '/api/login', { email, password })).headers.get('set-cookie').split(';')[0]; }
const places = { 'tashkent, uz': ['41.3', '69.24'], 'almaty, kz': ['43.24', '76.89'] };
let n = 0;
async function load(cookie, { status = 'In Transit', plate, delivery = '2030-05-12' } = {}) {
  n += 1;
  const id = (await json(cookie, 'POST', '/api/shipments', { customer: 'C', origin: 'Tashkent, UZ', destination: 'Almaty, KZ', pickup: '2030-05-10', delivery, weight: 100, equipment: 'Reefer' })).shipment.id;
  if (status === 'New') return id;
  const carrier = (await json(cookie, 'POST', '/api/carriers', { name: `Track Carrier ${n}`, mode: 'Truckload', phone: '+998 71 200 00 11' })).carrier;
  await call(cookie, 'PATCH', `/api/admin/shipments/${id}/status`, { status: 'Sourcing' });
  await call(cookie, 'POST', `/api/admin/shipments/${id}/dispatch`, { carrierId: carrier.id, rate: 1000, driverPhone: '+998 91 555 22 11', truckPlate: plate || `01 T ${n}` });
  if (status !== 'Dispatched') await call(cookie, 'PATCH', `/api/admin/shipments/${id}/status`, { status: 'In Transit' });
  if (status === 'Delivered' || status === 'Exception') await call(cookie, 'PATCH', `/api/admin/shipments/${id}/status`, { status });
  return id;
}

before(async () => {
  await initialize();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await login('admin@veyra.ai', 'admin123');
  await call(admin, 'POST', '/api/platform/tenants', { companyName: 'Track Other', adminName: 'Tim', adminEmail: 'tim@t.example', adminPassword: 'track-other-pass-1' });
  other = await login('tim@t.example', 'track-other-pass-1');
  geo.setTransport(async (url) => {
    lookups.push(url);
    const q = decodeURIComponent(/q=([^&]+)/.exec(url)?.[1] || '').toLowerCase();
    const hit = places[q];
    return new Response(JSON.stringify(hit ? [{ lat: hit[0], lon: hit[1] }] : []), { status: 200 });
  });
});
after(async () => {
  geo.setTransport(null);
  await new Promise((r) => server.close(r));
  await new Promise((r) => db.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('booked loads are listed with status, timeline and on-time state; unbooked loads are not', async () => {
  const moving = await load(admin, { plate: '01 GPS 1' });
  const booked = await load(admin, { status: 'Dispatched' });
  const problem = await load(admin, { status: 'Exception' });
  const done = await load(admin, { status: 'Delivered' });
  const fresh = await load(admin, { status: 'New' });
  const data = await json(admin, 'GET', '/api/tracking/overview');
  const ids = data.loads.map((l) => l.id);
  for (const id of [moving, booked, problem, done]) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes(fresh), 'a load without a truck is not tracked');
  assert.equal(data.summary.active, 3);
  assert.equal(data.summary.inTransit, 1);
  assert.equal(data.summary.booked, 1);
  assert.equal(data.summary.exceptions, 1);
  assert.equal(data.loads[0].id, problem, 'exceptions come first');
  const m = data.loads.find((l) => l.id === moving);
  assert.ok(m.timeline.bookedAt && m.timeline.departedAt && !m.timeline.deliveredAt);
  assert.equal(m.onTime, true);
  assert.equal(data.loads.find((l) => l.id === done).onTime, null);
  assert.deepEqual((await json(other, 'GET', '/api/tracking/overview')).loads, [], 'another company sees none of it');
});

test('GPS positions and city positions appear; unknown cities are looked up in the background, not in the request', async () => {
  // The first test's request already queued the two cities; they are looked up after that response was sent.
  for (let i = 0; i < 40 && lookups.length < 2; i += 1) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 1300));
  const token = (await json(admin, 'POST', '/api/integrations/gps/token')).token;
  const gps = await call(null, 'POST', '/api/integrations/gps', { positions: [{ truckPlate: '01 GPS 1', lat: 42.3, lng: 73.1, address: 'Shymkent' }] }, { authorization: `Bearer ${token}` });
  assert.equal(gps.status, 200);
  const data = await json(admin, 'GET', '/api/tracking/overview');
  const m = data.loads.find((l) => l.gps);
  assert.deepEqual([m.gps.lat, m.gps.lng], [42.3, 73.1]);
  assert.deepEqual(m.from, { lat: 41.3, lng: 69.24 });
  assert.deepEqual(m.to, { lat: 43.24, lng: 76.89 });
  assert.equal(data.summary.withGps, 1);
  assert.equal(new Set(lookups.map((u) => decodeURIComponent(/q=([^&]+)/.exec(u)[1]).toLowerCase())).size, lookups.length, 'each city is looked up once');
});

test('a load whose expected arrival is after the promised day is not on time, and alerts are listed', async () => {
  const late = await load(admin, { delivery: '2030-05-12' });
  await call(admin, 'POST', `/api/shipments/${late}/tracking`, { location: 'Border', eta: '2030-05-14T10:00' });
  const data = await json(admin, 'GET', '/api/tracking/overview');
  assert.equal(data.loads.find((l) => l.id === late).onTime, false);
  assert.ok(data.summary.onTimeShare < 100);
  assert.ok(Array.isArray(data.alerts));
});
