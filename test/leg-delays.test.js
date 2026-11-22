// Schedules and delays (Phase 4.2): a leg that is late, or whose handover is at risk, is shown on the leg
// and NEXUS makes one task for it; the task closes by itself when the leg is on time, delivered or cancelled.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-delays-'));
Object.assign(process.env, { NODE_ENV: 'development', DATABASE_PATH: path.join(dir, 'd.db'), PORT: '0', BCRYPT_COST: '10', API_RATE_LIMIT_MAX: '5000' });
delete process.env.OPENROUTER_API_KEY;

const { legTiming, planMoment } = require('../lib/legs');
const { app, initialize } = require('../server');
const { db } = require('../database');
const nexus = require('../agents/nexus');

let server; let base; let admin; let other; let load;
const call = (cookie, method, url, body) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
const json = async (...args) => { const res = await call(...args); return { status: res.status, body: await res.json() }; };
const delayTasks = async (cookie = admin) => (await json(cookie, 'GET', '/api/tasks')).body.tasks.filter((task) => / leg \d/.test(task.title) && /planned|pickup|ETA|arrive/.test(task.title));
const legs = async () => (await json(admin, 'GET', `/api/v2/shipments/${load.id}`)).body.legs;
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
  await call(admin, 'POST', '/api/platform/tenants', { companyName: 'Other Delays', adminName: 'Olga', adminEmail: 'olga@delays.example', adminPassword: 'OtherPass2026' });
  other = await login('olga@delays.example', 'OtherPass2026');
  const carrier = (await json(admin, 'POST', '/api/carriers', { name: 'Road Co', mode: 'Truckload', phone: '+1 214 555 0100' })).body.carrier.id;
  const created = await json(admin, 'POST', '/api/v2/shipments', {
    customer: 'Delay Foods', origin: 'Tashkent', destination: 'Hamburg', pickup: '2026-12-01', delivery: '2026-12-30', weight: 18000, equipment: 'Reefer',
    legs: [
      { mode: 'ROAD', origin: 'Tashkent', destination: 'Poti Port', carrierId: carrier, scheduledPickup: '2026-12-01T08:00', scheduledDelivery: '2026-12-05T18:00' },
      { mode: 'OCEAN', origin: 'Poti Port', destination: 'Hamburg Port', carrierId: carrier, scheduledPickup: '2026-12-06T06:00', scheduledDelivery: '2026-12-20' }
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

test('rules: a date means the end of that day; each kind of delay is found; small differences are not late', () => {
  assert.equal(planMoment('2026-12-05').toISOString(), '2026-12-05T23:59:59.000Z');
  assert.equal(planMoment('Oct 3'), null);
  const now = new Date('2026-12-05T12:00:00Z');
  const make = (extra) => ({ id: 1, status: 'In Transit', scheduledPickup: null, scheduledDelivery: null, eta: null, ...extra });
  assert.deepEqual(legTiming([make({ status: 'Booked', scheduledPickup: '2026-12-05T08:00' })], { now })[0].issues.map((i) => i.kind), ['pickup_missed']);
  assert.deepEqual(legTiming([make({ scheduledDelivery: '2026-12-04T12:00' })], { now })[0].issues.map((i) => [i.kind, i.hours]), [['overdue', 24]]);
  assert.deepEqual(legTiming([make({ scheduledDelivery: '2026-12-06T12:00', eta: '2026-12-07 00:00:00' })], { now })[0].issues.map((i) => [i.kind, i.hours]), [['eta_late', 12]]);
  assert.equal(legTiming([make({ scheduledDelivery: '2026-12-05T11:30' })], { now })[0].late, false, 'half an hour is within the grace');
  assert.equal(legTiming([make({ status: 'Delivered', scheduledDelivery: '2026-12-01' })], { now })[0].late, false);
  assert.equal(legTiming([make({ scheduledDelivery: '2026-12-05' })], { now })[0].late, false, 'due some time today');
  const handover = legTiming([
    make({ id: 1, scheduledDelivery: '2026-12-06T12:00', eta: '2026-12-07T10:00' }),
    make({ id: 2, status: 'Planned', scheduledPickup: '2026-12-07T06:00' })
  ], { now });
  assert.deepEqual(handover[1].issues.map((i) => [i.kind, i.hours]), [['handover_risk', 4]]);
  const cancelledBetween = legTiming([
    make({ id: 1, scheduledDelivery: '2026-12-08T12:00' }),
    make({ id: 2, status: 'Cancelled' }),
    make({ id: 3, status: 'Planned', scheduledPickup: '2026-12-08T06:00' })
  ], { now });
  assert.equal(cancelledBetween[2].issues[0].kind, 'handover_risk', 'a cancelled leg in between is skipped');
});

test('the API shows the timing of each leg', async () => {
  const [first] = await legs();
  assert.ok(first.timing, 'timing is part of every leg');
  assert.equal(typeof first.timing.late, 'boolean');
});

test('NEXUS: one task per late leg and per handover at risk; no duplicates; tasks close when the leg is fine', async () => {
  const [road, ocean] = load.legs;
  assert.equal((await json(admin, 'POST', `/api/v2/legs/${road.id}/status`, { status: 'Booked' })).status, 200);
  assert.equal((await json(admin, 'POST', `/api/v2/legs/${road.id}/status`, { status: 'In Transit' })).status, 200);
  await nexus.idle();
  // On the way, ahead of plan: nothing.
  assert.equal(await nexus.delaySweep(new Date('2026-12-03T12:00:00Z')), 0);
  // The truck reports an ETA one day late: the road leg is late and the ship leg's pickup is at risk.
  assert.equal((await json(admin, 'POST', `/api/v2/legs/${road.id}/tracking`, { location: 'Baku', eta: '2026-12-06T18:00Z' })).status, 201);
  assert.equal(await nexus.delaySweep(new Date('2026-12-03T12:00:00Z')), 2);
  assert.equal(await nexus.delaySweep(new Date('2026-12-03T12:00:00Z')), 0, 'not again');
  const titles = (await delayTasks()).map((task) => task.title).sort();
  assert.equal(titles.length, 2);
  assert.match(titles[0], /leg 1 \(road\): ETA is after the planned delivery \(24 h\)/i);
  assert.match(titles[1], /leg 2 \(ocean\): the leg before will arrive after this pickup \(12 h\)/i);
  assert.equal((await delayTasks(other)).length, 0, 'another company sees nothing');
  assert.equal((await legs())[1].timing.late, true);

  // The planner moves the ship pickup: the handover task closes, the road one stays.
  assert.equal((await json(admin, 'PATCH', `/api/v2/legs/${ocean.id}`, { scheduledPickup: '2026-12-07T06:00' })).status, 200);
  await nexus.delaySweep(new Date('2026-12-03T12:00:00Z'));
  assert.deepEqual((await delayTasks()).map((task) => task.title.match(/leg (\d)/)[1]), ['1']);

  // The truck arrives: the leg is delivered and its task closes.
  assert.equal((await json(admin, 'POST', `/api/v2/legs/${road.id}/status`, { status: 'Delivered' })).status, 200);
  await nexus.idle();
  await nexus.delaySweep(new Date('2026-12-06T20:00:00Z'));
  assert.equal((await delayTasks()).length, 0);
});
