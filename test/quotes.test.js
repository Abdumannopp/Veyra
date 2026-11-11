// Quotes & Pricing: lane price check, quote life cycle, quote -> load, printing, company isolation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-quotes-'));
Object.assign(process.env, { NODE_ENV: 'development', DATABASE_PATH: path.join(dir, 'q.db'), PORT: '0', BCRYPT_COST: '10', API_RATE_LIMIT_MAX: '5000', CURRENCY: 'USD', NEXUS_ENABLED: 'false' });
const { app, initialize } = require('../server');
const { db } = require('../database');

let server; let base; let admin; let operator; let other;
const call = (cookie, method, url, body) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
const json = async (...args) => (await call(...args)).json();
const dbRun = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, (e) => (e ? reject(e) : resolve())));
async function login(email, password) { return (await call(null, 'POST', '/api/login', { email, password })).headers.get('set-cookie').split(';')[0]; }
const lane = { origin: 'Tashkent, UZ', destination: 'Almaty, KZ', equipment: 'Reefer' };
const quoteBody = (extra = {}) => ({ customer: 'Navoiy Textile', ...lane, price: 2500, ...extra });

before(async () => {
  await initialize();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await login('admin@veyra.ai', 'admin123');
  operator = await login('demo@veyra.ai', 'demo123');
  await call(admin, 'POST', '/api/platform/tenants', { companyName: 'Quote Other', adminName: 'Qodir', adminEmail: 'qodir@q.example', adminPassword: 'quote-other-pass-1' });
  other = await login('qodir@q.example', 'quote-other-pass-1');
});
after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => db.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('price check: nothing known, then lane history and market price give a suggestion', async () => {
  const empty = await json(admin, 'GET', `/api/quotes/estimate?${new URLSearchParams(lane)}`);
  assert.equal(empty.suggestedCustomerPrice, null);
  assert.equal(empty.expectedCarrierCost, null);
  assert.equal((await call(admin, 'GET', '/api/quotes/estimate?origin=A')).status, 400);
  assert.equal((await call(admin, 'GET', `/api/quotes/estimate?${new URLSearchParams({ ...lane, equipment: 'Rocket' })}`)).status, 400);

  for (let i = 0; i < 3; i += 1) {
    const id = (await json(admin, 'POST', '/api/shipments', { customer: 'C', ...lane, pickup: '2030-05-10', delivery: '2030-05-12', weight: 100, customerRate: 2400 })).shipment.id;
    await dbRun('UPDATE shipments SET rate = 2000 WHERE id = ?', [Number(id.slice(4))]);
  }
  const est = await json(admin, 'GET', `/api/quotes/estimate?${new URLSearchParams(lane)}`);
  assert.equal(est.carrier.typical, 2000);
  assert.equal(est.expectedCarrierCost, 2000);
  assert.equal(est.suggestedCustomerPrice, 2400, 'expected carrier cost plus the usual margin');
  assert.equal((await json(other, 'GET', `/api/quotes/estimate?${new URLSearchParams(lane)}`)).carrier, null, 'another company has its own history');
});

test('quotes: validated, draft by default, valid for 7 days, other companies cannot see them', async () => {
  assert.equal((await call(admin, 'POST', '/api/quotes', quoteBody({ price: -1 }))).status, 400);
  assert.equal((await call(admin, 'POST', '/api/quotes', quoteBody({ customer: '' }))).status, 400);
  assert.equal((await call(admin, 'POST', '/api/quotes', quoteBody({ pickup: '2030-05-10', delivery: '2030-05-01' }))).status, 400);
  const { quote } = await json(admin, 'POST', '/api/quotes', quoteBody({ carrierCost: 2000, customerPhone: '+998 90 111 22 33' }));
  assert.match(quote.number, /^Q-\d+$/);
  assert.equal(quote.status, 'draft');
  assert.equal(quote.margin, 500);
  assert.equal(quote.validUntil, new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));
  assert.equal((await json(operator, 'GET', '/api/quotes')).quotes.length, 1, 'a dispatcher can work with quotes too');
  assert.equal((await json(other, 'GET', '/api/quotes')).quotes.length, 0);
  assert.equal((await call(other, 'GET', `/api/quotes/${quote.id}`)).status, 404);
  assert.equal((await call(other, 'PATCH', `/api/quotes/${quote.id}`, { status: 'sent' })).status, 404);
});

test('life cycle: sent, edited, expired by date, won -> a load with the quoted price', async () => {
  const { quote } = await json(admin, 'POST', '/api/quotes', quoteBody({ weight: 18000 }));
  assert.equal((await json(admin, 'PATCH', `/api/quotes/${quote.id}`, { status: 'sent' })).quote.status, 'sent');
  assert.equal((await call(admin, 'PATCH', `/api/quotes/${quote.id}`, { status: 'won' })).status, 400);
  assert.equal((await json(admin, 'PATCH', `/api/quotes/${quote.id}`, { price: 2600 })).quote.price, 2600);
  await dbRun("UPDATE quotes SET valid_until = '2020-01-01' WHERE id = ?", [quote.id]);
  assert.equal((await json(admin, 'GET', `/api/quotes/${quote.id}`)).quote.status, 'expired', 'shows as expired after its date');

  assert.equal((await call(admin, 'POST', `/api/quotes/${quote.id}/convert`, {})).status, 400, 'dates are needed');
  const converted = await json(admin, 'POST', `/api/quotes/${quote.id}/convert`, { pickup: '2030-06-01', delivery: '2030-06-03' });
  assert.match(converted.shipmentId, /^SHP-\d+$/);
  assert.equal(converted.quote.status, 'accepted');
  const shipment = await json(admin, 'GET', `/api/shipments/${converted.shipmentId}`);
  assert.deepEqual([shipment.status, shipment.customerRate, shipment.weight, shipment.reference, shipment.origin], ['New', 2600, '18000 kg', `Q-${quote.id}`, 'Tashkent, UZ']);
  const events = (await json(admin, 'GET', `/api/shipments/${converted.shipmentId}/events`)).events;
  assert.match(events[0].note, /quote Q-/);
  assert.equal((await call(admin, 'POST', `/api/quotes/${quote.id}/convert`, { pickup: '2030-06-01', delivery: '2030-06-03' })).status, 409, 'not twice');
  assert.equal((await call(admin, 'PATCH', `/api/quotes/${quote.id}`, { price: 1 })).status, 409, 'a won quote is closed');
});

test('lost quotes stay closed; printing escapes text and shows no carrier cost', async () => {
  const { quote } = await json(admin, 'POST', '/api/quotes', quoteBody({ customer: '<b>Bold</b> & Co', carrierCost: 1234, notes: 'Loading 8:00' }));
  const page = await call(admin, 'GET', `/api/quotes/${quote.id}/print`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('&lt;b&gt;Bold&lt;/b&gt; &amp; Co'));
  assert.ok(html.includes('$2,500.00'));
  assert.ok(!html.includes('1,234') && !html.includes('1234'), 'the customer never sees the carrier cost');
  assert.equal((await call(other, 'GET', `/api/quotes/${quote.id}/print`)).status, 404);
  await call(admin, 'PATCH', `/api/quotes/${quote.id}`, { status: 'declined' });
  assert.equal((await call(admin, 'POST', `/api/quotes/${quote.id}/convert`, { pickup: '2030-06-01', delivery: '2030-06-03', weight: 100 })).status, 409);
  assert.equal((await call(admin, 'PATCH', `/api/quotes/${quote.id}`, { price: 3000 })).status, 409);
});
