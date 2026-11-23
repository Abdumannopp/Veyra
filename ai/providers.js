// The AI providers VEYRA can use. Exactly ONE is active for the whole server (AI_PROVIDER); every model call goes
// through ai/gateway.js, which keeps the same rules (consent, quota, ledger, redaction, answer check) for all of them.
//
// Each adapter turns one request into the provider's own HTTP format and reads the answer back into the same shape:
//   build({ model, system, user, maxTokens }) -> { url, headers, body }
//   read(json) -> { text, model, inputTokens, outputTokens }
// `user` is either a string or content parts in the OpenAI style:
//   { type: 'text', text } | { type: 'image_url', image_url: { url: 'data:<mime>;base64,...' } }
//   | { type: 'file', file: { filename, file_data: 'data:application/pdf;base64,...' } }
//
// Keys are read from the environment at call time and are never logged or returned.

function parseDataUrl(url) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(String(url || ''));
  return match ? { mime: match[1], data: match[2] } : null;
}

// The parts as plain items: { kind: 'text', text } | { kind: 'file', mime, data, filename }.
function plainParts(user) {
  if (typeof user === 'string') return [{ kind: 'text', text: user }];
  return (Array.isArray(user) ? user : []).map((part) => {
    if (part?.type === 'text') return { kind: 'text', text: String(part.text ?? '') };
    if (part?.type === 'image_url') return { kind: 'file', ...parseDataUrl(part.image_url?.url), filename: null };
    if (part?.type === 'file') return { kind: 'file', ...parseDataUrl(part.file?.file_data), filename: part.file?.filename || 'document.pdf' };
    return null;
  }).filter((part) => part && (part.kind === 'text' || (part.mime && part.data)));
}

const numberOrNull = (value) => (Number.isFinite(Number(value)) && value !== null && value !== undefined ? Number(value) : null);

// OpenAI-style chat completions (OpenRouter and OpenAI share it).
function chatBody({ model, system, user, maxTokens }) {
  const body = { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0, max_tokens: maxTokens };
  if (model) body.model = model;
  return body;
}
function readChat(json) {
  const content = json?.choices?.[0]?.message?.content;
  return {
    text: typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => part?.text || '').join('') : '',
    model: json?.model || null,
    inputTokens: numberOrNull(json?.usage?.prompt_tokens),
    outputTokens: numberOrNull(json?.usage?.completion_tokens)
  };
}

const PROVIDERS = {
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    keyEnv: 'OPENROUTER_API_KEY',
    modelEnv: 'OPENROUTER_MODEL',
    // OpenRouter has an account default model, so the model may be left empty (a warning is shown).
    modelRequired: false,
    build: (request) => ({
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'X-Title': 'VEYRA' },
      body: chatBody(request)
    }),
    read: readChat
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    keyEnv: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_MODEL',
    modelRequired: true,
    build: (request) => {
      const body = chatBody(request);
      // OpenAI uses max_completion_tokens for current models.
      body.max_completion_tokens = body.max_tokens;
      delete body.max_tokens;
      return { url: 'https://api.openai.com/v1/chat/completions', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, body };
    },
    read: readChat
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    keyEnv: 'ANTHROPIC_API_KEY',
    modelEnv: 'ANTHROPIC_MODEL',
    modelRequired: true,
    build: ({ model, system, user, maxTokens }) => ({
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: {
        model,
        system,
        max_tokens: maxTokens,
        temperature: 0,
        messages: [{
          role: 'user',
          content: plainParts(user).map((part) => {
            if (part.kind === 'text') return { type: 'text', text: part.text };
            if (part.mime === 'application/pdf') return { type: 'document', source: { type: 'base64', media_type: part.mime, data: part.data } };
            return { type: 'image', source: { type: 'base64', media_type: part.mime, data: part.data } };
          })
        }]
      }
    }),
    read: (json) => ({
      text: (Array.isArray(json?.content) ? json.content : []).filter((part) => part?.type === 'text').map((part) => part.text).join(''),
      model: json?.model || null,
      inputTokens: numberOrNull(json?.usage?.input_tokens),
      outputTokens: numberOrNull(json?.usage?.output_tokens)
    })
  },
  google: {
    id: 'google',
    name: 'Google Gemini',
    keyEnv: 'GEMINI_API_KEY',
    modelEnv: 'GEMINI_MODEL',
    modelRequired: true,
    build: ({ model, system, user, maxTokens }) => ({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      // The key goes in a header, never in the URL (URLs end up in logs).
      headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{
          role: 'user',
          parts: plainParts(user).map((part) => (part.kind === 'text' ? { text: part.text } : { inlineData: { mimeType: part.mime, data: part.data } }))
        }],
        generationConfig: { temperature: 0, maxOutputTokens: maxTokens, responseMimeType: 'application/json' }
      }
    }),
    read: (json) => ({
      text: (json?.candidates?.[0]?.content?.parts || []).map((part) => part?.text || '').join(''),
      model: json?.modelVersion || null,
      inputTokens: numberOrNull(json?.usageMetadata?.promptTokenCount),
      outputTokens: numberOrNull(json?.usageMetadata?.candidatesTokenCount)
    })
  }
};

const IDS = Object.keys(PROVIDERS);

// Which provider is active: AI_PROVIDER if set, else the first one with a key (OpenRouter first, as before).
function activeId() {
  const chosen = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
  if (chosen) return chosen;
  return IDS.find((id) => process.env[PROVIDERS[id].keyEnv]) || 'openrouter';
}

// Everything the screens and the gateway need to know, without the key itself.
function status() {
  const id = activeId();
  const provider = PROVIDERS[id];
  if (!provider) return { id, name: id, ready: false, problem: `AI_PROVIDER="${id}" is not known. Use one of: ${IDS.join(', ')}.`, model: null, keyEnv: null, modelEnv: null };
  const hasKey = Boolean(process.env[provider.keyEnv]);
  const model = process.env[provider.modelEnv] ? process.env[provider.modelEnv].trim() : '';
  let problem = null;
  if (!hasKey) problem = `Add ${provider.keyEnv} to the server settings to use ${provider.name}.`;
  else if (provider.modelRequired && !model) problem = `Set ${provider.modelEnv} to the ${provider.name} model you tested (it has no default model).`;
  return { id, name: provider.name, ready: !problem, problem, model: model || null, keyEnv: provider.keyEnv, modelEnv: provider.modelEnv, modelRequired: provider.modelRequired };
}

const active = () => PROVIDERS[activeId()] || null;

module.exports = { PROVIDERS, IDS, activeId, active, status, plainParts };
