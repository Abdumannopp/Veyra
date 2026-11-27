// AI reliability and security hardening: quota, ledger, consent, data minimisation, output shape, numbers,
// time zones, long messages, unknown units and signatures. No real provider is called: a fake transport records
// every request, so "the provider was not called" is checked by counting them.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-ai-hardening-'));
process.env.NODE_ENV = 'development';
process.env.DATABASE_PATH = path.join(dir, 'h.db');
process.env.PORT = '0';
process.env.BCRYPT_COST = '10';
process.env.API_RATE_LIMIT_MAX = '5000';
process.env.WEIGHT_UNIT = 'kg';
process.env.CURRENCY = 'UZS';
process.env.GEMINI_API_KEY = 'AIzaHardeningTestKey0123456789abcdefghij';
process.env.JWT_SECRET = 'jwt-secret-for-hardening-tests-0123456789';
process.env.GEMINI_MODEL = 'test/model';

const { app, initialize } = require('../server');
const database = require('../database');
const { runAsTenant } = require('../lib/tenant-context');
const aiGateway = require('../ai/gateway');
const { validateShape, FLOW_SCHEMA } = require('../ai/schema');
const { redactSecrets } = require('../ai/redact');
const { parseLocaleNumber } = require('../lib/numbers');
const flow = require('../agents/flow');
const vault = require('../agents/vault');

let server;
let base;
let admin;
let other;
const TENANT = 1;

const call = (cookie, method, url, body) => fetch(`${base}${url}`, {
  method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined
});
async function login(email, password) {
  const res = await call(null, 'POST', '/api/login', { email, password });
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie').split(';')[0];
}

const flowAnswer = (extra = {}) => ({
  customer: 'Navoiy Textile', customerPhone: null, reference: null, origin: 'Tashkent', destination: 'Almaty',
  pickup: '2030-05-10', delivery: '2030-05-12', weight: '18,5', weightUnit: 't', equipment: 'Reefer',
  customerRate: null, customerRateCurrency: null, questions: [], confidence: 0.8, ...extra
});

