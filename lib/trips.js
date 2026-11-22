/* =========================================================
   Trips: one truck run that carries several shipments (LTL consolidation).
   Pure rules only (no database): statuses, weight conversion, splitting the truck's price among the
   shipments it carries, and reading a trip or an allocation from a request body.
   ========================================================= */
const { fromMinor, minorDigits, toMinor, normalizeCurrency } = require('./money');
const { LegInputError, readWhen } = require('./legs');

const TRIP_STATUSES = ['Planned', 'Booked', 'In Transit', 'Exception', 'Delivered', 'Cancelled'];
const TRIP_TRANSITIONS = {
  Planned: ['Booked', 'Cancelled'],
  Booked: ['Planned', 'In Transit', 'Cancelled'],
  'In Transit': ['Exception'],
  Exception: ['In Transit']
};
// Where a trip can still take or give back shipments.
const EDITABLE_TRIP_STATUSES = ['Planned', 'Booked'];
// Where positions make sense.
const TRACKABLE_TRIP_STATUSES = ['Booked', 'In Transit', 'Exception'];
// Shipments that have not been booked on a truck yet may be put on a trip.
const ALLOCATABLE_SHIPMENT_STATUSES = ['New', 'Sourcing', 'Pending Approval'];

const KG_PER_LB = 0.45359237;
const round = (value, digits) => Math.round((value + Number.EPSILON) * 10 ** digits) / 10 ** digits;

// "18000 kg", "5400 lb" or a plain number (in the company's unit) as kilograms (3 decimals). null when unreadable.
function weightToKg(value, defaultUnit = 'kg') {
  if (value === null || value === undefined || value === '') return null;
  const match = /^\s*([0-9]+(?:[.,][0-9]+)?)\s*(kg|lb|lbs|t)?\s*$/i.exec(String(value).replace(/\s(?=\d{3}\b)/g, ''));
  if (!match) return null;
  const amount = Number(match[1].replace(',', '.'));
  const unit = (match[2] || defaultUnit || 'kg').toLowerCase();
  const kg = unit.startsWith('lb') ? amount * KG_PER_LB : unit === 't' ? amount * 1000 : amount;
  return Number.isFinite(kg) ? round(kg, 3) : null;
}

// Splits a price among shipments in proportion to their weights, to the minor unit, so the shares always add up
// to the price exactly (the leftover minor units go to the largest remainders). Equal shares when no weight is known.
function splitMoney(total, currency, weights) {
  if (!weights.length) return [];
  const totalMinor = toMinor(total, currency);
  const sumWeights = weights.reduce((sum, weight) => sum + (weight > 0 ? weight : 0), 0);
  const basis = sumWeights > 0 ? weights.map((weight) => (weight > 0 ? weight : 0)) : weights.map(() => 1);
  // Work in micro-units of weight to stay in integers.
  const scaled = basis.map((weight) => BigInt(Math.round(weight * 1000)));
  const scaledSum = scaled.reduce((sum, weight) => sum + weight, 0n);
  const floors = scaled.map((weight) => (totalMinor * weight) / scaledSum);
  const remainders = scaled.map((weight, index) => ({ index, rest: (totalMinor * weight) % scaledSum }));
  let left = totalMinor - floors.reduce((sum, part) => sum + part, 0n);
  remainders.sort((a, b) => (a.rest === b.rest ? a.index - b.index : a.rest > b.rest ? -1 : 1));
  for (const { index } of remainders) {
    if (left <= 0n) break;
    floors[index] += 1n;
    left -= 1n;
  }
  return floors.map((minor) => fromMinor(minor, currency));
}

const text = (value, label, max, { required = false } = {}) => {
  if (value === undefined || value === null || value === '') {
    if (required) throw new LegInputError(`${label} is required.`);
    return null;
  }
  if (typeof value !== 'string' || value.trim().length > max) throw new LegInputError(`${label} must be text of at most ${max} characters.`);
  return value.trim() || null;
};

const positiveNumber = (value, label, max) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > max) throw new LegInputError(`${label} must be a number above 0 and at most ${max}.`);
  return round(number, 3);
};

