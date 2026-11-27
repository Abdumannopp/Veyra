// Last mile (Phase 5.3): stops of a last-mile leg, proof of delivery per stop, failed stops and missed windows.
// Entered by dispatchers and drivers; no courier system is connected.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-lastmile-'));
Object.assign(process.env, { NODE_ENV: 'development', DATABASE_PATH: path.join(dir, 'l.db'), PORT: '0', BCRYPT_COST: '10', API_RATE_LIMIT_MAX: '5000' });
delete process.env.GEMINI_API_KEY;

const rules = require('../lib/last-mile');
const { app, initialize } = require('../server');
const { db } = require('../database');
const nexus = require('../agents/nexus');

let server; let base; let admin; let other; let load;
const call = (cookie, method, url, body) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
const json = async (...args) => { const res = await call(...args); return { status: res.status, body: await res.json() }; };
const stopTasks = async (cookie = admin) => (await json(cookie, 'GET', '/api/tasks')).body.tasks.filter((task) => /stop \d/.test(task.title));
const lastMile = (body) => body.legs.find((leg) => leg.mode === 'LAST_MILE');
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
  await call(admin, 'POST', '/api/platform/tenants', { companyName: 'Other Mile', adminName: 'Olga', adminEmail: 'olga@mile.example', adminPassword: 'OtherPass2026' });
  other = await login('olga@mile.example', 'OtherPass2026');
  const created = await json(admin, 'POST', '/api/v2/shipments', {
    customer: 'City Foods', origin: 'Hub', destination: 'Tashkent shops', pickup: '2026-12-01', delivery: '2026-12-02', weight: 900, equipment: 'Dry Van',
    legs: [{ mode: 'LAST_MILE', origin: 'Hub', destination: 'Tashkent shops', reference: 'ROUTE-7', details: { courier: 'City Courier' } }]
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  load = { id: created.body.shipment.id, leg: created.body.legs[0] };
});
after(async () => {
  await nexus.idle();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => db.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rules: stops and proofs of delivery are checked; a closed window is missed; the summary counts stops', () => {
  assert.throws(() => rules.readStop({}), /address is required/);
  assert.throws(() => rules.readStop({ address: 'A', contactPhone: 'call me' }), /phone number/);
  assert.throws(() => rules.readStop({ address: 'A', pieces: 0 }), /pieces/);
  assert.throws(() => rules.readStop({ address: 'A', windowFrom: '2026-12-01T12:00', windowTo: '2026-12-01T10:00' }), /after windowFrom/);
  assert.equal(rules.readStop({ address: ' Shop 1 ', windowTo: '2026-12-01T10:00' }).windowTo, '2026-12-01 10:00:00');
  assert.throws(() => rules.readDelivery({}), /receivedBy is required/);
  assert.throws(() => rules.readDelivery({ receivedBy: 'A', deliveredAt: '2099-01-01T00:00' }), /future/);
  assert.throws(() => rules.readFailure({}), /reason is required/);
  const now = new Date('2026-12-01T12:00:00Z');
  assert.equal(rules.missedWindow({ status: 'Pending', windowTo: '2026-12-01 10:00:00' }, { now }), true);
  assert.equal(rules.missedWindow({ status: 'Pending', windowTo: '2026-12-01 11:30:00' }, { now }), false, 'within the grace hour');
  assert.equal(rules.missedWindow({ status: 'Delivered', windowTo: '2026-12-01 10:00:00' }, { now }), false);
  assert.deepEqual(rules.summary([{ status: 'Delivered' }, { status: 'Failed' }]), { total: 2, pending: 0, delivered: 1, failed: 1, done: true, complete: false });
});

