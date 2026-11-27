// FLOW reads emails longer than 4 000 characters in parts and merges the answers into one draft. These tests follow the
// task's list: 3 000 / 4 500 / 12 000 / 50 000 characters, facts spread over parts, parts that disagree, an AI failure,
// a repeated email, company isolation and consent off. No real provider is called: a fake Gemini answers per part.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-flow-long-'));
process.env.NODE_ENV = 'development';
process.env.DATABASE_PATH = path.join(dir, 'l.db');
process.env.PORT = '0';
process.env.BCRYPT_COST = '10';
process.env.API_RATE_LIMIT_MAX = '5000';
process.env.WEIGHT_UNIT = 'kg';
process.env.CURRENCY = 'UZS';
process.env.MAX_RATE = '100000000';
process.env.GEMINI_API_KEY = 'AIzaFlowLongTestKey0123456789abcdefghijk';
delete process.env.GEMINI_MODEL;

const { app, initialize } = require('../server');
const database = require('../database');
const { runAsTenant } = require('../lib/tenant-context');
const aiGateway = require('../ai/gateway');
const flow = require('../agents/flow');
const nexus = require('../agents/nexus');

let server;
let base;
let admin;
let other;
let token;
let otherToken;

const call = (cookie, method, url, body) => fetch(`${base}${url}`, {
  method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined
});
async function login(email, password) {
  const res = await call(null, 'POST', '/api/login', { email, password });
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie').split(';')[0];
}

const EMPTY = {
  customer: null, customerPhone: null, reference: null, origin: null, destination: null, pickup: null, delivery: null,
  weight: null, weightUnit: null, equipment: null, customerRate: null, customerRateCurrency: null, questions: [], confidence: 0.9
};

