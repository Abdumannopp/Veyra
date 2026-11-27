// AI Gateway: the only place VEYRA talks to a language model. Every rule that protects money and data is enforced
// HERE, so a new endpoint or agent cannot skip it:
//
// 1. Consent: a company's data goes to the outside provider only after its administrator agreed (tenants.ai_external_consent),
//    and only to the provider it agreed to: a consent given for one provider does not cover another.
// 2. Quota: one unit per model request, taken BEFORE the provider is called, from durable counters in the database
//    (a daily budget per company and an hourly budget per person). Atomic, so parallel requests cannot pass the limit,
//    and kept across restarts and across several server instances. A failed request still counts. The gateway's own
//    retry is a second provider request and takes a second unit, so the counters equal the requests sent.
// 3. Ledger: an ai_calls row MUST be written before the call (else nothing is sent) and completed after it with status, model, tokens, latency
//    and the kind of error. Tokens are kept even when the answer is not valid JSON.
// 4. Data: passwords, API keys, tokens and the server's secrets are removed from the text before it is sent
//    (ai/redact.js). No prompt, email or document text is ever written to a log.
// 5. Output: the answer must be a JSON object that passes the caller's strict shape check (ai/schema.js).
//
// Provider: Google Gemini only (see ai/providers.js), model gemini-2.5-flash-lite by default.
const { httpError } = require('../lib/validation');
const { logEvent } = require('../lib/log');
const { redactContent } = require('./redact');
const providers = require('./providers');

const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 20000;

let transport = (url, init) => fetch(url, init);
// Tests replace the network with a fake; production never calls this.
function setTransport(fn) {
  transport = fn || ((url, init) => fetch(url, init));
}

// Where consent, quota and the ledger are kept (the database). Tests may pass another store.
let store = null;
function usageStore() {
  if (!store) store = require('../database');
  return store;
}
function setUsageStore(next) {
  store = next || null;
}

function isEnabled() {
  return providers.status().ready;
}

function modelName() {
  return providers.status().model || '';
}

// The provider (Google Gemini), its model and why it is not ready, never the key.
const providerStatus = () => providers.status();

// The model is pinned: gemini-2.5-flash-lite unless GEMINI_MODEL names another one. A different model is allowed but
// announced (start-up log and Integrations), so a change of model, and of its cost and quality, is never silent.
function checkModelConfig({ production = process.env.NODE_ENV !== 'development' } = {}) {
  const state = providers.status();
  if (!state.ready) return { ok: true, warning: null };
  if (state.model === providers.DEFAULT_MODEL) return { ok: true, warning: null };
  const warning = `GEMINI_MODEL is set to ${state.model}, not the project's model ${providers.DEFAULT_MODEL}. Check its price and test it before use.`;
  if (production) logEvent('warn', 'ai_model_changed', { model: state.model });
  return { ok: false, warning };
}

const limits = () => ({
  companyPerDay: Number(process.env.AI_DAILY_LIMIT_PER_TENANT) > 0 ? Number(process.env.AI_DAILY_LIMIT_PER_TENANT) : 300,
  personPerHour: Number(process.env.AI_RATE_LIMIT_PER_HOUR) > 0 ? Number(process.env.AI_RATE_LIMIT_PER_HOUR) : 60
});

// Windows are UTC calendar buckets: the company's day resets at 00:00 UTC, a person's hour at the top of the hour.
function windows(now = new Date()) {
  const iso = now.toISOString();
  const nextDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const nextHour = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() + 1);
  return {
    day: { key: `day:${iso.slice(0, 10)}`, resetSeconds: Math.max(1, Math.ceil((nextDay - now) / 1000)) },
    hour: (userId) => ({ key: `user:${userId}:hour:${iso.slice(0, 13)}`, resetSeconds: Math.max(1, Math.ceil((nextHour - now) / 1000)) })
  };
}

function quotaError(scope, limit, resetSeconds) {
  const error = httpError(429, scope === 'company_daily'
    ? `Your company used its ${limit} AI requests for today. AI starts again at 00:00 UTC; until then fill the form by hand.`
    : `You used your ${limit} AI requests for this hour. Please fill the form by hand or try again later.`);
  error.code = 'AI_QUOTA_EXCEEDED';
  error.details = { scope, limit, retryAfterSeconds: resetSeconds };
  error.retryAfterSeconds = resetSeconds;
  return error;
}

// Consent counts only for the provider it was given for.
async function hasConsent(db, tenantId) {
  const consent = await db.getAiConsent(tenantId);
  return consent.consent && consent.provider === providers.activeId();
}

function consentError() {
  const error = httpError(403, `Sending data to the AI provider (${providers.status().name}) is not allowed for your company yet. An administrator can allow it in Team & settings → AI data sharing.`);
  error.code = 'AI_CONSENT_REQUIRED';
  return error;
}

