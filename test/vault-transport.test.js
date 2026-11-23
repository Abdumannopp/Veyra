// VAULT for ocean, air and rail papers (Phase 4.3): a B/L, AWB or rail note is read, its numbers checked
// (check digits), compared with the leg of that mode, and filed under that leg. A difference is a task for a person.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-vault-modes-'));
Object.assign(process.env, {
  NODE_ENV: 'development', DATABASE_PATH: path.join(dir, 'v.db'), PORT: '0', BCRYPT_COST: '10', API_RATE_LIMIT_MAX: '5000',
  WEIGHT_UNIT: 'kg', OPENROUTER_API_KEY: 'sk-or-test', DOCUMENT_STORAGE: 'database'
});
delete process.env.OPENROUTER_MODEL;

const { app, initialize } = require('../server');
const { db } = require('../database');
const aiGateway = require('../ai/gateway');
const nexus = require('../agents/nexus');
const vault = require('../agents/vault');

let server; let base; let admin; let load;
const call = (method, url, body) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', cookie: admin || '' }, body: body ? JSON.stringify(body) : undefined });
const json = async (...args) => { const res = await call(...args); return { status: res.status, body: await res.json() }; };
const pdf = (marker) => Buffer.concat([Buffer.from(`%PDF-1.4\n% ${marker}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`), Buffer.alloc(64, 1)]);
const upload = (type, marker) => fetch(`${base}/api/shipments/${load.id}/documents?type=${type}&filename=${type}-${marker}.pdf`, { method: 'POST', headers: { 'content-type': 'application/pdf', cookie: admin }, body: pdf(marker) });
const fakeModel = (reply) => aiGateway.setTransport(async () => new Response(JSON.stringify({ model: 'test/vision', choices: [{ message: { content: JSON.stringify(reply) } }], usage: { prompt_tokens: 900, completion_tokens: 120 } }), { status: 200, headers: { 'content-type': 'application/json' } }));

const bl = {
  documentNumber: 'MSCUBL7788', shipper: 'Silk Road Foods', consignee: 'Hamburg Imports', carrier: 'MSC', vessel: 'MSC Aurora', voyage: 'AU123',
  from: 'Poti, Georgia', to: 'Hamburg, Germany', date: '2026-12-08', containerNumbers: ['CSQU 305438-3'], wagonNumbers: [], pieces: 20, grossWeight: 18.2, weightUnit: 't', goods: 'Dried fruit', notes: null
};

