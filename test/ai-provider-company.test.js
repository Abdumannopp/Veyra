// Each company chooses its own AI provider among those the server has ready (keys stay in the server settings).
// The consent is for one provider, a choice that stops being ready never falls back to another provider, and one
// company's choice never changes another's. No real provider is called: a fake transport records every request.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-ai-provider-company-'));
process.env.NODE_ENV = 'development';
process.env.DATABASE_PATH = path.join(dir, 'c.db');
process.env.PORT = '0';
process.env.BCRYPT_COST = '10';
process.env.API_RATE_LIMIT_MAX = '5000';
for (const name of ['AI_PROVIDER', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'GEMINI_API_KEY', 'GEMINI_MODEL']) delete process.env[name];
// The server has two providers ready: OpenRouter (the default) and Anthropic. OpenAI and Gemini are not set up.
process.env.OPENROUTER_API_KEY = 'sk-or-v1-companytestkey000000';
process.env.OPENROUTER_MODEL = 'test/router-model';
process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-companytestkey00';
process.env.ANTHROPIC_MODEL = 'test-claude-model';

const { app, initialize } = require('../server');
const database = require('../database');
const aiGateway = require('../ai/gateway');
const { runAsTenant } = require('../lib/tenant-context');

let server;
let base;
let admin;
let operator;
let other;

const call = (cookie, method, url, body) => fetch(`${base}${url}`, {
  method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined
});
async function login(email, password) {
  const res = await call(null, 'POST', '/api/login', { email, password });
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie').split(';')[0];
}

const ORDER = {
  customer: 'Navoiy Textile', customerPhone: null, reference: null, origin: 'Tashkent', destination: 'Almaty',
  pickup: '2030-05-10', delivery: '2030-05-12', weight: 18, weightUnit: 't', equipment: 'Reefer',
  customerRate: null, customerRateCurrency: null, questions: [], confidence: 0.8
};

// Answers in the format of whichever provider was called, and records the address.
function fakeProviders() {
  const requests = [];
  aiGateway.setTransport(async (url) => {
    requests.push(url);
    const text = JSON.stringify(ORDER);
    const reply = url.includes('anthropic.com')
      ? { model: 'test-claude-model', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 2 } }
      : { model: 'test/router-model', choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 2 } };
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return requests;
}
const settings = async (cookie) => (await call(cookie, 'GET', '/api/settings/ai-consent')).json();
const parse = (cookie) => call(cookie, 'POST', '/api/agents/flow/parse', { text: 'order' });

before(async () => {
  await initialize();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await login('admin@veyra.ai', 'admin123');
  operator = await login('demo@veyra.ai', 'demo123');
  const created = await call(admin, 'POST', '/api/platform/tenants', { companyName: 'Provider Other', adminName: 'Po', adminEmail: 'po@provider.example', adminPassword: 'provider-other-pass-1', plan: 'growth' });
  assert.equal(created.status, 201);
  other = await login('po@provider.example', 'provider-other-pass-1');
  assert.equal((await call(other, 'PUT', '/api/settings/ai-consent', { consent: true })).status, 200);
  assert.equal((await call(admin, 'PUT', '/api/settings/ai-consent', { consent: true })).status, 200);
});

after(async () => {
  aiGateway.setTransport(null);
  await new Promise((r) => server.close(r));
  await new Promise((r) => database.db.close(r));
});

test('the settings list every provider and which are ready, without any key', async () => {
  const view = await settings(admin);
  assert.equal(view.provider, 'OpenRouter', 'the server default until the company chooses');
  assert.equal(view.providerChoice, null);
  const byId = Object.fromEntries(view.providerOptions.map((option) => [option.id, option]));
  assert.deepEqual(Object.keys(byId).sort(), ['anthropic', 'google', 'openai', 'openrouter']);
  assert.equal(byId.openrouter.ready, true);
  assert.equal(byId.openrouter.isDefault, true);
  assert.equal(byId.anthropic.ready, true);
  assert.equal(byId.anthropic.model, 'test-claude-model');
  assert.equal(byId.openai.ready, false);
  assert.equal(byId.google.ready, false);
  const text = JSON.stringify(view);
  assert.ok(!text.includes(process.env.OPENROUTER_API_KEY) && !text.includes(process.env.ANTHROPIC_API_KEY), 'no key in the answer');
});