// Is AI allowed for this company right now? Used by screens and by NEXUS before queuing work; it takes nothing.
async function availability(tenantId, { userId = null, now = new Date() } = {}) {
  if (!isEnabled()) return { ok: false, code: 'AI_OFF', reason: 'AI is off.' };
  const db = usageStore();
  if (!(await hasConsent(db, tenantId))) return { ok: false, code: 'AI_CONSENT_REQUIRED', reason: consentError().message };
  const { companyPerDay, personPerHour } = limits();
  const w = windows(now);
  if ((await db.aiQuotaUsed(tenantId, w.day.key)) >= companyPerDay) return { ok: false, code: 'AI_QUOTA_EXCEEDED', reason: quotaError('company_daily', companyPerDay, w.day.resetSeconds).message, error: quotaError('company_daily', companyPerDay, w.day.resetSeconds) };
  if (userId && (await db.aiQuotaUsed(tenantId, w.hour(userId).key)) >= personPerHour) return { ok: false, code: 'AI_QUOTA_EXCEEDED', reason: quotaError('user_hourly', personPerHour, w.hour(userId).resetSeconds).message, error: quotaError('user_hourly', personPerHour, w.hour(userId).resetSeconds) };
  return { ok: true };
}

// Takes one unit from the company's day and the person's hour, or none of them.
async function reserve(tenantId, userId, now = new Date()) {
  const db = usageStore();
  const { companyPerDay, personPerHour } = limits();
  const w = windows(now);
  let tookDay = false;
  try {
    tookDay = await db.takeAiQuota(tenantId, w.day.key, companyPerDay);
    if (!tookDay) throw quotaError('company_daily', companyPerDay, w.day.resetSeconds);
    if (userId) {
      const hour = w.hour(userId);
      if (!(await db.takeAiQuota(tenantId, hour.key, personPerHour))) {
        await db.returnAiQuota(tenantId, w.day.key);
        throw quotaError('user_hourly', personPerHour, hour.resetSeconds);
      }
    }
  } catch (error) {
    if (error.code === 'AI_QUOTA_EXCEEDED') throw error;
    // The counter could not be written: nothing is sent, so nothing can be spent without being counted.
    logEvent('error', 'ai_quota_unavailable', { tenantId, error: error.message });
    if (tookDay) await db.returnAiQuota(tenantId, w.day.key).catch(() => {});
    const unavailable = httpError(503, 'AI usage could not be recorded, so nothing was sent to the AI provider. Please try again later.');
    unavailable.code = 'AI_USAGE_UNAVAILABLE';
    throw unavailable;
  }
}

// Gives back the units taken by reserve() when nothing was sent.
async function release(tenantId, userId, now = new Date()) {
  const db = usageStore();
  const w = windows(now);
  await db.returnAiQuota(tenantId, w.day.key);
  if (userId) await db.returnAiQuota(tenantId, w.hour(userId).key);
}

// Models sometimes wrap JSON in ``` fences or add a sentence; take the first JSON object.
function extractJson(text) {
  const cleaned = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw Object.assign(new Error('Model did not return JSON.'), { kind: 'invalid_json' });
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (_) {
    throw Object.assign(new Error('Model returned broken JSON.'), { kind: 'invalid_json' });
  }
}

// One HTTP request to the active provider. Returns { text, model, inputTokens, outputTokens } whatever the provider.
async function callOnce(provider, request, signal) {
  const response = await transport(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal
  });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = null;
  }
  if (!response.ok) {
    const error = new Error(data?.error?.message || `AI provider returned ${response.status}`);
    error.kind = response.status === 429 ? 'provider_rate_limit' : response.status >= 500 ? 'provider_error' : 'provider_rejected';
    error.retryable = response.status === 429 || response.status >= 500;
    throw error;
  }
  return data;
}

async function safeLog(log, task, tenantId) {
  try {
    await log?.(task);
  } catch (error) {
    logEvent('error', 'ai_audit_log_failed', { tenantId, agent: task.agent, status: task.status, error: error.message });
  }
}

/**
 * Ask the model for a JSON object.
 * @param {object} options
 * @param {string} options.agent        Agent name for the ledger and the log (FLOW, VAULT, ...).
 * @param {string} options.system       Trusted instructions.
 * @param {string|object[]} options.user  Untrusted content: text, or content parts (text plus a file as a data: URL).
 * @param {{tenantId: number, userId?: number}} options.usage  Who pays: REQUIRED. Consent and quota are checked for this company.
 * @param {(raw: object) => {ok: boolean, errors?: string[]}} options.validate  Strict shape check of the answer: REQUIRED.
 * @param {number} [options.timeoutMs]  Longer for documents than for short messages.
 * @param {(task: object) => Promise<void>} [options.log]  Writes the agent_tasks row (analytics).
 */
