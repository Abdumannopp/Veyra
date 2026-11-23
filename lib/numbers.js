// Reading numbers written by people in different countries (and repeated by an AI model): "18,5", "1 250,75",
// "1,250.75". The old code removed every comma, so "18,5" became 185 — ten times the real weight.
//
// Rules (the result says which applied):
// - A JSON number is used as it is.
// - Spaces (also non-breaking and thin spaces) and apostrophes are thousands separators: "1 250,75" -> 1250.75.
// - With both "," and ".", the LAST one is the decimal separator and the other must group by three:
//   "1,250.75" -> 1250.75, "1.250,75" -> 1250.75.
// - With only one kind of separator used several times, it groups thousands: "1,250,000" -> 1250000.
// - One separator followed by 1, 2 or 4+ digits is a decimal separator: "18,5" -> 18.5, "2.5" -> 2.5.
// - One separator followed by exactly 3 digits ("1,250", "18.500") can mean a thousand or a decimal; it is
//   AMBIGUOUS and is never guessed: the caller must leave the field for a person. ("0,250" is a decimal.)
// - Anything else (letters, two decimal points, negative numbers, empty) is invalid.

const THOUSANDS_GAPS = /[\s   ']/g;

function parseLocaleNumber(input) {
  if (typeof input === 'number') {
    return Number.isFinite(input) ? { ok: true, value: input } : { ok: false, reason: 'not a finite number' };
  }
  if (typeof input !== 'string') return { ok: false, reason: 'not a number' };
  const raw = input.trim().replace(THOUSANDS_GAPS, '');
  if (!raw) return { ok: false, reason: 'empty' };
  if (!/^\d[\d.,]*$/.test(raw) || /[.,]$/.test(raw)) return { ok: false, reason: 'not a plain positive number' };

  const commas = (raw.match(/,/g) || []).length;
  const dots = (raw.match(/\./g) || []).length;
  const grouped = (text, separator) => new RegExp(`^\\d{1,3}(\\${separator}\\d{3})+$`).test(text);

  if (commas && dots) {
    const decimal = raw.lastIndexOf(',') > raw.lastIndexOf('.') ? ',' : '.';
    const thousands = decimal === ',' ? '.' : ',';
    const [whole, fraction] = [raw.slice(0, raw.lastIndexOf(decimal)), raw.slice(raw.lastIndexOf(decimal) + 1)];
    if (raw.split(decimal).length !== 2 || !grouped(whole, thousands) || !/^\d+$/.test(fraction)) {
      return { ok: false, reason: 'separators do not match a number format' };
    }
    return { ok: true, value: Number(`${whole.split(thousands).join('')}.${fraction}`) };
  }

  const separator = commas ? ',' : dots ? '.' : null;
  if (!separator) return { ok: true, value: Number(raw) };
  const count = commas || dots;
  if (count > 1) {
    if (!grouped(raw, separator)) return { ok: false, reason: 'separators do not group by three' };
    return { ok: true, value: Number(raw.split(separator).join('')) };
  }
  const [whole, fraction] = raw.split(separator);
  if (fraction.length === 3 && whole !== '0') {
    return { ok: false, ambiguous: true, reason: `"${input.trim()}" can mean ${Number(whole + fraction)} or ${Number(`${whole}.${fraction}`)}` };
  }
  return { ok: true, value: Number(`${whole}.${fraction}`) };
}

// A positive amount within a bound, or why not. `ambiguous` results are passed through so the caller can say
// "check by hand" instead of "wrong".
function parsePositiveAmount(input, { max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = parseLocaleNumber(input);
  if (!parsed.ok) return parsed;
  if (!(parsed.value > 0)) return { ok: false, reason: 'must be above 0' };
  if (parsed.value > max) return { ok: false, reason: `must be at most ${max}` };
  return parsed;
}

module.exports = { parseLocaleNumber, parsePositiveAmount };
