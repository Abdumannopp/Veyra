// Ocean, air and rail details: the identifiers people type, checked the way the industry checks them.
// Pure rules, no database. All entered by people; nothing here talks to a shipping line, airline or railway.
//
//   Container number  ISO 6346: owner code (3 letters) + category (U, J or Z) + 6 digits + check digit.
//   Air waybill       IATA: airline prefix (3 digits) + 7-digit serial + check digit (serial mod 7).
//   Wagon number      UIC 12 digits or 1520-gauge 8 digits, last digit a Luhn-style check digit.
//   Chargeable weight IATA: the larger of the gross weight and the volume weight (1 m³ = 166.67 kg,
//                     i.e. cm³ / 6000), rounded up to the next half kilogram.

class DetailError extends Error {}

const CONTAINER_TYPES = ['20GP', '40GP', '40HC', '45HC', '20RF', '40RF', '40HR', '20OT', '40OT', '20FR', '40FR', '20TK'];
const CONSIGNMENT_NOTES = ['CIM', 'SMGS', 'CIM/SMGS'];

const compact = (value) => String(value).replace(/[\s-]/g, '').toUpperCase();

function containerCheckDigit(first10) {
  // Letters map to 10..38, skipping multiples of 11.
  const letterValue = (char) => {
    let value = 10;
    for (let code = 65; code < char.charCodeAt(0); code += 1) {
      value += 1;
      if (value % 11 === 0) value += 1;
    }
    return value;
  };
  let sum = 0;
  for (let i = 0; i < 10; i += 1) {
    const char = first10[i];
    const value = /\d/.test(char) ? Number(char) : letterValue(char);
    sum += value * 2 ** i;
  }
  return (sum % 11) % 10;
}

function readContainerNo(value) {
  const number = compact(value);
  if (!/^[A-Z]{3}[UJZ]\d{7}$/.test(number)) {
    throw new DetailError('Container no. must be 4 letters (the 4th U, J or Z) and 7 digits, e.g. MSCU1234565.');
  }
  if (containerCheckDigit(number.slice(0, 10)) !== Number(number[10])) {
    throw new DetailError(`Container no. ${number} has a wrong check digit (ISO 6346). Check the number on the container or the B/L.`);
  }
  return number;
}

function readAirWaybill(value) {
  const number = compact(value);
  if (!/^\d{11}$/.test(number)) throw new DetailError('Air waybill must be 11 digits: airline prefix and serial, e.g. 176-12345675.');
  const serial = number.slice(3, 10);
  if (Number(serial) % 7 !== Number(number[10])) {
    throw new DetailError(`Air waybill ${number.slice(0, 3)}-${number.slice(3)} has a wrong check digit. Check the AWB.`);
  }
  return `${number.slice(0, 3)}-${number.slice(3)}`;
}

function luhnStyleCheck(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    const product = Number(digits[i]) * (i % 2 === 0 ? 2 : 1);
    sum += Math.floor(product / 10) + (product % 10);
  }
  return (10 - (sum % 10)) % 10;
}

function readWagonNo(value) {
  const number = compact(value);
  if (!/^(\d{8}|\d{12})$/.test(number)) throw new DetailError('Wagon no. must be 8 digits (1520 gauge) or 12 digits (UIC).');
  if (luhnStyleCheck(number.slice(0, -1)) !== Number(number.slice(-1))) {
    throw new DetailError(`Wagon no. ${number} has a wrong check digit. Check the number on the wagon or the waybill.`);
  }
  return number;
}

function readFlightNumber(value) {
  const number = compact(value);
  if (!/^[A-Z0-9]{2}[A-Z]?\d{1,4}[A-Z]?$/.test(number)) throw new DetailError('Flight must be an airline code and a number, e.g. TK 1234.');
  return number;
}

function readAirport(label) {
  return (value) => {
    const code = compact(value);
    if (!/^[A-Z]{3}$/.test(code)) throw new DetailError(`${label} must be a 3-letter IATA airport code, e.g. TAS.`);
    return code;
  };
}

function oneOf(label, list) {
  return (value) => {
    const choice = compact(value);
    const found = list.find((item) => compact(item) === choice);
    if (!found) throw new DetailError(`${label} must be one of: ${list.join(', ')}.`);
    return found;
  };
}

function positive(label, { max, integer = false }) {
  return (value) => {
    const number = Number(String(value).replace(',', '.'));
    if (!Number.isFinite(number) || number <= 0 || number > max || (integer && !Number.isInteger(number))) {
      throw new DetailError(`${label} must be ${integer ? 'a whole number' : 'a number'} above 0 and at most ${max}.`);
    }
    return integer ? number : Math.round(number * 1000) / 1000;
  };
}

// Keys with a special rule; every other key is free text.
const RULES = {
  OCEAN: { containerNo: readContainerNo, containerType: oneOf('Container type', CONTAINER_TYPES) },
  AIR: {
    airWaybill: readAirWaybill,
    flightNumber: readFlightNumber,
    airportFrom: readAirport('Airport from'),
    airportTo: readAirport('Airport to'),
    pieces: positive('Pieces', { max: 100000, integer: true }),
    grossWeightKg: positive('Gross weight (kg)', { max: 200000 }),
    volumeM3: positive('Volume (m³)', { max: 1000 })
  },
  RAIL: {
    wagonNo: readWagonNo,
    consignmentNoteType: oneOf('Consignment note', CONSIGNMENT_NOTES)
  }
};

function chargeableWeightKg({ grossWeightKg, volumeM3 }) {
  if (!grossWeightKg && !volumeM3) return null;
  const volumeWeight = volumeM3 ? (volumeM3 * 1000000) / 6000 : 0;
  const weight = Math.max(grossWeightKg || 0, volumeWeight);
  return Math.ceil(weight * 2 - 1e-9) / 2;
}

// Applies the rule for one key (or returns null when the key has none).
function ruleFor(mode, key) {
  return RULES[mode]?.[key] || null;
}

// Values worked out from what was entered (not typed by people).
function derive(mode, details) {
  if (mode !== 'AIR') return details;
  const chargeable = chargeableWeightKg(details);
  const result = { ...details };
  delete result.chargeableWeightKg;
  if (chargeable) result.chargeableWeightKg = chargeable;
  return result;
}

module.exports = {
  CONSIGNMENT_NOTES, CONTAINER_TYPES, DetailError,
  chargeableWeightKg, containerCheckDigit, derive, readAirWaybill, readContainerNo, readWagonNo, ruleFor
};
