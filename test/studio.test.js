// Automation Studio: company rules are saved, checked, tested, run by NEXUS and kept per company.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-studio-'));
Object.assign(process.env, { NODE_ENV: 'development', DATABASE_PATH: path.join(dir, 's.db'), PORT: '0', BCRYPT_COST: '10', API_RATE_LIMIT_MAX: '5000' });
const { app, initialize } = require('../server');
const { db } = require('../database');
const nexus = require('../agents/nexus');

let server; let base; let admin; let other; let operator;
const call = (cookie, method, url, body) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
const json = async (...args) => (await call(...args)).json();
async function login(email, password) { return (await call(null, 'POST', '/api/login', { email, password })).headers.get('set-cookie').split(';')[0]; }
const newLoad = async (cookie, fields = {}) => (await json(cookie, 'POST', '/api/shipments', {
  customer: 'Navoiy Textile', origin: 'Tashkent, UZ', destination: 'Moscow, RU', pickup: '2030-05-10', delivery: '2030-05-14', weight: 100, equipment: 'Reefer', customerPhone: '+998 90 111 22 33', ...fields
})).shipment.id;
const openTasks = async (cookie) => (await json(cookie, 'GET', '/api/tasks')).tasks;

before(async () => {
  await initialize();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await login('admin@veyra.ai', 'admin123');
  await call(admin, 'POST', '/api/platform/tenants', { companyName: 'Studio Other', adminName: 'Sam', adminEmail: 'sam@s.example', adminPassword: 'studio-other-pass-1' });
  other = await login('sam@s.example', 'studio-other-pass-1');
  // The other company is on Scale, so its requests reach the company check, not the plan check.
  const theirId = (await json(admin, 'GET', '/api/platform/tenants')).tenants.find((t) => t.name === 'Studio Other').id;
  await call(admin, 'PATCH', `/api/platform/tenants/${theirId}/plan`, { plan: 'scale', status: 'active' });
  await call(admin, 'POST', '/api/admin/users', { name: 'Op', email: 'op@studio.example', password: 'studio-op-pass-12', role: 'operator' });
  operator = await login('op@studio.example', 'studio-op-pass-12');
});
after(async () => {
  await nexus.idle();
  await new Promise((r) => server.close(r));
  await new Promise((r) => db.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a rule is checked before it is saved, and only administrators may save it', async () => {
  const bad = await call(admin, 'POST', '/api/automation/workflows', { name: 'x', trigger: 'shipment.status', actions: [{ type: 'create_task', title: 'Hi' }] });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).message, /status/);
  assert.equal((await call(admin, 'POST', '/api/automation/workflows', { name: 'x', trigger: 'shipment.created', actions: [] })).status, 400);
  assert.equal((await call(admin, 'POST', '/api/automation/workflows', { name: 'x', trigger: 'nope', actions: [{ type: 'create_task', title: 'a' }] })).status, 400);
  assert.equal((await call(operator, 'POST', '/api/automation/workflows', { name: 'x', trigger: 'shipment.created', actions: [{ type: 'create_task', title: 'a' }] })).status, 403);
  const studio = await json(operator, 'GET', '/api/automation/studio');
  assert.equal(studio.canChange, false);
  assert.equal(studio.builtIn.length, 7);
  assert.ok(studio.templates.length >= 4);
});

test('a saved rule runs when its trigger happens and its conditions match', async () => {
  const created = await json(admin, 'POST', '/api/automation/workflows', {
    name: 'Russia papers', trigger: 'shipment.created', conditions: [{ field: 'destination', value: 'ru' }],
    actions: [{ type: 'create_task', title: 'Check papers for {id} · {customer}' }]
  });
  assert.equal(created.success, true);
  const toRussia = await newLoad(admin);
  const toKazakhstan = await newLoad(admin, { destination: 'Almaty, KZ' });
  await nexus.idle();
  const titles = (await openTasks(admin)).map((task) => task.title);
  assert.ok(titles.includes(`Check papers for ${toRussia} · Navoiy Textile`));
  assert.ok(!titles.some((title) => title.includes(toKazakhstan) && title.startsWith('Check papers')));

  const studio = await json(admin, 'GET', '/api/automation/studio');
  const rule = studio.workflows.find((workflow) => workflow.id === created.workflow.id);
  assert.equal(rule.runs30, 1);
  assert.equal(studio.runs[0].shipmentId, toRussia);
  assert.equal(studio.runs[0].status, 'done');
  assert.equal(studio.stats.successRate, 100);
});

