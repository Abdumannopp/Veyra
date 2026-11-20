// Self sign-up: a new company picks a plan, gets an account on trial, pays by card and the
// plan it chose becomes active. Closed when card payment is off or switched off.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const SECRET = 'pdl_ntfset_signup_secret';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-signup-'));
Object.assign(process.env, {
  NODE_ENV: 'development', DATABASE_PATH: path.join(dir, 's.db'), PORT: '0', BCRYPT_COST: '10', API_RATE_LIMIT_MAX: '5000', NEXUS_ENABLED: 'false',
  REGISTER_RATE_LIMIT_MAX: '50',
  PADDLE_CLIENT_TOKEN: 'test_client_token_abc', PADDLE_WEBHOOK_SECRET: SECRET,
  PADDLE_PRICE_STARTER_MONTHLY: 'pri_starter_monthly01', PADDLE_PRICE_SCALE_YEARLY: 'pri_scale_yearly0001'
});
const { app, initialize } = require('../server');
const { db } = require('../database');

let server; let base;
const call = (cookie, method, url, body) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
const json = async (...args) => (await call(...args)).json();
const person = (n, extra = {}) => ({ companyName: `Signup Co ${n}`, name: `Person ${n}`, email: `p${n}@signup.example`, password: 'signup-pass-123', acceptTerms: true, ...extra });
function webhook(event) {
  const raw = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const signature = `ts=${ts};h1=${crypto.createHmac('sha256', SECRET).update(`${ts}:${raw}`).digest('hex')}`;
  return fetch(`${base}/api/integrations/paddle/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'paddle-signature': signature }, body: raw });
}

before(async () => {
  await initialize();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => db.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sign-up opens with card payment and can be switched off; the pages are public', async () => {
  assert.equal((await json(null, 'GET', '/api/plans')).signup, true);
  assert.equal((await fetch(`${base}/signup`)).status, 200);
  process.env.COMPANY_SIGNUP = 'false';
  assert.equal((await json(null, 'GET', '/api/plans')).signup, false);
  assert.equal((await call(null, 'POST', '/api/signup', person(0))).status, 403);
  delete process.env.COMPANY_SIGNUP;
  const token = process.env.PADDLE_CLIENT_TOKEN;
  delete process.env.PADDLE_CLIENT_TOKEN;
  assert.equal((await json(null, 'GET', '/api/plans')).signup, false);
  process.env.PADDLE_CLIENT_TOKEN = token;
});

test('a new company signs up on the plan it chose, is signed in, and is its own separate company', async () => {
  const res = await call(null, 'POST', '/api/signup', person(1, { plan: 'scale' }));
  assert.equal(res.status, 201);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const body = await res.json();
  assert.equal(body.user.role, 'admin');
  assert.equal(body.user.isPlatformAdmin, false);
  assert.equal(body.cardPayment, true);

  const billing = await json(cookie, 'GET', '/api/billing/plan');
  assert.equal(billing.plan.key, 'scale');
  assert.equal(billing.plan.status, 'trial');
  assert.equal(billing.plan.users, 25);
  assert.equal(billing.usage.users, 1);
  // A fresh company: none of the first company's loads, and no access to the platform console.
  assert.equal((await json(cookie, 'GET', '/api/admin/shipments')).shipments.length, 0);
  assert.equal((await call(cookie, 'GET', '/api/platform/tenants')).status, 403);
});

test('bad sign-ups are refused without saying which accounts exist', async () => {
  assert.equal((await call(null, 'POST', '/api/signup', person(2, { plan: 'enterprise' }))).status, 400);
  assert.equal((await call(null, 'POST', '/api/signup', person(2, { password: 'short' }))).status, 400);
  assert.equal((await call(null, 'POST', '/api/signup', person(2, { companyName: '' }))).status, 400);
  const sameEmail = await call(null, 'POST', '/api/signup', person(3, { email: 'p1@signup.example' }));
  const sameCompany = await call(null, 'POST', '/api/signup', person(4, { companyName: 'signup co 1' }));
  assert.equal(sameEmail.status, 409);
  assert.equal(sameCompany.status, 409);
  assert.equal((await sameEmail.json()).message, (await sameCompany.json()).message);
});

test('choose a plan, pay, and the company works on that plan', async () => {
  const res = await call(null, 'POST', '/api/signup', person(5, { plan: 'starter' }));
  const cookie = res.headers.get('set-cookie').split(';')[0];
  // Starter cannot create workflows (a Scale feature) before or after paying for Starter.
  const workflow = { name: 'x', trigger: 'shipment.created', actions: [{ type: 'create_task', title: 'a' }] };
  assert.equal((await call(cookie, 'POST', '/api/automation/workflows', workflow)).status, 402);

  // They decide on Scale yearly at checkout instead, and pay.
  const { checkout } = await json(cookie, 'POST', '/api/billing/checkout', { plan: 'scale', period: 'yearly' });
  assert.equal(checkout.priceId, 'pri_scale_yearly0001');
  const paid = await webhook({
    event_type: 'subscription.created', occurred_at: new Date().toISOString(),
    data: { id: 'sub_signup5', customer_id: 'ctm_signup5', status: 'active', updated_at: new Date().toISOString(), custom_data: checkout.customData, items: [{ price: { id: checkout.priceId } }] }
  });
  assert.equal((await paid.json()).applied, true);

  const billing = await json(cookie, 'GET', '/api/billing/plan');
  assert.equal(billing.plan.key, 'scale');
  assert.equal(billing.plan.status, 'active');
  assert.equal(billing.plan.shipments, 2000);
  assert.equal(billing.paddle.period, 'yearly');
  assert.equal(billing.paddle.subscribed, true);
  assert.equal((await call(cookie, 'POST', '/api/automation/workflows', workflow)).status, 201);
});