// A fake Gemini: for each request, `answer(text, n)` decides the reply from the part's text. Records every part's text.
function fakeGemini(answer) {
  const parts = [];
  aiGateway.setTransport(async (url, init) => {
    const body = JSON.parse(init.body);
    const text = body.contents[0].parts.map((part) => part.text || '').join('');
    parts.push({ text, system: body.systemInstruction.parts[0].text });
    const reply = answer(text, parts.length);
    if (reply && reply.status) return new Response(JSON.stringify({ error: { message: 'busy' } }), { status: reply.status });
    return new Response(JSON.stringify({
      modelVersion: 'gemini-2.5-flash-lite',
      candidates: [{ content: { parts: [{ text: JSON.stringify({ ...EMPTY, ...reply }) }] } }],
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 50 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return parts;
}

// Readable filler: sentences and paragraphs, so the split can follow them.
const filler = (chars, word = 'Cargo handling note') => {
  const sentence = `${word} without new facts. `;
  let out = '';
  while (out.length < chars) out += (out.length % 900 < sentence.length ? '\n\n' : '') + sentence;
  return out.slice(0, chars);
};

const SETTINGS = { weightUnit: 'kg', currency: 'UZS', equipment: ['Reefer', 'Dry Van', 'Tent / Curtainsider'], maxRate: 1e9, maxWeight: 100000, timeZone: 'Asia/Tashkent' };
const usage = (tenantId = 1) => ({ usage: { tenantId } });
const read = (subject, body, extra = {}) => runAsTenant(1, () => flow.parseEmail({ subject, body }, SETTINGS, { ...usage(1), ...extra }));
const usedToday = (tenantId) => runAsTenant(tenantId, () => database.aiQuotaUsed(tenantId, `day:${new Date().toISOString().slice(0, 10)}`));
const callsSince = async (tenantId, id) => (await runAsTenant(tenantId, () => database.listAiCalls(tenantId, { limit: 50 }))).filter((row) => row.id > id);
const lastCallId = async (tenantId) => (await runAsTenant(tenantId, () => database.listAiCalls(tenantId, { limit: 1 })))[0]?.id || 0;
const inbound = (body, to = token) => call(null, 'POST', `/api/integrations/inbox/${to}`, body);
const tasks = async (cookie = admin) => (await (await call(cookie, 'GET', '/api/tasks')).json()).tasks;
const inboxItems = async (cookie = admin) => (await (await call(cookie, 'GET', '/api/inbox')).json()).items;

before(async () => {
  await initialize();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await login('admin@veyra.ai', 'admin123');
  token = (await (await call(admin, 'POST', '/api/settings/inbox/token')).json()).token;
  const created = await call(admin, 'POST', '/api/platform/tenants', { companyName: 'Long Mail Other', adminName: 'Lo', adminEmail: 'lo@longmail.example', adminPassword: 'long-mail-other-pass-1', plan: 'growth' });
  assert.equal(created.status, 201);
  other = await login('lo@longmail.example', 'long-mail-other-pass-1');
  otherToken = (await (await call(other, 'POST', '/api/settings/inbox/token')).json()).token;
});

after(async () => {
  await nexus.idle();
  aiGateway.setTransport(null);
  await new Promise((r) => server.close(r));
  await new Promise((r) => database.db.close(r));
});

/* ---------------- splitting ---------------- */

test('the split: parts of 3 500–3 800 characters at paragraph or sentence ends; joined again they are the email', () => {
  for (const size of [4500, 12000, 19999]) {
    const body = filler(size);
    const parts = flow.splitEmail(body);
    assert.equal(parts.join(''), body, `${size}: nothing lost or added`);
    parts.slice(0, -1).forEach((part, index) => {
      assert.ok(part.length >= flow.PART_MIN && part.length <= flow.PART_MAX, `${size}: part ${index + 1} has ${part.length}`);
      assert.match(part, /(\n\s*|[.!?;]\s?|\s)$/, 'cut at a natural break');
    });
  }
  // No natural break at all: a hard cut, still nothing lost.
  const block = 'x'.repeat(9000);
  const hard = flow.splitEmail(block);
  assert.equal(hard.join(''), block);
  assert.ok(hard.every((part) => part.length <= flow.PART_MAX));
});

/* ---------------- 1. 3 000 characters ---------------- */

test('1. a 3 000 character email is read as before: one call', async () => {
  const parts = fakeGemini(() => ({ customer: 'Navoiy Textile', origin: 'Tashkent', destination: 'Almaty', pickup: '2030-05-10', delivery: '2030-05-12', weight: '20', weightUnit: 't', equipment: 'Reefer' }));
  const result = await read('Truck needed', filler(3000));
  assert.equal(parts.length, 1);
  assert.equal(result.parts, 1);
  assert.equal(result.draft.weight, 20000);
  assert.deepEqual(result.conflicts, []);
  assert.doesNotMatch(parts[0].system, /PART 1 OF/);
});

/* ---------------- 2. 4 500 characters ---------------- */

test('2. a 4 500 character email is split into 2 parts; the subject only in the first; every part counted', async () => {
  const parts = fakeGemini((text, n) => (n === 1 ? { customer: 'Navoiy Textile', origin: 'Tashkent' } : { destination: 'Almaty', pickup: '2030-05-10' }));
  const start = await usedToday(1);
  const since = await lastCallId(1);
  const result = await read('Truck needed', filler(4500));
  assert.equal(parts.length, 2);
  assert.equal(result.parts, 2);
  assert.ok(parts[0].text.includes('Subject: Truck needed'));
  assert.ok(!parts[1].text.includes('Subject:'));
  assert.match(parts[0].system, /PART 1 OF 2/);
  assert.match(parts[1].system, /PART 2 OF 2/);
  assert.equal(result.draft.customer, 'Navoiy Textile');
  assert.equal(result.draft.destination, 'Almaty');
  // Cost: one quota unit and one ledger row (with tokens) per part.
  assert.equal(await usedToday(1), start + 2);
  const rows = await callsSince(1, since);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.status === 'succeeded' && row.inputTokens === 1000 && row.agent === 'FLOW'));
});

/* ---------------- 3. 12 000 characters, 5. facts spread over parts ---------------- */

test('3 + 5. a 12 000 character email: all parts read; facts from different parts merged; repeats counted once', async () => {
  const body = [
    'Hello, we are Navoiy Textile. Please quote a reefer truck.\n\n', filler(3800, 'Packing detail'),
    '\n\nLoading address: Tashkent, Chilanzar 5. Pickup on 2030-05-10.\n\n', filler(3800, 'Insurance remark'),
    '\n\nUnloading in Almaty. Delivery by 2030-05-12. Gross weight 18,5 t.\n\n', filler(3200, 'Customs comment'),
    '\n\nOur price offer 15 000 000 UZS. Ref PO-77. Call +998 90 111 22 33.'
  ].join('');
  assert.ok(body.length > 11000 && body.length < 13000, `body is ${body.length}`);
  const parts = fakeGemini((text) => {
    const facts = {};
    if (text.includes('Navoiy Textile')) Object.assign(facts, { customer: 'Navoiy Textile', equipment: 'Reefer' });
    if (text.includes('Chilanzar')) Object.assign(facts, { origin: 'Tashkent', pickup: '2030-05-10' });
    if (text.includes('Unloading in Almaty')) Object.assign(facts, { destination: 'Almaty', delivery: '2030-05-12', weight: '18,5', weightUnit: 't' });
    if (text.includes('PO-77')) Object.assign(facts, { customerRate: '15 000 000', customerRateCurrency: 'UZS', reference: 'PO-77', customerPhone: '+998 90 111 22 33', customer: 'navoiy textile', questions: ['Is the cargo palletised?'] });
    if (text.includes('Insurance')) Object.assign(facts, { questions: ['Is the cargo palletised?', 'Do you need insurance?'] });
    return facts;
  });
  const result = await read('Reefer Tashkent - Almaty', body);
  assert.ok(result.parts >= 3 && result.parts <= flow.MAX_PARTS, `${result.parts} parts`);
  assert.equal(parts.length, result.parts, 'every part read once');
  assert.equal(parts.map((p, i) => (i === 0 ? p.text.replace(/^<order[^>]*>\nSubject: [^\n]*\n\n/, '') : p.text.replace(/^<order[^>]*>\n/, '')).replace(/\n<\/order>$/, '')).join(''), body, 'together the parts are the whole email');
  assert.deepEqual(result.draft, {
    customer: 'Navoiy Textile', reference: 'PO-77', origin: 'Tashkent', destination: 'Almaty', customerPhone: '+998 90 111 22 33',
    pickup: '2030-05-10', delivery: '2030-05-12', weight: 18500, equipment: 'Reefer', customerRate: 15000000
  });
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.conflicts, [], '"Navoiy Textile" and "navoiy textile" are the same customer');
  assert.deepEqual(result.questions, ['Is the cargo palletised?', 'Do you need insurance?'], 'questions merged without repeats');
  assert.equal(result.needsReview, false);
});

/* ---------------- 4. 50 000 characters ---------------- */

test('4. a 50 000 character email: over the size limit, no AI call and no cost; stored whole, read by a person', async () => {
  const parts = fakeGemini(() => ({}));
  const start = await usedToday(1);
  await assert.rejects(read('Huge', filler(50000)), (e) => e.statusCode === 413 && e.code === 'AI_INPUT_TOO_LONG' && e.details.max === flow.MAX_EMAIL_CHARS && e.details.maxParts === flow.MAX_PARTS);
  assert.equal(parts.length, 0);
  assert.equal(await usedToday(1), start);

  // Through the inbox: the email is stored whole (it was cut at 8 000 before) and becomes a task for a person.
  const body = filler(50000);
  assert.ok((await inbound({ From: 'huge@x.example', Subject: 'Huge', TextBody: body, MessageID: 'huge-1' })).status < 300);
  await nexus.idle();
  assert.equal(parts.length, 0);
  const item = (await inboxItems()).find((entry) => entry.from === 'huge@x.example');
  assert.equal(item.body, body.trim(), 'stored whole (only the outer spaces are trimmed, as for every email)');
  assert.equal(item.status, 'failed');
  const task = (await tasks()).find((t) => t.payload?.from === 'huge@x.example');
  assert.match(task.payload.note, /at most 20000 characters/);
  assert.equal(task.payload.parsed, null);

  // Not enough budget for all parts: nothing is started.
  const budget = fakeGemini(() => ({}));
  const saved = process.env.AI_DAILY_LIMIT_PER_TENANT;
  process.env.AI_DAILY_LIMIT_PER_TENANT = String((await usedToday(1)) + 2);
  try {
    await assert.rejects(read('Four parts', filler(13000), { availability: (units) => aiGateway.availability(1, { units }) }), (e) => e.code === 'AI_QUOTA_EXCEEDED');
    assert.equal(budget.length, 0, 'a 4-part email with 2 units left is not started');
  } finally {
    if (saved === undefined) delete process.env.AI_DAILY_LIMIT_PER_TENANT; else process.env.AI_DAILY_LIMIT_PER_TENANT = saved;
  }
});

/* ---------------- 6. disagreements ---------------- */

test('6. parts that disagree: nothing is chosen automatically; the field is empty and shown to the operator', async () => {
  fakeGemini((text, n) => ({
    customer: 'Navoiy Textile', origin: 'Tashkent', destination: n === 1 ? 'Almaty' : 'Bishkek',
    pickup: '2030-05-10', delivery: '2030-05-12', weight: n === 1 ? '18 t' : '18000', weightUnit: n === 1 ? null : 'kg',
    customerRate: n === 1 ? '1500' : '1500', customerRateCurrency: n === 1 ? 'USD' : 'UZS', equipment: 'Reefer'
  }));
  const result = await read('Order', filler(5000));
  assert.equal(result.draft.destination, null);
  assert.equal(result.draft.customerRate, null);
  assert.ok(result.missing.includes('destination'));
  const fields = result.conflicts.map((conflict) => conflict.field);
  assert.ok(fields.includes('destination'));
  assert.ok(fields.includes('customerRate'), 'same number, different currency: a disagreement');
  const destination = result.conflicts.find((conflict) => conflict.field === 'destination');
  assert.deepEqual(destination.values, [{ value: 'Almaty', parts: [1] }, { value: 'Bishkek', parts: [2] }]);
  assert.equal(result.needsReview, true);
  assert.ok(result.review.some((line) => /disagree on the destination/.test(line) && /Almaty/.test(line) && /Bishkek/.test(line)));

  // Same weight written two ways (18 t and 18000 kg) is the same weight, not a disagreement.
  fakeGemini((text, n) => ({ weight: n === 1 ? '18' : '18000', weightUnit: n === 1 ? 't' : 'kg' }));
  const same = await read('Order', filler(5000));
  assert.equal(same.draft.weight, 18000);
  assert.ok(!same.conflicts.some((conflict) => conflict.field === 'weight'));
});

/* ---------------- 7. AI failure ---------------- */

test('7. a part that cannot be read: one retry, then no draft at all; the email stays for a person; a new try pays only for the rest', async () => {
  let attempts = 0;
  const body = filler(9000);
  // Part 2 always fails (the gateway retries it once).
  const parts = fakeGemini((text) => {
    if (!text.includes('Subject:') && !text.endsWith(body.slice(-30) + '\n</order>')) { attempts += 1; return { status: 503 }; }
    return { customer: 'Navoiy Textile' };
  });
  assert.ok((await inbound({ From: 'fail@x.example', Subject: 'Order', TextBody: body, MessageID: 'fail-1' })).status < 300);
  await nexus.idle();
  assert.equal(attempts, 2, 'the failing part was tried twice, then the reading stopped');
  const item = (await inboxItems()).find((entry) => entry.from === 'fail@x.example');
  assert.equal(item.status, 'failed');
  assert.equal(item.parsed.incomplete, true);
  assert.equal(item.parsed.failedPart, 2);
  assert.equal(item.parsed.parts, 3);
  assert.match(item.error, /part 2 of 3/);
  const task = (await tasks()).find((t) => t.payload?.from === 'fail@x.example');
  assert.equal(task.payload.parsed, null, 'no draft from part of the email');
  assert.match(task.payload.note, /part 2 of 3/);
  const shipments = (await (await call(admin, 'GET', '/api/shipments/search')).json()).allCount;

  // The operator presses "Read with AI" once the provider is back: part 1 is reused, parts 2 and 3 are read.
  const sentBefore = parts.length;
  const retry = fakeGemini(() => ({ customer: 'Navoiy Textile', origin: 'Tashkent' }));
  const res = await call(admin, 'POST', `/api/inbox/${item.id}/parse`);
  assert.equal(res.status, 200);
  const parsed = await res.json();
  assert.equal(retry.length, 2, 'only the 2 parts not read before');
  assert.ok(sentBefore >= 3);
  assert.equal(parsed.parts, 3);
  assert.equal(parsed.draft.customer, 'Navoiy Textile');
  assert.equal((await (await call(admin, 'GET', '/api/shipments/search')).json()).allCount, shipments, 'no load is created without the operator');
});

/* ---------------- 8. repeated email ---------------- */

test('8. the same email twice: stored once, read once; reading it again costs nothing; it makes at most one load', async () => {
  const parts = fakeGemini(() => ({ customer: 'Repeat Co', origin: 'Tashkent', destination: 'Almaty', pickup: '2030-05-10', delivery: '2030-05-12', weight: '20', weightUnit: 't', equipment: 'Reefer' }));
  const email = { From: 'repeat@x.example', Subject: 'Order', TextBody: filler(8000), MessageID: 'repeat-1' };
  assert.ok((await inbound(email)).status < 300);
  assert.ok((await inbound(email)).status < 300);
  await nexus.idle();
  const items = (await inboxItems()).filter((entry) => entry.from === 'repeat@x.example');
  assert.equal(items.length, 1);
  const read1 = parts.length;
  assert.equal(read1, 3);
  const again = await (await call(admin, 'POST', `/api/inbox/${items[0].id}/parse`)).json();
  assert.equal(again.reused, true);
  assert.equal(parts.length, read1, 'no new AI call');
  const load = { customer: 'Repeat Co', origin: 'Tashkent', destination: 'Almaty', pickup: '2030-05-10', delivery: '2030-05-12', weight: 20000, equipment: 'Reefer', inboxId: items[0].id };
  assert.equal((await call(admin, 'POST', '/api/shipments', load)).status, 201);
  assert.equal((await call(admin, 'POST', '/api/shipments', load)).status, 400, 'the email cannot make a second load');
});

/* ---------------- 9. companies ---------------- */

test('9. another company sees nothing of this company\'s long email or its reading', async () => {
  fakeGemini(() => ({ customer: 'Secret Customer' }));
  assert.ok((await inbound({ From: 'secret@x.example', Subject: 'Order', TextBody: filler(6000), MessageID: 'secret-1' })).status < 300);
  await nexus.idle();
  const mine = (await inboxItems()).find((entry) => entry.from === 'secret@x.example');
  assert.ok(mine);
  assert.ok(!(await inboxItems(other)).some((entry) => entry.from === 'secret@x.example'));
  assert.ok(!(await tasks(other)).some((t) => t.payload?.from === 'secret@x.example'));
  assert.equal((await call(other, 'POST', `/api/inbox/${mine.id}/parse`)).status, 404);
  assert.equal((await runAsTenant(2, () => database.listAiCalls(2, { limit: 50 }))).length, 0, 'no AI call is billed to the other company');
});

/* ---------------- 10. consent off ---------------- */

test('10. consent off: a long email is never sent to the AI provider', async () => {
  const parts = fakeGemini(() => ({ customer: 'Should not be read' }));
  assert.equal((await call(other, 'PUT', '/api/settings/ai-consent', { consent: false })).status, 200);
  assert.ok((await inbound({ From: 'noconsent@x.example', Subject: 'Order', TextBody: filler(9000), MessageID: 'noconsent-1' }, otherToken)).status < 300);
  await nexus.idle();
  assert.equal(parts.length, 0);
  const task = (await tasks(other)).find((t) => t.payload?.from === 'noconsent@x.example');
  assert.match(task.payload.note, /not allowed/);
  const item = (await inboxItems(other)).find((entry) => entry.from === 'noconsent@x.example');
  const res = await call(other, 'POST', `/api/inbox/${item.id}/parse`);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'AI_CONSENT_REQUIRED');
  assert.equal(parts.length, 0);
});

/* ---------------- logs ---------------- */

test('the email text never reaches the logs, while reading in parts', async () => {
  const lines = [];
  const original = [console.log, console.error, console.warn];
  const capture = (...args) => lines.push(args.join(' '));
  console.log = capture; console.error = capture; console.warn = capture;
  try {
    fakeGemini((text, n) => (n === 2 ? { status: 503 } : { customer: 'Logged Co' }));
    await read('Order', `SECRET-MARKER-123 ${filler(6000)}`).catch(() => {});
  } finally {
    [console.log, console.error, console.warn] = original;
  }
  assert.ok(!lines.some((line) => line.includes('SECRET-MARKER-123') || line.includes('Cargo handling note')));
});
