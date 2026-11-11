// AI Command Center: numbers come from real work, and the automation switches really stop NEXUS jobs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-cc-'));
Object.assign(process.env, { NODE_ENV: 'development', DATABASE_PATH: path.join(dir, 'c.db'), PORT: '0', BCRYPT_COST: '10', API_RATE_LIMIT_MAX: '5000', CURRENCY: 'USD', MESSAGE_LANGUAGE: 'en', OPENROUTER_API_KEY: 'sk-or-test' });
const { app, initialize } = require('../server');
const { db } = require('../database');
const aiGateway = require('../ai/gateway');
const nexus = require('../agents/nexus');

let server; let base; let admin; let ops; let operator; let other; let aiCalls = 0;
const call = (cookie, method, url, body) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
const json = async (...args) => (await call(...args)).json();
async function login(email, password) { return (await call(null, 'POST', '/api/login', { email, password })).headers.get('set-cookie').split(';')[0]; }
const tasks = async (cookie = admin) => (await json(cookie, 'GET', '/api/tasks')).tasks;
let carrierNo = 0;
async function bookLoad(cookie = admin) {
  carrierNo += 1;
  const id = (await json(cookie, 'POST', '/api/shipments', { customer: 'C', origin: 'Tashkent, UZ', destination: 'Almaty, KZ', pickup: '2030-05-10', delivery: '2030-05-12', weight: 100, equipment: 'Reefer', customerPhone: '+998 90 111 22 33' })).shipment.id;
  const carrier = (await json(cookie, 'POST', '/api/carriers', { name: `CC Carrier ${carrierNo}`, mode: 'Truckload', phone: '+998 71 200 00 11' })).carrier;
  await call(cookie, 'PATCH', `/api/admin/shipments/${id}/status`, { status: 'Sourcing' });
  await call(cookie, 'POST', `/api/admin/shipments/${id}/dispatch`, { carrierId: carrier.id, rate: 1000, customerRate: 900, driverPhone: '+998 91 555 22 11', truckPlate: '01 A 1' });
  await nexus.idle();
  return id;
}

