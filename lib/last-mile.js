// Last mile (Phase 5.3): the stops of a LAST_MILE leg and the proof of delivery at each stop.
// Pure rules, no database. Entered by dispatchers and drivers; no courier system is connected.
const { parseUtc, utcText } = require('./time');

class LastMileError extends Error {}

const STOP_STATUSES = ['Pending', 'Delivered', 'Failed'];

const text = (value, label, max, { required = false } = {}) => {
  if (value === undefined || value === null || String(value).trim() === '') {
    if (required) throw new LastMileError(`${label} is required.`);
    return null;
  }
  if (typeof value !== 'string' || value.trim().length > max) throw new LastMileError(`${label} must be text of at most ${max} characters.`);
  return value.trim();
};

function readMoment(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(raw)) throw new LastMileError(`${label} must be a date and time (YYYY-MM-DDTHH:MM, UTC unless it has an offset).`);
  const moment = parseUtc(raw);
  if (Number.isNaN(moment.getTime())) throw new LastMileError(`${label} is not a valid time.`);
  return utcText(moment);
}

// { address, contactName?, contactPhone?, pieces?, windowFrom?, windowTo?, note? }
function readStop(body) {
  const stop = {
    address: text(body?.address, 'address', 300, { required: true }),
    contactName: text(body?.contactName, 'contactName', 120),
    contactPhone: text(body?.contactPhone, 'contactPhone', 40),
    note: text(body?.note, 'note', 500),
    windowFrom: readMoment(body?.windowFrom, 'windowFrom'),
    windowTo: readMoment(body?.windowTo, 'windowTo'),
    pieces: null
  };
  if (stop.contactPhone && !/^\+?[\d\s()-]{5,40}$/.test(stop.contactPhone)) throw new LastMileError('contactPhone must be a phone number.');
  if (body?.pieces !== undefined && body?.pieces !== null && body?.pieces !== '') {
    const pieces = Number(body.pieces);
    if (!Number.isInteger(pieces) || pieces < 1 || pieces > 100000) throw new LastMileError('pieces must be a whole number from 1 to 100000.');
    stop.pieces = pieces;
  }
  if (stop.windowFrom && stop.windowTo && stop.windowTo <= stop.windowFrom) throw new LastMileError('windowTo must be after windowFrom.');
  return stop;
}

// Proof of delivery: who received it (required), when (default now, not in the future), a note, and a document.
function readDelivery(body, { now = new Date() } = {}) {
  const deliveredAt = readMoment(body?.deliveredAt, 'deliveredAt') || utcText(now);
  if (parseUtc(deliveredAt) - now > 5 * 60000) throw new LastMileError('deliveredAt cannot be in the future.');
  const documentId = body?.documentId === undefined || body?.documentId === null || body?.documentId === '' ? null : Number(body.documentId);
  if (documentId !== null && (!Number.isInteger(documentId) || documentId <= 0)) throw new LastMileError('documentId must be a document of this load.');
  return { receivedBy: text(body?.receivedBy, 'receivedBy', 120, { required: true }), note: text(body?.note, 'note', 500), deliveredAt, documentId };
}

function readFailure(body) {
  return { reason: text(body?.reason, 'reason', 300, { required: true }) };
}

// A pending stop whose delivery window has closed (one hour of grace).
function missedWindow(stop, { now = new Date(), graceHours = 1 } = {}) {
  if (stop.status !== 'Pending' || !stop.windowTo) return false;
  return now - parseUtc(stop.windowTo) > graceHours * 3600000;
}

// What the stops say about the leg: done when none is pending; complete when all were delivered.
function summary(stops) {
  const count = (status) => stops.filter((stop) => stop.status === status).length;
  const pending = count('Pending');
  return { total: stops.length, pending, delivered: count('Delivered'), failed: count('Failed'), done: stops.length > 0 && pending === 0, complete: stops.length > 0 && count('Delivered') === stops.length };
}

module.exports = { LastMileError, STOP_STATUSES, missedWindow, readDelivery, readFailure, readStop, summary };