// A trip from a request body. With partial = true only the given fields are returned.
function readTripInput(body, { partial = false, parseMoney = (value) => Number(value) } = {}) {
  const input = {};
  const has = (key) => body?.[key] !== undefined;
  if (has('origin') || !partial) input.origin = text(body?.origin, 'Origin', 200, { required: true });
  if (has('destination') || !partial) input.destination = text(body?.destination, 'Destination', 200, { required: true });
  if (has('carrierId')) {
    const id = body.carrierId === null || body.carrierId === '' ? null : Number(body.carrierId);
    if (id !== null && (!Number.isInteger(id) || id <= 0)) throw new LegInputError('carrierId must be a carrier number.');
    input.carrierId = id;
  }
  if (has('capacityWeightKg')) input.capacityWeightKg = body.capacityWeightKg === null || body.capacityWeightKg === '' ? null : positiveNumber(body.capacityWeightKg, 'The weight capacity (kg)', 100000);
  else if (!partial) input.capacityWeightKg = null;
  if (has('capacityPallets')) {
    if (body.capacityPallets === null || body.capacityPallets === '') input.capacityPallets = null;
    else {
      const pallets = Number(body.capacityPallets);
      if (!Number.isInteger(pallets) || pallets <= 0 || pallets > 200) throw new LegInputError('The pallet capacity must be a whole number from 1 to 200.');
      input.capacityPallets = pallets;
    }
  }
  if (has('cost')) {
    if (body.cost === null || body.cost === '') input.cost = null;
    else {
      const cost = parseMoney(body.cost);
      if (cost === null || cost === undefined) throw new LegInputError("The truck's price must be a valid amount.");
      input.cost = cost;
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
  if (has('truckPlate')) input.truckPlate = text(body.truckPlate, 'Truck plate', 20);
  if (has('driverName')) input.driverName = text(body.driverName, 'Driver', 120);
  if (has('driverPhone')) input.driverPhone = text(body.driverPhone, 'Driver phone', 40);
  if (has('notes')) input.notes = text(body.notes, 'Notes', 500);
  return input;
}

// Which shipment goes on a trip and how much of the truck it uses. weightKg defaults to the shipment's own weight.
function readAllocationInput(body) {
  const rawId = body?.shipmentId;
  const shipmentId = Number(String(rawId ?? '').replace(/^SHP-/i, ''));
  if (!Number.isInteger(shipmentId) || shipmentId <= 0) throw new LegInputError('shipmentId must be a shipment number such as SHP-12.');
  const input = { shipmentId };
  if (body.weightKg !== undefined && body.weightKg !== null && body.weightKg !== '') input.weightKg = positiveNumber(body.weightKg, 'weightKg', 100000);
  if (body.pallets !== undefined && body.pallets !== null && body.pallets !== '') {
    const pallets = Number(body.pallets);
    if (!Number.isInteger(pallets) || pallets < 0 || pallets > 200) throw new LegInputError('pallets must be a whole number from 0 to 200.');
    input.pallets = pallets;
  }
  for (const key of ['pickupSeq', 'dropSeq']) {
    if (body[key] === undefined || body[key] === null || body[key] === '') continue;
    const number = Number(body[key]);
    if (!Number.isInteger(number) || number < 1 || number > 100) throw new LegInputError(`${key} must be a whole number from 1 to 100.`);
    input[key] = number;
  }
  return input;
}

// Loads that could share a truck: the same lane (origin and destination, ignoring case and spacing) with pickups within
// `windowDays` of each other, packed into trucks of `capacityKg` (biggest first). A truck with one load is not a suggestion.
// loads: [{ id, customer, origin, destination, pickup, delivery, weightKg }]
function suggestPools(loads, { capacityKg = 20000, windowDays = 3 } = {}) {
  const key = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const day = (value) => {
    const time = /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? Date.parse(`${value}T00:00:00Z`) : NaN;
    return Number.isNaN(time) ? null : Math.floor(time / 86400000);
  };
  const lanes = new Map();
  for (const load of loads) {
    if (!(load.weightKg > 0) || load.weightKg > capacityKg) continue;
    const lane = `${key(load.origin)}|${key(load.destination)}`;
    if (!lanes.has(lane)) lanes.set(lane, []);
    lanes.get(lane).push(load);
  }
  const suggestions = [];
  for (const group of lanes.values()) {
    // Pickups close together share a cluster; loads without a date share one of their own.
    const dated = group.filter((load) => day(load.pickup) !== null).sort((a, b) => day(a.pickup) - day(b.pickup) || a.id - b.id);
    const clusters = [];
    for (const load of dated) {
      const last = clusters[clusters.length - 1];
      if (last && day(load.pickup) - day(last[0].pickup) <= windowDays) last.push(load);
      else clusters.push([load]);
    }
    const undated = group.filter((load) => day(load.pickup) === null);
    if (undated.length) clusters.push(undated);
    for (const cluster of clusters) {
      const trucks = [];
      for (const load of [...cluster].sort((a, b) => b.weightKg - a.weightKg || a.id - b.id)) {
        const truck = trucks.find((entry) => entry.weightKg + load.weightKg <= capacityKg + 0.0005);
        if (truck) {
          truck.loads.push(load);
          truck.weightKg = round(truck.weightKg + load.weightKg, 3);
        } else {
          trucks.push({ loads: [load], weightKg: load.weightKg });
        }
      }
      for (const truck of trucks) {
        if (truck.loads.length < 2) continue;
        const ordered = truck.loads.sort((a, b) => a.id - b.id);
        const pickups = ordered.map((load) => load.pickup).filter(Boolean).sort();
        suggestions.push({
          origin: ordered[0].origin, destination: ordered[0].destination, loads: ordered, totalWeightKg: truck.weightKg, capacityKg,
          utilization: Math.round((truck.weightKg / capacityKg) * 1000) / 1000, pickupFrom: pickups[0] || null, pickupTo: pickups[pickups.length - 1] || null
        });
      }
    }
  }
  return suggestions.sort((a, b) => b.loads.length - a.loads.length || b.utilization - a.utilization || a.loads[0].id - b.loads[0].id);
}

module.exports = {
  suggestPools,
  TRIP_STATUSES, TRIP_TRANSITIONS, EDITABLE_TRIP_STATUSES, TRACKABLE_TRIP_STATUSES, ALLOCATABLE_SHIPMENT_STATUSES,
  weightToKg, splitMoney, readTripInput, readAllocationInput, minorDigits
};
