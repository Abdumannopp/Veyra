// Plans: public price list, trial for new companies, limits on people and monthly loads,
// plan features, a locked plan that still reads, and who may change a plan.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-plans-'));
Object.assign(process.env, { NODE_ENV: 'development', DATABASE_PATH: path.join(dir, 'p.db'), PORT: '0', BCRYPT_COST: '10', API_RATE_LIMIT_MAX: '5000', NEXUS_ENABLED: 'false', GEMINI_API_KEY: 'AIza-test-gemini-key', SALES_EMAIL: 'sales@veyra.example' });
const { app, initialize } = require('../server');
const { db } = require('../database');

let server; let base; let owner; let boss; let tenantId;
const call = (cookie, method, url, body) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
const json = async (...args) => (await call(...args)).json();
async function login(email, password) { return (await call(null, 'POST', '/api/login', { email, password })).headers.get('set-cookie').split(';')[0]; }
const load = (cookie) => call(cookie, 'POST', '/api/shipments', { customer: 'C', origin: 'Austin, US', destination: 'Dallas, US', pickup: '2030-05-10', delivery: '2030-05-12', weight: 100, equipment: 'Dry Van' });
const setPlan = (body) => call(owner, 'PATCH', `/api/platform/tenants/${tenantId}/plan`, body);

before(async () => {
  await initialize();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  owner = await login('admin@veyra.ai', 'admin123');
  const created = await json(owner, 'POST', '/api/platform/tenants', { companyName: 'Plan Co', adminName: 'Pat', adminEmail: 'pat@plan.example', adminPassword: 'plan-company-pass-1', plan: 'starter' });
  tenantId = created.tenant.id;
  boss = await login('pat@plan.example', 'plan-company-pass-1');
});
after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => db.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the public price list has four plans with yearly prices and needs no sign-in', async () => {
  const data = await json(null, 'GET', '/api/plans');
  assert.deepEqual(data.plans.map((p) => [p.key, p.monthly]), [['starter', 99], ['growth', 249], ['scale', 599], ['enterprise', 1499]]);
  assert.equal(data.plans.find((p) => p.key === 'growth').popular, true);
  assert.equal(data.plans.find((p) => p.key === 'starter').yearlyPerMonth, 83);
  assert.equal(data.plans.find((p) => p.key === 'enterprise').contactSales, true);
  assert.equal(data.salesEmail, 'sales@veyra.example');
  assert.equal(data.trialDays, 14);
});

test('a new company starts a 14-day trial; the existing company keeps Enterprise', async () => {
  const mine = await json(boss, 'GET', '/api/billing/plan');
  assert.equal(mine.plan.key, 'starter');
  assert.equal(mine.plan.status, 'trial');
  assert.ok(mine.plan.trialDaysLeft >= 13 && mine.plan.trialDaysLeft <= 14);
  assert.equal(mine.plan.users, 3);
  assert.equal(mine.usage.users, 1);
  assert.equal(mine.plan.capabilities.ai.on, false);
  const ownerPlan = await json(owner, 'GET', '/api/billing/plan');
  assert.equal(ownerPlan.plan.key, 'enterprise');
  assert.equal(ownerPlan.plan.status, 'active');
});

test('plan features: Starter cannot use AI, GPS, messaging or workflows; Growth can, except workflows', async () => {
  for (const [method, url, body] of [
    ['POST', '/api/agents/flow/parse', { text: 'order' }],
    ['POST', '/api/integrations/gps/token'],
    ['POST', '/api/settings/inbox/token'],
    ['PUT', '/api/settings/messaging', { accountSid: 'AC1', authToken: 'x' }],
    ['POST', '/api/automation/workflows', { name: 'x', trigger: 'shipment.created', actions: [{ type: 'create_task', title: 'a' }] }]
  ]) {
    const res = await call(boss, method, url, body);
    assert.equal(res.status, 402, url);
    assert.match((await res.json()).message, /plan/);
  }
  assert.equal((await setPlan({ plan: 'growth' })).status, 200);
  assert.equal((await call(boss, 'POST', '/api/integrations/gps/token')).status, 201);
  const workflow = await call(boss, 'POST', '/api/automation/workflows', { name: 'x', trigger: 'shipment.created', actions: [{ type: 'create_task', title: 'a' }] });
  assert.equal(workflow.status, 402);
  assert.match((await workflow.json()).message, /Scale plan/);
});

test('people and monthly loads stop at the plan limit; disabled people free a seat', async () => {
  assert.equal((await setPlan({ plan: 'starter', shipmentLimit: 2 })).status, 200);
  assert.equal((await load(boss)).status, 201);
  assert.equal((await load(boss)).status, 201);
  const third = await load(boss);
  assert.equal(third.status, 402);
  assert.match((await third.json()).message, /2 shipments a month/);

  const add = (n) => call(boss, 'POST', '/api/admin/users', { name: `P${n}`, email: `p${n}@plan.example`, password: 'plan-person-pass-1', role: 'operator' });
  assert.equal((await add(1)).status, 201);
  const second = await add(2);
  assert.equal(second.status, 201);
  const full = await add(3);
  assert.equal(full.status, 402);
  assert.match((await full.json()).message, /3 users/);
  const secondId = (await second.json()).user.id;
  assert.equal((await call(boss, 'PATCH', `/api/admin/users/${secondId}`, { active: false })).status, 200);
  assert.equal((await add(3)).status, 201);
  assert.equal((await call(boss, 'PATCH', `/api/admin/users/${secondId}`, { active: true })).status, 402);
});

test('an unpaid plan keeps everything readable but adds nothing; only the platform owner changes plans', async () => {
  assert.equal((await setPlan({ status: 'past_due', shipmentLimit: null })).status, 200);
  const blocked = await load(boss);
  assert.equal(blocked.status, 402);
  assert.match((await blocked.json()).message, /overdue/);
  assert.equal((await call(boss, 'GET', '/api/admin/shipments')).status, 200);
  assert.equal((await json(boss, 'GET', '/api/billing/plan')).plan.locked, true);

  assert.equal((await call(boss, 'PATCH', `/api/platform/tenants/${tenantId}/plan`, { plan: 'enterprise' })).status, 403);
  assert.equal((await setPlan({ plan: 'gold' })).status, 400);
  assert.equal((await setPlan({ userLimit: 0 })).status, 400);
  assert.equal((await setPlan({ plan: 'growth', status: 'active' })).status, 200);
  assert.equal((await load(boss)).status, 201);
  const companies = (await json(owner, 'GET', '/api/platform/tenants')).tenants;
  const mine = companies.find((t) => t.id === tenantId);
  assert.equal(mine.plan, 'growth');
  assert.equal(mine.shipmentsThisMonth, 3);
});
