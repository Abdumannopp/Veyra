// Structured server log lines: one JSON object per line, easy to search in Railway / any log viewer.
// Only small, known fields are written. Never pass a prompt, an email or document text, a key or a password here.
function logEvent(level, event, fields = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      safe[key] = typeof value === 'string' ? value.slice(0, 300) : value;
    }
  }
  const line = JSON.stringify({ level, event, time: new Date().toISOString(), ...safe });
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
}

module.exports = { logEvent };
