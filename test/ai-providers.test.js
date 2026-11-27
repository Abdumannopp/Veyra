// The AI provider: Google Gemini only, model gemini-2.5-flash-lite by default. A fake transport checks the exact
// request (address, key header, body, how a PDF or a photo is sent) and answers in Gemini's own format, so the
// reading of the answer and the token counts are checked too. No real request is made.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-ai-gemini-'));
process.env.NODE_ENV = 'development';
process.env.DATABASE_PATH = path.join(dir, 'g.db');
process.env.PORT = '0';
process.env.BCRYPT_COST = '10';
process.env.API_RATE_LIMIT_MAX = '5000';
const KEY = 'AIzaGeminiTestKey0123456789abcdefghijklm';
for (const name of ['AI_PROVIDER', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_MODEL']) delete process.env[name];
process.env.GEMINI_API_KEY = KEY;

const { app, initialize } = require('../server');
const database = require('../database');
const { runAsTenant } = require('../lib/tenant-context');
const aiGateway = require('../ai/gateway');
const providers = require('../ai/providers');
const vault = require('../agents/vault');

const TENANT = 1;
let server;
let base;
let admin;

const call = (cookie, method, url, body) => fetch(`${base}${url}`, {
  method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined
});
async function login(email, password) {
  const res = await call(null, 'POST', '/api/login', { email, password });
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie').split(';')[0];
}

const ANSWER = { ok: true, place: 'Tashkent' };
const anyObject = () => ({ ok: true });
const askGateway = (user = 'Read: Tashkent') => runAsTenant(TENANT, () => aiGateway.completeJson({ agent: 'FLOW', system: 'SYSTEM RULES', user, maxTokens: 321, usage: { tenantId: TENANT }, validate: anyObject }));
const lastCall = async () => (await runAsTenant(TENANT, () => database.listAiCalls(TENANT, { limit: 1 })))[0];
const geminiReply = (text, extra = {}) => ({ modelVersion: 'gemini-2.5-flash-lite', candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 41, candidatesTokenCount: 6 }, ...extra });

function recordRequests(reply = geminiReply(JSON.stringify(ANSWER))) {
  const requests = [];
  aiGateway.setTransport(async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body), raw: init.body });
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return requests;
}

const pdf = { content: Buffer.from('%PDF-1.4 test'), mime: 'application/pdf', filename: 'cmr.pdf' };
const photo = { content: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), mime: 'image/jpeg', filename: 'cmr.jpg' };

before(async () => {
  await initialize();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await login('admin@veyra.ai', 'admin123');
  assert.equal((await call(admin, 'PUT', '/api/settings/ai-consent', { consent: true })).status, 200);
});

after(async () => {
  aiGateway.setTransport(null);
  await new Promise((r) => server.close(r));
  await new Promise((r) => database.db.close(r));
});

