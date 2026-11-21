/* =========================================================
   Money. Amounts are kept to the minor unit of their ISO 4217 currency and added without float drift.
   - roundMoney(value, currency): exact decimal rounding (half away from zero) to the currency's minor unit.
   - addMoney(currency, ...values): sums in whole minor units.
   Storage: PostgreSQL NUMERIC(18,4); SQLite REAL rounded here at write time and ROUND()ed in totals.
   ========================================================= */

// Currencies whose minor unit is not 2 decimals.
const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

function normalizeCurrency(code, fallback = null) {
  const value = String(code ?? '').trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(value)) return value;
  if (fallback !== null) return fallback;
  throw new Error('A currency is an ISO 4217 code such as USD, EUR or UZS.');
}

function minorDigits(currency) {
  const code = normalizeCurrency(currency, 'USD');
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

// Decimal text of a number without exponent notation ("1e-7" -> "0.0000001"), using 15 significant digits
// so that 0.1 + 0.2 (0.30000000000000004) reads as 0.3.
function decimalText(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('An amount must be a finite number.');
  const text = Number(number.toPrecision(15)).toString();
  if (!/e/i.test(text)) return text;
  const [mantissa, exponent] = text.toLowerCase().split('e');
  const negative = mantissa.startsWith('-');
  const [whole, fraction = ''] = mantissa.replace('-', '').split('.');
  const digits = whole + fraction;
  const point = whole.length + Number(exponent);
  const body = point <= 0 ? `0.${'0'.repeat(-point)}${digits}` : point >= digits.length ? digits + '0'.repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return (negative ? '-' : '') + body;
}

// Whole minor units for an amount (BigInt), rounding half away from zero.
function toMinor(value, currency) {
  const digits = minorDigits(currency);
  const text = decimalText(value);
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace('-', '').split('.');
  const padded = (fraction + '0'.repeat(digits + 1)).slice(0, digits + 1);
  let minor = BigInt(whole + padded.slice(0, digits));
  if (Number(padded[digits]) >= 5) minor += 1n;
  return negative ? -minor : minor;
}

function fromMinor(minor, currency) {
  const digits = minorDigits(currency);
  const negative = minor < 0n;
  const text = (negative ? -minor : minor).toString().padStart(digits + 1, '0');
  const body = digits ? `${text.slice(0, -digits)}.${text.slice(-digits)}` : text;
  return Number((negative ? '-' : '') + body);
}

// Rounds to a number of decimals (half away from zero) without float drift; for input that has no currency yet.
function roundTo(value, digits) {
  const text = decimalText(value);
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace('-', '').split('.');
  const padded = (fraction + '0'.repeat(digits + 1)).slice(0, digits + 1);
  let scaled = BigInt(whole + padded.slice(0, digits));
  if (Number(padded[digits]) >= 5) scaled += 1n;
  const result = digits ? `${(scaled / 10n ** BigInt(digits)).toString()}.${(scaled % 10n ** BigInt(digits)).toString().padStart(digits, '0')}` : scaled.toString();
  return Number((negative ? '-' : '') + result);
}

function roundMoney(value, currency) {
  if (value === null || value === undefined) return value;
  return fromMinor(toMinor(value, currency), currency);
}

function addMoney(currency, ...values) {
  return fromMinor(values.reduce((sum, value) => sum + toMinor(value ?? 0, currency), 0n), currency);
}

module.exports = { normalizeCurrency, minorDigits, roundTo, roundMoney, addMoney, toMinor, fromMinor };
