// Money: exact decimal rounding per currency, every amount labelled with its currency,
// totals that add cents without float drift, and old amounts that keep their currency when a company switches.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-money-'));
Object.assign(process.env, { NODE_ENV: 'development', DATABASE_PATH: path.join(dir, 'm.db'), BCRYPT_COST: '10', NEXUS_ENABLED: 'false', DB_RLS: 'off' });

const money = require('../lib/money');
const database = require('../database');
const { db, initialize, createShipment, dispatchShipment, getFinanceSummary, setTenantRegion, createQuote, updateQuote, upsertMarketRate, listMarketRates } = database;

const query = (method, sql, params = []) => new Promise((resolve, reject) => db[method](sql, params, function done(error, result) { return error ? reject(error) : resolve(method === 'run' ? { id: this.lastID } : result); }));
const T = 1;

async function load(customerRate, customer = 'ACME') {
  const created = await createShipment({
    customer, origin: 'Tashkent', destination: 'Berlin', pickup: '2026-10-05', delivery: '2026-10-09',
    status: 'Sourcing', weight: '4000', equipment: 'Reefer', customerRate, actorId: 1, tenantId: T
  });
  return Number(created.id.replace('SHP-', ''));
}

before(async () => {
  await initialize();
  await setTenantRegion(T, { currency: 'USD', weightUnit: 'kg' });
});
after(async () => {
  await new Promise((resolve) => db.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rounding is decimal, not floating point, and follows the currency minor unit', () => {
  assert.equal(money.roundMoney(0.1 + 0.2, 'USD'), 0.3);
  assert.equal(money.roundMoney(1.005, 'USD'), 1.01);
  assert.equal(money.roundMoney(2.675, 'EUR'), 2.68);
  assert.equal(money.roundMoney(-1.005, 'USD'), -1.01);
  assert.equal(money.roundMoney(1234.5678, 'JPY'), 1235);
  assert.equal(money.roundMoney(1.2345, 'KWD'), 1.235);
  assert.equal(money.roundMoney(null, 'USD'), null);
  assert.equal(money.addMoney('USD', ...Array(10).fill(0.1)), 1);
  assert.equal(money.addMoney('USD', 10.1, -0.3), 9.8);
  assert.equal(money.normalizeCurrency(' eur '), 'EUR');
  assert.throws(() => money.normalizeCurrency('euro'), /ISO 4217/);
  assert.throws(() => money.roundMoney(Infinity, 'USD'), /finite/);
});

test('a new load stores a rounded price and its currency', async () => {
  const id = await load(1500.005);
  const row = await query('get', 'SELECT customer_rate, currency FROM shipments WHERE id = ?', [id]);
  assert.equal(Number(row.customer_rate), 1500.01);
  assert.equal(row.currency, 'USD');
});

test('dispatch rounds both prices and keeps the load currency', async () => {
  const id = await load(null);
  const carrier = await query('run', "INSERT INTO carriers (tenant_id, name, mode, status) VALUES (?, 'Acme Freight', 'Truck', 'Available')", [T]);
  await dispatchShipment(T, id, carrier.id, 1200.126, 1, { customerRate: 1500.555 });
  const row = await query('get', 'SELECT rate, customer_rate, currency FROM shipments WHERE id = ?', [id]);
  assert.equal(Number(row.rate), 1200.13);
  assert.equal(Number(row.customer_rate), 1500.56);
  assert.equal(row.currency, 'USD');
});

test('quotes and market rates carry a currency and a margin without drift', async () => {
  const quote = await createQuote(T, {
    customer: 'ACME', origin: 'A', destination: 'B', equipment: 'Dry Van', price: 100.3, carrierCost: 100.1, validUntil: '2099-01-01'
  }, 1);
  assert.equal(quote.currency, 'USD');
  assert.equal(quote.margin, 0.2, '100.3 - 100.1 is 0.2 here, not 0.19999999999999574');
  const edited = await updateQuote(T, quote.id, { price: 200.005 });
  assert.equal(edited.price, 200.01);
  await upsertMarketRate(T, { origin: 'A', destination: 'B', equipment: 'Dry Van', rate: 99.999 });
  const rates = await listMarketRates(T);
  assert.equal(rates[0].rate, 100);
  assert.equal(rates[0].currency, 'USD');
});

test('finance totals add cents exactly and keep other currencies apart after a company switches currency', async () => {
  await query('run', 'DELETE FROM shipment_events');
  await query('run', 'DELETE FROM shipments');
  const ids = [];
  for (let i = 0; i < 10; i += 1) ids.push(await load(0.1, `Customer ${i}`));
  await query('run', "UPDATE shipments SET status = 'Delivered'");
  let summary = await getFinanceSummary(T);
  assert.equal(summary.currency, 'USD');
  assert.equal(summary.receivable, 1, 'ten loads of 0.10 add up to 1.00');
  assert.deepEqual(summary.otherCurrencies, []);

  await setTenantRegion(T, { currency: 'EUR', weightUnit: 'kg' });
  const euroLoad = await load(250.5, 'Euro customer');
  await query('run', "UPDATE shipments SET status = 'Delivered' WHERE id = ?", [euroLoad]);
  summary = await getFinanceSummary(T);
  assert.equal(summary.currency, 'EUR');
  assert.equal(summary.receivable, 250.5, 'only euro amounts are added into the euro total');
  assert.deepEqual(summary.otherCurrencies, [{ currency: 'USD', receivable: 1, payable: 0 }]);
  const oldLoad = summary.open.find((row) => row.id === `SHP-${ids[0]}`);
  assert.equal(oldLoad.currency, 'USD', 'an old amount keeps the currency it was entered in');
});

test('every money column holds exact decimals on PostgreSQL', async (t) => {
  if (!database.isPostgres) return t.skip('PostgreSQL only');
  const rows = await query('all', "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND ((table_name = 'shipments' AND column_name IN ('rate','customer_rate')) OR (table_name = 'quotes' AND column_name IN ('price','carrier_cost')) OR (table_name = 'market_rates' AND column_name = 'rate'))");
  assert.equal(rows.length, 5);
  assert.ok(rows.every((row) => row.data_type === 'numeric'), JSON.stringify(rows));
});