test('Gemini is the only provider; gemini-2.5-flash-lite unless GEMINI_MODEL says otherwise', () => {
  assert.deepEqual(providers.IDS, ['google']);
  assert.equal(providers.DEFAULT_MODEL, 'gemini-2.5-flash-lite');
  const state = providers.status();
  assert.equal(state.name, 'Google Gemini');
  assert.equal(state.model, 'gemini-2.5-flash-lite');
  assert.equal(aiGateway.isEnabled(), true);
  assert.equal(aiGateway.checkModelConfig({ production: true }).warning, null);

  // Other providers' keys do nothing now.
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-unusedkeyunusedkey0000';
  process.env.AI_PROVIDER = 'openrouter';
  try {
    assert.equal(providers.status().id, 'google');
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.AI_PROVIDER;
  }

  process.env.GEMINI_MODEL = 'gemini-other-test';
  try {
    assert.equal(providers.status().model, 'gemini-other-test');
    assert.match(aiGateway.checkModelConfig({ production: true }).warning, /not the project's model gemini-2\.5-flash-lite/);
  } finally {
    delete process.env.GEMINI_MODEL;
  }

  delete process.env.GEMINI_API_KEY;
  try {
    assert.equal(aiGateway.isEnabled(), false);
    assert.match(providers.status().problem, /GEMINI_API_KEY/);
  } finally {
    process.env.GEMINI_API_KEY = KEY;
  }
});

test('the request: generateContent for the model, key in a header (never the URL), system apart, JSON answers', async () => {
  const requests = recordRequests();
  assert.deepEqual(await askGateway(), ANSWER);
  const [request] = requests;
  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent');
  assert.ok(!request.url.includes(KEY), 'the key is not in the URL');
  assert.equal(request.headers['x-goog-api-key'], KEY);
  assert.equal(request.headers.Authorization, undefined);
  assert.deepEqual(request.body.systemInstruction, { parts: [{ text: 'SYSTEM RULES' }] });
  assert.deepEqual(request.body.contents, [{ role: 'user', parts: [{ text: 'Read: Tashkent' }] }]);
  assert.deepEqual(request.body.generationConfig, { temperature: 0, maxOutputTokens: 321, responseMimeType: 'application/json' });
  const row = await lastCall();
  assert.equal(row.provider, 'google');
  assert.equal(row.model, 'gemini-2.5-flash-lite');
  assert.equal(row.inputTokens, 41);
  assert.equal(row.outputTokens, 6);
});

test('documents: a PDF and a photo go as inlineData (base64), after the instruction text', async () => {
  const requests = recordRequests();
  await askGateway(vault.documentParts(pdf));
  await askGateway(vault.documentParts(photo));
  assert.deepEqual(requests[0].body.contents[0].parts, [
    { text: 'Read this document.' },
    { inlineData: { mimeType: 'application/pdf', data: pdf.content.toString('base64') } }
  ]);
  assert.deepEqual(requests[1].body.contents[0].parts[1], { inlineData: { mimeType: 'image/jpeg', data: photo.content.toString('base64') } });
});

test('answers: text split over several parts is joined; no JSON or a wrong shape is refused; errors retry once', async () => {
  const half = JSON.stringify(ANSWER);
  recordRequests({ candidates: [{ content: { parts: [{ text: half.slice(0, 5) }, { text: half.slice(5) }] } }] });
  assert.deepEqual(await askGateway(), ANSWER);

  recordRequests(geminiReply('no json here'));
  await assert.rejects(askGateway(), (e) => e.code === 'AI_INVALID_OUTPUT');
  recordRequests({ candidates: [] });
  await assert.rejects(askGateway(), (e) => e.code === 'AI_INVALID_OUTPUT', 'an empty answer (for example blocked by safety filters)');

  let n = 0;
  aiGateway.setTransport(async () => {
    n += 1;
    return new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 503 });
  });
  await assert.rejects(askGateway(), (e) => e.code === 'AI_PROVIDER_FAILED');
  assert.equal(n, 2, 'one retry');
  const failed = await lastCall();
  assert.equal(failed.provider, 'google');
  assert.equal(failed.attempts, 2);
});

test('a consent given earlier for OpenRouter does not count for Gemini: nothing is sent until the company agrees again', async () => {
  const requests = recordRequests();
  // As after the upgrade: the company had agreed to OpenRouter (migration 0016 marks old consents so).
  await runAsTenant(TENANT, () => database.setAiConsent(TENANT, true, null, 'openrouter'));
  const view = await (await call(admin, 'GET', '/api/settings/ai-consent')).json();
  assert.equal(view.consent, false);
  assert.equal(view.provider, 'Google Gemini');
  assert.equal(view.consentedProvider, 'OpenRouter');
  const res = await call(admin, 'POST', '/api/agents/flow/parse', { text: 'order' });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.code, 'AI_CONSENT_REQUIRED');
  assert.match(body.message, /Google Gemini/);
  assert.equal(requests.length, 0);

  assert.equal((await call(admin, 'PUT', '/api/settings/ai-consent', { consent: true })).status, 200);
  assert.equal((await (await call(admin, 'GET', '/api/settings/ai-consent')).json()).consent, true);
  const audit = (await (await call(admin, 'GET', '/api/audit')).json()).entries.filter((e) => e.action === 'ai.consent');
  assert.ok(audit.some((e) => /Google Gemini/.test(JSON.stringify(e))), 'the activity log names Gemini');
});

test('the key is never sent in the text and never shown in the integration status', async () => {
  const requests = recordRequests();
  await askGateway(`leaked ${KEY} and another AIzaSomeOtherKey0123456789abcdefghijk`);
  assert.ok(!requests[0].raw.includes(KEY));
  assert.ok(!requests[0].raw.includes('AIzaSomeOtherKey0123456789abcdefghijk'));
  const status = await (await call(admin, 'GET', '/api/integrations/status')).json();
  assert.ok(!JSON.stringify(status).includes(KEY));
  assert.equal(status.ai.provider, 'Google Gemini');
  assert.equal(status.ai.model, 'gemini-2.5-flash-lite');
});
