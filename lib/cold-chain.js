// Cold chain (Phase 5.1): the temperature range a load must stay in, the readings people record,
// and the excursions (stretches of time outside the range). Pure rules, no database.
// Readings are entered by people (or later by a logger); there is no sensor connection behind them.
const { parseUtc, utcText } = require('./time');

class ColdChainError extends Error {}

const LIMITS = { min: -40, max: 40 };

function readCelsius(value, label) {
  const number = Number(String(value ?? '').replace(',', '.').trim());
  if (value === '' || value === null || value === undefined || !Number.isFinite(number) || number < LIMITS.min || number > LIMITS.max) {
    throw new ColdChainError(`${label} must be a temperature in °C between ${LIMITS.min} and ${LIMITS.max}.`);
  }
  return Math.round(number * 10) / 10;
}

// { min, max } in °C, or null to clear. The range must be at least 0.5 °C wide.
function readRange(body) {
  if (body?.min === null && body?.max === null) return null;
  const min = readCelsius(body?.min, 'min');
  const max = readCelsius(body?.max, 'max');
  if (max - min < 0.5) throw new ColdChainError('max must be at least 0.5 °C above min.');
  return { min, max };
}

// A reading: celsius, when (UTC; default now; not in the future), optional note.
function readReading(body, { now = new Date() } = {}) {
  const celsius = readCelsius(body?.celsius, 'celsius');
  let recordedAt = now;
  if (body?.recordedAt !== undefined && body?.recordedAt !== null && body?.recordedAt !== '') {
    const raw = String(body.recordedAt).trim();
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(raw)) throw new ColdChainError('recordedAt must be a date and time (YYYY-MM-DDTHH:MM, UTC unless it has an offset).');
    recordedAt = parseUtc(raw);
    if (Number.isNaN(recordedAt.getTime())) throw new ColdChainError('recordedAt is not a valid time.');
    if (recordedAt - now > 5 * 60000) throw new ColdChainError('recordedAt cannot be in the future.');
  }
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 300) || null : null;
  return { celsius, recordedAt: utcText(recordedAt), note };
}

// Readings in time order give stretches outside the range. A stretch starts at the first reading outside and
// ends at the first reading back inside (open while the last reading is still outside).
function excursions(readings, range) {
  if (!range) return [];
  const sorted = [...readings].sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : a.id - b.id));
  const found = [];
  let current = null;
  for (const reading of sorted) {
    const celsius = Number(reading.celsius);
    const direction = celsius > range.max ? 'too_warm' : celsius < range.min ? 'too_cold' : null;
    if (direction && (!current || current.direction !== direction)) {
      if (current) {
        current.endedAt = reading.recordedAt;
        found.push(current);
      }
      current = { direction, startReadingId: reading.id, startedAt: reading.recordedAt, endedAt: null, peak: celsius, readings: 1 };
    } else if (direction) {
      current.readings += 1;
      current.peak = direction === 'too_warm' ? Math.max(current.peak, celsius) : Math.min(current.peak, celsius);
    } else if (current) {
      current.endedAt = reading.recordedAt;
      found.push(current);
      current = null;
    }
  }
  if (current) found.push(current);
  return found.map((item) => ({
    ...item,
    minutes: item.endedAt ? Math.round((parseUtc(item.endedAt) - parseUtc(item.startedAt)) / 60000) : null,
    open: !item.endedAt,
    limit: item.direction === 'too_warm' ? range.max : range.min
  }));
}

module.exports = { ColdChainError, LIMITS, excursions, readCelsius, readRange, readReading };
