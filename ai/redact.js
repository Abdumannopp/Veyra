// What may leave the server for the AI provider. Business content that the task needs (names, phone numbers,
// places, prices on an order or a transport document) is kept: without it the shipment cannot be read. What is
// removed is anything that only lets someone sign in somewhere: passwords, API keys, tokens, and the server's own
// secrets. They are replaced with [REDACTED] before the text is sent.

const PATTERNS = [
  // "password: abc", "pwd=abc", "passcode - abc", "parol: abc" (Uzbek / Russian too)
  /\b(pass(word|code|wd)?|pwd|parol)\b\s*[:=\-]\s*\S+/gi,
  /пароль\s*[:=\-]\s*\S+/gi,
  // "api key: ...", "token=...", "secret: ...", "access key ..."
  /\b(api[\s_-]?key|access[\s_-]?key|secret|token|auth[\s_-]?code|otp)\b\s*[:=\-]?\s*[A-Za-z0-9._\-]{6,}/gi,
  // Authorization headers
  /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  // JSON Web Tokens
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Well-known key shapes: OpenRouter / OpenAI / Anthropic (sk-...), Google (AIza...), Stripe, AWS, GitHub, Slack, Twilio
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\b(sk-or-v1-[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{20,}|sk_(live|test)_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|SK[0-9a-f]{32})\b/g
];

// The server's own secrets, if one were ever pasted into an email or a document.
const SECRET_SETTINGS = ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'JWT_SECRET', 'SECRETS_KEY', 'TWILIO_AUTH_TOKEN', 'DOCUMENT_ENCRYPTION_KEY', 'R2_SECRET_ACCESS_KEY', 'PADDLE_API_KEY', 'PADDLE_WEBHOOK_SECRET', 'GOOGLE_CLIENT_SECRET', 'MICROSOFT_CLIENT_SECRET', 'TOMTOM_API_KEY'];

function redactSecrets(text) {
  let out = String(text ?? '');
  for (const name of SECRET_SETTINGS) {
    const value = process.env[name];
    if (value && value.length >= 8) out = out.split(value).join('[REDACTED]');
  }
  for (const pattern of PATTERNS) out = out.replace(pattern, '[REDACTED]');
  return out;
}

// The user content of a request: plain text, or a list of parts (text plus a file as a data: URL).
// Text parts are cleaned; a file is sent as it is (it is the document being read), never with any key in it.
function redactContent(content) {
  if (typeof content === 'string') return redactSecrets(content);
  if (Array.isArray(content)) {
    return content.map((part) => (part && part.type === 'text' ? { ...part, text: redactSecrets(part.text) } : part));
  }
  return content;
}

module.exports = { redactSecrets, redactContent };
