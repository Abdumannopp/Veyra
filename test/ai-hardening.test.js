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
process.env.OPENROUTER_API_KEY = 'sk-or-hardening-test-key-123456';
process.env.JWT_SECRET = 'jwt-secret-for-hardening-tests-0123456789';
process.env.OPENROUTER_MODEL = 'test/model';

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
      model: 'test/model', choices: [{ message: { content: typeof next === 'string' ? next : JSON.stringify(next) } }],
      usage: { prompt_tokens: 100, completion_tokens: 20 }
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
const askGateway = (tenantId, userId, validate) => runAsTenant(tenantId, () => aiGateway.completeJson({
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
  const todays = requests.map((r) => /Today is (\d{4}-\d{2}-\d{2}) in the company's time zone \(([^)]+)\)/.exec(r.body.messages[0].content).slice(1));
  assert.deepEqual(todays, [['2026-11-24', 'Asia/Tashkent'], ['2026-11-23', 'America/New_York'], ['2026-11-23', 'UTC'], ['2026-11-23', 'UTC']]);
  // Just after midnight UTC: New York is still on the day before.
  await runAsTenant(TENANT, () => flow.parseOrder('order', { weightUnit: 'kg', currency: 'UZS', equipment: [], maxRate: 1, maxWeight: 1, timeZone: 'America/New_York', now: new Date('2026-11-24T00:30:00Z') }, { usage: { tenantId: TENANT } }));
  assert.match(requests.at(-1).body.messages[0].content, /Today is 2026-11-23/);
});

/* ---------------- long messages ---------------- */

test('FLOW: under, exactly at and over the limit; never cut', async () => {
  const requests = fakeProvider();
  const settings = { weightUnit: 'kg', currency: 'UZS', equipment: ['Reefer'], maxRate: 1e9, maxWeight: 100000 };
  const max = flow.MAX_INPUT_CHARS;
  await runAsTenant(TENANT, () => flow.parseOrder('x'.repeat(max - 1), settings, { usage: { tenantId: TENANT } }));
  await runAsTenant(TENANT, () => flow.parseOrder(`${'y'.repeat(max - 1)}Z`, settings, { usage: { tenantId: TENANT } }));
  assert.equal(requests.length, 2);
  assert.ok(requests[1].body.messages[1].content.includes('Z\n</order>'), 'the last character of the message is sent');
  await assert.rejects(runAsTenant(TENANT, () => flow.parseOrder('x'.repeat(max + 1), settings, { usage: { tenantId: TENANT } })), (error) => error.statusCode === 413 && error.code === 'AI_INPUT_TOO_LONG');
  assert.equal(requests.length, 2, 'nothing was sent for the long message');
});

test('NEXUS: an email whose subject plus body is too long goes to a person, with no AI call', async () => {
  const requests = fakeProvider();
  const token = (await (await call(admin, 'POST', '/api/settings/inbox/token')).json()).token;
  const subject = 'S'.repeat(100);
  const body = 'B'.repeat(flow.MAX_INPUT_CHARS - 50); // short alone, too long with the subject
  const res = await fetch(`${base}/api/integrations/inbox/${token}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ From: 'long@x.example', Subject: subject, TextBody: body, MessageID: 'long-1' })
  });
  assert.ok(res.status < 300, `inbound accepted (${res.status})`);
  await require('../agents/nexus').idle();
  assert.equal(requests.length, 0);
  const task = (await (await call(admin, 'GET', '/api/tasks')).json()).tasks.find((t) => t.payload?.from === 'long@x.example');
  assert.match(task.payload.note, /reads at most/);
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
  await withLimits(start + 100, 2, async () => {
    await askGateway(TENANT, 7);
    await askGateway(TENANT, 7);
    await assert.rejects(askGateway(TENANT, 7), (e) => e.code === 'AI_QUOTA_EXCEEDED' && e.details.scope === 'user_hourly' && e.retryAfterSeconds > 0);
    await askGateway(TENANT, 8);
    assert.equal(await usedToday(TENANT), start + 3);
  });
});

test('quota: a failed call counts once; the gateway retry does not count twice; the HTTP answer is 429 with Retry-After', async () => {
  const start = await usedToday(TENANT);
  const requests = fakeProvider(() => ({ status: 503 }));
  await assert.rejects(askGateway(TENANT, null), (e) => e.code === 'AI_PROVIDER_FAILED');
  assert.equal(requests.length, 2, 'retried once');
  assert.equal(await usedToday(TENANT), start + 1, 'one unit for one request, retry included');

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
    await runAsTenant(TENANT, () => aiGateway.completeJson({ agent: 'FLOW', system: 's', user: 'secret order text', usage: { tenantId: TENANT }, log: () => { throw new Error('disk full'); } }));
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
    `leaked ${process.env.OPENROUTER_API_KEY} and ${process.env.JWT_SECRET}`, 'пароль: qwerty123'
  ].join('\n');
  await runAsTenant(TENANT, () => flow.parseOrder(text, { weightUnit: 'kg', currency: 'UZS', equipment: [], maxRate: 1, maxWeight: 1 }, { usage: { tenantId: TENANT } }));
  const sent = requests[0].body.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
  for (const secret of ['Hunter2!x', 'abcd1234efgh5678', 'eyJhbGciOiJIUzI1NiJ9', process.env.OPENROUTER_API_KEY, process.env.JWT_SECRET, 'qwerty123']) {
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

test('model: a warning in production when OPENROUTER_MODEL is not set', () => {
  const saved = process.env.OPENROUTER_MODEL;
  delete process.env.OPENROUTER_MODEL;
  try {
    const result = aiGateway.checkModelConfig({ production: true });
    assert.match(result.warning, /OPENROUTER_MODEL is not set/);
  } finally {
    process.env.OPENROUTER_MODEL = saved;
  }
  assert.equal(aiGateway.checkModelConfig({ production: true }).warning, null);
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
