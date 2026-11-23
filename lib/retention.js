// Retention (Phase 6.2): how long a company keeps old data before Veyra removes it.
// Every category is off (kept for ever) until a company admin sets a number of days.
// Loads themselves, their money and their status history are never removed here: invoices and
// accounting may need them for years. What can go is detail that loses value once a load is finished.

class RetentionError extends Error {}

// key: [label, minimum days]
const CATEGORIES = {
  trackingDays: ['Positions of finished loads', 30],
  messagesDays: ['SMS / WhatsApp messages of finished loads', 30],
  documentsDays: ['Files of finished loads (CMR, POD, B/L…)', 90],
  tasksDays: ['Done NEXUS tasks (dismissed ones are kept)', 30],
  auditDays: ['Activity log', 365]
};

function readSettings(body) {
  const settings = { auto: body?.auto === true };
  for (const [key, [label, min]] of Object.entries(CATEGORIES)) {
    const value = body?.[key];
    if (value === undefined || value === null || value === '') {
      settings[key] = null;
      continue;
    }
    const days = Number(value);
    if (!Number.isInteger(days) || days < min || days > 3650) throw new RetentionError(`${label}: keep at least ${min} days (at most 3650), or leave it empty to keep for ever.`);
    settings[key] = days;
  }
  if (settings.auto && Object.keys(CATEGORIES).every((key) => settings[key] === null)) settings.auto = false;
  return settings;
}

function parseStored(text) {
  try {
    const parsed = JSON.parse(text || '{}');
    return readSettings(parsed && typeof parsed === 'object' ? parsed : {});
  } catch (_) {
    return readSettings({});
  }
}

module.exports = { CATEGORIES, RetentionError, parseStored, readSettings };