before(async () => {
  await initialize();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await login('admin@veyra.ai', 'admin123');
  ops = await login('ops@veyra.ai', 'ops123');
  operator = await login('demo@veyra.ai', 'demo123');
  await call(admin, 'POST', '/api/platform/tenants', { companyName: 'CC Other', adminName: 'Odil', adminEmail: 'odil@cc.example', adminPassword: 'cc-other-pass-123' });
  other = await login('odil@cc.example', 'cc-other-pass-123');
  aiGateway.setTransport(async () => { aiCalls += 1; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ customer: 'X', origin: 'A', destination: 'B', questions: [], confidence: 0.8 }) } }] }), { status: 200 }); });
});
after(async () => {
  await nexus.idle();
  aiGateway.setTransport(null);
  await new Promise((r) => server.close(r));
  await new Promise((r) => db.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the command center shows real work, live counts and all switches on by default', async () => {
  const id = await bookLoad();
  const data = await json(admin, 'GET', '/api/ai/command-center');
  assert.equal(data.success, true);
  assert.equal(data.canChange, true);
  assert.ok(data.automations.every((item) => item.on), 'everything is on until someone switches it off');
  assert.deepEqual(data.automations.map((item) => item.key).sort(), Object.keys(nexus.AUTOMATIONS).sort());
  assert.equal(data.live.onRoad, 1);
  assert.ok(data.performance.prepared >= 4, 'booking drafted 3 messages and a price warning');
  assert.equal(data.performance.byKind.message, 3);
  assert.ok(data.activity.some((item) => item.shipmentId === id));
  const operatorView = await json(operator, 'GET', '/api/ai/command-center');
  assert.equal(operatorView.canChange, false);
  const otherView = await json(other, 'GET', '/api/ai/command-center');
  assert.equal(otherView.performance.prepared, 0, 'another company sees only its own work');
  assert.equal(otherView.live.onRoad, 0);
});

test('switches: only administrators, only known keys, and they really stop the job', async () => {
  assert.equal((await call(operator, 'PUT', '/api/settings/automations', { bookingMessages: false })).status, 403);
  assert.equal((await call(ops, 'PUT', '/api/settings/automations', { bookingMessages: false })).status, 403);
  assert.equal((await call(admin, 'PUT', '/api/settings/automations', { launchRockets: false })).status, 400);
  assert.equal((await call(admin, 'PUT', '/api/settings/automations', { bookingMessages: 'no' })).status, 400);
  assert.equal((await call(admin, 'PUT', '/api/settings/automations', {})).status, 400);

  const off = await json(admin, 'PUT', '/api/settings/automations', { bookingMessages: false, priceCheck: false });
  assert.equal(off.automations.find((item) => item.key === 'bookingMessages').on, false);
  assert.equal(off.automations.find((item) => item.key === 'readOrders').on, true, 'the other switches are left alone');
  const before = (await tasks()).length;
  const id = await bookLoad();
  const forLoad = (await tasks()).filter((task) => task.shipmentId === id);
  assert.deepEqual(forLoad.map((t) => t.title), [], "no booking messages and no price warning; the booked load has no stale booking task");
  assert.equal((await tasks()).length, before);
  // Another company is not affected by this company's switches.
  const foreign = await bookLoad(other);
  assert.equal((await tasks(other)).filter((task) => task.shipmentId === foreign && task.kind === 'message').length, 3);
  const log = (await json(admin, 'GET', '/api/audit')).entries;
  assert.ok(log.some((entry) => entry.action === 'automation.changed' && /booking and pickup messages: off/.test(entry.detail)));
  await call(admin, 'PUT', '/api/settings/automations', { bookingMessages: true, priceCheck: true });
});

test('reading order emails can be switched off: the email still becomes a task, no AI call is made', async () => {
  const token = (await json(admin, 'POST', '/api/settings/inbox/token')).token;
  await call(admin, 'PUT', '/api/settings/automations', { readOrders: false });
  const calls = aiCalls;
  const res = await call(null, 'POST', `/api/integrations/inbox/${token}`, { From: 'buyer@x.example', Subject: 'Order', TextBody: 'Need a reefer Tashkent to Almaty', MessageID: 'cc-1' });
  assert.equal(res.status, 201);
  await nexus.idle();
  assert.equal(aiCalls, calls, 'FLOW was not called');
  const task = (await tasks()).find((t) => t.kind === 'review_intake');
  assert.match(task.payload.note, /switched off/);
  await call(admin, 'PUT', '/api/settings/automations', { readOrders: true });
  await call(null, 'POST', `/api/integrations/inbox/${token}`, { From: 'buyer@x.example', Subject: 'Order 2', TextBody: 'Another reefer', MessageID: 'cc-2' });
  await nexus.idle();
  assert.equal(aiCalls, calls + 1, 'switched back on, FLOW reads again');
});

test('risk watch off: SENTINEL raises no warning tasks for this company', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const id = (await json(admin, 'POST', '/api/shipments', { customer: 'C', origin: 'Bukhara, UZ', destination: 'Osh, KG', pickup: today, delivery: '2031-01-01', weight: 100, equipment: 'Reefer' })).shipment.id;
  await call(admin, 'PUT', '/api/settings/automations', { riskWatch: false });
  await nexus.sentinelSweep();
  assert.equal((await tasks()).filter((t) => t.shipmentId === id && /no truck booked/.test(t.title)).length, 0);
  await call(admin, 'PUT', '/api/settings/automations', { riskWatch: true });
  await nexus.sentinelSweep();
  assert.equal((await tasks()).filter((t) => t.shipmentId === id && /no truck booked/.test(t.title)).length, 1);
});