// A fake provider: each request is recorded; `reply` decides the answer (string = raw content).
function fakeProvider(reply = () => flowAnswer(), { delayMs = 0 } = {}) {
  const requests = [];
  aiGateway.setTransport(async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body, raw: init.body });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const next = reply(requests.length);
    if (next && next.status) return new Response(JSON.stringify({ error: { message: 'upstream' } }), { status: next.status });
    return new Response(JSON.stringify({
      modelVersion: 'test/model', candidates: [{ content: { parts: [{ text: typeof next === 'string' ? next : JSON.stringify(next) }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return requests;
}

const withLimits = async (day, hour, work) => {
  const saved = [process.env.AI_DAILY_LIMIT_PER_TENANT, process.env.AI_RATE_LIMIT_PER_HOUR];
  process.env.AI_DAILY_LIMIT_PER_TENANT = String(day);
  process.env.AI_RATE_LIMIT_PER_HOUR = String(hour);
  try { return await work(); } finally {
    for (const [key, value] of [['AI_DAILY_LIMIT_PER_TENANT', saved[0]], ['AI_RATE_LIMIT_PER_HOUR', saved[1]]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
};
const today = () => `day:${new Date().toISOString().slice(0, 10)}`;
// The day's counter is shared by every test in this file, so each test reads it and checks the change.
const usedToday = (tenantId) => runAsTenant(tenantId, () => database.aiQuotaUsed(tenantId, today()));
const anyObject = () => ({ ok: true });
const userIds = (tenantId) => new Promise((resolve, reject) => database.db.all('SELECT id FROM users WHERE tenant_id = ? ORDER BY id', [tenantId], (e, rows) => (e ? reject(e) : resolve(rows.map((row) => row.id)))));
const askGateway = (tenantId, userId, validate = anyObject) => runAsTenant(tenantId, () => aiGateway.completeJson({
  agent: 'FLOW', system: 's', user: 'u', usage: { tenantId, userId }, validate
}));

before(async () => {
  await initialize();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await login('admin@veyra.ai', 'admin123');
  const created = await call(admin, 'POST', '/api/platform/tenants', { companyName: 'Hardening Other', adminName: 'Oz', adminEmail: 'oz@hardening.example', adminPassword: 'hardening-other-pass-1', plan: 'growth' });
  assert.equal(created.status, 201);
  other = await login('oz@hardening.example', 'hardening-other-pass-1');
});

after(async () => {
  aiGateway.setTransport(null);
  await new Promise((r) => server.close(r));
  await new Promise((r) => database.db.close(r));
});

/* ---------------- numbers ---------------- */

test('numbers: decimal commas, thousands and ambiguous values', () => {
  const value = (text) => parseLocaleNumber(text);
  assert.equal(value('18,5').value, 18.5);
  assert.equal(value('2,5').value, 2.5);
  assert.equal(value('1 250,75').value, 1250.75);
  assert.equal(value('1,250.75').value, 1250.75);
  assert.equal(value('1.250,75').value, 1250.75);
  assert.equal(value('1,250,000').value, 1250000);
  assert.equal(value('0,250').value, 0.25);
  assert.equal(value(18000).value, 18000);
  for (const ambiguous of ['1,250', '18.500']) {
    const result = value(ambiguous);
    assert.equal(result.ok, false, ambiguous);
    assert.equal(result.ambiguous, true, ambiguous);
  }
  for (const bad of ['20 t', 'heavy', '1,2,3', '', '1.2.3,4']) assert.equal(value(bad).ok, false, bad);
});

test('FLOW: an ambiguous number is never written; a clear one is', () => {
  const settings = { weightUnit: 'kg', currency: 'UZS', equipment: ['Reefer'], maxRate: 1e9, maxWeight: 100000, today: '2030-05-01' };
  const clear = flow.validateDraft(flowAnswer({ weight: '18,5', weightUnit: 't' }), settings);
  assert.equal(clear.draft.weight, 18500);
  assert.equal(clear.needsReview, false);
  const ambiguous = flow.validateDraft(flowAnswer({ weight: '1,250', weightUnit: 'kg' }), settings);
  assert.equal(ambiguous.draft.weight, null);
  assert.equal(ambiguous.needsReview, true);
  assert.ok(ambiguous.review.some((line) => /weight/.test(line)));
  const price = flow.validateDraft(flowAnswer({ customerRate: '1 250,75', customerRateCurrency: 'UZS' }), settings);
  assert.equal(price.draft.customerRate, 1250.75);
  const noUnit = flow.validateDraft(flowAnswer({ weight: 18000, weightUnit: null }), settings);
  assert.equal(noUnit.draft.weight, null, 'a weight without a unit is not assumed to be kg');
  assert.equal(noUnit.needsReview, true);
  const badDate = flow.validateDraft(flowAnswer({ pickup: '2030-02-30' }), settings);
  assert.equal(badDate.draft.pickup, null);
  assert.ok(badDate.review.some((line) => /pickup/.test(line)));
});

/* ---------------- time zone ---------------- */

test('FLOW: "today" is the company\'s day around the UTC boundary; no zone = UTC', async () => {
  const requests = fakeProvider();
  const now = new Date('2026-11-23T20:30:00Z');
  const ask = (timeZone) => runAsTenant(TENANT, () => flow.parseOrder('order', { weightUnit: 'kg', currency: 'UZS', equipment: ['Reefer'], maxRate: 1e9, maxWeight: 100000, timeZone, now }, { usage: { tenantId: TENANT } }));
  await ask('Asia/Tashkent');
  await ask('America/New_York');
  await ask(null);
  await ask('Not/AZone');
  const todays = requests.map((r) => /Today is (\d{4}-\d{2}-\d{2}) in the company's time zone \(([^)]+)\)/.exec(r.body.systemInstruction.parts[0].text).slice(1));
  assert.deepEqual(todays, [['2026-11-24', 'Asia/Tashkent'], ['2026-11-23', 'America/New_York'], ['2026-11-23', 'UTC'], ['2026-11-23', 'UTC']]);
  // Just after midnight UTC: New York is still on the day before.
  await runAsTenant(TENANT, () => flow.parseOrder('order', { weightUnit: 'kg', currency: 'UZS', equipment: [], maxRate: 1, maxWeight: 1, timeZone: 'America/New_York', now: new Date('2026-11-24T00:30:00Z') }, { usage: { tenantId: TENANT } }));
  assert.match(requests.at(-1).body.systemInstruction.parts[0].text, /Today is 2026-11-23/);
});

/* ---------------- long messages ---------------- */

test('FLOW: under, exactly at and over the limit; never cut', async () => {
  const requests = fakeProvider();
  const settings = { weightUnit: 'kg', currency: 'UZS', equipment: ['Reefer'], maxRate: 1e9, maxWeight: 100000 };
  const max = flow.MAX_INPUT_CHARS;
  await runAsTenant(TENANT, () => flow.parseOrder('x'.repeat(max - 1), settings, { usage: { tenantId: TENANT } }));
  await runAsTenant(TENANT, () => flow.parseOrder(`${'y'.repeat(max - 1)}Z`, settings, { usage: { tenantId: TENANT } }));
  assert.equal(requests.length, 2);
  assert.ok(requests[1].body.contents[0].parts[0].text.includes('Z\n</order>'), 'the last character of the message is sent');
  await assert.rejects(runAsTenant(TENANT, () => flow.parseOrder('x'.repeat(max + 1), settings, { usage: { tenantId: TENANT } })), (error) => error.statusCode === 413 && error.code === 'AI_INPUT_TOO_LONG');
  assert.equal(requests.length, 2, 'nothing was sent for the long message');
});

test('NEXUS: an email whose subject plus body is over the limit is read in parts (subject in the first), never cut', async () => {
  const requests = fakeProvider();
  const token = (await (await call(admin, 'POST', '/api/settings/inbox/token')).json()).token;
  const subject = 'S'.repeat(100);
  const body = `${'B'.repeat(flow.MAX_INPUT_CHARS - 51)}Z`; // short alone, too long with the subject
  const res = await fetch(`${base}/api/integrations/inbox/${token}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ From: 'long@x.example', Subject: subject, TextBody: body, MessageID: 'long-1' })
  });
  assert.ok(res.status < 300, `inbound accepted (${res.status})`);
  await require('../agents/nexus').idle();
  assert.equal(requests.length, 2, 'two parts, two model calls');
  const texts = requests.map((r) => r.body.contents[0].parts[0].text);
  assert.ok(texts[0].includes(`Subject: ${subject}`));
  assert.ok(!texts[1].includes('Subject:'), 'the subject only in the first part');
  assert.ok(texts[1].includes('Z\n</order>'), 'the last character of the email is read');
  const task = (await (await call(admin, 'GET', '/api/tasks')).json()).tasks.find((t) => t.payload?.from === 'long@x.example');
  assert.equal(task.payload.parsed.parts, 2);
  assert.ok(task.payload.parsed.draft);
});

/* ---------------- quota ---------------- */

test('quota: parallel requests never pass the company limit; counted once each; kept in the database', async () => {
  const requests = fakeProvider(() => ({ ok: true }), { delayMs: 20 });
  const start = await usedToday(TENANT);
  await withLimits(start + 5, 1000, async () => {
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => askGateway(TENANT, null)));
    const passed = results.filter((r) => r.status === 'fulfilled').length;
    const refused = results.filter((r) => r.status === 'rejected');
    assert.equal(passed, 5);
    assert.equal(requests.length, 5);
    assert.ok(refused.every((r) => r.reason.statusCode === 429 && r.reason.code === 'AI_QUOTA_EXCEEDED' && r.reason.details.scope === 'company_daily'));
    // A "restart": nothing is held in memory, the database still says 5.
    assert.equal(await usedToday(TENANT), start + 5);
  });
});

test('quota: a person\'s hourly limit; a refused person does not use the company budget', async () => {
  fakeProvider(() => ({ ok: true }));
  const start = await usedToday(TENANT);
  const [first, second] = await userIds(TENANT);
  await withLimits(start + 100, 2, async () => {
    await askGateway(TENANT, first);
    await askGateway(TENANT, first);
    await assert.rejects(askGateway(TENANT, first), (e) => e.code === 'AI_QUOTA_EXCEEDED' && e.details.scope === 'user_hourly' && e.retryAfterSeconds > 0);
    await askGateway(TENANT, second);
    assert.equal(await usedToday(TENANT), start + 3);
  });
});

test('quota: each provider request takes one unit, the gateway retry included; the HTTP answer is 429 with Retry-After', async () => {
  const start = await usedToday(TENANT);
  const requests = fakeProvider(() => ({ status: 503 }));
  await assert.rejects(askGateway(TENANT, null), (e) => e.code === 'AI_PROVIDER_FAILED');
  assert.equal(requests.length, 2, 'retried once');
  assert.equal(await usedToday(TENANT), start + 2, 'two provider requests (the call and its retry) = two units');

  fakeProvider();
  await withLimits(await usedToday(TENANT), 1000, async () => {
    const res = await call(admin, 'POST', '/api/agents/flow/parse', { text: 'order' });
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) > 0);
    const body = await res.json();
    assert.equal(body.code, 'AI_QUOTA_EXCEEDED');
    assert.equal(body.details.scope, 'company_daily');
  });
});

test('quota: one company using its budget does not touch another\'s', async () => {
  fakeProvider();
  await withLimits((await usedToday(TENANT)) + 1, 1000, async () => {
    await call(admin, 'PUT', '/api/settings/ai-consent', { consent: true });
    await call(other, 'PUT', '/api/settings/ai-consent', { consent: true });
    assert.equal((await call(admin, 'POST', '/api/agents/flow/parse', { text: 'order' })).status, 200);
    assert.equal((await call(admin, 'POST', '/api/agents/flow/parse', { text: 'order' })).status, 429);
    assert.equal((await call(other, 'POST', '/api/agents/flow/parse', { text: 'order' })).status, 200);
  });
});

/* ---------------- ledger and logs ---------------- */

test('ledger: tokens are kept for an answer that is not JSON; failures are recorded with their kind', async () => {
  fakeProvider(() => 'Sorry, I cannot help with that.');
  await assert.rejects(askGateway(TENANT, null), (e) => e.code === 'AI_INVALID_OUTPUT');
  const [row] = await runAsTenant(TENANT, () => database.listAiCalls(TENANT, { limit: 1 }));
  assert.equal(row.status, 'invalid_output');
  assert.equal(row.errorKind, 'invalid_json');
  assert.equal(row.inputTokens, 100, 'the tokens of the answer that was not JSON are kept');
  assert.equal(row.model, 'test/model');
  assert.ok(row.latencyMs >= 0);

  fakeProvider(() => { throw new Error('network down'); });
  await assert.rejects(askGateway(TENANT, null));
  const [failed] = await runAsTenant(TENANT, () => database.listAiCalls(TENANT, { limit: 1 }));
  assert.equal(failed.status, 'failed');
  assert.ok(failed.errorKind);
});

test('ledger: a failing activity log is a structured log line, not silence, and the quota still counts', async () => {
  fakeProvider(() => ({ ok: true }));
  const start = await usedToday(TENANT);
  const lines = [];
  const original = console.error;
  const originalLog = console.log;
  const capture = (...args) => lines.push(args.join(' '));
  console.error = capture;
  console.log = capture;
  try {
    await runAsTenant(TENANT, () => aiGateway.completeJson({ agent: 'FLOW', system: 's', user: 'secret order text', usage: { tenantId: TENANT }, validate: anyObject, log: () => { throw new Error('disk full'); } }));
  } finally {
    console.error = original;
    console.log = originalLog;
  }
  const line = lines.find((l) => l.includes('ai_audit_log_failed'));
  assert.ok(line, 'structured line written');
  assert.doesNotThrow(() => JSON.parse(line));
  assert.ok(!lines.some((l) => l.includes('secret order text')), 'no prompt text in logs');
  assert.equal(await usedToday(TENANT), start + 1);
});

/* ---------------- consent ---------------- */

test('consent: off = the provider is never called, a clear 403; changes are logged with who and when', async () => {
  const requests = fakeProvider();
  const off = await call(other, 'PUT', '/api/settings/ai-consent', { consent: false });
  assert.equal(off.status, 200);
  const res = await call(other, 'POST', '/api/agents/flow/parse', { text: 'order' });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'AI_CONSENT_REQUIRED');
  assert.equal(requests.length, 0);

  // The other company's setting does not change ours.
  assert.equal((await (await call(admin, 'GET', '/api/settings/ai-consent')).json()).consent, true);
  const mine = await (await call(other, 'GET', '/api/settings/ai-consent')).json();
  assert.equal(mine.consent, false);
  assert.ok(mine.changedAt);
  assert.ok(mine.changedBy);
  assert.equal((await call(other, 'PUT', '/api/settings/ai-consent', { consent: 'yes' })).status, 400);

  const activity = await (await call(other, 'GET', '/api/audit')).json();
  const entries = activity.entries.filter((e) => e.action === 'ai.consent');
  assert.ok(entries.length >= 2, 'every change is in the activity log');
  assert.equal((await call(other, 'PUT', '/api/settings/ai-consent', { consent: true })).status, 200);
});

test('consent: a new company starts with sharing off', async () => {
  const created = await call(admin, 'POST', '/api/platform/tenants', { companyName: 'Fresh Co', adminName: 'Fi', adminEmail: 'fi@fresh.example', adminPassword: 'fresh-company-pass-1', plan: 'growth' });
  assert.equal(created.status, 201);
  const fresh = await login('fi@fresh.example', 'fresh-company-pass-1');
  assert.equal((await (await call(fresh, 'GET', '/api/settings/ai-consent')).json()).consent, false);
});

/* ---------------- data minimisation ---------------- */

test('redaction: passwords, keys and server secrets never reach the provider; ordinary data does', async () => {
  const requests = fakeProvider();
  const text = [
    'Truck Tashkent-Almaty, 20 t, call +998 90 111 22 33, price 15 000 000 UZS.',
    'Portal password: Hunter2!x', 'api_key=abcd1234efgh5678', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
    `leaked ${process.env.GEMINI_API_KEY} and ${process.env.JWT_SECRET}`, 'пароль: qwerty123'
  ].join('\n');
  await runAsTenant(TENANT, () => flow.parseOrder(text, { weightUnit: 'kg', currency: 'UZS', equipment: [], maxRate: 1, maxWeight: 1 }, { usage: { tenantId: TENANT } }));
  const sent = requests[0].raw;
  for (const secret of ['Hunter2!x', 'abcd1234efgh5678', 'eyJhbGciOiJIUzI1NiJ9', process.env.GEMINI_API_KEY, process.env.JWT_SECRET, 'qwerty123']) {
    assert.ok(!sent.includes(secret), `not sent: ${secret.slice(0, 6)}…`);
  }
  assert.ok(sent.includes('+998 90 111 22 33'));
  assert.ok(sent.includes('15 000 000 UZS'));
  assert.ok(redactSecrets('no secrets here').includes('no secrets here'));
});

/* ---------------- output shape ---------------- */

test('schema: invalid JSON, empty answer, extra text, wrong types and missing fields', async () => {
  assert.equal(validateShape(flowAnswer(), FLOW_SCHEMA).ok, true);
  assert.equal(validateShape({ ...flowAnswer(), extra: 'ignored' }, FLOW_SCHEMA).ok, true, 'extra keys are ignored');
  assert.equal(validateShape(null, FLOW_SCHEMA).ok, false);
  assert.equal(validateShape([], FLOW_SCHEMA).ok, false);
  const { customer, ...missing } = flowAnswer();
  assert.equal(validateShape(missing, FLOW_SCHEMA).ok, false);
  assert.equal(validateShape(flowAnswer({ questions: 'none' }), FLOW_SCHEMA).ok, false);
  assert.equal(validateShape(flowAnswer({ confidence: '0.5x' }), FLOW_SCHEMA).ok, false);
  assert.equal(validateShape(flowAnswer({ origin: 42 }), FLOW_SCHEMA).ok, false);
  assert.equal(validateShape(flowAnswer({ weightUnit: 'stone' }), FLOW_SCHEMA).ok, false);

  const cases = ['', '{not json', 'Here you go: hello', JSON.stringify({ customer: 'x' }), JSON.stringify(flowAnswer({ questions: 7 }))];
  for (const reply of cases) {
    fakeProvider(() => reply);
    await assert.rejects(
      runAsTenant(TENANT, () => flow.parseOrder('order', { weightUnit: 'kg', currency: 'UZS', equipment: [], maxRate: 1, maxWeight: 1 }, { usage: { tenantId: TENANT } })),
      (e) => e.statusCode === 502 && e.code === 'AI_INVALID_OUTPUT', `rejected: ${reply.slice(0, 20)}`
    );
  }
  // Extra text around a valid object is accepted (the object is taken), then checked like any other answer.
  fakeProvider(() => `Sure!\n${JSON.stringify(flowAnswer())}\nThanks`);
  const ok = await runAsTenant(TENANT, () => flow.parseOrder('order', { weightUnit: 'kg', currency: 'UZS', equipment: ['Reefer'], maxRate: 1e9, maxWeight: 100000 }, { usage: { tenantId: TENANT } }));
  assert.equal(ok.draft.customer, 'Navoiy Textile');
});

/* ---------------- model configuration ---------------- */

test('model: gemini-2.5-flash-lite by default; another GEMINI_MODEL is announced with a warning', () => {
  const saved = process.env.GEMINI_MODEL;
  delete process.env.GEMINI_MODEL;
  try {
    assert.equal(aiGateway.modelName(), 'gemini-2.5-flash-lite');
    assert.equal(aiGateway.checkModelConfig({ production: true }).warning, null);
  } finally {
    process.env.GEMINI_MODEL = saved;
  }
  assert.match(aiGateway.checkModelConfig({ production: true }).warning, /not the project's model gemini-2\.5-flash-lite/);
});

/* ---------------- VAULT ---------------- */

const cmr = (extra = {}) => ({
  consignor: 'Navoiy Textile', consignee: 'Almaty Trade', carrier: null, placeOfLoading: 'Tashkent', placeOfDelivery: 'Almaty',
  date: null, truckPlate: null, grossWeight: 18000, weightUnit: 'kg', packages: null, goods: null, signedByConsignee: null, notes: null, ...extra
});
const shipment = { customer: 'Navoiy Textile', origin: 'Tashkent', destination: 'Almaty', weight: 18000, pickup: '2030-05-10', delivery: '2030-05-12' };

test('VAULT: a weight with no unit is never assumed kg and never "ok"', () => {
  const fields = vault.validateExtraction(cmr({ weightUnit: null }), { weightUnit: 'kg' });
  assert.equal(fields.weightUnitAssumed, true);
  assert.equal(fields.grossWeight, null);
  assert.equal(fields.grossWeightAsWritten, 18000);
  const result = vault.compareWithShipment(fields, shipment, { type: 'cmr' });
  const weight = result.checks.find((c) => c.field === 'weight');
  assert.equal(weight.status, 'unknown');
  assert.match(weight.hint, /Check by hand/);
  assert.equal(result.needsReview, true);

  const ambiguous = vault.validateExtraction(cmr({ grossWeight: '18.500', weightUnit: 'kg' }), { weightUnit: 'kg' });
  assert.equal(vault.compareWithShipment(ambiguous, shipment).checks.find((c) => c.field === 'weight').status, 'unknown');

  const known = vault.validateExtraction(cmr({ grossWeight: '18,0', weightUnit: 't' }), { weightUnit: 'kg' });
  assert.equal(known.weightUnitAssumed, false);
  assert.equal(vault.compareWithShipment(known, shipment).checks.find((c) => c.field === 'weight').status, 'ok');
});

test('VAULT: receiver signature true / false / null on a POD; no warning on a CMR', () => {
  const check = (signed, type) => vault.compareWithShipment(vault.validateExtraction(cmr({ signedByConsignee: signed }), { weightUnit: 'kg' }), shipment, { type }).checks.find((c) => c.field === 'signature');
  assert.equal(check(true, 'pod').status, 'ok');
  assert.equal(check(false, 'pod').status, 'mismatch');
  assert.equal(check(null, 'pod').status, 'unknown');
  assert.equal(check(false, 'cmr'), undefined);
  assert.equal(check(null, 'cmr'), undefined);
});

/* ---------------- plans still apply ---------------- */

test('plan gating: Starter still gets 402 and the provider is not called', async () => {
  const requests = fakeProvider();
  const created = await call(admin, 'POST', '/api/platform/tenants', { companyName: 'Starter Hard', adminName: 'St', adminEmail: 'st@starter.example', adminPassword: 'starter-company-pass-1', plan: 'starter' });
  assert.equal(created.status, 201);
  const starter = await login('st@starter.example', 'starter-company-pass-1');
  assert.equal((await call(starter, 'POST', '/api/agents/flow/parse', { text: 'order' })).status, 402);
  assert.equal(requests.length, 0);
});

/* ---------------- PR #40 review: manual reading, ledger, validators, retries ---------------- */

const cmrAnswer = () => ({
  consignor: 'Navoiy Textile', consignee: null, carrier: null, placeOfLoading: 'Tashkent', placeOfDelivery: 'Almaty',
  date: null, truckPlate: null, grossWeight: 18000, weightUnit: 'kg', packages: null, goods: null, signedByConsignee: null, notes: null
});
const pdfBytes = (marker) => Buffer.concat([Buffer.from(`%PDF-1.4\n% ${marker}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`), Buffer.alloc(64, 1)]);

test('manual "Read with AI": the asking person\'s hourly budget is taken by the real call, also in parallel', async () => {
  const nexus = require('../agents/nexus');
  // Automatic reading off, so only the manual requests reach the model.
  assert.equal((await call(admin, 'PUT', '/api/settings/automations', { readDocuments: false })).status, 200);
  try {
    const created = await call(admin, 'POST', '/api/shipments', { customer: 'Hourly Co', origin: 'Tashkent', destination: 'Almaty', pickup: '2030-05-10', delivery: '2030-05-12', weight: 18000, equipment: 'Reefer' });
    assert.equal(created.status, 201);
    const shipmentId = String((await created.json()).shipment?.id || '').replace(/\D/g, '');
    const docIds = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await fetch(`${base}/api/shipments/${shipmentId}/documents?type=cmr&filename=cmr${i}.pdf`, { method: 'POST', headers: { 'content-type': 'application/pdf', cookie: admin }, body: pdfBytes(`hourly-${i}`) });
      assert.equal(res.status, 201);
      docIds.push((await res.json()).document.id);
    }
    await nexus.idle();
    const [adminId] = await userIds(TENANT);
    const hourKey = `user:${adminId}:hour:${new Date().toISOString().slice(0, 13)}`;
    const hourUsed = () => runAsTenant(TENANT, () => database.aiQuotaUsed(TENANT, hourKey));
    const startHour = await hourUsed();
    const requests = fakeProvider(() => cmrAnswer(), { delayMs: 30 });
    await withLimits((await usedToday(TENANT)) + 100, startHour + 2, async () => {
      // All five pass the quick check at the door (nothing is taken there); the background readings run in parallel.
      const answers = await Promise.all(docIds.map((id) => call(admin, 'POST', `/api/shipments/${shipmentId}/documents/${id}/extract`)));
      assert.ok(answers.every((res) => res.status === 202));
      await nexus.idle();
      assert.equal(requests.length, 2, 'only the person\'s 2 hourly units reached the provider');
      assert.equal(await hourUsed(), startHour + 2);
      const docs = (await (await call(admin, 'GET', `/api/shipments/${shipmentId}/documents`)).json()).documents.filter((d) => docIds.includes(d.id));
      const failed = docs.filter((d) => d.extraction?.status === 'failed' || d.extractionStatus === 'failed');
      assert.equal(failed.length, 3, 'the other three say the hourly limit was reached');
    });
    // The ledger names the person who asked.
    const calls = await runAsTenant(TENANT, () => database.listAiCalls(TENANT, { limit: 2 }));
    assert.ok(calls.every((row) => row.userId === adminId && row.agent === 'VAULT'));
  } finally {
    await call(admin, 'PUT', '/api/settings/automations', { readDocuments: true });
  }
});

// A store that wraps the real one and fails on purpose.
function failingStore(overrides) {
  const real = require('../database');
  return { ...real, ...overrides };
}

test('ledger: if the ai_calls row cannot be written, nothing is sent and the unit is given back', async () => {
  const requests = fakeProvider();
  const start = await usedToday(TENANT);
  aiGateway.setUsageStore(failingStore({ startAiCall: async () => { throw new Error('ledger down'); } }));
  try {
    await assert.rejects(askGateway(TENANT, null), (e) => e.statusCode === 503 && e.code === 'AI_USAGE_UNAVAILABLE');
  } finally {
    aiGateway.setUsageStore(null);
  }
  assert.equal(requests.length, 0, 'the provider was not called');
  assert.equal(await usedToday(TENANT), start, 'the unit was given back');
});

test('ledger: completing the row is retried; if it still fails the tokens are in a structured log line', async () => {
  const real = require('../database');
  fakeProvider(() => ({ ok: true }));
  let failures = 1;
  aiGateway.setUsageStore(failingStore({ finishAiCall: async (...args) => { if (failures > 0) { failures -= 1; throw new Error('busy'); } return real.finishAiCall(...args); } }));
  try {
    await askGateway(TENANT, null);
  } finally {
    aiGateway.setUsageStore(null);
  }
  const [row] = await runAsTenant(TENANT, () => database.listAiCalls(TENANT, { limit: 1 }));
  assert.equal(row.status, 'succeeded', 'the second try saved the row');
  assert.equal(row.inputTokens, 100);
  assert.equal(row.outputTokens, 20);

  const lines = [];
  const original = [console.error, console.log];
  console.error = (...a) => lines.push(a.join(' '));
  console.log = (...a) => lines.push(a.join(' '));
  aiGateway.setUsageStore(failingStore({ finishAiCall: async () => { throw new Error('ledger gone'); } }));
  try {
    await askGateway(TENANT, null);
  } finally {
    aiGateway.setUsageStore(null);
    [console.error, console.log] = original;
  }
  const line = lines.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).find((l) => l?.event === 'ai_ledger_finish_failed');
  assert.ok(line, 'structured line written');
  assert.equal(line.inputTokens, 100);
  assert.equal(line.outputTokens, 20);
  assert.equal(line.status, 'succeeded');
});

test('validate is required: a call without it is refused before anything is spent', async () => {
  const requests = fakeProvider();
  const start = await usedToday(TENANT);
  await assert.rejects(runAsTenant(TENANT, () => aiGateway.completeJson({ agent: 'FLOW', system: 's', user: 'u', usage: { tenantId: TENANT } })), /without an answer check/);
  await assert.rejects(runAsTenant(TENANT, () => aiGateway.completeJson({ agent: 'FLOW', system: 's', user: 'u', usage: { tenantId: TENANT }, validate: 'yes' })), /without an answer check/);
  assert.equal(requests.length, 0);
  assert.equal(await usedToday(TENANT), start);
});

test('validate is used by every agent: FLOW, VAULT CMR/POD and VAULT transport papers reject a wrong shape', async () => {
  // Every model call in the code passes validate (a source scan, so a new agent cannot forget it).
  const root = path.join(__dirname, '..');
  for (const file of ['agents/flow.js', 'agents/vault.js', 'agents/nexus.js', 'server.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const calls = source.split('completeJson({').slice(1);
    for (const body of calls) assert.match(body.slice(0, body.indexOf('});')), /validate:/, `${file}: completeJson without validate`);
  }
  const wrong = { hello: 'world' };
  const doc = { content: pdfBytes('shape'), mime: 'application/pdf', filename: 'x.pdf' };
  fakeProvider(() => wrong);
  await assert.rejects(runAsTenant(TENANT, () => flow.parseOrder('order', { weightUnit: 'kg', currency: 'UZS', equipment: [], maxRate: 1, maxWeight: 1 }, { usage: { tenantId: TENANT } })), (e) => e.code === 'AI_INVALID_OUTPUT');
  await assert.rejects(runAsTenant(TENANT, () => vault.extractFields(doc, { weightUnit: 'kg' }, { usage: { tenantId: TENANT } })), (e) => e.code === 'AI_INVALID_OUTPUT');
  for (const type of ['bill_of_lading', 'air_waybill', 'rail_waybill']) {
    await assert.rejects(runAsTenant(TENANT, () => vault.extractTransport(doc, type, { usage: { tenantId: TENANT } })), (e) => e.code === 'AI_INVALID_OUTPUT', type);
  }
  // And a right shape passes for VAULT CMR.
  fakeProvider(() => cmrAnswer());
  const fields = await runAsTenant(TENANT, () => vault.extractFields(doc, { weightUnit: 'kg' }, { usage: { tenantId: TENANT } }));
  assert.equal(fields.consignor, 'Navoiy Textile');
});

test('retry: counters equal the provider requests sent; the ledger has both attempts and all tokens', async () => {
  const start = await usedToday(TENANT);
  const requests = fakeProvider((n) => (n === 1 ? { status: 503 } : { ok: true }));
  await askGateway(TENANT, null);
  assert.equal(requests.length, 2);
  assert.equal(await usedToday(TENANT), start + 2, 'two requests = two units');
  const [row] = await runAsTenant(TENANT, () => database.listAiCalls(TENANT, { limit: 1 }));
  assert.equal(row.status, 'succeeded');
  assert.equal(row.attempts, 2);
  assert.equal(row.inputTokens, 100, 'only the answered request reported tokens');

  // No unit left for the retry: it is not sent.
  const now = await usedToday(TENANT);
  const second = fakeProvider(() => ({ status: 503 }));
  await withLimits(now + 1, 1000, async () => {
    await assert.rejects(askGateway(TENANT, null), (e) => e.code === 'AI_PROVIDER_FAILED');
  });
  assert.equal(second.length, 1, 'no retry without a unit');
  assert.equal(await usedToday(TENANT), now + 1);
  const [last] = await runAsTenant(TENANT, () => database.listAiCalls(TENANT, { limit: 1 }));
  assert.equal(last.attempts, 1);
});
