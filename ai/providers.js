// The AI provider VEYRA uses: Google Gemini only (decision of the project owner). Every model call goes through
// ai/gateway.js, which keeps the rules (consent, quota, ledger, redaction, answer check) around it.
//
// Settings (server environment only, e.g. Railway Variables; never in code or chat):
//   GEMINI_API_KEY  the key from Google AI Studio. Without it AI is off and nothing leaves the server.
//   GEMINI_MODEL    optional; default gemini-2.5-flash-lite (the model the project uses).
//
// The adapter turns one request into Gemini's HTTP format and reads the answer back:
//   build({ model, system, user, maxTokens }) -> { url, headers, body }
//   read(json) -> { text, model, inputTokens, outputTokens }
// `user` is either a string or content parts:
//   { type: 'text', text } | { type: 'image_url', image_url: { url: 'data:<mime>;base64,...' } }
//   | { type: 'file', file: { filename, file_data: 'data:application/pdf;base64,...' } }
// The key is read at call time, sent only in a header (never in the URL), and never logged or returned.

const DEFAULT_MODEL = 'gemini-2.5-flash-lite';

function parseDataUrl(url) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(String(url || ''));
  return match ? { mime: match[1], data: match[2] } : null;
}

// The parts as plain items: { kind: 'text', text } | { kind: 'file', mime, data }.
function plainParts(user) {
  if (typeof user === 'string') return [{ kind: 'text', text: user }];
  return (Array.isArray(user) ? user : []).map((part) => {
    if (part?.type === 'text') return { kind: 'text', text: String(part.text ?? '') };
    if (part?.type === 'image_url') return { kind: 'file', ...parseDataUrl(part.image_url?.url) };
    if (part?.type === 'file') return { kind: 'file', ...parseDataUrl(part.file?.file_data) };
    return null;
  }).filter((part) => part && (part.kind === 'text' || (part.mime && part.data)));
}

const numberOrNull = (value) => (value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null);

const GEMINI = {
  id: 'google',
  name: 'Google Gemini',
  keyEnv: 'GEMINI_API_KEY',
  modelEnv: 'GEMINI_MODEL',
  defaultModel: DEFAULT_MODEL,
  build: ({ model, system, user, maxTokens }) => ({
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
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
};

const PROVIDERS = { google: GEMINI };
const IDS = Object.keys(PROVIDERS);
const activeId = () => GEMINI.id;
const active = () => GEMINI;

// Everything the screens and the gateway need to know, without the key itself.
function status() {
  const hasKey = Boolean(process.env.GEMINI_API_KEY);
  const model = (process.env.GEMINI_MODEL || '').trim() || DEFAULT_MODEL;
  const problem = hasKey ? null : 'Add GEMINI_API_KEY to the server settings to use Google Gemini.';
  return { id: GEMINI.id, name: GEMINI.name, ready: hasKey, problem, model, keyEnv: GEMINI.keyEnv, modelEnv: GEMINI.modelEnv, defaultModel: DEFAULT_MODEL };
}

module.exports = { PROVIDERS, IDS, DEFAULT_MODEL, activeId, active, status, plainParts };
