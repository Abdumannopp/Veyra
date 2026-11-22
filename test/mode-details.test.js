// Ocean, air and rail details (Phase 4): identifiers checked the way the industry checks them,
// and the chargeable weight of air cargo worked out. Everything is entered by people.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-modes-'));
Object.assign(process.env, { NODE_ENV: 'development', DATABASE_PATH: path.join(dir, 'm.db'), PORT: '0', BCRYPT_COST: '10', API_RATE_LIMIT_MAX: '5000', NEXUS_ENABLED: 'false' });

const rules = require('../lib/mode-details');
const { readLegInput } = require('../lib/legs');
const { app, initialize } = require('../server');
const { db } = require('../database');

let server; let base; let admin;
const call = (method, url, body) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', cookie: admin || '' }, body: body ? JSON.stringify(body) : undefined });
const json = async (...args) => { const res = await call(...args); return { status: res.status, body: await res.json() }; };

before(async () => {
  await initialize();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await call('POST', '/api/login', { email: 'admin@veyra.ai', password: 'admin123' });
  admin = res.headers.get('set-cookie').split(';')[0];
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => db.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('container numbers follow ISO 6346 (published example CSQU3054383)', () => {
  assert.equal(rules.readContainerNo('csqu 305438-3'), 'CSQU3054383');
  assert.throws(() => rules.readContainerNo('CSQU3054384'), /wrong check digit/);
  assert.throws(() => rules.readContainerNo('CSQX3054383'), /4th U, J or Z/);
  assert.throws(() => rules.readContainerNo('CSQU305438'), /7 digits/);
});

test('air waybills: prefix, serial and a mod-7 check digit', () => {
  assert.equal(rules.readAirWaybill('176 1234 5675'), '176-12345675');
  assert.throws(() => rules.readAirWaybill('176-12345676'), /wrong check digit/);
  assert.throws(() => rules.readAirWaybill('176-123'), /11 digits/);
});

test('wagon numbers: UIC 12 digits (published example 21 81 2471 217-3) or 8 digits', () => {
  assert.equal(rules.readWagonNo('21 81 2471 217-3'), '218124712173');
  assert.throws(() => rules.readWagonNo('218124712174'), /wrong check digit/);
  assert.equal(rules.readWagonNo('5234567-5'), '52345675');
  assert.throws(() => rules.readWagonNo('12345'), /8 digits/);
});

test('chargeable weight is the larger of gross and volume weight, rounded up to half a kilogram', () => {
  assert.equal(rules.chargeableWeightKg({ grossWeightKg: 100, volumeM3: 1 }), 167);
  assert.equal(rules.chargeableWeightKg({ grossWeightKg: 250.2, volumeM3: 0.5 }), 250.5);
  assert.equal(rules.chargeableWeightKg({}), null);
});

test('leg input: rules apply per mode, values are normalised, chargeable weight cannot be typed', () => {
  const air = readLegInput({ mode: 'AIR', origin: 'Tashkent', destination: 'Istanbul', details: { flightNumber: 'tk 371', airWaybill: '235 1234 5675', airportFrom: 'tas', airportTo: 'ist', pieces: '4', grossWeightKg: '120,5', volumeM3: 1.2 } });
  assert.deepEqual(air.details, { flightNumber: 'TK371', airWaybill: '235-12345675', airportFrom: 'TAS', airportTo: 'IST', pieces: 4, grossWeightKg: 120.5, volumeM3: 1.2, chargeableWeightKg: 200 });
  assert.throws(() => readLegInput({ mode: 'AIR', origin: 'A', destination: 'B', details: { chargeableWeightKg: 5 } }), /not a AIR detail/);
  assert.throws(() => readLegInput({ mode: 'AIR', origin: 'A', destination: 'B', details: { airportFrom: 'Tashkent' } }), /3-letter IATA/);
  assert.throws(() => readLegInput({ mode: 'AIR', origin: 'A', destination: 'B', details: { pieces: 1.5 } }), /whole number/);
  const ocean = readLegInput({ mode: 'OCEAN', origin: 'Poti', destination: 'Hamburg', details: { containerNo: 'csqu3054383', containerType: '40hc', sealNo: 'S-1' } });
  assert.deepEqual(ocean.details, { containerNo: 'CSQU3054383', containerType: '40HC', sealNo: 'S-1' });
  assert.throws(() => readLegInput({ mode: 'OCEAN', origin: 'A', destination: 'B', details: { containerType: '30XL' } }), /Container type must be one of/);
  const rail = readLegInput({ mode: 'RAIL', origin: 'Almaty', destination: "Xi'an", details: { wagonNo: '218124712173', consignmentNoteType: 'cim/smgs', borderStation: 'Dostyk' } });
  assert.equal(rail.details.consignmentNoteType, 'CIM/SMGS');
});

test('API: a wrong container number is refused with the reason; a right one is saved normalised', async () => {
  const header = { customer: 'Silk Road Foods', origin: 'Tashkent', destination: 'Hamburg', pickup: '2026-12-01', delivery: '2026-12-30', weight: 18000, equipment: 'Reefer' };
  const bad = await json('POST', '/api/v2/shipments', { ...header, legs: [{ mode: 'OCEAN', origin: 'Poti', destination: 'Hamburg', details: { containerNo: 'CSQU3054384' } }] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.message, /wrong check digit/);
  const good = await json('POST', '/api/v2/shipments', { ...header, legs: [
    { mode: 'OCEAN', origin: 'Poti', destination: 'Hamburg', details: { containerNo: 'csqu 3054383', containerType: '40RF' } },
    { mode: 'AIR', origin: 'Hamburg', destination: 'Tashkent', details: { grossWeightKg: 300, volumeM3: 3 } }
  ] });
  assert.equal(good.status, 201);
  assert.equal(good.body.legs[0].details.containerNo, 'CSQU3054383');
  assert.equal(good.body.legs[1].details.chargeableWeightKg, 500);
});
