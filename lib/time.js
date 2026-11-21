/* =========================================================
   Time. Everything is STORED in UTC ("YYYY-MM-DD HH:MM:SS", the database clock). A company chooses a
   time zone (IANA name such as "Asia/Tashkent") and a locale (such as "de-DE") only for how people SEE
   dates, numbers and "what is today" - never for what is saved.
   ========================================================= */

const DEFAULT_TIMEZONE = 'UTC';
const DEFAULT_LOCALE = 'en-US';

// Zones offered in Settings. Any valid IANA name is accepted by the API; these cover the main trading regions.
const TIMEZONES = [
  'UTC', 'Europe/London', 'Europe/Dublin', 'Europe/Lisbon', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Rome', 'Europe/Amsterdam',
  'Europe/Warsaw', 'Europe/Prague', 'Europe/Bucharest', 'Europe/Athens', 'Europe/Kyiv', 'Europe/Istanbul', 'Europe/Moscow', 'Europe/Minsk',
  'Asia/Tbilisi', 'Asia/Baku', 'Asia/Yerevan', 'Asia/Dubai', 'Asia/Riyadh', 'Asia/Tehran', 'Asia/Tashkent', 'Asia/Samarkand', 'Asia/Almaty',
  'Asia/Bishkek', 'Asia/Dushanbe', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Shanghai',
  'Asia/Hong_Kong', 'Asia/Seoul', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland', 'Africa/Cairo', 'Africa/Lagos', 'Africa/Nairobi',
  'Africa/Johannesburg', 'America/St_Johns', 'America/Halifax', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix',
  'America/Los_Angeles', 'America/Anchorage', 'America/Mexico_City', 'America/Bogota', 'America/Sao_Paulo', 'America/Argentina/Buenos_Aires'
];

const LOCALES = ['en-US', 'en-GB', 'en-AU', 'en-CA', 'de-DE', 'fr-FR', 'es-ES', 'it-IT', 'nl-NL', 'pl-PL', 'pt-BR', 'tr-TR', 'ru-RU', 'uk-UA', 'uz-UZ', 'kk-KZ', 'ar-AE', 'zh-CN', 'ja-JP', 'ko-KR'];

function isValidTimeZone(zone) {
  if (typeof zone !== 'string' || !zone || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch (_) {
    return false;
  }
}

function isValidLocale(locale) {
  return typeof locale === 'string' && LOCALES.includes(locale);
}

const timeZoneOr = (zone, fallback = DEFAULT_TIMEZONE) => (isValidTimeZone(zone) ? zone : fallback);
const localeOr = (locale, fallback = DEFAULT_LOCALE) => (isValidLocale(locale) ? locale : fallback);

function pad(number, width = 2) {
  return String(number).padStart(width, '0');
}

// The database's UTC text for an instant.
function utcText(date = new Date()) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

// A stored UTC text ("YYYY-MM-DD HH:MM:SS" or ISO) as an instant.
function parseUtc(value) {
  if (value instanceof Date) return value;
  const text = String(value ?? '').trim();
  if (!text) return new Date(NaN);
  return new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? text.replace(' ', 'T') : `${text.replace(' ', 'T')}Z`);
}

function zoneParts(instant, timeZone) {
  const parts = {};
  for (const part of new Intl.DateTimeFormat('en-CA', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(instant)) parts[part.type] = part.value;
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour, minute: +parts.minute, second: +parts.second };
}

// "YYYY-MM-DD" of an instant in a company's time zone (what that company calls today).
function localDate(timeZone, instant = new Date()) {
  const p = zoneParts(parseUtc(instant), timeZoneOr(timeZone));
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

// How far the zone is ahead of UTC at an instant, in milliseconds.
function offsetMs(timeZone, instant) {
  const p = zoneParts(instant, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instant.getTime() / 1000) * 1000;
}

// The UTC instant at which a local calendar day ("YYYY-MM-DD") begins in the zone.
function localDayStart(timeZone, day) {
  const zone = timeZoneOr(timeZone);
  const [year, month, date] = day.split('-').map(Number);
  const wall = Date.UTC(year, month - 1, date);
  let guess = new Date(wall - offsetMs(zone, new Date(wall)));
  guess = new Date(wall - offsetMs(zone, guess)); // second pass settles days where the clock changes
  return guess;
}

// Adds whole days to a "YYYY-MM-DD" calendar day.
function addDays(day, days) {
  const [year, month, date] = day.split('-').map(Number);
  const moved = new Date(Date.UTC(year, month - 1, date + days));
  return `${pad(moved.getUTCFullYear(), 4)}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}`;
}

// A stored UTC time shown for people: in the company's zone and locale. Returns the input text if it is not a time.
function formatDateTime(value, { timeZone = DEFAULT_TIMEZONE, locale = DEFAULT_LOCALE, dateOnly = false } = {}) {
  const instant = parseUtc(value);
  if (Number.isNaN(instant.getTime())) return String(value ?? '');
  const options = dateOnly ? { dateStyle: 'medium' } : { dateStyle: 'medium', timeStyle: 'short' };
  return new Intl.DateTimeFormat(localeOr(locale), { ...options, timeZone: timeZoneOr(timeZone) }).format(instant);
}

module.exports = {
  DEFAULT_TIMEZONE, DEFAULT_LOCALE, TIMEZONES, LOCALES,
  isValidTimeZone, isValidLocale, timeZoneOr, localeOr,
  utcText, parseUtc, localDate, localDayStart, addDays, formatDateTime
};
