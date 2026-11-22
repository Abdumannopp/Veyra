/* =========================================================
   Shipment legs: one customer order (the shipment) moves in one or more legs, each by its own mode.
   Pure rules only (no database): modes, statuses, transitions, mode-specific details, the shipment's
   status rolled up from its legs, and how a classic single-truck load looks as one ROAD leg.
   ========================================================= */
const modeDetails = require('./mode-details');
const { normalizeCurrency } = require('./money');
const { parseUtc, utcText } = require('./time');

const MODES = ['ROAD', 'OCEAN', 'AIR', 'RAIL', 'WAREHOUSE', 'LAST_MILE'];

const LEG_STATUSES = ['Planned', 'Booked', 'In Transit', 'Delivered', 'Exception', 'Cancelled'];
const LEG_TRANSITIONS = {
  Planned: ['Booked', 'Cancelled'],
  Booked: ['In Transit', 'Planned', 'Cancelled'],
  'In Transit': ['Delivered', 'Exception'],
  Exception: ['In Transit', 'Cancelled']
};
// Statuses in which the leg can still be edited.
const OPEN_LEG_STATUSES = ['Planned', 'Booked', 'In Transit', 'Exception'];
// Where location updates make sense.
const TRACKABLE_LEG_STATUSES = ['Booked', 'In Transit', 'Exception'];

// What may be recorded per mode (manual entry; there is no carrier connection behind these fields).
const DETAIL_KEYS = {
  ROAD: ['truckPlate', 'driverName', 'driverPhone', 'equipment'],
  OCEAN: ['shippingLine', 'bookingNo', 'vessel', 'voyage', 'containerNo', 'containerType', 'sealNo', 'billOfLading', 'portOfLoading', 'portOfDischarge'],
  AIR: ['airline', 'flightNumber', 'airWaybill', 'airportFrom', 'airportTo', 'pieces', 'grossWeightKg', 'volumeM3'],
  RAIL: ['trainNo', 'wagonNo', 'consignmentNoteType', 'consignmentNoteNo', 'terminalFrom', 'terminalTo', 'borderStation'],
  WAREHOUSE: ['warehouseName', 'storageDays'],
  LAST_MILE: ['courier', 'parcelNo']
};

// The classic load statuses seen as a leg status.
const LEG_STATUS_OF_SHIPMENT = {
  New: 'Planned', Sourcing: 'Planned', 'Pending Approval': 'Planned', Dispatched: 'Booked', 'In Transit': 'In Transit',
  Delivered: 'Delivered', Exception: 'Exception', Cancelled: 'Cancelled'
};

class LegInputError extends Error {}

const text = (value, label, max, { required = false } = {}) => {
  if (value === undefined || value === null || value === '') {
    if (required) throw new LegInputError(`${label} is required.`);
    return null;
  }
  if (typeof value !== 'string' || value.trim().length > max) throw new LegInputError(`${label} must be text of at most ${max} characters.`);
  return value.trim() || null;
};

// A date ("YYYY-MM-DD") stays a date; a date and time becomes UTC text. Anything else is refused.
function readWhen(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const date = new Date(`${raw}T00:00:00Z`);
    if (!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw) return raw;
  } else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})?$/.test(raw)) {
    const instant = parseUtc(raw);
    if (!Number.isNaN(instant.getTime())) return utcText(instant);
  }
  throw new LegInputError(`${label} must be a date (YYYY-MM-DD) or a date and time (YYYY-MM-DDTHH:MM, UTC unless it has an offset).`);
}

function readDetails(mode, value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new LegInputError('details must be an object.');
  const allowed = DETAIL_KEYS[mode];
  const details = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!allowed.includes(key)) throw new LegInputError(`${key} is not a ${mode} detail. Allowed: ${allowed.join(', ')}.`);
    if (entry === null || entry === '') continue;
    if (typeof entry !== 'string' && typeof entry !== 'number') throw new LegInputError(`${key} must be text or a number.`);
    const stored = String(entry).trim();
    if (!stored) continue;
    if (stored.length > 120) throw new LegInputError(`${key} must be at most 120 characters.`);
    const rule = modeDetails.ruleFor(mode, key);
    try {
      details[key] = rule ? rule(stored) : stored;
    } catch (error) {
      if (error instanceof modeDetails.DetailError) throw new LegInputError(error.message);
      throw error;
    }
  }
  return modeDetails.derive(mode, details);
}

// Reads the fields of a leg from a request body. `parseMoney` is the app's price rule (returns null when invalid).
// With partial = true only the given fields are returned (for edits).
function readLegInput(body, { partial = false, parseMoney = (value) => Number(value), mode: knownMode = null } = {}) {
  const input = {};
  const has = (key) => body?.[key] !== undefined;
  const mode = has('mode') ? String(body.mode).toUpperCase() : knownMode;
  if (has('mode') || !partial) {
    if (!MODES.includes(mode)) throw new LegInputError(`Mode must be one of ${MODES.join(', ')}.`);
    input.mode = mode;
  }
  if (has('origin') || !partial) input.origin = text(body?.origin, 'Origin', 200, { required: true });
  if (has('destination') || !partial) input.destination = text(body?.destination, 'Destination', 200, { required: true });
  if (has('carrierId')) {
    const id = body.carrierId === null || body.carrierId === '' ? null : Number(body.carrierId);
    if (id !== null && (!Number.isInteger(id) || id <= 0)) throw new LegInputError('carrierId must be a carrier number.');
    input.carrierId = id;
  }
  if (has('price')) {
    if (body.price === null || body.price === '') input.price = null;
    else {
      const price = parseMoney(body.price);
      if (price === null || price === undefined) throw new LegInputError('The price must be a valid amount.');
      input.price = price;
    }
  }
  if (has('currency')) {
    try {
      input.currency = body.currency === null || body.currency === '' ? null : normalizeCurrency(body.currency);
    } catch (error) {
      throw new LegInputError(error.message);
    }
  }
  if (has('scheduledPickup')) input.scheduledPickup = readWhen(body.scheduledPickup, 'scheduledPickup');
  if (has('scheduledDelivery')) input.scheduledDelivery = readWhen(body.scheduledDelivery, 'scheduledDelivery');
  if (has('reference')) input.reference = text(body.reference, 'Reference', 120);
  if (has('eta')) input.eta = readWhen(body.eta, 'eta');
  if (has('details')) input.details = readDetails(mode || knownMode || 'ROAD', body.details);
  return input;
}