test('API: stops are added to a last-mile leg only; other companies cannot see or change them', async () => {
  assert.equal((await json(admin, 'POST', `/api/v2/legs/${load.leg.id}/stops`, {})).status, 400);
  const first = await json(admin, 'POST', `/api/v2/legs/${load.leg.id}/stops`, { address: 'Shop 1, Chilonzor', contactName: 'Aziz', contactPhone: '+998 90 111 22 33', pieces: 4, windowTo: '2026-11-01T10:00Z' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  await json(admin, 'POST', `/api/v2/legs/${load.leg.id}/stops`, { address: 'Shop 2, Yunusobod', pieces: 6 });
  const third = await json(admin, 'POST', `/api/v2/legs/${load.leg.id}/stops`, { address: 'Shop 3, Sergeli' });
  const leg = lastMile(third.body);
  assert.deepEqual(leg.stops.map((stop) => [stop.sequence, stop.status]), [[1, 'Pending'], [2, 'Pending'], [3, 'Pending']]);
  assert.equal(leg.stopSummary.total, 3);
  assert.equal((await json(other, 'POST', `/api/v2/legs/${load.leg.id}/stops`, { address: 'X' })).status, 404);
  assert.equal((await json(other, 'POST', `/api/v2/stops/${leg.stops[0].id}/deliver`, { receivedBy: 'X' })).status, 404);
  assert.equal((await json(admin, 'POST', `/api/v2/stops/${leg.stops[0].id}/deliver`, { receivedBy: 'Aziz' })).status, 409, 'the leg has not started');
  assert.equal((await json(admin, 'DELETE', `/api/v2/stops/${leg.stops[2].id}`)).status, 200);
  load.stops = leg.stops.slice(0, 2);
});

test('deliver with proof, fail with a reason (one task), try again; the last delivered stop completes the leg', async () => {
  const [first, second] = load.stops;
  for (const status of ['Booked', 'In Transit']) assert.equal((await json(admin, 'POST', `/api/v2/legs/${load.leg.id}/status`, { status })).status, 200, status);
  // A missed window makes one task, closed once the stop is delivered.
  assert.equal(await nexus.stopSweep(), 1);
  assert.equal(await nexus.stopSweep(), 0);
  assert.equal((await json(admin, 'POST', `/api/v2/stops/${first.id}/deliver`, { receivedBy: '' })).status, 400);
  assert.equal((await json(admin, 'POST', `/api/v2/stops/${first.id}/deliver`, { receivedBy: 'Aziz', documentId: 99999 })).status, 404, 'a document of this load only');
  const delivered = await json(admin, 'POST', `/api/v2/stops/${first.id}/deliver`, { receivedBy: 'Aziz', note: 'Signed' });
  assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
  assert.equal(lastMile(delivered.body).stops[0].receivedBy, 'Aziz');
  assert.equal(lastMile(delivered.body).status, 'In Transit', 'one stop is still pending');
  assert.equal((await json(admin, 'POST', `/api/v2/stops/${first.id}/deliver`, { receivedBy: 'Aziz' })).status, 409, 'once');
  await nexus.stopSweep();
  assert.equal((await stopTasks()).filter((task) => /window/.test(task.title)).length, 0, 'the window task closed');

  assert.equal((await json(admin, 'POST', `/api/v2/stops/${second.id}/fail`, {})).status, 400);
  const failed = await json(admin, 'POST', `/api/v2/stops/${second.id}/fail`, { reason: 'Shop closed' });
  assert.equal(lastMile(failed.body).stops[1].status, 'Failed');
  await nexus.idle();
  const tasks = await stopTasks();
  assert.equal(tasks.length, 1);
  assert.match(tasks[0].title, /stop 2 not delivered — Shop closed/);
  assert.equal((await stopTasks(other)).length, 0);

  assert.equal((await json(admin, 'POST', `/api/v2/stops/${second.id}/retry`)).status, 200);
  const last = await json(admin, 'POST', `/api/v2/stops/${second.id}/deliver`, { receivedBy: 'Shop 2 manager' });
  assert.equal(last.body.legDelivered, true);
  assert.equal(lastMile(last.body).status, 'Delivered');
  assert.equal(last.body.shipment.status, 'Delivered', 'the load follows its only leg');
  assert.equal((await json(admin, 'POST', `/api/v2/legs/${load.leg.id}/stops`, { address: 'Late shop' })).status, 409, 'a delivered leg takes no new stops');
});