test('only administrators choose, and only a provider the server has ready', async () => {
  assert.equal((await call(operator, 'PUT', '/api/settings/ai-provider', { provider: 'anthropic' })).status, 403);
  assert.equal((await call(admin, 'PUT', '/api/settings/ai-provider', { provider: 'mystery' })).status, 400);
  assert.equal((await call(admin, 'PUT', '/api/settings/ai-provider', {})).status, 400);
  const notReady = await call(admin, 'PUT', '/api/settings/ai-provider', { provider: 'openai' });
  assert.equal(notReady.status, 409);
  assert.equal((await notReady.json()).code, 'AI_PROVIDER_NOT_READY');
  assert.equal((await settings(admin)).providerChoice, null, 'nothing changed');
});

test('a company switches to Anthropic: consent is asked again, then calls go to Anthropic; the other company stays put', async () => {
  const requests = fakeProviders();
  assert.equal((await parse(admin)).status, 200);
  assert.match(requests.at(-1), /openrouter\.ai/, 'before: the server default');

  const changed = await call(admin, 'PUT', '/api/settings/ai-provider', { provider: 'anthropic' });
  assert.equal(changed.status, 200);
  const view = await changed.json();
  assert.equal(view.provider, 'Anthropic');
  assert.equal(view.providerChoice, 'anthropic');
  assert.equal(view.consent, false, 'the OpenRouter consent does not cover Anthropic');
  assert.equal(view.consentedProvider, 'OpenRouter');

  const sent = requests.length;
  const refused = await parse(admin);
  assert.equal(refused.status, 403);
  const body = await refused.json();
  assert.equal(body.code, 'AI_CONSENT_REQUIRED');
  assert.match(body.message, /Anthropic/);
  assert.equal(requests.length, sent, 'nothing was sent anywhere');

  // The other company is not touched: still the server default, still allowed.
  assert.equal((await settings(other)).provider, 'OpenRouter');
  assert.equal((await parse(other)).status, 200);
  assert.match(requests.at(-1), /openrouter\.ai/);

  assert.equal((await call(admin, 'PUT', '/api/settings/ai-consent', { consent: true })).status, 200);
  assert.equal((await parse(admin)).status, 200);
  assert.match(requests.at(-1), /api\.anthropic\.com/, 'after: the company\'s own provider');
  const [row] = await runAsTenant(1, () => database.listAiCalls(1, { limit: 1 }));
  assert.equal(row.provider, 'anthropic');

  const audit = (await (await call(admin, 'GET', '/api/audit')).json()).entries.filter((e) => e.action === 'ai.provider');
  assert.ok(audit.some((e) => /OpenRouter → Anthropic/.test(JSON.stringify(e))), 'the change is in the activity log');
});

test('a chosen provider that is no longer set up stops AI for that company; it never falls back to another', async () => {
  const requests = fakeProviders();
  const savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const view = await settings(admin);
    assert.equal(view.provider, 'Anthropic');
    assert.equal(view.providerReady, false);
    const res = await parse(admin);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'AI_OFF');
    assert.equal(requests.length, 0, 'not sent to OpenRouter instead');
    assert.equal((await call(admin, 'PUT', '/api/settings/ai-consent', { consent: true })).status, 409, 'cannot agree to a provider that is not ready');
    // The other company (server default) still works.
    assert.equal((await parse(other)).status, 200);
  } finally {
    process.env.ANTHROPIC_API_KEY = savedKey;
  }
});

test('back to the server default (null)', async () => {
  const res = await call(admin, 'PUT', '/api/settings/ai-provider', { provider: null });
  assert.equal(res.status, 200);
  const view = await res.json();
  assert.equal(view.providerChoice, null);
  assert.equal(view.provider, 'OpenRouter');
  assert.equal(view.consent, false, 'the last consent was given for Anthropic, so OpenRouter needs a new one');
});
