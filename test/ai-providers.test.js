// AI providers: OpenRouter, OpenAI, Anthropic, Google Gemini. One is active (AI_PROVIDER). For each, a fake transport
// checks the exact request (address, key header, body, how a PDF or a photo is sent) and answers in that provider's
// own format, so the gateway's reading of the answer and the token counts are checked too. No real provider is called.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-ai-providers-'));
process.env.NODE_ENV = 'development';
process.env.DATABASE_PATH = path.join(dir, 'p.db');
process.env.PORT = '0';
process.env.BCRYPT_COST = '10';
process.env.API_RATE_LIMIT_MAX = '5000';
const KEYS = { OPENROUTER_API_KEY: 'sk-or-v1-testkeytestkeytestkey00', OPENAI_API_KEY: 'sk-openai-testkey-0123456789abcd', ANTHROPIC_API_KEY: 'sk-ant-api03-testkey-0123456789', GEMINI_API_KEY: 'AIzaTestKey0123456789abcdefghijklmnopq' };
for (const name of [...Object.keys(KEYS), 'AI_PROVIDER', 'OPENROUTER_MODEL', 'OPENAI_MODEL', 'ANTHROPIC_MODEL', 'GEMINI_MODEL']) delete process.env[name];
process.env.OPENROUTER_API_KEY = KEYS.OPENROUTER_API_KEY;

const { app, initialize } = require('../server');
const database = require('../database');
const { runAsTenant } = require('../lib/tenant-context');
const aiGateway = require('../ai/gateway');
const providers = require('../ai/providers');

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

// Switch the server to one provider (and only its key), for the length of `work`.
async function usingProvider(env, work) {
  const names = [...Object.keys(KEYS), 'AI_PROVIDER', 'OPENROUTER_MODEL', 'OPENAI_MODEL', 'ANTHROPIC_MODEL', 'GEMINI_MODEL'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  Object.assign(process.env, env);
  try {
    return await work();
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
  }
}

const ANSWER = { ok: true, place: 'Tashkent' };
const anyObject = () => ({ ok: true });
const askGateway = (user = 'Read: Tashkent') => runAsTenant(TENANT, () => aiGateway.completeJson({ agent: 'FLOW', system: 'SYSTEM RULES', user, maxTokens: 321, usage: { tenantId: TENANT }, validate: anyObject }));
const agree = (provider) => runAsTenant(TENANT, () => database.setAiConsent(TENANT, true, null, provider));
const lastCall = async () => (await runAsTenant(TENANT, () => database.listAiCalls(TENANT, { limit: 1 })))[0];

function recordRequests(reply) {
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
});

after(async () => {
  aiGateway.setTransport(null);
  await new Promise((r) => server.close(r));
  await new Promise((r) => database.db.close(r));
});

test('choosing the provider: AI_PROVIDER, else the first key; a direct provider needs its model', async () => {
  await usingProvider({ OPENROUTER_API_KEY: KEYS.OPENROUTER_API_KEY }, () => {
    assert.equal(providers.activeId(), 'openrouter');
    assert.equal(aiGateway.isEnabled(), true, 'OpenRouter may use the account default model');
    assert.match(aiGateway.checkModelConfig({ production: true }).warning, /OPENROUTER_MODEL is not set/);
  });
  await usingProvider({ ANTHROPIC_API_KEY: KEYS.ANTHROPIC_API_KEY }, () => {
    assert.equal(providers.activeId(), 'anthropic', 'the only key decides');
    assert.equal(aiGateway.isEnabled(), false, 'no model = AI stays off');
    assert.match(aiGateway.checkModelConfig({ production: true }).warning, /ANTHROPIC_MODEL/);
  });
  await usingProvider({ AI_PROVIDER: 'openai', OPENAI_API_KEY: KEYS.OPENAI_API_KEY, OPENAI_MODEL: 'test-openai-model', OPENROUTER_API_KEY: KEYS.OPENROUTER_API_KEY }, () => {
    assert.equal(providers.activeId(), 'openai', 'AI_PROVIDER wins over other keys');
    assert.equal(aiGateway.isEnabled(), true);
    assert.equal(aiGateway.checkModelConfig({ production: true }).warning, null);
  });
  await usingProvider({ AI_PROVIDER: 'openai' }, () => {
    assert.equal(aiGateway.isEnabled(), false, 'chosen but no key');
    assert.equal(aiGateway.checkModelConfig({ production: true }).warning, null, 'no key = simply not set up');
  });
  await usingProvider({ AI_PROVIDER: 'mystery', OPENAI_API_KEY: KEYS.OPENAI_API_KEY }, () => {
    assert.equal(aiGateway.isEnabled(), false);
    assert.match(aiGateway.checkModelConfig({ production: true }).warning, /not known/);
  });
  await usingProvider({}, async () => {
    await assert.rejects(askGateway(), (e) => e.statusCode === 503 && e.code === 'AI_OFF');
  });
});

