// Time: everything is stored in UTC; a company's time zone and locale only change what people see
// (what "today" is, the daily charts, quote expiry, dates in the interface).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-time-'));
Object.assign(process.env, { NODE_ENV: 'development', DATABASE_PATH: path.join(dir, 't.db'), PORT: '0', BCRYPT_COST: '10', API_RATE_LIMIT_MAX: '5000', NEXUS_ENABLED: 'false' });

const timeLib = require('../lib/time');
const { runAsSystem, runAsTenant } = require('../lib/tenant-context');
const database = require('../database');
const { app, initialize } = require('../server');
const { db } = database;

let server; let base; let admin;
const call = (cookie, method, url, body) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
const json = async (...args) => (await call(...args)).json();
const asCompany = (work) => runAsTenant(1, work);
const system = (sql, params) => runAsSystem(() => database.sql.run(sql, params));

before(async () => {
  await initialize();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await call(null, 'POST', '/api/login', { email: 'admin@veyra.ai', password: 'admin123' });
  admin = res.headers.get('set-cookie').split(';')[0];
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => db.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('what a company calls today, and when its day begins, follow its time zone (including clock changes)', () => {
  const instant = new Date('2026-11-21T20:30:00Z');
  assert.equal(timeLib.localDate('UTC', instant), '2026-11-21');
  assert.equal(timeLib.localDate('Asia/Tashkent', instant), '2026-11-22');
  assert.equal(timeLib.localDate('America/Los_Angeles', instant), '2026-11-21');
  assert.equal(timeLib.utcText(timeLib.localDayStart('Asia/Tashkent', '2026-11-22')), '2026-11-21 19:00:00');
  assert.equal(timeLib.utcText(timeLib.localDayStart('America/New_York', '2026-03-08')), '2026-03-08 05:00:00');
  assert.equal(timeLib.utcText(timeLib.localDayStart('America/New_York', '2026-03-09')), '2026-03-09 04:00:00', 'the day after the clocks changed');
  assert.equal(timeLib.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(timeLib.localDate('Not/AZone', instant), '2026-11-21', 'a bad zone falls back to UTC');
});

test('times are shown in the company zone and locale; stored text is read as UTC', () => {
  assert.equal(timeLib.formatDateTime('2026-11-21 20:30:00', { timeZone: 'Asia/Tashkent', locale: 'de-DE' }), '22.11.2026, 01:30');
  assert.equal(timeLib.formatDateTime('2026-11-21 20:30:00', { timeZone: 'America/New_York', locale: 'en-US' }), 'Nov 21, 2026, 3:30 PM');
  assert.equal(timeLib.formatDateTime('2026-11-21T20:30:00Z', { timeZone: 'UTC', dateOnly: true }), 'Nov 21, 2026');
  assert.equal(timeLib.formatDateTime('not a time'), 'not a time');
  assert.equal(timeLib.isValidTimeZone('Europe/Berlin'), true);
  assert.equal(timeLib.isValidTimeZone('Mars/Base'), false);
  assert.equal(timeLib.isValidLocale('uz-UZ'), true);
  assert.equal(timeLib.isValidLocale('xx-XX'), false);
});

test('administrators set the time zone and locale; bad values are refused; unchanged when left out', async () => {
  assert.equal((await call(admin, 'PUT', '/api/company/settings', { currency: 'USD', weightUnit: 'kg', timeZone: 'Mars/Base' })).status, 400);
  assert.equal((await call(admin, 'PUT', '/api/company/settings', { currency: 'USD', weightUnit: 'kg', locale: 'xx-XX' })).status, 400);
  const saved = await json(admin, 'PUT', '/api/company/settings', { currency: 'USD', weightUnit: 'kg', timeZone: 'Asia/Tashkent', locale: 'de-DE' });
  assert.deepEqual(saved.region, { currency: 'USD', weightUnit: 'kg', timeZone: 'Asia/Tashkent', locale: 'de-DE' });
  const kept = await json(admin, 'PUT', '/api/company/settings', { currency: 'USD', weightUnit: 'kg' });
  assert.equal(kept.region.timeZone, 'Asia/Tashkent', 'leaving the zone out keeps it');
  const settings = await json(admin, 'GET', '/api/company/settings');
  assert.ok(settings.timeZones.includes('Asia/Tashkent') && settings.locales.includes('de-DE'));
  assert.equal((await json(admin, 'GET', '/api/me')).region.locale, 'de-DE');
  assert.equal((await json(null, 'GET', '/api/config')).timeZone, 'UTC');
});

test('storage stays UTC whatever zone the company uses', async () => {
  await runAsSystem(() => database.setTenantRegion(1, { currency: 'USD', weightUnit: 'kg', timeZone: 'Pacific/Kiritimati', locale: 'en-US' }));
  const created = await asCompany(() => database.createShipment({
    customer: 'UTC Co', origin: 'A', destination: 'B', pickup: '2030-01-01', delivery: '2030-01-02', status: 'New', weight: '1', equipment: 'Dry Van', actorId: 1, tenantId: 1
  }));
  const row = await runAsSystem(() => database.sql.get('SELECT created_at AS createdAt FROM shipments WHERE id = ?', [Number(created.id.replace('SHP-', ''))]));
  const drift = Math.abs(timeLib.parseUtc(row.createdAt).getTime() - Date.now());
  assert.ok(drift < 10000, `stored ${row.createdAt} is the UTC clock (off by ${drift} ms)`);
});

test('daily volume counts calendar days of the company zone, not UTC days', async () => {
  for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC']) {
    await runAsSystem(() => database.setTenantRegion(1, { currency: 'USD', weightUnit: 'kg', timeZone: zone, locale: 'en-US' }));
    await system('DELETE FROM shipment_events');
    await system('DELETE FROM shipments');
    const today = timeLib.localDate(zone);
    const justAfterMidnight = timeLib.utcText(new Date(timeLib.localDayStart(zone, today).getTime() + 60000));
    const justBeforeMidnight = timeLib.utcText(new Date(timeLib.localDayStart(zone, today).getTime() - 60000));
    for (const createdAt of [justAfterMidnight, justBeforeMidnight]) {
      await system("INSERT INTO shipments (tenant_id, customer, origin, destination, status, created_at) VALUES (1, 'Daily', 'A', 'B', 'New', ?)", [createdAt]);
    }
    const { weeklyVolume } = await asCompany(() => database.getAnalyticsPayload(1, { days: 7 }));
    assert.equal(weeklyVolume.at(-1).day, today, zone);
    assert.equal(weeklyVolume.at(-1).total, justAfterMidnight > utcNow() ? 0 : 1, `${zone}: a minute after local midnight is today`);
    assert.equal(weeklyVolume.at(-2).total, 1, `${zone}: a minute before local midnight is yesterday`);
  }
});

const utcNow = () => timeLib.utcText(new Date());

test('a quote expires at the end of the company day, not the UTC day', async () => {
  const zone = 'Pacific/Pago_Pago';
  await runAsSystem(() => database.setTenantRegion(1, { currency: 'USD', weightUnit: 'kg', timeZone: zone, locale: 'en-US' }));
  const today = timeLib.localDate(zone);
  const make = (validUntil) => asCompany(() => database.createQuote(1, {
    customer: 'Expiry Co', origin: 'A', destination: 'B', equipment: 'Dry Van', price: 100, validUntil
  }, 1));
  assert.notEqual((await make(today)).status, 'expired', 'valid through today in the company zone');
  assert.equal((await make(timeLib.addDays(today, -1))).status, 'expired');
});

test('the public tracking page carries the company zone and locale', async () => {
  await runAsSystem(() => database.setTenantRegion(1, { currency: 'USD', weightUnit: 'kg', timeZone: 'Asia/Tashkent', locale: 'ru-RU' }));
  const shipments = await json(admin, 'GET', '/api/admin/shipments');
  const id = shipments.shipments[0].id;
  const shared = await json(admin, 'POST', `/api/shipments/${id}/share`, {});
  const token = String(shared.path).split('/').pop();
  const page = await json(null, 'GET', `/api/public/track/${token}`);
  assert.equal(page.timeZone, 'Asia/Tashkent');
  assert.equal(page.locale, 'ru-RU');
});
