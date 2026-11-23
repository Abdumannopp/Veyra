// Customs and dangerous goods (Phase 6.1): format checks, warnings per leg mode, and NEXUS tasks.
// Entered by people; no customs system is connected; the checks are not legal advice.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-compliance-'));
Object.assign(process.env, { NODE_ENV: 'development', DATABASE_PATH: path.join(dir, 'c.db'), PORT: '0', BCRYPT_COST: '10', API_RATE_LIMIT_MAX: '5000' });
delete process.env.OPENROUTER_API_KEY;

const rules = require('../lib/compliance');
const { app, initialize } = require('../server');
const { db } = require('../database');
const nexus = require('../agents/nexus');

let server; let base; let admin; let other; let load;
const call = (cookie, method, url, body) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
const json = async (...args) => { const res = await call(...args); return { status: res.status, body: await res.json() }; };
const tasks = async (cookie = admin) => (await json(cookie, 'GET', '/api/tasks')).body.tasks.filter((task) => /customs|UN\d{4}/.test(task.title));
async function login(email, password) {
  const res = await call(null, 'POST', '/api/login', { email, password });
  assert.equal(res.status, 200, email);
  return res.headers.get('set-cookie').split(';')[0];
}
const record = { goodsDescription: 'Paint', hsCode: '3208.10', originCountry: 'uz', destinationCountry: 'TR', declaredValue: 12000, incoterm: 'fca', customsStatus: 'Not started' };

before(async () => {
  await initialize();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await login('admin@veyra.ai', 'admin123');
  await call(admin, 'POST', '/api/platform/tenants', { companyName: 'Other Customs', adminName: 'Olga', adminEmail: 'olga@customs.example', adminPassword: 'OtherPass2026' });
  other = await login('olga@customs.example', 'OtherPass2026');
  const created = await json(admin, 'POST', '/api/v2/shipments', {
    customer: 'Paint Co', origin: 'Tashkent', destination: 'Istanbul', pickup: '2026-12-01', delivery: '2026-12-10', weight: 2000, equipment: 'Dry Van',
    legs: [{ mode: 'ROAD', origin: 'Tashkent', destination: 'TAS airport' }, { mode: 'AIR', origin: 'TAS', destination: 'IST' }]
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  load = created.body.shipment.id;
});
after(async () => {
  await nexus.idle();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => db.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rules: HS codes, countries, Incoterms, customs status and dangerous goods are checked', () => {
  const ok = rules.readCompliance(record);
  assert.deepEqual([ok.hsCode, ok.originCountry, ok.incoterm, ok.dangerous], ['320810', 'UZ', 'FCA', false]);
  assert.throws(() => rules.readCompliance({ hsCode: '32' }), /6 to 10 digits/);
  assert.throws(() => rules.readCompliance({ originCountry: 'Uzbekistan' }), /2-letter/);
  assert.throws(() => rules.readCompliance({ incoterm: 'FOT' }), /Incoterms 2020/);
  assert.throws(() => rules.readCompliance({ customsStatus: 'Declared' }), /declaration number/);
  assert.throws(() => rules.readCompliance({ dangerous: true, unNumber: '12', dgClass: '3', packingGroup: 'II', properShippingName: 'Paint' }), /UN and 4 digits/);
  assert.throws(() => rules.readCompliance({ dangerous: true, unNumber: 'UN1263', dgClass: '10', packingGroup: 'II', properShippingName: 'Paint' }), /dgClass/);
  assert.throws(() => rules.readCompliance({ dangerous: true, unNumber: 'UN1263', dgClass: '3', properShippingName: 'Paint' }), /packingGroup/);
  assert.throws(() => rules.readCompliance({ dangerous: true, unNumber: 'UN1072', dgClass: '2.2', packingGroup: 'II', properShippingName: 'Oxygen' }), /no packing group/);
  assert.throws(() => rules.readCompliance({ dangerous: true, unNumber: 'UN1263', dgClass: '3', packingGroup: 'II' }), /properShippingName/);
  const dg = rules.readCompliance({ dangerous: true, unNumber: '1263', dgClass: '3', packingGroup: 'ii', properShippingName: 'Paint' });
  assert.deepEqual([dg.unNumber, dg.packingGroup], ['UN1263', 'II']);
  assert.deepEqual(rules.warnings(dg, { legModes: ['ROAD', 'AIR'] }).map((w) => w.kind), ['dg_air', 'dg_road']);
  assert.deepEqual(rules.warnings(rules.readCompliance({ originCountry: 'UZ', destinationCountry: 'KZ' })).map((w) => w.kind), ['customs_missing']);
});

test('API: save and read the record; other companies cannot; bad input is refused', async () => {
  assert.equal((await json(admin, 'GET', `/api/v2/shipments/${load}/compliance`)).body.compliance, null);
  assert.equal((await json(admin, 'PUT', `/api/v2/shipments/${load}/compliance`, { hsCode: 'x' })).status, 400);
  const saved = await json(admin, 'PUT', `/api/v2/shipments/${load}/compliance`, record);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.compliance.hsCode, '320810');
  assert.equal(saved.body.compliance.declaredValue, 12000);
  assert.deepEqual(saved.body.warnings, []);
  assert.equal((await json(other, 'GET', `/api/v2/shipments/${load}/compliance`)).status, 404);
  assert.equal((await json(other, 'PUT', `/api/v2/shipments/${load}/compliance`, record)).status, 404);
});

test('NEXUS: dangerous goods on an air leg make one task; customs held makes a task that closes when cleared', async () => {
  const dg = { ...record, dangerous: true, unNumber: 'UN1263', dgClass: '3', packingGroup: 'II', properShippingName: 'Paint' };
  const saved = await json(admin, 'PUT', `/api/v2/shipments/${load}/compliance`, dg);
  assert.deepEqual(saved.body.warnings.map((w) => w.kind), ['dg_air', 'dg_road']);
  await json(admin, 'PUT', `/api/v2/shipments/${load}/compliance`, dg);
  await nexus.idle();
  let open = await tasks();
  assert.equal(open.filter((task) => /UN1263/.test(task.title)).length, 2, 'one per warning, not per save');
  assert.equal((await tasks(other)).length, 0);

  await json(admin, 'PUT', `/api/v2/shipments/${load}/compliance`, { ...dg, customsStatus: 'Held', declarationNo: 'GTD-77' });
  await nexus.idle();
  open = await tasks();
  assert.ok(open.some((task) => /held by customs \(declaration GTD-77\)/.test(task.title)));
  await json(admin, 'PUT', `/api/v2/shipments/${load}/compliance`, { ...dg, customsStatus: 'Cleared', declarationNo: 'GTD-77' });
  await nexus.idle();
  assert.equal((await tasks()).filter((task) => /held by customs/.test(task.title)).length, 0);
});