before(async () => {
  await initialize();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await call('POST', '/api/login', { email: 'admin@veyra.ai', password: 'admin123' });
  admin = res.headers.get('set-cookie').split(';')[0];
  const created = await json('POST', '/api/v2/shipments', {
    customer: 'Silk Road Foods', origin: 'Tashkent', destination: 'Hamburg', pickup: '2026-12-01', delivery: '2026-12-30', weight: 18000, equipment: 'Reefer',
    legs: [
      { mode: 'ROAD', origin: 'Tashkent', destination: 'Poti Port' },
      { mode: 'OCEAN', origin: 'Poti Port', destination: 'Hamburg Port', details: { billOfLading: 'MSCU-BL-7788', vessel: 'MSC Aurora', containerNo: 'CSQU3054383', portOfLoading: 'Poti', portOfDischarge: 'Hamburg' } }
    ]
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  load = { id: created.body.shipment.id, legs: created.body.legs };
});
after(async () => {
  await nexus.idle();
  aiGateway.setTransport(null);
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => db.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rules: numbers that fail their check digit are not trusted; comparison is plain code', () => {
  const fields = vault.validateTransport({ ...bl, containerNumbers: ['CSQU3054383', 'CSQU3054384'] }, 'bill_of_lading');
  assert.deepEqual(fields.containerNumbers, ['CSQU3054383']);
  assert.deepEqual(fields.unreadable, ['a container number with a wrong check digit']);
  assert.equal(fields.grossWeightKg, 18200);
  const leg = { mode: 'OCEAN', origin: 'Poti Port', destination: 'Hamburg Port', reference: null, details: { billOfLading: 'MSCU-BL-7788', vessel: 'MSC Aurora', containerNo: 'CSQU3054383' } };
  const result = vault.compareWithLeg(vault.validateTransport(bl, 'bill_of_lading'), leg, { weight: '18000 kg' });
  assert.equal(result.mismatches, 0, JSON.stringify(result.checks));
  const awb = vault.validateTransport({ documentNumber: '235 1234 5675', flightNumber: 'tk 371', from: 'TAS', to: 'IST', pieces: 4 }, 'air_waybill');
  assert.equal(awb.documentNumber, '235-12345675');
  const air = vault.compareWithLeg(awb, { origin: 'Tashkent', destination: 'Istanbul', details: { airWaybill: '235-12345675', flightNumber: 'TK371', airportFrom: 'TAS', airportTo: 'IST', pieces: 5 } }, {});
  assert.deepEqual(air.checks.filter((c) => c.status === 'mismatch').map((c) => c.field), ['pieces']);
  const badAwb = vault.validateTransport({ documentNumber: '235-12345676' }, 'air_waybill');
  assert.deepEqual(badAwb.unreadable, ['AWB 235-12345676']);
  const rail = vault.compareWithLeg(vault.validateTransport({ documentNumber: 'SMGS-55', wagonNumbers: ['21 81 2471 217-3'], from: 'Dostyk', to: "Xi'an" }, 'rail_waybill'),
    { origin: 'Dostyk', destination: "Xi'an", details: { consignmentNoteNo: 'SMGS 55', wagonNo: '52345675' } }, {});
  assert.deepEqual(rail.checks.filter((c) => c.status === 'mismatch').map((c) => c.field), ['wagonNo']);
});

test('a matching B/L is read, filed under the ocean leg, and raises no task', async () => {
  fakeModel(bl);
  const res = await upload('bill_of_lading', 'ok');
  assert.equal(res.status, 201);
  const doc = (await res.json()).document;
  await nexus.idle();
  const docs = (await json('GET', `/api/shipments/${load.id}/documents`)).body.documents;
  const read = docs.find((item) => item.id === doc.id);
  assert.equal(read.extractionStatus, 'done', read.error);
  assert.equal(read.comparison.mismatches, 0, JSON.stringify(read.comparison.checks));
  assert.equal(read.legId, load.legs[1].id, 'filed under the ocean leg');
  const tasks = (await json('GET', '/api/tasks')).body.tasks.filter((task) => task.kind === 'check_document');
  assert.equal(tasks.length, 0);
});

test('a B/L for another container and vessel raises one task naming the leg', async () => {
  fakeModel({ ...bl, vessel: 'Maersk Kobe', containerNumbers: ['MSCU1234566'] });
  const doc = (await (await upload('bill_of_lading', 'bad')).json()).document;
  await nexus.idle();
  const read = (await json('GET', `/api/shipments/${load.id}/documents`)).body.documents.find((item) => item.id === doc.id);
  assert.deepEqual(read.comparison.checks.filter((c) => c.status === 'mismatch').map((c) => c.field).sort(), ['containerNo', 'vessel']);
  const tasks = (await json('GET', '/api/tasks')).body.tasks.filter((task) => task.kind === 'check_document');
  assert.equal(tasks.length, 1);
  assert.match(tasks[0].title, /2 differences from SHP-\d+ leg 2 \(ocean\)/);
});

test('an AWB on a load with no air leg is read but has nothing to compare with', async () => {
  fakeModel({ documentNumber: '235-12345675', from: 'TAS', to: 'HAM' });
  const doc = (await (await upload('air_waybill', 'noleg')).json()).document;
  await nexus.idle();
  const read = (await json('GET', `/api/shipments/${load.id}/documents`)).body.documents.find((item) => item.id === doc.id);
  assert.equal(read.extractionStatus, 'done');
  assert.equal(read.comparison.mismatches, 0);
  assert.match(read.comparison.checks[0].hint, /no air leg/);
  assert.equal(read.legId, null);
});
