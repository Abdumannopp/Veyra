// Warehouse (Phase 5.2): receiving goods into a WAREHOUSE leg, the days they are stored, and their release.
// Pure rules, no database. Everything is entered by warehouse staff; no warehouse system is connected.
const { parseUtc, utcText } = require('./time');

class WarehouseError extends Error {}

const wholeNumber = (value, label, { min = 0, max = 1000000, required = false } = {}) => {
  if (value === undefined || value === null || value === '') {
    if (required) throw new WarehouseError(`${label} is required.`);
    return null;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new WarehouseError(`${label} must be a whole number from ${min} to ${max}.`);
  return number;
};

function readMoment(value, label, now) {
  if (value === undefined || value === null || value === '') return utcText(now);
  const raw = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(raw)) throw new WarehouseError(`${label} must be a date and time (YYYY-MM-DDTHH:MM, UTC unless it has an offset).`);
  const moment = parseUtc(raw);
  if (Number.isNaN(moment.getTime())) throw new WarehouseError(`${label} is not a valid time.`);
  if (moment - now > 5 * 60000) throw new WarehouseError(`${label} cannot be in the future.`);
  return utcText(moment);
}

const note = (value) => (typeof value === 'string' ? value.trim().slice(0, 500) || null : null);

// { piecesExpected?, piecesReceived, damagedPieces?, freeDays?, dailyRate?, receivedAt?, note? }
// parseMoney is the app's price rule (returns null when invalid).
function readReceive(body, { now = new Date(), parseMoney } = {}) {
  const piecesReceived = wholeNumber(body?.piecesReceived, 'piecesReceived', { required: true });
  const piecesExpected = wholeNumber(body?.piecesExpected, 'piecesExpected');
  const damagedPieces = wholeNumber(body?.damagedPieces, 'damagedPieces') ?? 0;
  if (damagedPieces > piecesReceived) throw new WarehouseError('damagedPieces cannot be more than piecesReceived.');
  const freeDays = wholeNumber(body?.freeDays, 'freeDays', { max: 365 }) ?? 0;
  let dailyRate = null;
  if (body?.dailyRate !== undefined && body?.dailyRate !== null && body?.dailyRate !== '') {
    dailyRate = parseMoney ? parseMoney(body.dailyRate) : Number(body.dailyRate);
    if (dailyRate === null || !Number.isFinite(dailyRate) || dailyRate < 0) throw new WarehouseError('dailyRate must be a price of 0 or more.');
  }
  return { piecesExpected, piecesReceived, damagedPieces, freeDays, dailyRate, receivedAt: readMoment(body?.receivedAt, 'receivedAt', now), note: note(body?.note) };
}

// { piecesReleased?, releasedAt?, note? }. Released pieces default to the good pieces received.
function readRelease(body, stay, { now = new Date() } = {}) {
  const releasedAt = readMoment(body?.releasedAt, 'releasedAt', now);
  if (releasedAt < stay.receivedAt) throw new WarehouseError('releasedAt cannot be before the goods were received.');
  const piecesReleased = wholeNumber(body?.piecesReleased, 'piecesReleased', { max: stay.piecesReceived }) ?? stay.piecesReceived - stay.damagedPieces;
  return { piecesReleased, releasedAt, note: note(body?.note) };
}

// Storage is charged per started day (24 h) after the free days.
function storage(stay, { now = new Date() } = {}) {
  if (!stay?.receivedAt) return null;
  const end = stay.releasedAt ? parseUtc(stay.releasedAt) : now;
  const days = Math.max(1, Math.ceil((end - parseUtc(stay.receivedAt)) / 86400000));
  const chargeableDays = Math.max(0, days - (stay.freeDays || 0));
  const charge = stay.dailyRate === null || stay.dailyRate === undefined ? null : Math.round(chargeableDays * Number(stay.dailyRate) * 100) / 100;
  const shortPieces = stay.piecesExpected === null || stay.piecesExpected === undefined ? 0 : Math.max(0, stay.piecesExpected - stay.piecesReceived);
  const overPieces = stay.piecesExpected === null || stay.piecesExpected === undefined ? 0 : Math.max(0, stay.piecesReceived - stay.piecesExpected);
  return { days, freeDays: stay.freeDays || 0, chargeableDays, charge, overFreeDays: chargeableDays > 0, shortPieces, overPieces, damagedPieces: stay.damagedPieces || 0, released: Boolean(stay.releasedAt) };
}

module.exports = { WarehouseError, readReceive, readRelease, storage };