test('OpenRouter: chat completions, Bearer key, answer and tokens read', async () => {
  await usingProvider({ OPENROUTER_API_KEY: KEYS.OPENROUTER_API_KEY, OPENROUTER_MODEL: 'test/router-model' }, async () => {
    await agree('openrouter');
    const requests = recordRequests({ model: 'test/router-model', choices: [{ message: { content: JSON.stringify(ANSWER) } }], usage: { prompt_tokens: 11, completion_tokens: 3 } });
    assert.deepEqual(await askGateway(), ANSWER);
    const [request] = requests;
    assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(request.headers.Authorization, `Bearer ${KEYS.OPENROUTER_API_KEY}`);
    assert.equal(request.body.model, 'test/router-model');
    assert.equal(request.body.max_tokens, 321);
    assert.equal(request.body.messages[0].content, 'SYSTEM RULES');
    const row = await lastCall();
    assert.equal(row.provider, 'openrouter');
    assert.equal(row.inputTokens, 11);
    assert.equal(row.outputTokens, 3);
  });
});

test('OpenAI: chat completions at api.openai.com, max_completion_tokens, files as file / image_url parts', async () => {
  await usingProvider({ AI_PROVIDER: 'openai', OPENAI_API_KEY: KEYS.OPENAI_API_KEY, OPENAI_MODEL: 'test-openai-model' }, async () => {
    await agree('openai');
    const requests = recordRequests({ model: 'test-openai-model', choices: [{ message: { content: JSON.stringify(ANSWER) } }], usage: { prompt_tokens: 21, completion_tokens: 4 } });
    const vault = require('../agents/vault');
    assert.deepEqual(await askGateway(vault.documentParts(pdf)), ANSWER);
    await askGateway(vault.documentParts(photo));
    const [first, second] = requests;
    assert.equal(first.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(first.headers.Authorization, `Bearer ${KEYS.OPENAI_API_KEY}`);
    assert.equal(first.body.model, 'test-openai-model');
    assert.equal(first.body.max_completion_tokens, 321);
    assert.equal(first.body.max_tokens, undefined);
    assert.equal(first.body.messages[1].content[1].type, 'file');
    assert.match(first.body.messages[1].content[1].file.file_data, /^data:application\/pdf;base64,/);
    assert.equal(second.body.messages[1].content[1].type, 'image_url');
    const row = await lastCall();
    assert.equal(row.provider, 'openai');
    assert.equal(row.inputTokens, 21);
  });
});

test('Anthropic: messages API, x-api-key and version headers, system apart, PDF as document, photo as image', async () => {
  await usingProvider({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEYS.ANTHROPIC_API_KEY, ANTHROPIC_MODEL: 'test-claude-model' }, async () => {
    await agree('anthropic');
    const requests = recordRequests({ model: 'test-claude-model', content: [{ type: 'text', text: `Here:\n${JSON.stringify(ANSWER)}` }], usage: { input_tokens: 31, output_tokens: 5 } });
    const vault = require('../agents/vault');
    assert.deepEqual(await askGateway(vault.documentParts(pdf)), ANSWER);
    await askGateway(vault.documentParts(photo));
    await askGateway('plain text');
    const [first, second, third] = requests;
    assert.equal(first.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(first.headers['x-api-key'], KEYS.ANTHROPIC_API_KEY);
    assert.equal(first.headers['anthropic-version'], '2023-06-01');
    assert.equal(first.headers.Authorization, undefined);
    assert.equal(first.body.model, 'test-claude-model');
    assert.equal(first.body.system, 'SYSTEM RULES');
    assert.equal(first.body.max_tokens, 321);
    const parts = first.body.messages[0].content;
    assert.deepEqual(parts[0], { type: 'text', text: 'Read this document.' });
    assert.equal(parts[1].type, 'document');
    assert.equal(parts[1].source.media_type, 'application/pdf');
    assert.equal(parts[1].source.data, pdf.content.toString('base64'));
    assert.equal(second.body.messages[0].content[1].type, 'image');
    assert.equal(second.body.messages[0].content[1].source.media_type, 'image/jpeg');
    assert.deepEqual(third.body.messages[0].content, [{ type: 'text', text: 'plain text' }]);
    const row = await lastCall();
    assert.equal(row.provider, 'anthropic');
    assert.equal(row.inputTokens, 31);
    assert.equal(row.outputTokens, 5);
  });
});

test('Google Gemini: generateContent, key in a header (never the URL), files as inlineData, JSON answers', async () => {
  await usingProvider({ AI_PROVIDER: 'google', GEMINI_API_KEY: KEYS.GEMINI_API_KEY, GEMINI_MODEL: 'test-gemini-model' }, async () => {
    await agree('google');
    const requests = recordRequests({ modelVersion: 'test-gemini-model-001', candidates: [{ content: { parts: [{ text: JSON.stringify(ANSWER) }] } }], usageMetadata: { promptTokenCount: 41, candidatesTokenCount: 6 } });
    const vault = require('../agents/vault');
    assert.deepEqual(await askGateway(vault.documentParts(pdf)), ANSWER);
    const [request] = requests;
    assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/test-gemini-model:generateContent');
    assert.ok(!request.url.includes(KEYS.GEMINI_API_KEY), 'the key is not in the URL');
    assert.equal(request.headers['x-goog-api-key'], KEYS.GEMINI_API_KEY);
    assert.deepEqual(request.body.systemInstruction, { parts: [{ text: 'SYSTEM RULES' }] });
    assert.equal(request.body.generationConfig.maxOutputTokens, 321);
    assert.equal(request.body.generationConfig.responseMimeType, 'application/json');
    assert.deepEqual(request.body.contents[0].parts[0], { text: 'Read this document.' });
    assert.deepEqual(request.body.contents[0].parts[1], { inlineData: { mimeType: 'application/pdf', data: pdf.content.toString('base64') } });
    const row = await lastCall();
    assert.equal(row.provider, 'google');
    assert.equal(row.model, 'test-gemini-model-001');
    assert.equal(row.inputTokens, 41);
    assert.equal(row.outputTokens, 6);
  });
});

test('every provider: provider errors, retries, quota and schema checks behave the same', async () => {
  const cases = [
    ['openrouter', { OPENROUTER_API_KEY: KEYS.OPENROUTER_API_KEY, OPENROUTER_MODEL: 'm' }],
    ['openai', { AI_PROVIDER: 'openai', OPENAI_API_KEY: KEYS.OPENAI_API_KEY, OPENAI_MODEL: 'm' }],
    ['anthropic', { AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEYS.ANTHROPIC_API_KEY, ANTHROPIC_MODEL: 'm' }],
    ['google', { AI_PROVIDER: 'google', GEMINI_API_KEY: KEYS.GEMINI_API_KEY, GEMINI_MODEL: 'm' }]
  ];
  for (const [id, env] of cases) {
    await usingProvider(env, async () => {
      await agree(id);
      let n = 0;
      aiGateway.setTransport(async () => {
        n += 1;
        return new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 503 });
      });
      await assert.rejects(askGateway(), (e) => e.code === 'AI_PROVIDER_FAILED', id);
      assert.equal(n, 2, `${id}: one retry`);
      const failed = await lastCall();
      assert.equal(failed.provider, id);
      assert.equal(failed.attempts, 2);

      // A reply that is not the expected shape is refused for every provider.
      const textReply = {
        openrouter: { choices: [{ message: { content: 'no json here' } }] },
        openai: { choices: [{ message: { content: 'no json here' } }] },
        anthropic: { content: [{ type: 'text', text: 'no json here' }] },
        google: { candidates: [{ content: { parts: [{ text: 'no json here' }] } }] }
      }[id];
      recordRequests(textReply);
      await assert.rejects(askGateway(), (e) => e.code === 'AI_INVALID_OUTPUT', id);
    });
  }
});