// The shipment's own status from the status of its legs.
function rollupStatus(legStatuses) {
  const live = legStatuses.filter((status) => status !== 'Cancelled');
  if (!legStatuses.length) return 'New';
  if (!live.length) return 'Cancelled';
  if (live.includes('Exception')) return 'Exception';
  if (live.every((status) => status === 'Delivered')) return 'Delivered';
  if (live.includes('In Transit') || (live.includes('Delivered') && live.some((status) => status !== 'Delivered'))) return 'In Transit';
  if (live.includes('Booked')) return 'Dispatched';
  return 'New';
}

// Whether a leg may start or finish: the leg before it (ignoring cancelled ones) must be delivered first.
function blockedByEarlierLeg(legs, leg, nextStatus) {
  if (!['In Transit', 'Delivered'].includes(nextStatus)) return null;
  const earlier = legs.filter((other) => other.sequence < leg.sequence && other.status !== 'Cancelled');
  const open = earlier.find((other) => other.status !== 'Delivered');
  return open ? `Leg ${open.sequence} (${open.mode}) is not delivered yet.` : null;
}

/* ---------- schedules and delays (Phase 4.2) ---------- */

// A planned time as a moment. A date without a time means "some time that day": the end of the day (UTC),
// so a leg planned for today is not late before the day is over. Unreadable text gives null.
function planMoment(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const end = new Date(`${raw}T23:59:59Z`);
    return Number.isNaN(end.getTime()) ? null : end;
  }
  // Only ISO-style times count; free text such as "Oct 3" on an old load is not guessed at.
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(raw)) return null;
  const instant = parseUtc(raw);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

const hoursBetween = (later, earlier) => Math.round(((later - earlier) / 3600000) * 10) / 10;

// For each leg (in order): is it late, and is the next handover at risk?
//   pickup_missed   still Planned/Booked after its planned pickup
//   overdue         not delivered after its planned delivery
//   eta_late        on the way, and the latest ETA is after the planned delivery
//   handover_risk   the previous leg is expected (ETA, else plan) after this leg's planned pickup
// `graceHours` keeps a few minutes' difference from counting as late.
function legTiming(legs, { now = new Date(), graceHours = 1 } = {}) {
  const grace = graceHours * 3600000;
  const result = legs.map((leg) => {
    const open = !['Delivered', 'Cancelled'].includes(leg.status);
    const pickup = planMoment(leg.scheduledPickup);
    const delivery = planMoment(leg.scheduledDelivery);
    const eta = planMoment(leg.eta);
    const issues = [];
    if (open && pickup && ['Planned', 'Booked'].includes(leg.status) && now - pickup > grace) {
      issues.push({ kind: 'pickup_missed', hours: hoursBetween(now, pickup), text: `pickup planned ${hoursBetween(now, pickup)} h ago has not started` });
    }
    if (open && delivery && now - delivery > grace) {
      issues.push({ kind: 'overdue', hours: hoursBetween(now, delivery), text: `${hoursBetween(now, delivery)} h past the planned delivery` });
    } else if (open && delivery && eta && eta - delivery > grace) {
      issues.push({ kind: 'eta_late', hours: hoursBetween(eta, delivery), text: `ETA is ${hoursBetween(eta, delivery)} h after the planned delivery` });
    }
    return { legId: leg.id, late: issues.length > 0, issues, expectedArrival: open ? (eta || delivery) : null };
  });
  for (let i = 1; i < legs.length; i += 1) {
    const next = legs[i];
    if (!['Planned', 'Booked'].includes(next.status)) continue;
    const previous = legs.slice(0, i).reverse().find((leg) => leg.status !== 'Cancelled');
    if (!previous || previous.status === 'Delivered') continue;
    const arrival = result[legs.indexOf(previous)].expectedArrival;
    const pickup = planMoment(next.scheduledPickup);
    if (arrival && pickup && arrival - pickup > grace) {
      result[i].issues.push({ kind: 'handover_risk', hours: hoursBetween(arrival, pickup), text: `the leg before is expected ${hoursBetween(arrival, pickup)} h after this pickup` });
      result[i].late = true;
    }
  }
  return result.map(({ expectedArrival, ...timing }) => ({ ...timing, expectedArrival: expectedArrival ? utcText(expectedArrival) : null }));
}

module.exports = {
  legTiming, planMoment,
  MODES, LEG_STATUSES, LEG_TRANSITIONS, OPEN_LEG_STATUSES, TRACKABLE_LEG_STATUSES, DETAIL_KEYS, LEG_STATUS_OF_SHIPMENT,
  LegInputError, readLegInput, readDetails, readWhen, rollupStatus, blockedByEarlierLeg
};