test('a status rule drafts a customer message; a switched-off rule does nothing', async () => {
  const rule = (await json(admin, 'POST', '/api/automation/workflows', {
    name: 'Exception call', trigger: 'shipment.status', triggerStatus: 'Sourcing',
    actions: [{ type: 'message_customer', purpose: 'status_update' }, { type: 'create_task', title: 'Call {customer}' }]
  })).workflow;
  const id = await newLoad(admin, { destination: 'Almaty, KZ' });
  await call(admin, 'PATCH', `/api/admin/shipments/${id}/status`, { status: 'Sourcing' });
  await nexus.idle();
  let tasks = (await openTasks(admin)).filter((task) => task.shipmentId === id);
  assert.ok(tasks.some((task) => task.kind === 'message' && task.title.includes('Exception call')));
  assert.ok(tasks.some((task) => task.title === 'Call Navoiy Textile'));

  assert.equal((await json(admin, 'PATCH', `/api/automation/workflows/${rule.id}`, { enabled: false })).workflow.enabled, false);
  const second = await newLoad(admin, { destination: 'Almaty, KZ' });
  await call(admin, 'PATCH', `/api/admin/shipments/${second}/status`, { status: 'Sourcing' });
  await nexus.idle();
  tasks = (await openTasks(admin)).filter((task) => task.shipmentId === second);
  assert.ok(!tasks.some((task) => task.title === 'Call Navoiy Textile'));
});

test('"Run test" shows what would happen and changes nothing', async () => {
  const id = await newLoad(admin, { equipment: 'Dry Van' });
  await nexus.idle();
  const before = (await openTasks(admin)).length;
  const workflow = { name: 'Reefer', trigger: 'shipment.created', conditions: [{ field: 'equipment', value: 'Reefer' }], actions: [{ type: 'create_task', title: 'Temp for {id}' }] };
  const miss = await json(admin, 'POST', '/api/automation/test', { workflow, shipmentId: id });
  assert.equal(miss.matched, false);
  assert.equal(miss.conditions[0].ok, false);
  const hit = await json(admin, 'POST', '/api/automation/test', { workflow: { ...workflow, conditions: [{ field: 'equipment', value: 'dry' }] }, shipmentId: id });
  assert.equal(hit.matched, true);
  assert.deepEqual(hit.actions, [`Create a task: Temp for ${id}`]);
  assert.equal((await openTasks(admin)).length, before);
});

test('rules belong to one company', async () => {
  const mine = (await json(admin, 'GET', '/api/automation/studio')).workflows[0];
  const theirs = await json(other, 'GET', '/api/automation/studio');
  assert.equal(theirs.workflows.length, 0);
  assert.equal(theirs.runs.length, 0);
  assert.equal((await call(other, 'DELETE', `/api/automation/workflows/${mine.id}`)).status, 404);
  assert.equal((await call(other, 'PUT', `/api/automation/workflows/${mine.id}`, { name: 'x', trigger: 'shipment.created', actions: [{ type: 'create_task', title: 'a' }] })).status, 404);
  const loadOfMine = (await json(admin, 'GET', '/api/automation/studio')).runs[0].shipmentId;
  assert.equal((await call(other, 'POST', '/api/automation/test', { workflow: { name: 'x', trigger: 'shipment.created', actions: [{ type: 'create_task', title: 'a' }] }, shipmentId: loadOfMine })).status, 404);
  assert.equal((await call(admin, 'DELETE', `/api/automation/workflows/${mine.id}`)).status, 200);
});