test('consent is for one provider: after switching provider, nothing is sent until the company agrees again', async () => {
  await usingProvider({ OPENROUTER_API_KEY: KEYS.OPENROUTER_API_KEY, OPENROUTER_MODEL: 'm' }, async () => {
    assert.equal((await call(admin, 'PUT', '/api/settings/ai-consent', { consent: true })).status, 200);
    const view = await (await call(admin, 'GET', '/api/settings/ai-consent')).json();
    assert.equal(view.consent, true);
    assert.equal(view.provider, 'OpenRouter');
  });
  await usingProvider({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEYS.ANTHROPIC_API_KEY, ANTHROPIC_MODEL: 'm' }, async () => {
    const requests = recordRequests({ content: [{ type: 'text', text: '{}' }] });
    const view = await (await call(admin, 'GET', '/api/settings/ai-consent')).json();
    assert.equal(view.consent, false, 'agreed to OpenRouter, not to Anthropic');
    assert.equal(view.provider, 'Anthropic');
    assert.equal(view.consentedProvider, 'OpenRouter');
    const res = await call(admin, 'POST', '/api/agents/flow/parse', { text: 'order' });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, 'AI_CONSENT_REQUIRED');
    assert.match(body.message, /Anthropic/);
    assert.equal(requests.length, 0, 'nothing sent to the new provider');

    assert.equal((await call(admin, 'PUT', '/api/settings/ai-consent', { consent: true })).status, 200);
    assert.equal((await (await call(admin, 'GET', '/api/settings/ai-consent')).json()).consent, true);
    const audit = (await (await call(admin, 'GET', '/api/audit')).json()).entries.filter((e) => e.action === 'ai.consent');
    assert.ok(audit.some((e) => /Anthropic/.test(e.details || e.detail || e.message || JSON.stringify(e))), 'the audit names the provider');
  });
});

test('keys: no provider key is ever sent in the text, and none appears in the integration status', async () => {
  await usingProvider({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEYS.ANTHROPIC_API_KEY, ANTHROPIC_MODEL: 'test-claude-model', OPENAI_API_KEY: KEYS.OPENAI_API_KEY, GEMINI_API_KEY: KEYS.GEMINI_API_KEY }, async () => {
    await agree('anthropic');
    const requests = recordRequests({ content: [{ type: 'text', text: JSON.stringify(ANSWER) }] });
    await askGateway(`leaked ${KEYS.OPENAI_API_KEY} ${KEYS.ANTHROPIC_API_KEY} ${KEYS.GEMINI_API_KEY}`);
    for (const key of Object.values(KEYS)) assert.ok(!requests[0].raw.includes(key), 'key removed from the text');
    const status = await (await call(admin, 'GET', '/api/integrations/status')).json();
    const text = JSON.stringify(status);
    for (const key of Object.values(KEYS)) assert.ok(!text.includes(key), 'no key in the status');
    assert.equal(status.ai?.provider || status.integrations?.ai?.provider, 'Anthropic');
  });
});