async function completeJson({ agent, system, user, maxTokens = 700, timeoutMs = TIMEOUT_MS, log, usage, validate }) {
  if (!isEnabled()) throw Object.assign(httpError(503, `AI is not configured. ${providers.status().problem || ''}`.trim()), { code: 'AI_OFF' });
  if (!usage || !Number.isInteger(Number(usage.tenantId)) || Number(usage.tenantId) <= 0) {
    // A programming error, never a user error: every model call must name the company that pays for it.
    throw new Error(`AI call for ${agent} without a company: pass usage: { tenantId }.`);
  }
  if (typeof validate !== 'function') {
    // A programming error: an answer that is not checked must never be used, so the call is refused before anything is spent.
    throw new Error(`AI call for ${agent} without an answer check: pass validate.`);
  }
  const tenantId = Number(usage.tenantId);
  const userId = usage.userId ? Number(usage.userId) : null;
  const db = usageStore();

  if (!(await hasConsent(db, tenantId))) throw consentError();
  await reserve(tenantId, userId);

  // The ledger row must exist BEFORE anything is sent: without it the cost could not be recorded. If it cannot be
  // written, the unit is given back and nothing is sent.
  let callId = null;
  try {
    callId = await db.startAiCall(tenantId, { userId, agent, provider: providers.activeId() });
    if (!callId) throw new Error('no ledger id');
  } catch (error) {
    logEvent('error', 'ai_ledger_start_failed', { tenantId, agent, error: error.message });
    await release(tenantId, userId).catch(() => {});
    const unavailable = httpError(503, 'AI usage could not be recorded, so nothing was sent to the AI provider. Please try again later.');
    unavailable.code = 'AI_USAGE_UNAVAILABLE';
    throw unavailable;
  }

  const provider = providers.active();
  const model = modelName();
  const request = provider.build({ model, system, user: redactContent(user), maxTokens });

  const started = Date.now();
  const totals = { inputTokens: null, outputTokens: null, model: model || null, attempts: 0 };
  const addUsage = (answer) => {
    if (answer?.model) totals.model = answer.model;
    if (Number.isFinite(answer?.inputTokens)) totals.inputTokens = (totals.inputTokens || 0) + answer.inputTokens;
    if (Number.isFinite(answer?.outputTokens)) totals.outputTokens = (totals.outputTokens || 0) + answer.outputTokens;
  };
  const finish = async (status, errorKind, message) => {
    const latencyMs = Date.now() - started;
    const result = { status, model: totals.model, inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, latencyMs, attempts: totals.attempts, errorKind };
    // The provider has already charged: the row is completed with a second try, and if both fail the tokens are kept
    // in a structured log line (never the prompt), so the cost can still be reconciled.
    let saved = false;
    for (let attempt = 0; attempt < 2 && !saved; attempt += 1) {
      try {
        await db.finishAiCall(tenantId, callId, result);
        saved = true;
      } catch (error) {
        if (attempt === 1) logEvent('error', 'ai_ledger_finish_failed', { tenantId, agent, callId, error: error.message, ...result });
      }
    }
    await safeLog(log, { agent, status: status === 'succeeded' ? 'succeeded' : 'failed', model: totals.model, inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, latencyMs, error: errorKind ? `${errorKind}${message ? `: ${message}` : ''}` : null }, tenantId);
  };

  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    totals.attempts += 1;
    let data;
    try {
      data = provider.read(await callOnce(provider, request, controller.signal));
    } catch (error) {
      clearTimeout(timer);
      lastError = error.name === 'AbortError' ? Object.assign(new Error('AI provider timed out.'), { kind: 'timeout' }) : error;
      if (!lastError.kind) lastError.kind = error instanceof TypeError ? 'network' : 'provider_error';
      const retryable = error.name === 'AbortError' || error.retryable || error instanceof TypeError;
      if (!retryable || attempt === 1) break;
      // A retry is a second provider request and may be charged too: it takes its own unit, so the counters always
      // equal the number of requests sent. No unit left = no retry.
      try {
        await reserve(tenantId, userId);
      } catch (quotaError) {
        logEvent('warn', 'ai_retry_skipped', { tenantId, agent, callId, reason: quotaError.code || 'quota' });
        break;
      }
      continue;
    }
    clearTimeout(timer);
    // The provider answered and charged for it: its token usage is recorded whatever the answer looks like.
    addUsage(data);
    let parsed;
    try {
      parsed = extractJson(data?.text);
    } catch (error) {
      await finish('invalid_output', 'invalid_json', error.message);
      throw Object.assign(httpError(502, 'The AI answer could not be read. Please fill the form by hand.'), { code: 'AI_INVALID_OUTPUT' });
    }
    const shape = validate(parsed) || { ok: false, errors: ['validator returned nothing'] };
    if (!shape.ok) {
      await finish('invalid_output', 'schema', (shape.errors || []).slice(0, 3).join('; '));
      throw Object.assign(httpError(502, 'The AI answer did not have the expected fields, so nothing was filled in. Please fill the form by hand.'), { code: 'AI_INVALID_OUTPUT' });
    }
    await finish('succeeded', null, null);
    return parsed;
  }
  await finish('failed', lastError?.kind || 'provider_error', lastError?.message);
  throw Object.assign(httpError(502, 'The AI assistant could not answer right now. Please fill the form by hand or try again.'), { code: 'AI_PROVIDER_FAILED' });
}

module.exports = { completeJson, providerStatus, isEnabled, setTransport, setUsageStore, extractJson, availability, checkModelConfig, modelName, limits };
