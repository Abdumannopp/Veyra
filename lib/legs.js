/* =========================================================
   Shipment legs: one customer order (the shipment) moves in one or more legs, each by its own mode.
   Pure rules only (no database): modes, statuses, transitions, mode-specific details, the shipment's
   status rolled up from its legs, and how a classic single-truck load looks as one ROAD leg.
   ========================================================= */
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
  OCEAN: ['vessel', 'voyage', 'containerNo', 'billOfLading', 'portOfLoading', 'portOfDischarge'],
  AIR: ['flightNumber', 'airWaybill', 'airportFrom', 'airportTo'],
  RAIL: ['trainNo', 'wagonNo', 'terminalFrom', 'terminalTo'],
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
    if (stored.length > 120) throw new LegInputError(`${key} must be at most 120 characters.`);
    details[key] = stored;
  }
  return details;
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

module.exports = {
  MODES, LEG_STATUSES, LEG_TRANSITIONS, OPEN_LEG_STATUSES, TRACKABLE_LEG_STATUSES, DETAIL_KEYS, LEG_STATUS_OF_SHIPMENT,
  LegInputError, readLegInput, readDetails, readWhen, rollupStatus, blockedByEarlierLeg
};
