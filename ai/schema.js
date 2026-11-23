// Strict shape checks for what a model returns. A model's answer is untrusted: before any of it is used it must be a
// JSON object with every expected key, each of the right type (or null), enum values from the allowed list and
// numbers in range. If any check fails, the whole answer is rejected and a person fills the form instead.
//
// Field types: 'string', 'numberish' (a number, or text that lib/numbers.js reads later), 'boolean',
// 'stringArray', 'number' (a real JSON number only). Options: nullable (default true), enum, maxLength, min, max, maxItems.

function checkField(name, value, rule) {
  if (value === null || value === undefined) return rule.nullable === false ? `${name} is required` : null;
  switch (rule.type) {
    case 'string':
      if (typeof value !== 'string') return `${name} must be text`;
      if (rule.maxLength && value.length > rule.maxLength) return `${name} is longer than ${rule.maxLength}`;
      if (rule.enum && !rule.enum.includes(value.trim().toLowerCase())) return `${name} must be one of ${rule.enum.join(', ')}`;
      return null;
    case 'number':
    case 'numberish':
      if (rule.type === 'number' && typeof value !== 'number') return `${name} must be a number`;
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) return `${name} must be a finite number`;
        if (rule.min !== undefined && value < rule.min) return `${name} is below ${rule.min}`;
        if (rule.max !== undefined && value > rule.max) return `${name} is above ${rule.max}`;
        return null;
      }
      if (typeof value === 'string' && value.length <= 40) return null;
      return `${name} must be a number`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${name} must be true, false or null`;
    case 'stringArray':
      if (!Array.isArray(value)) return `${name} must be a list`;
      if (rule.maxItems && value.length > rule.maxItems) return `${name} has more than ${rule.maxItems} items`;
      return value.every((item) => typeof item === 'string') ? null : `${name} must be a list of text`;
    default:
      return `${name} has an unknown rule`;
  }
}

// Returns { ok: true } or { ok: false, errors: [...] }. Extra keys are ignored; missing keys are errors.
function validateShape(raw, schema) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['the answer is not a JSON object'] };
  const errors = [];
  for (const [name, rule] of Object.entries(schema)) {
    if (!Object.prototype.hasOwnProperty.call(raw, name)) {
      errors.push(`${name} is missing`);
      continue;
    }
    const problem = checkField(name, raw[name], rule);
    if (problem) errors.push(problem);
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

const text = (maxLength = 300) => ({ type: 'string', maxLength });
const WEIGHT_UNITS = ['kg', 'kgs', 'lb', 'lbs', 't', 'ton', 'tons', 'tonne', 'tonnes'];

const FLOW_SCHEMA = {
  customer: text(200), customerPhone: text(60), reference: text(120), origin: text(300), destination: text(300),
  pickup: text(40), delivery: text(40), weight: { type: 'numberish' }, weightUnit: { type: 'string', enum: WEIGHT_UNITS },
  equipment: text(80), customerRate: { type: 'numberish' }, customerRateCurrency: text(10),
  questions: { type: 'stringArray', maxItems: 20, nullable: false }, confidence: { type: 'number', min: 0, max: 1, nullable: false }
};

const CMR_SCHEMA = {
  consignor: text(), consignee: text(), carrier: text(), placeOfLoading: text(), placeOfDelivery: text(), date: text(40),
  truckPlate: text(60), grossWeight: { type: 'numberish' }, weightUnit: { type: 'string', enum: WEIGHT_UNITS },
  packages: { type: 'numberish' }, goods: text(), signedByConsignee: { type: 'boolean' }, notes: text(600)
};

const TRANSPORT_SCHEMA = {
  documentNumber: text(80), shipper: text(), consignee: text(), carrier: text(), vessel: text(), voyage: text(80),
  flightNumber: text(40), trainNo: text(80), from: text(), to: text(), date: text(40),
  containerNumbers: { type: 'stringArray', maxItems: 50, nullable: false }, wagonNumbers: { type: 'stringArray', maxItems: 50, nullable: false },
  pieces: { type: 'numberish' }, grossWeight: { type: 'numberish' }, weightUnit: { type: 'string', enum: WEIGHT_UNITS },
  goods: text(), notes: text(600)
};

module.exports = { validateShape, FLOW_SCHEMA, CMR_SCHEMA, TRANSPORT_SCHEMA, WEIGHT_UNITS };
