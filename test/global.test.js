// Global readiness: legal pages, consent at sign-up, per-company currency and weight unit,
// and a company's own data export.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-global-'));
Object.assign(process.env, {
  NODE_ENV: 'development', DATABASE_PATH: path.join(dir, 'g.db'), PORT: '0', BCRYPT_COST: '10', API_RATE_LIMIT_MAX: '5000', NEXUS_ENABLED: 'false',
  REGISTER_RATE_LIMIT_MAX: '50', COMPANY_SIGNUP: 'true', LEGAL_ENTITY: 'Veyra <Test> Ltd', LEGAL_EMAIL: 'legal@veyra.example', REFUND_DAYS: '14'
});
const { app, initialize } = require('../server');
const { db } = require('../database');

let server; let base; let eu; let owner;
const call = (cookie, method, url, body) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
const json = async (...args) => (await call(...args)).json();
async function login(email, password) { return (await call(null, 'POST', '/api/login', { email, password })).headers.get('set-cookie').split(';')[0]; }
const signup = (extra) => call(null, 'POST', '/api/signup', { companyName: 'Rhein Freight', name: 'Anna', email: 'anna@rhein.example', password: 'rhein-pass-1234', plan: 'growth', acceptTerms: true, currency: 'EUR', weightUnit: 'lb', ...extra });

before(async () => {
  await initialize();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  owner = await login('admin@veyra.ai', 'admin123');
});
after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => db.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Terms, Privacy and Refund pages are public, name Paddle as Merchant of Record and escape company details', async () => {
  for (const page of ['terms', 'privacy', 'refunds']) {
    const res = await fetch(`${base}/${page}`);
    assert.equal(res.status, 200, page);
    const html = await res.text();
    assert.match(html, /Merchant of Record/);
    assert.match(html, /href="\/privacy"/);
  }
  const terms = await (await fetch(`${base}/terms`)).text();
  assert.match(terms, /Veyra &lt;Test&gt; Ltd/);
  assert.doesNotMatch(terms, /<Test>/);
  assert.match(await (await fetch(`${base}/refunds`)).text(), /within 14 days of your first payment/);
});

test('sign-up needs consent and keeps the company\'s currency and weight unit', async () => {
  assert.equal((await signup({ acceptTerms: false })).status, 400);
  assert.equal((await signup({ currency: 'XYZ' })).status, 400);
  assert.equal((await signup({ weightUnit: 'stone' })).status, 400);
  const res = await signup();
  assert.equal(res.status, 201);
  eu = res.headers.get('set-cookie').split(';')[0];
  const me = await json(eu, 'GET', '/api/me');
  assert.deepEqual(me.region, { currency: 'EUR', weightUnit: 'lb', timeZone: 'UTC', locale: 'en-US' });
  const plans = await json(null, 'GET', '/api/plans');
  assert.ok(plans.regions.currencies.includes('EUR'));
});

test('loads, invoices and finance use the company\'s own currency and unit; the default company is unchanged', async () => {
  const created = await json(eu, 'POST', '/api/shipments', { customer: 'Bayer', origin: 'Cologne, DE', destination: 'Lyon, FR', pickup: '2030-05-10', delivery: '2030-05-12', weight: 22000, equipment: 'Reefer', customerRate: 1800 });
  const id = created.shipment.id;
  const list = await json(eu, 'GET', '/api/admin/shipments');
  assert.equal(list.shipments.find((s) => s.id === id).weight, '22000 lb');
  assert.equal((await json(eu, 'GET', '/api/finance/summary')).currency, 'EUR');
  const invoice = await (await call(eu, 'GET', `/api/shipments/${id}/invoice`)).text();
  assert.match(invoice, /€1,800/);

  assert.deepEqual((await json(owner, 'GET', '/api/me')).region, { currency: 'USD', weightUnit: 'kg', timeZone: 'UTC', locale: 'en-US' });
});

test('administrators change the region; others cannot; amounts are not converted', async () => {
  await call(eu, 'POST', '/api/admin/users', { name: 'Op', email: 'op@rhein.example', password: 'rhein-op-pass-1', role: 'operator' });
  const op = await login('op@rhein.example', 'rhein-op-pass-1');
  assert.equal((await json(op, 'GET', '/api/company/settings')).canChange, false);
  assert.equal((await call(op, 'PUT', '/api/company/settings', { currency: 'GBP', weightUnit: 'kg' })).status, 403);
  assert.equal((await call(eu, 'PUT', '/api/company/settings', { currency: 'GBP' })).status, 400);
  const saved = await json(eu, 'PUT', '/api/company/settings', { currency: 'GBP', weightUnit: 'kg', timeZone: 'UTC', locale: 'en-US' });
  assert.deepEqual(saved.region, { currency: 'GBP', weightUnit: 'kg', timeZone: 'UTC', locale: 'en-US' });
  assert.deepEqual((await json(op, 'GET', '/api/me')).region, { currency: 'GBP', weightUnit: 'kg', timeZone: 'UTC', locale: 'en-US' });
  // The earlier load keeps the weight it was entered with.
  assert.ok((await json(eu, 'GET', '/api/admin/shipments')).shipments.some((s) => s.weight === '22000 lb'));
  assert.equal((await call(op, 'GET', '/api/company/export')).status, 403);
});

test('a company downloads its own data, with its consent record and without passwords or other companies', async () => {
  const res = await call(eu, 'GET', '/api/company/export');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="veyra-export-/);
  const text = await res.text();
  const data = JSON.parse(text);
  assert.equal(data.company.name, 'Rhein Freight');
  assert.ok(data.company.terms_version);
  assert.ok(data.company.terms_accepted_at);
  assert.equal(data.shipments.length, 1);
  assert.equal(data.users.length, 2);
  assert.doesNotMatch(text, /"password"/);
  assert.doesNotMatch(text, /admin@veyra\.ai/);
});
