// Paddle: checkout details, signed webhooks that move a company's plan, ordering, tampering,
// plan switching and the billing portal through a fake Paddle API.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const SECRET = 'pdl_ntfset_test_secret_123';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-paddle-'));
Object.assign(process.env, {
  NODE_ENV: 'development', DATABASE_PATH: path.join(dir, 'p.db'), PORT: '0', BCRYPT_COST: '10', API_RATE_LIMIT_MAX: '5000', NEXUS_ENABLED: 'false',
  PADDLE_CLIENT_TOKEN: 'test_client_token_abc', PADDLE_WEBHOOK_SECRET: SECRET, PADDLE_API_KEY: 'pdl_test_apikey',
  PADDLE_PRICE_STARTER_MONTHLY: 'pri_starter_monthly01', PADDLE_PRICE_GROWTH_MONTHLY: 'pri_growth_monthly01',
  PADDLE_PRICE_GROWTH_YEARLY: 'pri_growth_yearly001', PADDLE_PRICE_SCALE_MONTHLY: 'pri_scale_monthly001'
});
const { app, initialize } = require('../server');
const { db } = require('../database');
const paddle = require('../integrations/paddle');

let server; let base; let owner; let boss; let tenantId; let otherId; let apiCalls = [];
const call = (cookie, method, url, body, headers = {}) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
const json = async (...args) => (await call(...args)).json();
async function login(email, password) { return (await call(null, 'POST', '/api/login', { email, password })).headers.get('set-cookie').split(';')[0]; }
function sign(raw, ts = Math.floor(Date.now() / 1000), secret = SECRET) {
  return `ts=${ts};h1=${crypto.createHmac('sha256', secret).update(`${ts}:${raw}`).digest('hex')}`;
}
function webhook(event, signature) {
  const raw = JSON.stringify(event);
  return fetch(`${base}/api/integrations/paddle/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'paddle-signature': signature || sign(raw) }, body: raw });
}
const subEvent = (type, { status = 'active', price = 'pri_growth_monthly01', updatedAt = new Date().toISOString(), customData, id = 'sub_01test' } = {}) => ({
  event_type: type, occurred_at: updatedAt,
  data: { id, customer_id: 'ctm_01test', status, updated_at: updatedAt, custom_data: customData, items: [{ price: { id: price }, quantity: 1 }] }
});

before(async () => {
  await initialize();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  owner = await login('admin@veyra.ai', 'admin123');
  tenantId = (await json(owner, 'POST', '/api/platform/tenants', { companyName: 'Pay Co', adminName: 'Pia', adminEmail: 'pia@pay.example', adminPassword: 'pay-company-pass-1', plan: 'starter' })).tenant.id;
  otherId = (await json(owner, 'POST', '/api/platform/tenants', { companyName: 'Other Co', adminName: 'Oz', adminEmail: 'oz@other.example', adminPassword: 'other-company-pass-1', plan: 'starter' })).tenant.id;
  boss = await login('pia@pay.example', 'pay-company-pass-1');
  paddle.setTransport(async (url, init) => {
    apiCalls.push({ url, init });
    if (url.endsWith('/portal-sessions')) return new Response(JSON.stringify({ data: { urls: { general: { overview: 'https://customer-portal.paddle.com/cpl_01test' } } } }), { status: 201 });
    if (init.method === 'PATCH') {
      const priceId = JSON.parse(init.body).items[0].price_id;
      return new Response(JSON.stringify({ data: { id: 'sub_01test', customer_id: 'ctm_01test', status: 'active', updated_at: new Date(Date.now() + 120000).toISOString(), items: [{ price: { id: priceId } }] } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
});
after(async () => {
  paddle.setTransport(null);
  await new Promise((r) => server.close(r));
  await new Promise((r) => db.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the signature check accepts Paddle\'s format and rejects tampering, old messages and wrong secrets', () => {
  const raw = Buffer.from('{"a":1}');
  assert.equal(paddle.verifySignature(raw, sign('{"a":1}')), true);
  assert.equal(paddle.verifySignature(Buffer.from('{"a":2}'), sign('{"a":1}')), false);
  assert.equal(paddle.verifySignature(raw, sign('{"a":1}', Math.floor(Date.now() / 1000) - 3600)), false);
  assert.equal(paddle.verifySignature(raw, sign('{"a":1}', undefined, 'wrong')), false);
  assert.equal(paddle.verifySignature(raw, 'ts=1;h1=zz'), false);
  assert.equal(paddle.verifySignature(raw, `${sign('{"a":1}')};h1=${'0'.repeat(64)}`), true);
});

test('the Billing page offers card payment, and checkout returns a signed company reference', async () => {
  const billing = await json(boss, 'GET', '/api/billing/plan');
  assert.equal(billing.paddle.enabled, true);
  assert.equal(billing.paddle.subscribed, false);
  assert.deepEqual(billing.paddle.plans.growth, { monthly: true, yearly: true, name: 'Growth', price: 249, yearlyPerMonth: 208 });
  assert.equal(billing.paddle.plans.scale.yearly, false);
  const res = await json(boss, 'POST', '/api/billing/checkout', { plan: 'growth', period: 'monthly' });
  assert.equal(res.checkout.priceId, 'pri_growth_monthly01');
  assert.equal(res.checkout.email, 'pia@pay.example');
  assert.equal(res.checkout.customData.veyra_tenant, String(tenantId));
  assert.equal((await call(boss, 'POST', '/api/billing/checkout', { plan: 'scale', period: 'yearly' })).status, 400);
  assert.equal((await call(boss, 'POST', '/api/billing/checkout', { plan: 'enterprise', period: 'monthly' })).status, 400);
  const csp = (await fetch(`${base}/`)).headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' https:\/\/cdn\.paddle\.com/);
  assert.match(csp, /frame-src https:\/\/buy\.paddle\.com/);
});

test('a signed subscription webhook moves the company to the paid plan; bad or forged ones change nothing', async () => {
  const reference = paddle.referenceFor(tenantId, process.env.JWT_SECRET || 'veyra-dev-secret');
  assert.equal((await webhook(subEvent('subscription.created', { customData: reference }), 'ts=1;h1=00')).status, 401);
  // A reference for another company with a made-up signature is ignored.
  const forged = await (await webhook(subEvent('subscription.created', { customData: { veyra_tenant: String(otherId), veyra_sig: 'a'.repeat(64) }, id: 'sub_forged' }))).json();
  assert.equal(forged.ignored, true);

  const ok = await webhook(subEvent('subscription.created', { customData: reference }));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).applied, true);
  const billing = await json(boss, 'GET', '/api/billing/plan');
  assert.equal(billing.plan.key, 'growth');
  assert.equal(billing.plan.status, 'active');
  assert.equal(billing.paddle.subscribed, true);
  assert.equal((await call(boss, 'POST', '/api/billing/checkout', { plan: 'growth', period: 'monthly' })).status, 409);
  assert.equal((await json(owner, 'GET', '/api/platform/tenants')).tenants.find((t) => t.id === otherId).plan, 'starter');
  assert.equal((await json(null, 'POST', '/api/integrations/paddle/webhook', {})).success, false);
  assert.equal((await webhook({ event_type: 'transaction.completed', data: {} })).status, 200);
});

test('later events win: past due, then an older "active" arriving late is ignored, then cancelled', async () => {
  const now = Date.now();
  await webhook(subEvent('subscription.past_due', { status: 'past_due', updatedAt: new Date(now + 60000).toISOString() }));
  assert.equal((await json(boss, 'GET', '/api/billing/plan')).plan.status, 'past_due');
  const late = await (await webhook(subEvent('subscription.updated', { status: 'active', updatedAt: new Date(now + 30000).toISOString() }))).json();
  assert.equal(late.applied, false);
  assert.equal((await json(boss, 'GET', '/api/billing/plan')).plan.locked, true);
  await webhook(subEvent('subscription.updated', { status: 'active', updatedAt: new Date(now + 90000).toISOString() }));
  assert.equal((await json(boss, 'GET', '/api/billing/plan')).plan.locked, false);
});

test('switching plans and the billing portal go through the Paddle API', async () => {
  apiCalls = [];
  const switched = await json(boss, 'POST', '/api/billing/change-plan', { plan: 'scale', period: 'monthly' });
  assert.equal(switched.plan.key, 'scale');
  assert.equal(apiCalls[0].init.method, 'PATCH');
  assert.match(apiCalls[0].url, /^https:\/\/sandbox-api\.paddle\.com\/subscriptions\/sub_01test$/);
  assert.equal(apiCalls[0].init.headers.authorization, 'Bearer pdl_test_apikey');
  assert.equal(JSON.parse(apiCalls[0].init.body).proration_billing_mode, 'prorated_immediately');
  const portal = await json(boss, 'POST', '/api/billing/portal');
  assert.equal(portal.url, 'https://customer-portal.paddle.com/cpl_01test');

  await webhook(subEvent('subscription.canceled', { status: 'canceled', price: 'pri_scale_monthly001', updatedAt: new Date(Date.now() + 10 * 60000).toISOString() }));
  const after = await json(boss, 'GET', '/api/billing/plan');
  assert.equal(after.plan.status, 'cancelled');
  assert.equal(after.paddle.subscribed, false);
  assert.equal((await call(boss, 'POST', '/api/billing/change-plan', { plan: 'growth', period: 'monthly' })).status, 409);
});
