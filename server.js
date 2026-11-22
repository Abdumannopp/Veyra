require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  httpError,
  readPositiveInteger,
  parsePositiveNumber,
  parseMoney: parseMoneyUpTo,
  parseIsoDate,
  parseShipmentId,
  normalizePlate,
  readOptionalText,
  readOptionalPhone,
  parseEta
} = require('./lib/validation');
const fs = require('fs');
const {
  DB_PATH,
  getUserPasswordHash,
  setUserPassword,
  recordAudit,
  listAudit,
  backupTo,
  updateShipmentDetails,
  setShipmentPayment,
  getFinanceSummary,
  setShipmentShareTokenHash,
  findSharedShipment,
  BCRYPT_COST,
  DEFAULT_TENANT_ID,
  ALLOWED_ROLES,
  CARRIER_MODES,
  CARRIER_MANUAL_STATUSES,
  initialize,
  getTenant,
  listTenants,
  createTenantWithAdmin,
  setTenantGpsTokenHash,
  findTenantByGpsTokenHash,
  setTenantInboxTokenHash,
  findTenantByInboxTokenHash,
  setTenantInboxAllowedSenders,
  setTenantMessagingSettings,
  setTenantImapSettings,
  setTenantImapState,
  setTenantAutomationSettings,
  getCommandCenterStats,
  listTenantIdsWithImap,
  createInboxItem,
  addInboxAttachment,
  getInboxAttachmentFile,
  deleteInboxAttachments,
  setDocumentType,
  listMarketRates,
  createQuote,
  getQuote,
  listQuotes,
  updateQuote,
  convertQuote,
  getLanePriceData,
  listBorderWaits,
  upsertBorderWait,
  deleteBorderWait,
  getBorderWait,
  upsertMarketRate,
  deleteMarketRate,
  moveInboxAttachmentsToShipment,
  findShipmentIdsByReference,
  findMessageByCallbackTokenHash,
  recordMessageDelivery,
  getRouteData,
  getPulseData,
  listSentinelLoads,
  listTrackingOverview,
  countShipmentsThisMonth,
  setTenantRegion,
  exportTenantData,
  findTenantByPaddleSubscription,
  applyPaddleSubscription,
  countActiveUsers,
  updateTenantPlan,
  listWorkflows,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  setWorkflowEnabled,
  deleteWorkflow,
  listWorkflowRuns,
  getWorkflowStats,
  getInboxItem,
  listInboxItems,
  countInboxItemsToday,
  updateInboxItem,
  listTasks,
  getTask,
  resolveTask,
  resolveTasksByKey,
  addDocument,
  getDocument,
  listDocuments,
  getDocumentFile,
  updateDocumentExtraction,
  deleteDocument,
  findUserByEmail,
  findUserById,
  updateUser,
  createUser,
  listUsers,
  createAuthSession,
  isAuthSessionActive,
  revokeAuthSession,
  getRateLimitStatus,
  consumeRateLimit,
  recordRateLimitAttempts,
  clearRateLimitAttempts,
  listShipments,
  searchShipments,
  getShipment,
  updateShipmentStatus,
  createShipment,
  dispatchShipment,
  addTrackingUpdate,
  recordGpsPositions,
  listTrackingUpdates,
  listShipmentEvents,
  createMessage,
  listMessages,
  recordAgentTask,
  getAgentUsage,
  listCarriersWithStats,
  getScoutData,
  createCarrier,
  updateCarrierStatus,
  getAnalyticsReport,
  getDashboardPayload,
  getAlerts,
  listJobs,
  jobStats,
  retryJob,
  getShipmentLegs,
  getLeg,
  createShipmentWithLegs,
  addLeg,
  updateLeg,
  setLegStatus,
  addLegTracking,
  setDocumentLeg,
  listLegDocuments
} = require('./database');
const aiGateway = require('./ai/gateway');
const flowAgent = require('./agents/flow');
const scoutAgent = require('./agents/scout');
const relayAgent = require('./agents/relay');
const vaultAgent = require('./agents/vault');
const routeAgent = require('./agents/route');
const pulseAgent = require('./agents/pulse');
const sentinelAgent = require('./agents/sentinel');
const studio = require('./agents/studio');
const { isPostgres: databaseIsPostgres } = require('./database');
const { runAsSystem, runAsTenant } = require('./lib/tenant-context');
const { addMoney } = require('./lib/money');
const timeLib = require('./lib/time');
const legsLib = require('./lib/legs');
const jobQueue = require('./lib/job-queue');
const plans = require('./lib/plans');
const paddle = require('./integrations/paddle');
const legal = require('./lib/legal');
const nexus = require('./agents/nexus');
const { parseInbound, senderAllowed, mentionedShipmentIds, guessDocumentType, stripHtml } = require('./lib/inbound-email');
const messaging = require('./integrations/messaging');
const geo = require('./integrations/geo');
const traffic = require('./integrations/traffic');
const imap = require('./integrations/imap');
const mailapi = require('./integrations/mailapi');
const { parseEmail } = require('./lib/mime');

const REGISTRATION_INVITE_CODE = process.env.REGISTRATION_INVITE_CODE || '';
const MAX_LEN = {
  carrierName: 120, name: 120, email: 254, customer: 120, reference: 80, origin: 160, destination: 160, trackingNumber: 80, note: 500,
  phone: 40, contactName: 120, driverName: 120, driverPhone: 40, truckPlate: 20, location: 160, companyName: 120, message: 1000
};
// bcrypt only uses the first 72 bytes of a password; longer input would be silently cut.
const MAX_PASSWORD_BYTES = 72;

// Same hash cost as real accounts, so a login for an unknown email takes as long as a real one.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), BCRYPT_COST);

const ROLE_PERMISSIONS = {
  admin: ['*'],
  operations: ['shipments:finance', 'analytics:read', 'dashboard:read', 'carriers:read', 'carriers:write', 'shipments:read', 'shipments:create', 'shipments:status', 'shipments:dispatch', 'shipments:track', 'shipments:message', 'shipments:document', 'users:read'],
  // Dispatchers log where the truck is ("check calls") and message drivers, but cannot book or change status.
  operator: ['dashboard:read', 'carriers:read', 'shipments:read', 'shipments:create', 'shipments:track', 'shipments:message', 'shipments:document']
};

const app = express();
// Production is the default; development must be requested explicitly (NODE_ENV=development).
const isProduction = process.env.NODE_ENV !== 'development';
const PORT = process.env.PORT || 3000;
// Development mode has demo accounts with published passwords, so by default it only listens on this machine.
const HOST = process.env.HOST || (isProduction ? '0.0.0.0' : '127.0.0.1');
// Where "Start free trial" and "Contact sales" on the pricing page send people.
const SALES_EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(process.env.SALES_EMAIL || '')) ? process.env.SALES_EMAIL : null;
const JWT_SECRET = process.env.JWT_SECRET || (isProduction ? null : 'veyra-dev-secret');

// Region settings: one product, configured per deployment (kg or lb, local currency).
const WEIGHT_UNIT = ['kg', 'lb'].includes(String(process.env.WEIGHT_UNIT).toLowerCase()) ? String(process.env.WEIGHT_UNIT).toLowerCase() : 'kg';
const CURRENCY = /^[A-Z]{3}$/.test(String(process.env.CURRENCY || '')) ? process.env.CURRENCY : 'USD';
const EQUIPMENT = ['Dry Van', 'Tent / Curtainsider', 'Reefer', 'Flatbed', 'LTL', 'Expedited'];
const MAX_WEIGHT = 1000000;
// Sanity bound for money fields. Raise MAX_RATE for currencies with large numbers (e.g. UZS).
const MAX_RATE = readPositiveInteger(process.env.MAX_RATE, 10000000);
// A booked truck nobody has checked on for this long is flagged.
const STALE_TRACKING_HOURS = readPositiveInteger(process.env.STALE_TRACKING_HOURS, 12);
const GPS_MIN_INTERVAL_MINUTES = readPositiveInteger(process.env.GPS_MIN_INTERVAL_MINUTES, 15);
const GPS_WEBHOOK_PATH = '/api/integrations/gps';
const INBOX_WEBHOOK_PREFIX = '/api/integrations/inbox/';
const INBOX_DAILY_LIMIT = readPositiveInteger(process.env.INBOX_DAILY_LIMIT, 200);
// Automatic AI work (reading emails and documents) stops at this many AI calls per company per day.
const AI_DAILY_LIMIT_PER_TENANT = readPositiveInteger(process.env.AI_DAILY_LIMIT_PER_TENANT, 300);
const DOC_MAX_BYTES = readPositiveInteger(process.env.DOC_MAX_MB, 8) * 1024 * 1024;
const DOC_MAX_PER_SHIPMENT = readPositiveInteger(process.env.DOC_MAX_PER_SHIPMENT, 20);
const DOC_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
// Emails with files: the whole email may be this large, and at most this many files are kept.
const INBOX_MAX_BYTES = readPositiveInteger(process.env.INBOX_MAX_MB, 15) * 1024 * 1024;
const INBOX_MAX_ATTACHMENTS = readPositiveInteger(process.env.INBOX_MAX_ATTACHMENTS, 5);
// Small pictures in an email are almost always signature logos, not documents.
const INBOX_MIN_IMAGE_BYTES = 10 * 1024;
const TWILIO_STATUS_PREFIX = '/api/integrations/twilio/status/';
const PADDLE_WEBHOOK_PATH = '/api/integrations/paddle/webhook';
// The public https address of this server. Twilio reports "delivered / read / failed" to it.
// Render and Railway tell the app its address; elsewhere set PUBLIC_URL. Without it, delivery reports are off.
const PUBLIC_URL = (() => {
  const raw = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL
    || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.origin : null;
  } catch (_) {
    return null;
  }
})();
// Open self-sign-up is a demo convenience. In production nobody can create an account
// unless an invite code is configured or open registration is switched on explicitly.
const REGISTRATION_MODE = REGISTRATION_INVITE_CODE
  ? 'invite'
  : (!isProduction || process.env.ALLOW_OPEN_REGISTRATION === 'true' ? 'open' : 'closed');
// A new company can sign itself up from the pricing page, choose a plan and pay by card.
// On by default once card payment (Paddle) is set up; COMPANY_SIGNUP=true / false overrides.
const companySignupOpen = () => (process.env.COMPANY_SIGNUP === 'true' ? true : process.env.COMPANY_SIGNUP === 'false' ? false : paddle.enabled());
const SESSION_COOKIE = 'veyraSession';
const SESSION_DURATION_SECONDS = 8 * 60 * 60;
const AUTH_RATE_LIMIT_CONFIG = {
  normalApi: {
    windowMs: readPositiveInteger(process.env.API_RATE_LIMIT_WINDOW_MS, 60 * 1000),
    max: readPositiveInteger(process.env.API_RATE_LIMIT_MAX, 120)
  },
  register: {
    windowMs: readPositiveInteger(process.env.REGISTER_RATE_LIMIT_WINDOW_MS, 60 * 60 * 1000),
    max: readPositiveInteger(process.env.REGISTER_RATE_LIMIT_MAX, 5),
    message: 'Too many registration attempts from this IP. Please try again later.'
  },
  login: {
    windowMs: readPositiveInteger(process.env.LOGIN_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    max: readPositiveInteger(process.env.LOGIN_RATE_LIMIT_MAX, 8),
    ipMax: readPositiveInteger(process.env.LOGIN_RATE_LIMIT_IP_MAX, 30),
    // Failures for one account from ALL addresses together; stops password guessing spread over many IPs.
    accountMax: readPositiveInteger(process.env.LOGIN_RATE_LIMIT_ACCOUNT_MAX, 30),
    message: 'Too many login attempts. Please try again in 15 minutes.',
    logThreshold: readPositiveInteger(process.env.LOGIN_FAILURE_LOG_THRESHOLD, 4)
  }
};
const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: isProduction,
  sameSite: 'lax',
  path: '/',
  maxAge: SESSION_DURATION_SECONDS * 1000
};

if (isProduction && !process.env.JWT_SECRET) {
  console.error('JWT_SECRET is required in production. Set it in your environment or .env file.');
  process.exit(1);
}
// A short secret can be guessed, and with it anyone could sign in as anyone. Warn loudly; do not stop a running business.
if (isProduction && String(process.env.JWT_SECRET).length < 32) {
  console.warn('WARNING: JWT_SECRET is shorter than 32 characters. Generate a long one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
}

const parseMoney = (value) => parseMoneyUpTo(value, MAX_RATE);

nexus.configure({
  flow: { weightUnit: WEIGHT_UNIT, currency: CURRENCY, equipment: EQUIPMENT, maxRate: MAX_RATE, maxWeight: MAX_WEIGHT },
  staleHours: STALE_TRACKING_HOURS,
  aiDailyLimit: AI_DAILY_LIMIT_PER_TENANT,
  formatMoney: (value) => {
    try {
      return Number(value).toLocaleString('en-US', { style: 'currency', currency: CURRENCY, maximumFractionDigits: 2 });
    } catch (_) {
      return `${Number(value).toFixed(2)} ${CURRENCY}`;
    }
  }
});

// Database work starts as server work (login lookups, webhooks, public tracking); authMiddleware narrows it to
// the signed-in company, so PostgreSQL row level security fences every authenticated request.
app.use((req, res, next) => runAsSystem(next));
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Paddle's checkout (only when it is configured) runs in a frame from Paddle and may open a PayPal window.
  const paddleOn = paddle.enabled();
  const paddleFrames = 'https://buy.paddle.com https://sandbox-buy.paddle.com';
  res.setHeader('Permissions-Policy', `camera=(), microphone=(), geolocation=(), payment=(${paddleOn ? `self "https://buy.paddle.com" "https://sandbox-buy.paddle.com"` : ''})`);
  res.setHeader('Cross-Origin-Opener-Policy', paddleOn ? 'same-origin-allow-popups' : 'same-origin');
  // Defence in depth against XSS: only same-origin scripts, no inline <script>, no framing.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    `script-src 'self'${paddleOn ? ' https://cdn.paddle.com' : ''}`,
    `style-src 'self' https://fonts.googleapis.com${paddleOn ? ' https://cdn.paddle.com' : ''}`,
    "style-src-attr 'unsafe-inline'",
    "font-src 'self' https://fonts.gstatic.com",
    `img-src 'self' data:${paddleOn ? ' https://cdn.paddle.com' : ''}`,
    `connect-src 'self'${paddleOn ? ' https://*.paddle.com' : ''}`,
    `frame-src ${paddleOn ? paddleFrames : "'none'"}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; '));
  if (isProduction) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
app.use(cors({
  origin: isProduction ? process.env.ALLOWED_ORIGIN || false : true,
  credentials: true
}));
// GPS providers send batches of positions, so their endpoint accepts larger bodies.
const smallJson = express.json({ limit: '50kb' });
const gpsJson = express.json({ limit: '1mb' });
// Email providers post JSON, a form, or a multipart form with files. These bodies can be large, so they are
// read only inside the inbox route, after the address was checked (see parseInboxBody).
const inboxMultipart = express.raw({ limit: INBOX_MAX_BYTES, type: (req) => /^multipart\/form-data/i.test(String(req.headers['content-type'] || '')) });
const inboxJson = express.json({ limit: INBOX_MAX_BYTES });
const inboxForm = express.urlencoded({ extended: false, limit: '1mb' });
const parseInboxBody = (req, res, next) => inboxMultipart(req, res, (multipartError) => (multipartError ? next(multipartError)
  : inboxJson(req, res, (jsonError) => (jsonError ? next(jsonError) : inboxForm(req, res, next)))));
app.use((req, res, next) => {
  if (req.path === GPS_WEBHOOK_PATH) return gpsJson(req, res, next);
  if (req.path.startsWith(INBOX_WEBHOOK_PREFIX) || req.path.startsWith(TWILIO_STATUS_PREFIX) || req.path === PADDLE_WEBHOOK_PATH) return next();
  return smallJson(req, res, next);
});
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

function readPaging(req) {
  const limit = Math.min(readPositiveInteger(req.query.limit, 100), 200);
  const page = readPositiveInteger(req.query.page, 1);
  return { limit, offset: (page - 1) * limit, page };
}

const SHIPMENT_STATUSES = ['New', 'Sourcing', 'Pending Approval', 'Dispatched', 'In Transit', 'Exception', 'Delivered', 'Cancelled'];

function passwordTooLong(password) {
  return Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES;
}

function validateNewPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || passwordTooLong(password) || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return `Password must be at least 8 characters (at most ${MAX_PASSWORD_BYTES} bytes) and include a letter and a number.`;
  }
  return null;
}

function validateNameAndEmail(name, email) {
  if (typeof name !== 'string' || typeof email !== 'string' || !name.trim() || !email.trim()) {
    return 'Name and email are required.';
  }
  if (name.length > MAX_LEN.name || email.length > MAX_LEN.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return 'Name or email is invalid.';
  }
  return null;
}

function formatMoney(value, currency = CURRENCY) {
  try {
    return Number(value).toLocaleString('en-US', { style: 'currency', currency, maximumFractionDigits: 2 });
  } catch (_) {
    return `${Number(value).toFixed(2)} ${currency}`;
  }
}
const moneyIn = (currency) => (value) => formatMoney(value, currency);

/* ---------- region: each company picks its currency and weight unit ---------- */
// Common trading currencies; any other valid ISO code can be set by the server default.
const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'PLN', 'CZK', 'RON', 'TRY', 'AED', 'SAR', 'INR', 'CNY', 'JPY', 'KRW', 'SGD', 'MXN', 'BRL', 'ZAR', 'KZT', 'UZS', 'RUB', 'UAH', 'GEL', 'AZN', 'KGS', 'TJS', 'NGN', 'KES', 'EGP'];
const WEIGHT_UNITS = ['kg', 'lb'];
// Where times and numbers are shown: the server default (TIMEZONE / LOCALE, else UTC and en-US) unless the company chose.
const TIMEZONE = timeLib.timeZoneOr(process.env.TIMEZONE);
const LOCALE = timeLib.localeOr(process.env.LOCALE);
const regionFrom = (currency, weightUnit, timeZone, locale) => ({
  currency: /^[A-Z]{3}$/.test(String(currency || '')) ? currency : CURRENCY,
  weightUnit: WEIGHT_UNITS.includes(weightUnit) ? weightUnit : WEIGHT_UNIT,
  timeZone: timeLib.timeZoneOr(timeZone, TIMEZONE),
  locale: timeLib.localeOr(locale, LOCALE)
});
async function regionOf(tenantId) {
  const tenant = await getTenant(tenantId);
  return regionFrom(tenant?.currency, tenant?.weightUnit, tenant?.timeZone, tenant?.locale);
}
function readRegion(body, { required = false } = {}) {
  const currency = body?.currency === undefined || body?.currency === '' ? null : String(body.currency).toUpperCase();
  const weightUnit = body?.weightUnit === undefined || body?.weightUnit === '' ? null : String(body.weightUnit).toLowerCase();
  if ((required || currency !== null) && !CURRENCIES.includes(currency)) throw httpError(400, `Choose a currency: ${CURRENCIES.join(', ')}.`);
  if ((required || weightUnit !== null) && !WEIGHT_UNITS.includes(weightUnit)) throw httpError(400, 'Choose a weight unit: kg or lb.');
  const timeZone = body?.timeZone === undefined || body?.timeZone === '' ? null : String(body.timeZone);
  const locale = body?.locale === undefined || body?.locale === '' ? null : String(body.locale);
  if (timeZone !== null && !timeLib.isValidTimeZone(timeZone)) throw httpError(400, 'Choose a valid time zone, for example Asia/Tashkent or Europe/Berlin.');
  if (locale !== null && !timeLib.isValidLocale(locale)) throw httpError(400, `Choose a language and number format: ${timeLib.LOCALES.join(', ')}.`);
  return { currency, weightUnit, timeZone, locale };
}

function serializeShipment(shipment) {
  const hasMargin = shipment.rate !== null && shipment.rate !== undefined && shipment.customer_rate !== null && shipment.customer_rate !== undefined;
  return {
    id: `SHP-${shipment.id}`,
    customer: shipment.customer,
    customerPhone: shipment.customer_phone || null,
    origin: shipment.origin,
    destination: shipment.destination,
    pickup: shipment.pickup || 'Today',
    delivery: shipment.delivery || 'Next Day',
    status: shipment.status || 'Pending Approval',
    reference: shipment.reference,
    legMode: shipment.leg_mode || 'single',
    carrier: shipment.carrier_id,
    carrierId: shipment.carrier_id,
    rate: shipment.rate,
    customerRate: shipment.customer_rate ?? null,
    currency: shipment.currency || CURRENCY,
    margin: hasMargin ? addMoney(shipment.currency || CURRENCY, shipment.customer_rate, -shipment.rate) : null,
    weight: shipment.weight,
    equipment: shipment.equipment,
    carrierName: shipment.carrierName,
    carrierPhone: shipment.carrierPhone || null,
    driverName: shipment.driver_name || null,
    driverPhone: shipment.driver_phone || null,
    truckPlate: shipment.truck_plate || null,
    lastLocation: shipment.last_location || null,
    eta: shipment.eta || null,
    lastTrackedAt: shipment.last_tracked_at || null,
    trackingNumber: shipment.tracking_number,
    invoiceNumber: shipment.customer_invoice_number || null,
    invoicedAt: shipment.customer_invoiced_at || null,
    customerPaidAt: shipment.customer_paid_at || null,
    carrierPaidAt: shipment.carrier_paid_at || null,
    shared: Boolean(shipment.share_token_hash)
  };
}

function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function getNormalizedEmail(req) {
  const email = req.body?.email || '';
  return String(email).trim().toLowerCase();
}

function createRateLimiter({ windowMs, max, keyGenerator, message, onLimitReached, store = new Map() }) {
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, attempts] of store) {
      const recentAttempts = attempts.filter((timestamp) => timestamp > cutoff);
      if (recentAttempts.length) store.set(key, recentAttempts);
      else store.delete(key);
    }
  }, windowMs).unref();

  return function rateLimiter(req, res, next) {
    const key = keyGenerator(req);
    const now = Date.now();
    const cutoff = now - windowMs;
    const recentRequests = (store.get(key) || []).filter((timestamp) => timestamp > cutoff);

    if (recentRequests.length >= max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((recentRequests[0] + windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.setHeader('RateLimit-Limit', String(max));
      res.setHeader('RateLimit-Remaining', '0');
      res.setHeader('RateLimit-Reset', String(Math.ceil((recentRequests[0] + windowMs) / 1000)));
      if (onLimitReached) {
        onLimitReached(req, res, key, recentRequests.length);
      }
      if (res.headersSent) {
        return;
      }
      return res.status(429).json({
        success: false,
        message: message || 'Too many requests. Please try again later.'
      });
    }

    recentRequests.push(now);
    store.set(key, recentRequests);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - recentRequests.length)));
    res.setHeader('RateLimit-Reset', String(Math.ceil((recentRequests[0] + windowMs) / 1000)));
    return next();
  };
}

function rateLimitKey(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function trackFailedLoginAttempt(req, email) {
  const ip = getClientIp(req);
  const normalizedEmail = (email || '').trim().toLowerCase();
  const accountId = rateLimitKey(normalizedEmail || 'unknown').slice(0, 12);
  const ipAttempts = await recordRateLimitAttempts(
    [
      rateLimitKey(`login-ip:${ip}`),
      rateLimitKey(`login-account:${ip}:${normalizedEmail || 'unknown'}`),
      rateLimitKey(`login-account-any:${normalizedEmail || 'unknown'}`)
    ],
    AUTH_RATE_LIMIT_CONFIG.login.windowMs
  );

  if (ipAttempts === AUTH_RATE_LIMIT_CONFIG.login.logThreshold || ipAttempts === AUTH_RATE_LIMIT_CONFIG.login.ipMax) {
    console.warn(`[AUTH SECURITY] repeated failed login attempts for account=${accountId} from ${ip} (count=${ipAttempts})`);
  }
}

async function clearFailedLoginAttempt(req, email) {
  const ip = getClientIp(req);
  const normalizedEmail = (email || '').trim().toLowerCase();
  await clearRateLimitAttempts(rateLimitKey(`login-account:${ip}:${normalizedEmail || 'unknown'}`));
  await clearRateLimitAttempts(rateLimitKey(`login-account-any:${normalizedEmail || 'unknown'}`));
}

const normalApiLimiter = createRateLimiter({
  windowMs: AUTH_RATE_LIMIT_CONFIG.normalApi.windowMs,
  max: AUTH_RATE_LIMIT_CONFIG.normalApi.max,
  keyGenerator: (req) => getClientIp(req),
  message: 'Too many API requests. Please try again later.'
});

// AI calls cost money: each person gets a fair hourly budget.
const aiLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: readPositiveInteger(process.env.AI_RATE_LIMIT_PER_HOUR, 60),
  keyGenerator: (req) => `ai:${req.user?.id}`,
  message: 'AI hourly limit reached. Please fill the form by hand or try again later.'
});

// Text messages cost money and can annoy drivers: an hourly cap per person.
const messageLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: readPositiveInteger(process.env.MESSAGE_RATE_LIMIT_PER_HOUR, 60),
  keyGenerator: (req) => `msg:${req.user?.id}`,
  message: 'Message limit reached for this hour.'
});

const gpsLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: readPositiveInteger(process.env.GPS_RATE_LIMIT_PER_MINUTE, 600),
  keyGenerator: (req) => `gps:${req.gpsTokenHash || getClientIp(req)}`,
  message: 'Too many GPS requests.'
});

const inboxLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: readPositiveInteger(process.env.INBOX_RATE_LIMIT_PER_MINUTE, 60),
  keyGenerator: (req) => `inbox:${req.inboxTokenHash || getClientIp(req)}`,
  message: 'Too many messages.'
});

// The inbox address is a secret in the URL: also limit by sender address, so guessing addresses is not free.
const inboxIpLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: readPositiveInteger(process.env.INBOX_IP_RATE_LIMIT_PER_MINUTE, 600),
  keyGenerator: (req) => `inbox-ip:${getClientIp(req)}`,
  message: 'Too many requests.'
});

// Twilio sends several reports per message, all from its own addresses.
const twilioStatusLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: readPositiveInteger(process.env.TWILIO_STATUS_RATE_LIMIT_PER_MINUTE, 1200),
  keyGenerator: (req) => `twilio-status:${getClientIp(req)}`,
  message: 'Too many requests.'
});

const documentLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: readPositiveInteger(process.env.DOC_RATE_LIMIT_PER_HOUR, 60),
  keyGenerator: (req) => `doc:${req.user?.id}`,
  message: 'Upload limit reached for this hour.'
});

const loginLimiter = async (req, res, next) => {
  const ip = getClientIp(req);
  const email = getNormalizedEmail(req);
  try {
    const { windowMs, ipMax, max, accountMax } = AUTH_RATE_LIMIT_CONFIG.login;
    const [ipStatus, accountStatus, anyIpStatus] = await Promise.all([
      getRateLimitStatus(rateLimitKey(`login-ip:${ip}`), windowMs, ipMax),
      getRateLimitStatus(rateLimitKey(`login-account:${ip}:${email || 'unknown'}`), windowMs, max),
      getRateLimitStatus(rateLimitKey(`login-account-any:${email || 'unknown'}`), windowMs, accountMax)
    ]);

    if (ipStatus.limited || accountStatus.limited || anyIpStatus.limited) {
      const emailId = rateLimitKey(email || 'unknown').slice(0, 12);
      console.warn(`[AUTH SECURITY] login rate limit exceeded for account=${emailId} from ${ip}`);
      const retryAfterMs = Math.max(ipStatus.retryAfterMs, accountStatus.retryAfterMs, anyIpStatus.retryAfterMs);
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      return res.status(429).json({ success: false, message: AUTH_RATE_LIMIT_CONFIG.login.message });
    }
    return next();
  } catch (error) {
    console.error('[AUTH SECURITY] login rate limiter unavailable:', error.message);
    return res.status(503).json({ success: false, message: 'Authentication is temporarily unavailable.' });
  }
};

const registerLimiter = async (req, res, next) => {
  const ip = getClientIp(req);
  try {
    const result = await consumeRateLimit(
      rateLimitKey(`register:${ip}`),
      AUTH_RATE_LIMIT_CONFIG.register.windowMs,
      AUTH_RATE_LIMIT_CONFIG.register.max
    );
    if (result.limited) {
      console.warn(`[AUTH SECURITY] registration rate limit exceeded from ${ip}`);
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
      return res.status(429).json({ success: false, message: AUTH_RATE_LIMIT_CONFIG.register.message });
    }
    return next();
  } catch (error) {
    console.error('[AUTH SECURITY] registration rate limiter unavailable:', error.message);
    return res.status(503).json({ success: false, message: 'Registration is temporarily unavailable.' });
  }
};

// The GPS webhook has its own token and limiter (providers send many requests from one address).
app.use('/api', (req, res, next) => (req.path === '/integrations/gps' || req.path.startsWith('/integrations/inbox/') || req.path.startsWith('/integrations/twilio/')
  ? next() : normalApiLimiter(req, res, next)));

const authRateLimiters = { login: loginLimiter, register: registerLimiter };

function makeToken(user) {
  const jti = crypto.randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_DURATION_SECONDS;
  const token = jwt.sign(
    {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      jti
    },
    JWT_SECRET,
    { expiresIn: SESSION_DURATION_SECONDS }
  );
  return { token, jti, expiresAt };
}

function readSessionCookie(req) {
  const cookieHeader = req.headers.cookie || '';
  const cookie = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (!cookie) return null;
  try {
    return decodeURIComponent(cookie.slice(SESSION_COOKIE.length + 1));
  } catch (error) {
    return null;
  }
}

async function issueSessionCookie(user, res) {
  const session = makeToken(user);
  await createAuthSession(session.jti, session.expiresAt, user.id);
  res.cookie(SESSION_COOKIE, session.token, SESSION_COOKIE_OPTIONS);
}

async function authMiddleware(req, res, next) {
  const token = readSessionCookie(req);
  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required.'
    });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!(await isAuthSessionActive(payload.jti))) {
      return res.status(401).json({
        success: false,
        message: 'Session expired or revoked.'
      });
    }
    // Role, company and access come from the database on every request, not from the token,
    // so an admin's change (new role, account disabled) applies immediately.
    const user = await findUserById(payload.id);
    if (!user || user.disabledAt) {
      return res.status(401).json({ success: false, message: 'Session expired or revoked.' });
    }
    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      jti: payload.jti,
      tenantId: user.tenantId,
      tenantName: user.tenantName,
      isPlatformAdmin: Boolean(user.isPlatformAdmin),
      region: regionFrom(user.tenantCurrency, user.tenantWeightUnit, user.tenantTimeZone, user.tenantLocale)
    };
    // Platform admins manage every company; everyone else only ever reaches their own company's rows.
    return req.user.isPlatformAdmin ? runAsSystem(next) : runAsTenant(req.user.tenantId, next);
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token.'
    });
  }
}

function requirePermission(permission) {
  return (req, res, next) => {
    const permissions = ROLE_PERMISSIONS[req.user?.role] || [];
    if (!permissions.includes('*') && !permissions.includes(permission)) {
      return res.status(403).json({
        success: false,
        message: `Forbidden: missing ${permission} permission.`
      });
    }
    return next();
  };
}

// The platform owner adds customer companies; a company's own admin cannot.
function requirePlatformAdmin(req, res, next) {
  if (!req.user?.isPlatformAdmin) {
    return res.status(403).json({ success: false, message: 'Forbidden: platform administrators only.' });
  }
  return next();
}

function hasPermission(user, permission) {
  const permissions = ROLE_PERMISSIONS[user?.role] || [];
  return permissions.includes('*') || permissions.includes(permission);
}

function sanitizeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    permissions: ROLE_PERMISSIONS[user.role] || [],
    isPlatformAdmin: Boolean(user.is_platform_admin ?? user.isPlatformAdmin)
  };
}

// Writes an agent_tasks row for every AI call (success or failure).
function agentLogger(req, shipmentId = null) {
  return (task) => recordAgentTask(req.user.tenantId, { ...task, shipmentId, actorId: req.user.id })
    .catch((error) => console.error('[agent log] failed:', error.message));
}

// Writes one line to the company's activity log. Never blocks or fails the request it describes.
function audit(req, action, detail = null) {
  recordAudit(req.user.tenantId, { actorId: req.user.id, action, detail, ip: getClientIp(req) })
    .catch((error) => console.error('[audit] failed:', error.message));
}

function sendError(res, error, fallbackMessage, logLabel) {
  if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
  console.error(`[${logLabel}] failed:`, error.message);
  return res.status(500).json({ success: false, message: fallbackMessage });
}

/* ---------- subscription plan checks (lib/plans.js) ---------- */
const planOf = async (tenantId) => plans.resolvePlan(await getTenant(tenantId));
async function requireCapability(tenantId, capability) {
  plans.assertCapability(await planOf(tenantId), capability);
}
// Express middleware form, for routes where the whole action is a plan feature.
const needsPlan = (capability) => async (req, res, next) => {
  try {
    await requireCapability(req.user.tenantId, capability);
    return next();
  } catch (error) {
    return sendError(res, error, 'Plan check failed.', 'plan');
  }
};
async function requireShipmentRoom(tenantId) {
  plans.assertCanAddShipment(await planOf(tenantId), await countShipmentsThisMonth(tenantId));
}

/* =========================================================
   PUBLIC
   ========================================================= */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'VEYRA Logistics API',
    timestamp: new Date().toISOString()
  });
});

// Public settings the UI needs before sign-in (units, currency, whether sign-up is possible, features on).
// The plans on the public pricing page. Prices are in US dollars.
app.get('/api/plans', (req, res) => {
  res.json({
    success: true, currency: 'USD', trialDays: plans.TRIAL_DAYS, salesEmail: SALES_EMAIL, signup: companySignupOpen(), cardPayment: paddle.enabled(),
    plans: plans.publicPlans(), regions: { currencies: CURRENCIES, weightUnits: WEIGHT_UNITS, defaultCurrency: CURRENCY, defaultWeightUnit: WEIGHT_UNIT }
  });
});

// Self-service: a new company with its first administrator, on a free trial of the chosen plan.
// The browser then goes straight to Billing to pay by card; Paddle's webhook makes the plan Active.
app.post('/api/signup', registerLimiter, async (req, res) => {
  try {
    if (!companySignupOpen()) return res.status(403).json({ success: false, message: 'Sign-up is not open. Contact us to get an account.' });
    const { companyName, name, email, password, plan = 'growth', acceptTerms } = req.body || {};
    if (acceptTerms !== true) return res.status(400).json({ success: false, message: 'Please accept the Terms of Service and Privacy Policy.' });
    const region = readRegion(req.body);
    if (typeof companyName !== 'string' || !companyName.trim() || companyName.trim().length > MAX_LEN.companyName) {
      return res.status(400).json({ success: false, message: `Company name is required (at most ${MAX_LEN.companyName} characters).` });
    }
    const identityError = validateNameAndEmail(name, email);
    if (identityError) return res.status(400).json({ success: false, message: identityError });
    const passwordError = validateNewPassword(password);
    if (passwordError) return res.status(400).json({ success: false, message: passwordError });
    // Enterprise is arranged with sales, never by self sign-up.
    if (!paddle.PLAN_KEYS.includes(plan)) return res.status(400).json({ success: false, message: 'Choose Starter, Growth or Scale. For Enterprise, contact sales.' });

    const result = await createTenantWithAdmin({
      name: companyName.trim(),
      adminName: name.trim(),
      adminEmail: email.trim().toLowerCase(),
      passwordHash: await bcrypt.hash(password, BCRYPT_COST),
      plan,
      trialDays: plans.TRIAL_DAYS,
      currency: region.currency,
      weightUnit: region.weightUnit,
      termsVersion: legal.TERMS_VERSION
    });
    const user = await findUserByEmail(result.admin.email);
    await issueSessionCookie(user, res);
    recordAudit(result.tenant.id, { actorId: user.id, action: 'company.signup', detail: `${result.tenant.name}: ${plan} trial`, ip: getClientIp(req) }).catch(() => {});
    return res.status(201).json({ success: true, user: sanitizeUser(user), company: { name: result.tenant.name, plan }, cardPayment: paddle.enabled() });
  } catch (error) {
    if (error.statusCode === 409 || String(error.code) === 'SQLITE_CONSTRAINT') {
      // Same answer for a taken email or company name: do not reveal which accounts exist.
      return res.status(409).json({ success: false, message: 'Sign-up could not be completed. Try signing in, or use a different email and company name.' });
    }
    return sendError(res, error, 'Sign-up failed. Please try again.', 'signup');
  }
});

app.get('/api/config', (req, res) => {
  res.json({
    weightUnit: WEIGHT_UNIT,
    currency: CURRENCY,
    timeZone: TIMEZONE,
    locale: LOCALE,
    equipment: EQUIPMENT,
    registration: REGISTRATION_MODE,
    maxRate: MAX_RATE,
    staleTrackingHours: STALE_TRACKING_HOURS,
    ai: { enabled: aiGateway.isEnabled() },
    // Which channels can send depends on the company: see GET /api/messaging/status (after sign-in).
    documents: { maxMb: DOC_MAX_BYTES / (1024 * 1024), types: DOC_MIME_TYPES },
    nexus: { enabled: process.env.NEXUS_ENABLED !== 'false' }
  });
});

app.post('/api/register', registerLimiter, async (req, res) => {
  try {
    const { name, email, password, inviteCode } = req.body || {};

    if (REGISTRATION_MODE === 'closed') {
      return res.status(403).json({ success: false, message: 'Sign-up is closed. Ask your administrator to create an account for you.' });
    }
    if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string' || !name.trim() || !email.trim() || !password) {
      return res.status(400).json({
        success: false,
        message: 'Name, email and password are required.'
      });
    }
    const identityError = validateNameAndEmail(name, email);
    if (identityError) return res.status(400).json({ success: false, message: identityError });
    const passwordError = validateNewPassword(password);
    if (passwordError) return res.status(400).json({ success: false, message: passwordError });
    if (REGISTRATION_INVITE_CODE) {
      const provided = Buffer.from(String(inviteCode || ''));
      const expected = Buffer.from(REGISTRATION_INVITE_CODE);
      if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
        return res.status(403).json({ success: false, message: 'A valid invite code is required.' });
      }
    }

    const normalizedEmail = email.trim().toLowerCase();
    const hashedPassword = await bcrypt.hash(password, BCRYPT_COST);
    const existingUser = await findUserByEmail(normalizedEmail);
    if (existingUser) {
      // Generic message: do not reveal whether the email is registered.
      return res.status(409).json({
        success: false,
        message: 'Registration could not be completed. Try signing in or use a different email.'
      });
    }

    let user;
    try {
      // Self-registered people join the default company as operators.
      user = await createUser({
        name: name.trim(),
        email: normalizedEmail,
        password: hashedPassword,
        role: 'operator',
        tenantId: DEFAULT_TENANT_ID
      });
    } catch (error) {
      if (String(error.code) === 'SQLITE_CONSTRAINT') {
        return res.status(409).json({ success: false, message: 'Registration could not be completed. Try signing in or use a different email.' });
      }
      throw error;
    }
    await issueSessionCookie(user, res);

    return res.status(201).json({
      success: true,
      user: sanitizeUser(user)
    });
  } catch (error) {
    console.error('[register] failed:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Registration failed'
    });
  }
});

app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password
      || email.length > MAX_LEN.email || passwordTooLong(password)) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }
    const normalizedEmail = email.trim().toLowerCase();

    const user = await findUserByEmail(normalizedEmail);
    // A disabled account is treated exactly like an unknown one (same message, same timing).
    if (!user || user.disabled_at) {
      // Equalise timing with the real-user path so response time does not reveal valid emails.
      await bcrypt.compare(String(password || ''), DUMMY_HASH);
      await trackFailedLoginAttempt(req, normalizedEmail);
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.'
      });
    }

    const isValid = await bcrypt.compare(String(password || ''), user.password);
    if (!isValid) {
      await trackFailedLoginAttempt(req, normalizedEmail);
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.'
      });
    }

    await clearFailedLoginAttempt(req, normalizedEmail);
    await issueSessionCookie(user, res);
    return res.json({
      success: true,
      user: sanitizeUser(user)
    });
  } catch (error) {
    console.error('[login] failed:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Login failed'
    });
  }
});

app.post('/api/logout', async (req, res) => {
  const token = readSessionCookie(req);
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      await revokeAuthSession(payload.jti);
    } catch (error) {
      // Expired or malformed cookies are still cleared below.
    }
  }

  res.clearCookie(SESSION_COOKIE, {
    httpOnly: SESSION_COOKIE_OPTIONS.httpOnly,
    secure: SESSION_COOKIE_OPTIONS.secure,
    sameSite: SESSION_COOKIE_OPTIONS.sameSite,
    path: SESSION_COOKIE_OPTIONS.path
  });
  return res.json({ success: true });
});

/* =========================================================
   DASHBOARD, ANALYTICS, ALERTS
   ========================================================= */
app.get('/api/dashboard', authMiddleware, requirePermission('dashboard:read'), async (req, res) => {
  try {
    const payload = await getDashboardPayload(req.user.tenantId, { days: req.query.days });
    if (!hasPermission(req.user, 'analytics:read')) {
      delete payload.stats;
      delete payload.statuses;
      delete payload.weeklyVolume;
    }
    res.json(payload);
  } catch (error) {
    console.error('[dashboard] failed:', error.message);
    res.status(500).json({
      success: false,
      message: 'Dashboard unavailable'
    });
  }
});

app.get('/api/analytics', authMiddleware, requirePermission('analytics:read'), async (req, res) => {
  try {
    const report = await getAnalyticsReport(req.user.tenantId, { days: req.query.days });
    report.agents = await getAgentUsage(req.user.tenantId, report.rangeDays);
    res.json(report);
  } catch (error) {
    console.error('[analytics] failed:', error.message);
    res.status(500).json({ success: false, message: 'Analytics unavailable.' });
  }
});

// What needs attention right now (notification bell).
app.get('/api/alerts', authMiddleware, requirePermission('shipments:read'), async (req, res) => {
  try {
    res.json({ success: true, alerts: await getAlerts(req.user.tenantId, { staleHours: STALE_TRACKING_HOURS }) });
  } catch (error) {
    console.error('[alerts] failed:', error.message);
    res.status(500).json({ success: false, message: 'Alerts unavailable.' });
  }
});

/* =========================================================
   SHIPMENTS
   ========================================================= */
app.get('/api/shipments', authMiddleware, requirePermission('shipments:read'), async (req, res) => {
  try {
    const shipments = await listShipments(req.user.tenantId, readPaging(req));
    res.json(shipments.map(serializeShipment));
  } catch (error) {
    console.error('[shipments] failed:', error.message);
    res.status(500).json({ success: false, message: 'Shipments unavailable' });
  }
});

// Paged, filtered list for the Shipments page and CSV export. Registered before /:id.
app.get('/api/shipments/search', authMiddleware, requirePermission('shipments:read'), async (req, res) => {
  const { limit, offset, page } = readPaging(req);
  const status = SHIPMENT_STATUSES.includes(req.query.status) ? req.query.status : null;
  const equipment = EQUIPMENT.includes(req.query.equipment) ? req.query.equipment : null;
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 120) : '';
  const sort = typeof req.query.sort === 'string' ? req.query.sort : 'newest';
  try {
    const result = await searchShipments(req.user.tenantId, { status, equipment, q, sort, limit, offset });
    res.json({
      success: true,
      items: result.items.map(serializeShipment),
      total: result.total,
      allCount: result.allCount,
      statusCounts: result.statusCounts,
      page,
      pageSize: limit,
      pages: Math.max(1, Math.ceil(result.total / limit))
    });
  } catch (error) {
    console.error('[shipment search] failed:', error.message);
    res.status(500).json({ success: false, message: 'Shipments unavailable' });
  }
});

app.get('/api/shipments/:id', authMiddleware, requirePermission('shipments:read'), async (req, res) => {
  const shipmentId = parseShipmentId(req.params.id);
  if (!shipmentId) {
    return res.status(400).json({ success: false, message: 'Valid shipment ID is required.' });
  }
  try {
    const shipment = await getShipment(req.user.tenantId, shipmentId);
    if (!shipment) return res.status(404).json({ success: false, message: 'Shipment not found.' });
    return res.json(serializeShipment(shipment));
  } catch (error) {
    console.error('[shipment] failed:', error.message);
    return res.status(500).json({ success: false, message: 'Shipment unavailable' });
  }
});

app.post('/api/shipments', authMiddleware, requirePermission('shipments:create'), async (req, res) => {
  try {
    const { customer, reference, origin, destination, pickup, delivery, weight, equipment, trackingNumber } = req.body || {};
    const pickupDate = parseIsoDate(pickup);
    const deliveryDate = parseIsoDate(delivery);
    const weightValue = parsePositiveNumber(weight, MAX_WEIGHT);
    const hasCustomerRate = req.body?.customerRate !== undefined && req.body?.customerRate !== null && req.body?.customerRate !== '';
    const customerRate = hasCustomerRate ? parseMoney(req.body.customerRate) : null;
    if (hasCustomerRate && customerRate === null) {
      return res.status(400).json({ success: false, message: `Customer price must be between 0.01 and ${MAX_RATE.toLocaleString('en-US')}.` });
    }
    const customerPhone = readOptionalPhone(req.body, 'customerPhone');
    if (customerPhone.error) return res.status(400).json({ success: false, message: customerPhone.error });
    // Optional: the email this load was made from (closes its task and marks it converted).
    const inboxId = req.body?.inboxId === undefined || req.body?.inboxId === null || req.body?.inboxId === '' ? null : Number(req.body.inboxId);
    if (inboxId !== null) {
      const item = Number.isInteger(inboxId) && inboxId > 0 ? await getInboxItem(req.user.tenantId, inboxId) : null;
      if (!item || ['converted', 'dismissed'].includes(item.status)) {
        return res.status(400).json({ success: false, message: 'That incoming message no longer exists or was already handled.' });
      }
    }

    const textFields = { customer, origin, destination };
    for (const [field, value] of Object.entries(textFields)) {
      if (typeof value !== 'string' || value.trim().length > MAX_LEN[field]) {
        return res.status(400).json({ success: false, message: `${field} is required and must be at most ${MAX_LEN[field]} characters.` });
      }
    }
    for (const field of ['reference', 'trackingNumber']) {
      const value = req.body?.[field];
      if (value !== undefined && value !== null && (typeof value !== 'string' || value.trim().length > MAX_LEN[field])) {
        return res.status(400).json({ success: false, message: `${field} must be text of at most ${MAX_LEN[field]} characters.` });
      }
    }
    if (!customer?.trim() || !origin?.trim() || !destination?.trim() || weightValue === null || !EQUIPMENT.includes(equipment)) {
      return res.status(400).json({ success: false, message: `Customer, route, a weight up to ${MAX_WEIGHT.toLocaleString('en-US')} ${req.user.region.weightUnit}, and valid equipment are required.` });
    }
    if (!pickupDate || !deliveryDate) {
      return res.status(400).json({ success: false, message: 'Pickup and delivery must be valid dates (YYYY-MM-DD).' });
    }
    if (deliveryDate < pickupDate) {
      return res.status(400).json({ success: false, message: 'Delivery date must be on or after pickup date.' });
    }

    await requireShipmentRoom(req.user.tenantId);
    const shipment = await createShipment({
      customer: customer.trim(),
      origin: origin.trim(),
      destination: destination.trim(),
      pickup,
      delivery,
      status: 'New',
      weight: `${weightValue} ${req.user.region.weightUnit}`,
      equipment,
      reference: reference?.trim(),
      trackingNumber: trackingNumber?.trim(),
      customerRate,
      customerPhone: customerPhone.value,
      actorId: req.user.id,
      tenantId: req.user.tenantId
    });

    nexus.emit('shipment.created', { tenantId: req.user.tenantId, shipmentId: parseShipmentId(shipment.id) });
    let documentsAttached = 0;
    if (inboxId !== null) {
      const newId = parseShipmentId(shipment.id);
      await updateInboxItem(req.user.tenantId, inboxId, { status: 'converted', shipmentId: newId });
      await resolveTasksByKey(req.user.tenantId, `inbox:${inboxId}`, { userId: req.user.id });
      // Files that came with the email go with the load.
      const moved = await moveInboxAttachmentsToShipment(req.user.tenantId, inboxId, newId, {
        uploadedBy: req.user.id, typeFor: (filename) => guessDocumentType(filename) || 'other', maxPerShipment: DOC_MAX_PER_SHIPMENT
      });
      documentsAttached = moved.documentIds.length;
      moved.documentIds.forEach((documentId) => nexus.emit('document.uploaded', { tenantId: req.user.tenantId, shipmentId: newId, documentId }));
    }

    return res.status(201).json({
      success: true,
      shipment,
      documentsAttached
    });
  } catch (error) {
    return sendError(res, error, 'Shipment creation failed', 'create shipment');
  }
});

/* =========================================================
   ACCOUNT: passwords
   ========================================================= */
const passwordLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => `pwd:${req.user?.id}`,
  message: 'Too many password attempts. Try again later.'
});

// A person changes their own password. Every other device is signed out; this one stays signed in.
app.post('/api/me/password', authMiddleware, passwordLimiter, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || !currentPassword || passwordTooLong(currentPassword)) {
    return res.status(400).json({ success: false, message: 'Enter your current password.' });
  }
  const passwordError = validateNewPassword(newPassword);
  if (passwordError) return res.status(400).json({ success: false, message: passwordError });
  if (newPassword === currentPassword) return res.status(400).json({ success: false, message: 'The new password must be different from the current one.' });
  try {
    const hash = await getUserPasswordHash(req.user.tenantId, req.user.id);
    if (!hash || !(await bcrypt.compare(currentPassword, hash))) {
      return res.status(403).json({ success: false, message: 'The current password is not correct.' });
    }
    await setUserPassword(req.user.tenantId, req.user.id, await bcrypt.hash(newPassword, BCRYPT_COST));
    await issueSessionCookie({ id: req.user.id, email: req.user.email, name: req.user.name, role: req.user.role }, res);
    audit(req, 'password.changed', 'own password');
    return res.json({ success: true });
  } catch (error) {
    return sendError(res, error, 'Password could not be changed.', 'change password');
  }
});

// An administrator gives a team member a new password (they forgot it). That person is signed out everywhere.
app.post('/api/admin/users/:id/password', authMiddleware, requirePermission('users:write'), passwordLimiter, async (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ success: false, message: 'Valid user ID is required.' });
  if (userId === req.user.id) return res.status(400).json({ success: false, message: 'Change your own password under "Change password".' });
  const passwordError = validateNewPassword(req.body?.newPassword);
  if (passwordError) return res.status(400).json({ success: false, message: passwordError });
  try {
    const target = await findUserById(userId);
    if (!target || target.tenantId !== req.user.tenantId) return res.status(404).json({ success: false, message: 'User not found.' });
    await setUserPassword(req.user.tenantId, userId, await bcrypt.hash(req.body.newPassword, BCRYPT_COST));
    audit(req, 'password.reset', target.email);
    return res.json({ success: true });
  } catch (error) {
    return sendError(res, error, 'Password could not be reset.', 'reset password');
  }
});

// The company's activity log (administrators only).
app.get('/api/audit', authMiddleware, requirePermission('users:write'), async (req, res) => {
  try {
    res.json({ success: true, entries: await listAudit(req.user.tenantId) });
  } catch (error) {
    return sendError(res, error, 'Activity log unavailable.', 'audit');
  }
});

/* =========================================================
   LOADS: corrections, money, customer link
   ========================================================= */
// Correct a load that was entered wrong. Only the fields that are sent are changed.
app.patch('/api/shipments/:id', authMiddleware, requirePermission('shipments:create'), async (req, res) => {
  const shipmentId = parseShipmentId(req.params.id);
  if (!shipmentId) return res.status(400).json({ success: false, message: 'Valid shipment ID is required.' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const changes = {};
  const bad = (message) => res.status(400).json({ success: false, message });
  for (const field of ['customer', 'origin', 'destination']) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== 'string' || !body[field].trim() || body[field].trim().length > MAX_LEN[field]) return bad(`${field} must be text of at most ${MAX_LEN[field]} characters.`);
    changes[field] = body[field].trim();
  }
  for (const [field, max] of [['reference', MAX_LEN.reference], ['driverName', MAX_LEN.driverName], ['truckPlate', MAX_LEN.truckPlate]]) {
    if (body[field] === undefined) continue;
    const parsed = readOptionalText(body, field, max);
    if (parsed.error) return bad(parsed.error);
    changes[field] = parsed.value;
  }
  for (const field of ['customerPhone', 'driverPhone']) {
    if (body[field] === undefined) continue;
    const parsed = readOptionalPhone(body, field);
    if (parsed.error) return bad(parsed.error);
    changes[field] = parsed.value;
  }
  for (const field of ['pickup', 'delivery']) {
    if (body[field] === undefined) continue;
    if (!parseIsoDate(body[field])) return bad('Pickup and delivery must be valid dates (YYYY-MM-DD).');
    changes[field] = body[field];
  }
  if (body.weight !== undefined) {
    const weight = parsePositiveNumber(body.weight, MAX_WEIGHT);
    if (weight === null) return bad(`Weight must be a number up to ${MAX_WEIGHT.toLocaleString('en-US')} ${req.user.region.weightUnit}.`);
    changes.weight = `${weight} ${req.user.region.weightUnit}`;
  }
  if (body.equipment !== undefined) {
    if (!EQUIPMENT.includes(body.equipment)) return bad(`Equipment must be one of: ${EQUIPMENT.join(', ')}.`);
    changes.equipment = body.equipment;
  }
  if (body.customerRate !== undefined) {
    const empty = body.customerRate === null || body.customerRate === '';
    const price = empty ? null : parseMoney(body.customerRate);
    if (!empty && price === null) return bad(`Customer price must be between 0.01 and ${MAX_RATE.toLocaleString('en-US')}.`);
    changes.customerRate = price;
  }
  if (!Object.keys(changes).length) return bad('Send at least one field to change.');
  try {
    const result = await updateShipmentDetails(req.user.tenantId, shipmentId, changes, req.user.id);
    const shipment = await getShipment(req.user.tenantId, shipmentId);
    return res.json({ success: true, changed: result.changed, shipment: serializeShipment(shipment) });
  } catch (error) {
    return sendError(res, error, 'Shipment could not be changed.', 'edit shipment');
  }
});

// Invoice sent / customer paid / carrier paid.
app.patch('/api/shipments/:id/payment', authMiddleware, requirePermission('shipments:finance'), async (req, res) => {
  const shipmentId = parseShipmentId(req.params.id);
  const { invoiceNumber, invoiced, customerPaid, carrierPaid } = req.body || {};
  const flags = [invoiced, customerPaid, carrierPaid];
  const number = readOptionalText(req.body, 'invoiceNumber', 60);
  if (!shipmentId || flags.some((flag) => flag !== undefined && typeof flag !== 'boolean') || number.error
    || (invoiceNumber === undefined && flags.every((flag) => flag === undefined))) {
    return res.status(400).json({ success: false, message: 'Send invoiceNumber (text) and/or invoiced, customerPaid, carrierPaid (true or false).' });
  }
  try {
    const result = await setShipmentPayment(req.user.tenantId, shipmentId, {
      invoiceNumber: invoiceNumber === undefined ? undefined : number.value, invoiced, customerPaid, carrierPaid
    }, req.user.id);
    if (result.changed.length) audit(req, 'payment.changed', `SHP-${shipmentId}: ${result.changed.join('; ')}`);
    return res.json({ success: true, changed: result.changed, shipment: serializeShipment(await getShipment(req.user.tenantId, shipmentId)) });
  } catch (error) {
    return sendError(res, error, 'Payment could not be saved.', 'payment');
  }
});

// Money that is still open (delivered but unpaid).
app.get('/api/finance/summary', authMiddleware, requirePermission('shipments:finance'), async (req, res) => {
  try {
    res.json({ success: true, currency: req.user.region.currency, ...(await getFinanceSummary(req.user.tenantId)) });
  } catch (error) {
    return sendError(res, error, 'Finance summary unavailable.', 'finance');
  }
});

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

// A printable invoice for the customer (open it and print or "Save as PDF" from the browser).
app.get('/api/shipments/:id/invoice', authMiddleware, requirePermission('shipments:finance'), async (req, res) => {
  const shipmentId = parseShipmentId(req.params.id);
  if (!shipmentId) return res.status(400).json({ success: false, message: 'Valid shipment ID is required.' });
  try {
    const shipment = await getShipment(req.user.tenantId, shipmentId);
    if (!shipment) return res.status(404).json({ success: false, message: 'Shipment not found.' });
    if (shipment.customer_rate === null || shipment.customer_rate === undefined) {
      return res.status(409).json({ success: false, message: 'Enter the customer price on the load first.' });
    }
    const e = escapeHtml;
    const number = shipment.customer_invoice_number || `SHP-${shipment.id}`;
    const date = (shipment.customer_invoiced_at || new Date().toISOString()).slice(0, 10);
    const row = (label, value) => `<tr><th>${e(label)}</th><td>${e(value || '—')}</td></tr>`;
    res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invoice ${e(number)}</title><link rel="stylesheet" href="/invoice.css"></head>
<body><main class="invoice">
<header><div><h1>${e(req.user.tenantName || 'Invoice')}</h1><p>Freight invoice</p></div>
<div class="meta"><p><strong>Invoice</strong> ${e(number)}</p><p><strong>Date</strong> ${e(date)}</p><p><strong>Load</strong> SHP-${shipment.id}</p></div></header>
<section><h2>Bill to</h2><p class="party">${e(shipment.customer)}</p></section>
<table>
${row('Route', `${shipment.origin} → ${shipment.destination}`)}
${row('Pickup', shipment.pickup)}
${row('Delivery', shipment.delivery)}
${row('Cargo', [shipment.weight, shipment.equipment].filter(Boolean).join(' · '))}
${row('Customer reference', shipment.reference)}
${row('Truck', shipment.truck_plate)}
</table>
<p class="total"><span>Total due</span><strong>${e(formatMoney(shipment.customer_rate, req.user.region.currency))}</strong></p>
<p class="state">${shipment.customer_paid_at ? `Paid on ${e(String(shipment.customer_paid_at).slice(0, 10))}` : 'Not paid yet'}</p>
<p class="actions"><button type="button" id="printButton">Print or save as PDF</button></p>
</main><script src="/print.js"></script></body></html>`);
  } catch (error) {
    return sendError(res, error, 'Invoice unavailable.', 'invoice');
  }
});

/* =========================================================
   GLOBAL TRACKING: every booked load on one map
   ========================================================= */
// Positions come from GPS (when a provider sends them) and city coordinates from the map cache
// (when GEO_PROVIDER is on). Nothing is invented: a load without coordinates is listed, not drawn.
app.get('/api/tracking/overview', authMiddleware, requirePermission('shipments:read'), async (req, res) => {
  try {
    const [rows, openLoads] = await Promise.all([listTrackingOverview(req.user.tenantId), listSentinelLoads(req.user.tenantId)]);
    const risks = sentinelAgent.assess(await geo.annotateOffRoute(openLoads), { staleHours: STALE_TRACKING_HOURS, offRouteKm: geo.offRouteKm() });
    const riskBy = new Map();
    risks.forEach((risk) => {
      const list = riskBy.get(risk.shipmentId) || [];
      list.push({ type: risk.type, severity: risk.severity, title: risk.title });
      riskBy.set(risk.shipmentId, list);
    });
    const places = new Map();
    const place = async (name) => {
      const lookup = String(name || '').trim().toLowerCase();
      if (!places.has(lookup)) places.set(lookup, await geo.cachedPlace(name));
      return places.get(lookup);
    };
    const loads = [];
    for (const row of rows) {
      const id = `SHP-${row.id}`;
      const from = await place(row.origin);
      const to = await place(row.destination);
      const loadRisks = riskBy.get(id) || [];
      const deliveryDay = /^\d{4}-\d{2}-\d{2}$/.test(String(row.delivery)) ? row.delivery : null;
      const etaDay = row.eta ? String(row.eta).slice(0, 10) : null;
      const late = row.status !== 'Delivered' && (loadRisks.some((risk) => ['late_delivery', 'eta_after_delivery', 'late_pickup'].includes(risk.type)) || (etaDay && deliveryDay && etaDay > deliveryDay));
      loads.push({
        id,
        customer: row.customer,
        origin: row.origin,
        destination: row.destination,
        pickup: row.pickup,
        delivery: row.delivery,
        status: row.status,
        weight: row.weight,
        equipment: row.equipment,
        eta: row.eta || null,
        lastLocation: row.lastLocation || null,
        lastTrackedAt: row.lastTrackedAt || null,
        carrierName: row.carrierName || null,
        carrierPhone: row.carrierPhone || null,
        driverName: row.driverName || null,
        driverPhone: row.driverPhone || null,
        truckPlate: row.truckPlate || null,
        gps: row.lat === null || row.lat === undefined ? null : { lat: Number(row.lat), lng: Number(row.lng), at: row.gpsAt },
        from,
        to,
        timeline: { bookedAt: row.bookedAt || null, departedAt: row.departedAt || null, deliveredAt: row.deliveredAt || null },
        onTime: row.status === 'Delivered' ? null : !late,
        risks: loadRisks
      });
    }
    // Places the map does not know yet are looked up in the background, for the next visit.
    geo.warmPlaces(loads.filter((load) => !load.from || !load.to).flatMap((load) => [load.origin, load.destination]));
    const active = loads.filter((load) => load.status !== 'Delivered');
    return res.json({
      success: true,
      map: { enabled: geo.enabled() },
      summary: {
        active: active.length,
        inTransit: active.filter((load) => load.status === 'In Transit').length,
        booked: active.filter((load) => load.status === 'Dispatched').length,
        exceptions: active.filter((load) => load.status === 'Exception').length,
        onTimeShare: active.length ? Math.round((active.filter((load) => load.onTime).length / active.length) * 100) : null,
        withGps: active.filter((load) => load.gps).length
      },
      loads,
      alerts: risks.slice(0, 20)
    });
  } catch (error) {
    return sendError(res, error, 'Tracking unavailable.', 'tracking overview');
  }
});

/* =========================================================
   AUTOMATION STUDIO: the company's own "when ... then ..." rules
   ========================================================= */
const workflowId = (value) => (/^\d{1,9}$/.test(String(value)) ? Number(value) : null);

app.get('/api/automation/studio', authMiddleware, requirePermission('shipments:read'), async (req, res) => {
  try {
    const [tenant, workflows, runs, stats] = await Promise.all([
      getTenant(req.user.tenantId), listWorkflows(req.user.tenantId), listWorkflowRuns(req.user.tenantId, 50), getWorkflowStats(req.user.tenantId)
    ]);
    const builtIn = studio.BUILT_IN.map((item) => ({ ...item, on: tenant.automationSettings?.[item.key] !== false }));
    const active = workflows.filter((workflow) => workflow.enabled).length + builtIn.filter((item) => item.on).length;
    return res.json({
      success: true,
      nexus: { enabled: process.env.NEXUS_ENABLED !== 'false' },
      canChange: hasPermission(req.user, 'settings:write'),
      stats: {
        active,
        custom: workflows.length,
        runs30: stats.runs30,
        successRate: stats.runs30 ? Math.round(((stats.runs30 - stats.failed30) / stats.runs30) * 100) : null
      },
      builtIn,
      workflows: workflows.map((workflow) => ({
        ...workflow,
        triggerText: studio.describeTrigger(workflow),
        actionTexts: workflow.actions.map((action) => studio.describeAction(action))
      })),
      runs,
      templates: studio.TEMPLATES,
      options: {
        triggers: studio.TRIGGERS,
        statuses: studio.STATUSES,
        fields: studio.FIELDS,
        actions: Object.fromEntries(Object.entries(studio.ACTIONS).map(([key, spec]) => [key, { label: spec.label, purposes: spec.purposes || null }])),
        purposes: studio.PURPOSE_LABELS,
        limits: studio.LIMITS
      }
    });
  } catch (error) {
    return sendError(res, error, 'Automation Studio unavailable.', 'automation studio');
  }
});

app.post('/api/automation/workflows', authMiddleware, requirePermission('settings:write'), needsPlan('workflows'), async (req, res) => {
  try {
    const fields = studio.validateWorkflow(req.body);
    const workflow = await createWorkflow(req.user.tenantId, fields, req.user.id, studio.LIMITS.perCompany);
    audit(req, 'workflow.created', `${workflow.name} (#${workflow.id})`);
    return res.status(201).json({ success: true, workflow });
  } catch (error) {
    return sendError(res, error, 'The workflow could not be saved.', 'workflow create');
  }
});

app.put('/api/automation/workflows/:id', authMiddleware, requirePermission('settings:write'), needsPlan('workflows'), async (req, res) => {
  try {
    const id = workflowId(req.params.id);
    if (!id) return res.status(404).json({ success: false, message: 'Workflow not found.' });
    const fields = studio.validateWorkflow(req.body);
    const workflow = await updateWorkflow(req.user.tenantId, id, fields);
    audit(req, 'workflow.changed', `${workflow.name} (#${id})`);
    return res.json({ success: true, workflow });
  } catch (error) {
    return sendError(res, error, 'The workflow could not be saved.', 'workflow update');
  }
});

app.patch('/api/automation/workflows/:id', authMiddleware, requirePermission('settings:write'), async (req, res) => {
  try {
    const id = workflowId(req.params.id);
    if (!id || typeof req.body?.enabled !== 'boolean') return res.status(400).json({ success: false, message: 'Send enabled: true or false.' });
    if (req.body.enabled) await requireCapability(req.user.tenantId, 'workflows');
    const workflow = await setWorkflowEnabled(req.user.tenantId, id, req.body.enabled);
    audit(req, 'workflow.changed', `${workflow.name} (#${id}): ${workflow.enabled ? 'on' : 'off'}`);
    return res.json({ success: true, workflow });
  } catch (error) {
    return sendError(res, error, 'The workflow could not be changed.', 'workflow toggle');
  }
});

app.delete('/api/automation/workflows/:id', authMiddleware, requirePermission('settings:write'), async (req, res) => {
  try {
    const id = workflowId(req.params.id);
    const current = id ? await getWorkflow(req.user.tenantId, id) : null;
    if (!current) return res.status(404).json({ success: false, message: 'Workflow not found.' });
    await deleteWorkflow(req.user.tenantId, id);
    audit(req, 'workflow.deleted', `${current.name} (#${id})`);
    return res.json({ success: true });
  } catch (error) {
    return sendError(res, error, 'The workflow could not be deleted.', 'workflow delete');
  }
});

// "Run test": checks a rule (saved or not yet saved) against one load. Changes nothing.
app.post('/api/automation/test', authMiddleware, requirePermission('shipments:read'), async (req, res) => {
  try {
    const workflow = studio.validateWorkflow(req.body?.workflow);
    const shipmentId = parseShipmentId(req.body?.shipmentId);
    const shipment = shipmentId ? await getShipment(req.user.tenantId, shipmentId) : null;
    if (!shipment) return res.status(404).json({ success: false, message: 'Load not found.' });
    // The test pretends the trigger just happened to this load.
    const result = studio.evaluate(workflow, { type: workflow.trigger, status: workflow.triggerStatus }, shipment);
    return res.json({
      success: true,
      shipment: { id: `SHP-${shipment.id}`, customer: shipment.customer, origin: shipment.origin, destination: shipment.destination, equipment: shipment.equipment, status: shipment.status },
      trigger: studio.describeTrigger(workflow),
      conditions: result.conditions,
      matched: result.matched,
      actions: result.matched ? workflow.actions.map((action) => studio.describeAction(action, shipment)) : []
    });
  } catch (error) {
    return sendError(res, error, 'The test could not run.', 'workflow test');
  }
});

/* =========================================================
   AI COMMAND CENTER: what the agents do for this company, and its switches
   ========================================================= */
app.get('/api/ai/command-center', authMiddleware, requirePermission('shipments:read'), async (req, res) => {
  try {
    const [tenant, stats, loads] = await Promise.all([
      getTenant(req.user.tenantId),
      getCommandCenterStats(req.user.tenantId, 30),
      listSentinelLoads(req.user.tenantId)
    ]);
    const risks = sentinelAgent.assess(await geo.annotateOffRoute(loads), { staleHours: STALE_TRACKING_HOURS, offRouteKm: geo.offRouteKm() });
    const messagingOn = messaging.channelsOf(messaging.resolveConfig(tenant, DEFAULT_TENANT_ID).config).length > 0;
    const nexusOn = process.env.NEXUS_ENABLED !== 'false';
    const automations = Object.entries(nexus.AUTOMATIONS).map(([key, label]) => ({ key, label, on: tenant.automationSettings?.[key] !== false }));
    return res.json({
      success: true,
      nexus: { enabled: nexusOn },
      agents: {
        ai: aiGateway.isEnabled(),
        messaging: messagingOn,
        map: geo.enabled()
      },
      automations,
      canChange: hasPermission(req.user, 'settings:write'),
      live: { ...stats.live, risks: risks.length, urgentRisks: risks.filter((risk) => risk.severity === 'high').length, openTasks: stats.open },
      performance: {
        days: stats.days,
        prepared: stats.prepared,
        handled: stats.done + stats.dismissed,
        done: stats.done,
        dismissed: stats.dismissed,
        minutesToHandle: stats.minutesToHandle,
        aiCalls: stats.aiCalls,
        aiSuccessRate: stats.aiCalls ? Math.round((stats.aiSucceeded / stats.aiCalls) * 100) : null,
        byKind: stats.byKind,
        daily: stats.daily
      },
      activity: stats.activity
    });
  } catch (error) {
    return sendError(res, error, 'AI Command Center unavailable.', 'command center');
  }
});

// Switch automatic jobs on or off for this company (administrators). Only known keys and true/false are accepted.
app.put('/api/settings/automations', authMiddleware, requirePermission('settings:write'), async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const keys = Object.keys(body);
  if (!keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(nexus.AUTOMATIONS, key) || typeof body[key] !== 'boolean')) {
    return res.status(400).json({ success: false, message: `Send one or more of ${Object.keys(nexus.AUTOMATIONS).join(', ')} with true or false.` });
  }
  try {
    const tenant = await getTenant(req.user.tenantId);
    const next = { ...(tenant.automationSettings || {}) };
    keys.forEach((key) => { next[key] = body[key]; });
    await setTenantAutomationSettings(req.user.tenantId, next);
    audit(req, 'automation.changed', keys.map((key) => `${nexus.AUTOMATIONS[key]}: ${body[key] ? 'on' : 'off'}`).join('; '));
    return res.json({ success: true, automations: Object.entries(nexus.AUTOMATIONS).map(([key, label]) => ({ key, label, on: next[key] !== false })) });
  } catch (error) {
    return sendError(res, error, 'Settings could not be saved.', 'automations');
  }
});

/* =========================================================
   QUOTES: price offers to customers, before a load exists
   ========================================================= */
const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'declined'];
const QUOTE_VALID_DAYS = 7;
const isoDay = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

// Reads quote fields from a request. partial = only what was sent (editing). Returns { fields } or { error }.
function readQuoteFields(body, { partial = false, weightUnit = WEIGHT_UNIT } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const fields = {};
  const has = (key) => b[key] !== undefined;
  for (const [key, max] of [['customer', MAX_LEN.customer], ['origin', MAX_LEN.origin], ['destination', MAX_LEN.destination]]) {
    if (!partial || has(key)) {
      if (typeof b[key] !== 'string' || !b[key].trim() || b[key].trim().length > max) return { error: `${key} is required (at most ${max} characters).` };
      fields[key] = b[key].trim();
    }
  }
  if (!partial || has('equipment')) {
    if (!EQUIPMENT.includes(b.equipment)) return { error: `Equipment must be one of: ${EQUIPMENT.join(', ')}.` };
    fields.equipment = b.equipment;
  }
  if (!partial || has('price')) {
    const price = parseMoney(b.price);
    if (price === null) return { error: `The price must be between 0.01 and ${MAX_RATE.toLocaleString('en-US')}.` };
    fields.price = price;
  }
  if (has('carrierCost')) {
    const empty = b.carrierCost === null || b.carrierCost === '';
    const cost = empty ? null : parseMoney(b.carrierCost);
    if (!empty && cost === null) return { error: 'The carrier cost must be a positive number.' };
    fields.carrierCost = cost;
  }
  if (has('weight')) {
    const empty = b.weight === null || b.weight === '';
    const weight = empty ? null : parsePositiveNumber(b.weight, MAX_WEIGHT);
    if (!empty && weight === null) return { error: `Weight must be a number up to ${MAX_WEIGHT.toLocaleString('en-US')} ${weightUnit}.` };
    fields.weight = weight;
  }
  for (const key of ['pickup', 'delivery']) {
    if (!has(key)) continue;
    if (b[key] === null || b[key] === '') { fields[key] = null; continue; }
    if (!parseIsoDate(b[key])) return { error: 'Dates must be YYYY-MM-DD.' };
    fields[key] = b[key];
  }
  if (fields.pickup && fields.delivery && fields.delivery < fields.pickup) return { error: 'Delivery date must be on or after pickup date.' };
  if (has('validUntil')) {
    if (!parseIsoDate(b.validUntil)) return { error: 'Valid until must be a date (YYYY-MM-DD).' };
    fields.validUntil = b.validUntil;
  } else if (!partial) {
    fields.validUntil = isoDay(QUOTE_VALID_DAYS);
  }
  const phone = readOptionalPhone(b, 'customerPhone');
  if (phone.error) return { error: phone.error };
  if (has('customerPhone')) fields.customerPhone = phone.value;
  const notes = readOptionalText(b, 'notes', 1000);
  if (notes.error) return { error: notes.error };
  if (has('notes')) fields.notes = notes.value;
  return { fields };
}

// What a lane usually costs, so the quote is priced on facts (PULSE). Nothing is saved.
async function laneEstimate(tenantId, { origin, destination, equipment }) {
  const formatMoney = moneyIn((await regionOf(tenantId)).currency);
  const data = await getLanePriceData(tenantId, { origin, destination, equipment });
  const first = pulseAgent.analyzePrices(data, { formatMoney });
  const expectedCost = first.carrier?.typical ?? first.market?.rate ?? null;
  const analysis = expectedCost ? pulseAgent.analyzePrices(data, { rate: expectedCost, formatMoney }) : first;
  return { ...analysis, expectedCarrierCost: expectedCost };
}

app.get('/api/quotes/estimate', authMiddleware, requirePermission('shipments:read'), async (req, res) => {
  const origin = String(req.query.origin || '').trim();
  const destination = String(req.query.destination || '').trim();
  const equipment = String(req.query.equipment || '');
  if (!origin || !destination || origin.length > MAX_LEN.origin || destination.length > MAX_LEN.destination || (equipment && !EQUIPMENT.includes(equipment))) {
    return res.status(400).json({ success: false, message: 'Enter the origin, destination and equipment.' });
  }
  try {
    return res.json({ success: true, ...(await laneEstimate(req.user.tenantId, { origin, destination, equipment })) });
  } catch (error) {
    return sendError(res, error, 'Price check unavailable.', 'quote estimate');
  }
});

app.get('/api/quotes', authMiddleware, requirePermission('shipments:read'), async (req, res) => {
  try {
    res.json({ success: true, quotes: await listQuotes(req.user.tenantId) });
  } catch (error) {
    return sendError(res, error, 'Quotes unavailable.', 'quotes');
  }
});

app.post('/api/quotes', authMiddleware, requirePermission('shipments:create'), async (req, res) => {
  const parsed = readQuoteFields(req.body, { weightUnit: req.user.region.weightUnit });
  if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
  try {
    const quote = await createQuote(req.user.tenantId, parsed.fields, req.user.id);
    return res.status(201).json({ success: true, quote });
  } catch (error) {
    return sendError(res, error, 'Quote could not be saved.', 'quote create');
  }
});

const readQuoteId = (raw) => {
  const match = /^(?:Q-)?([1-9]\d{0,9})$/i.exec(String(raw));
  return match ? Number(match[1]) : null;
};

app.get('/api/quotes/:id', authMiddleware, requirePermission('shipments:read'), async (req, res) => {
  const id = readQuoteId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Valid quote number is required.' });
  try {
    const quote = await getQuote(req.user.tenantId, id);
    if (!quote) return res.status(404).json({ success: false, message: 'Quote not found.' });
    return res.json({ success: true, quote });
  } catch (error) {
    return sendError(res, error, 'Quote unavailable.', 'quote');
  }
});

// Edit a quote and/or move it: draft -> sent -> accepted / declined.
app.patch('/api/quotes/:id', authMiddleware, requirePermission('shipments:create'), async (req, res) => {
  const id = readQuoteId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Valid quote number is required.' });
  const { status, ...rest } = req.body || {};
  if (status !== undefined && !QUOTE_STATUSES.includes(status)) {
    return res.status(400).json({ success: false, message: `Status must be one of: ${QUOTE_STATUSES.join(', ')}.` });
  }
  const parsed = readQuoteFields(rest, { partial: true, weightUnit: req.user.region.weightUnit });
  if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
  if (!status && !Object.keys(parsed.fields).length) return res.status(400).json({ success: false, message: 'Send at least one change.' });
  try {
    const quote = await updateQuote(req.user.tenantId, id, parsed.fields, status);
    return res.json({ success: true, quote });
  } catch (error) {
    return sendError(res, error, 'Quote could not be changed.', 'quote update');
  }
});

// The customer said yes: the quote becomes a load. Dates and weight are required now if the quote had none.
app.post('/api/quotes/:id/convert', authMiddleware, requirePermission('shipments:create'), async (req, res) => {
  const id = readQuoteId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Valid quote number is required.' });
  try {
    const quote = await getQuote(req.user.tenantId, id);
    if (!quote) return res.status(404).json({ success: false, message: 'Quote not found.' });
    const pickup = req.body?.pickup || quote.pickup;
    const delivery = req.body?.delivery || quote.delivery;
    const weightValue = req.body?.weight !== undefined && req.body?.weight !== '' ? parsePositiveNumber(req.body.weight, MAX_WEIGHT) : quote.weight;
    if (!parseIsoDate(pickup) || !parseIsoDate(delivery) || delivery < pickup) {
      return res.status(400).json({ success: false, message: 'Pickup and delivery dates (YYYY-MM-DD, delivery not before pickup) are needed to create the load.' });
    }
    if (!weightValue) return res.status(400).json({ success: false, message: `The weight (${req.user.region.weightUnit}) is needed to create the load.` });
    await requireShipmentRoom(req.user.tenantId);
    const shipmentId = await convertQuote(req.user.tenantId, id, { pickup, delivery, weight: `${weightValue} ${req.user.region.weightUnit}`, actorId: req.user.id });
    return res.status(201).json({ success: true, shipmentId: `SHP-${shipmentId}`, quote: await getQuote(req.user.tenantId, id) });
  } catch (error) {
    return sendError(res, error, 'The load could not be created.', 'quote convert');
  }
});

// A printable offer for the customer (print, or "Save as PDF" in the browser).
app.get('/api/quotes/:id/print', authMiddleware, requirePermission('shipments:read'), async (req, res) => {
  const id = readQuoteId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Valid quote number is required.' });
  try {
    const quote = await getQuote(req.user.tenantId, id);
    if (!quote) return res.status(404).json({ success: false, message: 'Quote not found.' });
    const e = escapeHtml;
    const row = (label, value) => `<tr><th>${e(label)}</th><td>${e(value || '—')}</td></tr>`;
    res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Quote ${e(quote.number)}</title><link rel="stylesheet" href="/invoice.css"></head>
<body><main class="invoice">
<header><div><h1>${e(req.user.tenantName || 'Quote')}</h1><p>Freight quote</p></div>
<div class="meta"><p><strong>Quote</strong> ${e(quote.number)}</p><p><strong>Date</strong> ${e(String(quote.createdAt).slice(0, 10))}</p><p><strong>Valid until</strong> ${e(quote.validUntil)}</p></div></header>
<section><h2>For</h2><p class="party">${e(quote.customer)}</p></section>
<table>
${row('Route', `${quote.origin} → ${quote.destination}`)}
${row('Equipment', quote.equipment)}
${row('Weight', quote.weight ? `${quote.weight} ${req.user.region.weightUnit}` : '')}
${row('Pickup', quote.pickup)}
${row('Delivery', quote.delivery)}
${row('Notes', quote.notes)}
</table>
<p class="total"><span>Price</span><strong>${e(formatMoney(quote.price, req.user.region.currency))}</strong></p>
<p class="state">Price for one full truck on this route. Valid until ${e(quote.validUntil)}.</p>
<p class="actions"><button type="button" id="printButton">Print or save as PDF</button></p>
</main><script src="/print.js"></script></body></html>`);
  } catch (error) {
    return sendError(res, error, 'Quote unavailable.', 'quote print');
  }
});

// A link the customer can open without an account. Creating a new link makes the old one stop working.
app.post('/api/shipments/:id/share', authMiddleware, requirePermission('shipments:message'), async (req, res) => {
  const shipmentId = parseShipmentId(req.params.id);
  if (!shipmentId) return res.status(400).json({ success: false, message: 'Valid shipment ID is required.' });
  try {
    const token = crypto.randomBytes(24).toString('hex');
    if (!(await setShipmentShareTokenHash(req.user.tenantId, shipmentId, rateLimitKey(token)))) return res.status(404).json({ success: false, message: 'Shipment not found.' });
    audit(req, 'tracking_link.created', `SHP-${shipmentId}`);
    return res.status(201).json({ success: true, path: `/track/${token}`, url: PUBLIC_URL ? `${PUBLIC_URL}/track/${token}` : null });
  } catch (error) {
    return sendError(res, error, 'Link could not be created.', 'share');
  }
});

app.delete('/api/shipments/:id/share', authMiddleware, requirePermission('shipments:message'), async (req, res) => {
  const shipmentId = parseShipmentId(req.params.id);
  if (!shipmentId) return res.status(400).json({ success: false, message: 'Valid shipment ID is required.' });
  try {
    if (!(await setShipmentShareTokenHash(req.user.tenantId, shipmentId, null))) return res.status(404).json({ success: false, message: 'Shipment not found.' });
    audit(req, 'tracking_link.removed', `SHP-${shipmentId}`);
    return res.json({ success: true });
  } catch (error) {
    return sendError(res, error, 'Link could not be removed.', 'unshare');
  }
});

const publicTrackLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => `track:${getClientIp(req)}`,
  message: 'Too many requests.'
});

// What the customer sees: where the load is. Nothing about prices, phones, the carrier or other loads.
app.get('/api/public/track/:token', publicTrackLimiter, async (req, res) => {
  try {
    const token = String(req.params.token);
    const shipment = /^[a-f0-9]{48}$/.test(token) ? await findSharedShipment(rateLimitKey(token)) : null;
    if (!shipment) return res.status(404).json({ success: false, message: 'This tracking link is not valid any more.' });
    return res.json({
      success: true,
      company: shipment.company,
      load: `SHP-${shipment.id}`,
      reference: shipment.reference || null,
      origin: shipment.origin,
      destination: shipment.destination,
      pickup: shipment.pickup,
      delivery: shipment.delivery,
      status: shipment.status,
      lastLocation: shipment.lastLocation || null,
      lastTrackedAt: shipment.lastTrackedAt || null,
      eta: shipment.eta || null,
      truckPlate: shipment.truckPlate || null,
      // How this company shows times (the stored values are UTC).
      timeZone: timeLib.timeZoneOr(shipment.timeZone, TIMEZONE),
      locale: timeLib.localeOr(shipment.locale, LOCALE)
    });
  } catch (error) {
    return sendError(res, error, 'Tracking unavailable.', 'public track');
  }
});

app.get('/track/:token', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'track.html')));
// Public price list (no sign-in).
app.get('/pricing', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'pricing.html')));
app.get('/signup', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'signup.html')));
// Terms, Privacy and Refund policy (public; Paddle and the law require them before selling).
for (const key of Object.keys(legal.PAGES)) {
  app.get(`/${key}`, (req, res) => res.type('html').send(legal.renderPage(key)));
}

/* =========================================================
   BACKUPS: a daily copy of the whole database (platform owner only)
   ========================================================= */
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(path.resolve(DB_PATH)), 'backups');
const BACKUP_KEEP = readPositiveInteger(process.env.BACKUP_KEEP, 7);
const BACKUP_NAME = /^veyra-\d{8}-\d{6}\.db$/;

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter((name) => BACKUP_NAME.test(name)).sort().reverse().map((name) => {
    const stat = fs.statSync(path.join(BACKUP_DIR, name));
    return { name, size: stat.size, createdAt: stat.mtime.toISOString() };
  });
}

let backupRunning = false;
async function createBackup() {
  if (backupRunning) throw httpError(409, 'A backup is being made right now.');
  backupRunning = true;
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const name = `veyra-${stamp}.db`;
    await backupTo(path.join(BACKUP_DIR, name));
    // Keep the newest few; older copies are removed so the disk does not fill up.
    listBackups().slice(BACKUP_KEEP).forEach((old) => fs.rmSync(path.join(BACKUP_DIR, old.name), { force: true }));
    return listBackups().find((entry) => entry.name === name);
  } finally {
    backupRunning = false;
  }
}

let backupTimer = null;
function startBackups() {
  // PostgreSQL is backed up by its provider (for example Railway's database backups), not by Veyra.
  if (backupTimer || process.env.BACKUP_ENABLED === 'false' || databaseIsPostgres) return;
  const check = async () => {
    try {
      const newest = listBackups()[0];
      if (!newest || Date.now() - Date.parse(newest.createdAt) > 24 * 60 * 60 * 1000) await createBackup();
    } catch (error) {
      console.error('[backup] failed:', error.message);
    }
  };
  backupTimer = setInterval(check, 60 * 60 * 1000);
  backupTimer.unref();
  setTimeout(check, 60000).unref();
}

app.get('/api/platform/backups', authMiddleware, requirePlatformAdmin, (req, res) => {
  try {
    res.json({ success: true, backups: listBackups(), keep: BACKUP_KEEP, automatic: process.env.BACKUP_ENABLED !== 'false' });
  } catch (error) {
    return sendError(res, error, 'Backups unavailable.', 'backups');
  }
});

app.post('/api/platform/backups', authMiddleware, requirePlatformAdmin, async (req, res) => {
  try {
    const backup = await createBackup();
    audit(req, 'backup.created', backup.name);
    return res.status(201).json({ success: true, backup });
  } catch (error) {
    return sendError(res, error, 'Backup could not be made.', 'backup create');
  }
});

// The file holds every company's data: only the platform owner may download it, and each download is logged.
app.get('/api/platform/backups/:name/file', authMiddleware, requirePlatformAdmin, (req, res) => {
  const name = String(req.params.name);
  if (!BACKUP_NAME.test(name) || !fs.existsSync(path.join(BACKUP_DIR, name))) return res.status(404).json({ success: false, message: 'Backup not found.' });
  audit(req, 'backup.downloaded', name);
  return res.download(path.join(BACKUP_DIR, name), name);
});

app.get('/api/shipments/:id/events', authMiddleware, requirePermission('shipments:read'), async (req, res) => {
  try {
    const shipmentId = parseShipmentId(req.params.id);
    if (!shipmentId) {
      return res.status(400).json({ success: false, message: 'Valid shipment ID is required.' });
    }
    return res.json({ success: true, events: await listShipmentEvents(req.user.tenantId, shipmentId) });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Shipment history unavailable.' });
  }
});

// Where is the truck? Location updates (typed check calls and GPS), newest first.
app.get('/api/shipments/:id/tracking', authMiddleware, requirePermission('shipments:read'), async (req, res) => {
  const shipmentId = parseShipmentId(req.params.id);
  if (!shipmentId) return res.status(400).json({ success: false, message: 'Valid shipment ID is required.' });
  try {
    if (!(await getShipment(req.user.tenantId, shipmentId))) return res.status(404).json({ success: false, message: 'Shipment not found.' });
    return res.json({ success: true, updates: await listTrackingUpdates(req.user.tenantId, shipmentId) });
  } catch (error) {
    console.error('[tracking list] failed:', error.message);
    return res.status(500).json({ success: false, message: 'Tracking history unavailable.' });
  }
});

app.post('/api/shipments/:id/tracking', authMiddleware, requirePermission('shipments:track'), async (req, res) => {
  const shipmentId = parseShipmentId(req.params.id);
  const location = req.body?.location;
  if (!shipmentId || typeof location !== 'string' || !location.trim() || location.trim().length > MAX_LEN.location) {
    return res.status(400).json({ success: false, message: `A current location (at most ${MAX_LEN.location} characters) is required.` });
  }
  const eta = parseEta(req.body?.eta);
  const note = readOptionalText(req.body, 'note', MAX_LEN.note);
  const invalid = eta.error || note.error;
  if (invalid) return res.status(400).json({ success: false, message: invalid });
  try {
    const update = await addTrackingUpdate(req.user.tenantId, shipmentId, { location: location.trim(), eta: eta.value, note: note.value }, req.user.id);
    return res.status(201).json({ success: true, update });
  } catch (error) {
    return sendError(res, error, 'Location update failed.', 'tracking add');
  }
});

/* ---------- RELAY: messages to driver / carrier / customer ---------- */
const MESSAGE_RECIPIENTS = Object.keys(relayAgent.PURPOSES);
const MESSAGE_CHANNELS = ['sms', 'whatsapp'];

app.get('/api/shipments/:id/messages', authMiddleware, requirePermission('shipments:read'), async (req, res) => {
  const shipmentId = parseShipmentId(req.params.id);
  if (!shipmentId) return res.status(400).json({ success: false, message: 'Valid shipment ID is required.' });
  try {
    if (!(await getShipment(req.user.tenantId, shipmentId))) return res.status(404).json({ success: false, message: 'Shipment not found.' });
    return res.json({ success: true, messages: await listMessages(req.user.tenantId, shipmentId) });
  } catch (error) {
    return sendError(res, error, 'Messages unavailable.', 'messages list');
  }
});

app.post('/api/shipments/:id/messages/draft', authMiddleware, requirePermission('shipments:message'), async (req, res) => {
  const shipmentId = parseShipmentId(req.params.id);
  const { recipient, purpose } = req.body || {};
  if (!shipmentId || !MESSAGE_RECIPIENTS.includes(recipient)) {
    return res.status(400).json({ success: false, message: `Choose who the message is for: ${MESSAGE_RECIPIENTS.join(', ')}.` });
  }
  try {
    const shipment = await getShipment(req.user.tenantId, shipmentId);
    if (!shipment) return res.status(404).json({ success: false, message: 'Shipment not found.' });
    const draft = relayAgent.draftMessage({
      shipment,
      recipient,
      purpose,
      company: req.user.tenantName,
      formatMoney: moneyIn(req.user.region.currency)
    });
    const tenant = await getTenant(req.user.tenantId);
    return res.json({ success: true, draft: { ...draft, recipient, channels: messaging.publicStatus(tenant, DEFAULT_TENANT_ID).channels } });
  } catch (error) {
    return sendError(res, error, 'Draft failed.', 'message draft');
  }
});

app.post('/api/shipments/:id/messages', authMiddleware, requirePermission('shipments:message'), messageLimiter, needsPlan('messaging'), async (req, res) => {
  const shipmentId = parseShipmentId(req.params.id);
  const { recipient, channel, body } = req.body || {};
  if (!shipmentId || !MESSAGE_RECIPIENTS.includes(recipient) || !MESSAGE_CHANNELS.includes(channel)
    || typeof body !== 'string' || !body.trim() || body.length > MAX_LEN.message) {
    return res.status(400).json({ success: false, message: `A recipient, a channel (sms or whatsapp) and a message of at most ${MAX_LEN.message} characters are required.` });
  }
  try {
    const shipment = await getShipment(req.user.tenantId, shipmentId);
    if (!shipment) return res.status(404).json({ success: false, message: 'Shipment not found.' });
    const delivered = await deliverMessage(req, shipment, { recipient, channel, body: body.trim() });
    if (delivered.result.status !== 'sent') {
      return res.status(502).json({ success: false, message: `The message was not delivered: ${delivered.result.error}`, messageId: delivered.saved.id });
    }
    return res.status(201).json({ success: true, message: { id: delivered.saved.id, status: delivered.result.status, to: delivered.to } });
  } catch (error) {
    return sendError(res, error, 'Message could not be sent.', 'message send');
  }
});

// Sends one message with the signed-in company's Twilio account and records the result.
// The number always comes from the load record, never from the browser.
async function deliverMessage(req, shipment, { recipient, channel, body }) {
  const to = relayAgent.recipientPhone(shipment, recipient);
  if (!to) throw httpError(400, `There is no ${recipient} phone number on this load.`);
  const tenant = await getTenant(req.user.tenantId);
  const { config } = messaging.resolveConfig(tenant, DEFAULT_TENANT_ID);
  // A one-time secret in the report address ties Twilio's delivery report to this message.
  const callbackToken = PUBLIC_URL ? crypto.randomBytes(24).toString('hex') : null;
  const result = await messaging.send(config, {
    channel, to, body, statusCallback: callbackToken ? `${PUBLIC_URL}${TWILIO_STATUS_PREFIX}${callbackToken}` : null
  });
  const saved = await createMessage(req.user.tenantId, {
    callbackTokenHash: callbackToken && result.status === 'sent' ? rateLimitKey(callbackToken) : null,
    shipmentId: shipment.id,
    channel,
    recipientType: recipient,
    toPhone: to,
    body,
    status: result.status,
    provider: result.provider,
    providerMessageId: result.providerMessageId,
    error: result.error,
    createdBy: req.user.id
  });
  return { result, saved, to };
}

/* =========================================================
   NEXUS TASKS: what the agents prepared for a person
   ========================================================= */
app.get('/api/tasks', authMiddleware, requirePermission('shipments:read'), async (req, res) => {
  try {
    res.json({ success: true, tasks: await listTasks(req.user.tenantId, { status: 'open' }) });
  } catch (error) {
    return sendError(res, error, 'Tasks unavailable.', 'tasks');
  }
});

app.post('/api/tasks/:id/dismiss', authMiddleware, requirePermission('shipments:read'), async (req, res) => {
  const taskId = Number(req.params.id);
  if (!Number.isInteger(taskId) || taskId <= 0) return res.status(400).json({ success: false, message: 'Valid task ID is required.' });
  try {
    if (!(await getTask(req.user.tenantId, taskId))) return res.status(404).json({ success: false, message: 'Task not found.' });
    await resolveTask(req.user.tenantId, taskId, { status: 'dismissed', userId: req.user.id });
    return res.json({ success: true });
  } catch (error) {
    return sendError(res, error, 'Task could not be updated.', 'task dismiss');
  }
});

// A person approves a drafted message: it is sent now (optionally edited), and the task is closed.
app.post('/api/tasks/:id/approve', authMiddleware, requirePermission('shipments:message'), messageLimiter, async (req, res) => {
  const taskId = Number(req.params.id);
  const channel = req.body?.channel;
  const edited = req.body?.body;
  if (!Number.isInteger(taskId) || taskId <= 0 || !MESSAGE_CHANNELS.includes(channel)
    || (edited !== undefined && (typeof edited !== 'string' || !edited.trim() || edited.length > MAX_LEN.message))) {
    return res.status(400).json({ success: false, message: `A task, a channel (sms or whatsapp) and, if you edit it, a message of at most ${MAX_LEN.message} characters are required.` });
  }
  try {
    const task = await getTask(req.user.tenantId, taskId);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });
    if (task.status !== 'open') return res.status(409).json({ success: false, message: 'This task was already handled.' });
    if (task.kind !== 'message' || !task.shipmentId || !MESSAGE_RECIPIENTS.includes(task.payload?.recipient)) {
      return res.status(400).json({ success: false, message: 'Only message tasks can be approved.' });
    }
    const shipment = await getShipment(req.user.tenantId, parseShipmentId(task.shipmentId));
    if (!shipment) return res.status(404).json({ success: false, message: 'Shipment not found.' });
    const body = (edited ?? task.payload.body).trim();
    const delivered = await deliverMessage(req, shipment, { recipient: task.payload.recipient, channel, body });
    if (delivered.result.status !== 'sent') {
      return res.status(502).json({ success: false, message: `The message was not delivered: ${delivered.result.error}`, messageId: delivered.saved.id });
    }
    await resolveTask(req.user.tenantId, taskId, { status: 'done', userId: req.user.id });
    return res.status(201).json({ success: true, message: { id: delivered.saved.id, status: 'sent', to: delivered.to } });
  } catch (error) {
    return sendError(res, error, 'Message could not be sent.', 'task approve');
  }
});

/* =========================================================
   INBOX: orders that arrive by email
   ========================================================= */
app.get('/api/inbox', authMiddleware, requirePermission('shipments:create'), async (req, res) => {
  try {
    res.json({ success: true, items: await listInboxItems(req.user.tenantId) });
  } catch (error) {
    return sendError(res, error, 'Inbox unavailable.', 'inbox');
  }
});

app.post('/api/inbox/:id/dismiss', authMiddleware, requirePermission('shipments:create'), async (req, res) => {
  const itemId = Number(req.params.id);
  if (!Number.isInteger(itemId) || itemId <= 0) return res.status(400).json({ success: false, message: 'Valid inbox ID is required.' });
  try {
    if (!(await updateInboxItem(req.user.tenantId, itemId, { status: 'dismissed' }))) return res.status(404).json({ success: false, message: 'Message not found.' });
    await resolveTasksByKey(req.user.tenantId, `inbox:${itemId}`, { status: 'dismissed', userId: req.user.id });
    await deleteInboxAttachments(req.user.tenantId, itemId);
    return res.json({ success: true });
  } catch (error) {
    return sendError(res, error, 'Message could not be dismissed.', 'inbox dismiss');
  }
});

// Read a stored email with FLOW on demand (when it was not read automatically).
app.post('/api/inbox/:id/parse', authMiddleware, requirePermission('shipments:create'), aiLimiter, needsPlan('ai'), async (req, res) => {
  const itemId = Number(req.params.id);
  if (!Number.isInteger(itemId) || itemId <= 0) return res.status(400).json({ success: false, message: 'Valid inbox ID is required.' });
  try {
    const item = await getInboxItem(req.user.tenantId, itemId);
    if (!item) return res.status(404).json({ success: false, message: 'Message not found.' });
    if (['converted', 'dismissed'].includes(item.status)) return res.status(409).json({ success: false, message: 'This message was already handled.' });
    const parsed = await flowAgent.parseOrder(`Subject: ${item.subject || ''}\n\n${item.body}`, flowSettings(req.user.region), agentLogger(req));
    await updateInboxItem(req.user.tenantId, itemId, { status: 'parsed', parsed, error: null });
    return res.json({ success: true, ...parsed });
  } catch (error) {
    return sendError(res, error, 'The AI assistant is unavailable.', 'inbox parse');
  }
});

function flowSettings(region = regionFrom()) {
  return { weightUnit: region.weightUnit, currency: region.currency, equipment: EQUIPMENT, maxRate: MAX_RATE, maxWeight: MAX_WEIGHT };
}

// Which load is an email about? Its number (SHP-12) or, failing that, the load's own reference in the text.
// Only an unambiguous match counts.
async function matchShipmentForEmail(tenantId, message) {
  const text = `${message.subject}\n${message.text}`;
  const found = [];
  for (const id of mentionedShipmentIds(text)) {
    if (await getShipment(tenantId, id)) found.push(id);
  }
  if (found.length === 1) return found[0];
  if (found.length > 1) return null;
  const words = (text.slice(0, 2000).match(/[A-Za-z0-9][A-Za-z0-9\-_/]{3,39}/g) || []).filter((word) => /\d/.test(word));
  const byReference = await findShipmentIdsByReference(tenantId, words);
  return byReference.length === 1 ? byReference[0] : null;
}

// Moves an email's files to a load. A file whose name or email does not say what it is counts as a CMR
// (proof of delivery once the load is delivered), because that is what people send about a running load.
async function attachEmailFilesToShipment(tenantId, inboxId, shipment, { context = '', uploadedBy = null } = {}) {
  const fallback = shipment.status === 'Delivered' ? 'pod' : 'cmr';
  return moveInboxAttachmentsToShipment(tenantId, inboxId, shipment.id, {
    uploadedBy, typeFor: (filename) => guessDocumentType(filename, context) || fallback, maxPerShipment: DOC_MAX_PER_SHIPMENT
  });
}

app.post(`${INBOX_WEBHOOK_PREFIX}:token`, (req, res, next) => {
  req.inboxTokenHash = rateLimitKey(String(req.params.token));
  return inboxIpLimiter(req, res, (error) => (error ? next(error) : inboxLimiter(req, res, next)));
}, async (req, res, next) => {
  // The address is checked before the (possibly large) body is read.
  try {
    req.inboxTenant = await findTenantByInboxTokenHash(req.inboxTokenHash);
    if (!req.inboxTenant) return res.status(404).json({ success: false, message: 'Unknown inbox address.' });
    await requireCapability(req.inboxTenant.id, 'email');
    return next();
  } catch (error) {
    return sendError(res, error, 'Message could not be stored.', 'inbox webhook');
  }
}, parseInboxBody, async (req, res) => {
  try {
    let message;
    try {
      message = parseInbound(req.body, req.headers['content-type'], DOC_MAX_BYTES);
    } catch (_) {
      // Providers retry on errors, so an unusable message is acknowledged, not rejected.
      return res.json({ success: true, ignored: 'unreadable' });
    }
    const outcome = await ingestEmail(req.inboxTenant, message);
    return res.status(outcome.status).json(outcome.body);
  } catch (error) {
    return sendError(res, error, 'Message could not be stored.', 'inbox webhook');
  }
});

// Everything that happens to an incoming email, whether it was posted to the inbox address or read from a
// company's mailbox over IMAP: keep real documents, store the email, put files on the load it names, or
// hand it to NEXUS. Returns { status, body }.
async function ingestEmail(tenant, message) {
  // Keep real documents only: the type comes from the file's first bytes, never from its name.
  const files = [];
  let filesSkipped = 0;
  for (const attachment of message.attachments || []) {
    const mime = attachment.content.length <= DOC_MAX_BYTES ? detectMime(attachment.content) : null;
    const logo = mime && mime !== 'application/pdf' && attachment.content.length < INBOX_MIN_IMAGE_BYTES;
    if (logo) continue;
    if (!mime || files.length >= INBOX_MAX_ATTACHMENTS) {
      filesSkipped += 1;
      continue;
    }
    files.push({ filename: safeFilename(attachment.filename, mime), mime, content: attachment.content });
  }
  if (!message.text && !files.length) return { status: 200, body: { success: true, ignored: 'empty' } };
  if ((await countInboxItemsToday(tenant.id)) >= INBOX_DAILY_LIMIT) {
    return { status: 429, body: { success: false, message: 'Daily limit of incoming messages reached.' } };
  }
  const settings = await getTenant(tenant.id);
  const allowed = senderAllowed(message.from, settings.allowedSenders);
  const { item, duplicate } = await createInboxItem(tenant.id, {
    externalId: message.messageId || null,
    from: message.from,
    subject: message.subject,
    body: message.text,
    status: allowed ? 'new' : 'blocked'
  });
  if (duplicate) return { status: 200, body: { success: true, duplicate: true } };
  // Files from senders who are not allowed are not kept at all.
  if (!allowed) return { status: 201, body: { success: true, id: item.id, accepted: false } };
  for (const file of files) await addInboxAttachment(tenant.id, item.id, file);

  // An email with files that names one of this company's loads: the files go straight to that load.
  const shipmentId = files.length ? await matchShipmentForEmail(tenant.id, message) : null;
  if (shipmentId) {
    const shipment = await getShipment(tenant.id, shipmentId);
    const moved = await attachEmailFilesToShipment(tenant.id, item.id, shipment, { context: `${message.subject} ${message.text}` });
    if (moved.documentIds.length || !moved.skipped) {
      await updateInboxItem(tenant.id, item.id, { status: 'attached', shipmentId });
      nexus.emit('inbox.attached', { tenantId: tenant.id, inboxId: item.id, shipmentId, documentIds: moved.documentIds, skipped: moved.skipped, from: message.from }, { idempotencyKey: `inbox-attached:${item.id}` });
      return { status: 201, body: { success: true, id: item.id, accepted: true, attachedTo: `SHP-${shipmentId}`, documents: moved.documentIds.length, filesSkipped } };
    }
  }
  nexus.emit('inbox.received', { tenantId: tenant.id, inboxId: item.id }, { idempotencyKey: `inbox:${item.id}` });
  return { status: 201, body: { success: true, id: item.id, accepted: true, files: files.length, filesSkipped } };
}

// A file that came with an email (before it is on a load). Always a download.
app.get('/api/inbox/:id/attachments/:fileId/file', authMiddleware, requirePermission('shipments:create'), async (req, res) => {
  const itemId = Number(req.params.id);
  const fileId = Number(req.params.fileId);
  if (!Number.isInteger(itemId) || itemId <= 0 || !Number.isInteger(fileId) || fileId <= 0) return res.status(400).json({ success: false, message: 'Valid IDs are required.' });
  try {
    const file = await getInboxAttachmentFile(req.user.tenantId, itemId, fileId);
    if (!file) return res.status(404).json({ success: false, message: 'File not found.' });
    res.attachment(file.filename);
    res.type(file.mime);
    return res.send(file.content);
  } catch (error) {
    return sendError(res, error, 'File unavailable.', 'inbox file');
  }
});

/* =========================================================
   MAILBOX (IMAP): VEYRA reads a company's order mailbox itself
   ========================================================= */
const IMAP_POLL_MINUTES = readPositiveInteger(process.env.IMAP_POLL_MINUTES, 5);
const MAILBOX_BATCH = 20;
const mailboxBusy = new Set();

// What the browser may know: where it reads, when it last looked, whether that worked. Never the password.
function mailboxStatus(tenant) {
  const settings = tenant?.imapSettings;
  const provider = settings?.provider || null;
  return {
    configured: Boolean(settings),
    provider,
    host: provider ? (mailapi.PROVIDERS[provider]?.label || provider) : (settings?.host || null),
    user: settings?.email || settings?.user || null,
    mailbox: settings?.mailbox || null,
    // Which "sign in with ..." buttons can be offered: the platform owner must have registered the app first.
    providers: Object.fromEntries(Object.keys(mailapi.PROVIDERS).map((name) => [name, Boolean(PUBLIC_URL && mailapi.enabled(name))])),
    lastCheckedAt: tenant?.imapState?.checkedAt || null,
    lastError: tenant?.imapState?.error || null,
    lastImported: tenant?.imapState?.imported ?? null,
    pollMinutes: IMAP_POLL_MINUTES
  };
}

// Reads new messages of one company's mailbox and runs each through the same steps as an emailed inbox address.
// A message the daily limit turns away is left for the next round, not lost.
async function pollMailbox(tenantId) {
  if (mailboxBusy.has(tenantId)) return { busy: true };
  mailboxBusy.add(tenantId);
  try {
    const tenant = await getTenant(tenantId);
    if (!tenant?.imapSettings) return { configured: false };
    // A plan without email automation keeps the settings but stops reading the mailbox.
    const plan = plans.resolvePlan(tenant);
    if (plan.locked || !plan.capabilities.includes('email')) return { configured: true, paused: true };
    const previous = tenant.imapState;
    const viaApi = Boolean(tenant.imapSettings.provider);
    const label = viaApi ? tenant.imapSettings.provider : 'imap';
    const position = viaApi
      ? (Number.isFinite(previous?.after) ? { after: previous.after } : null)
      : (Number.isInteger(previous?.lastUid) ? { uidValidity: previous.uidValidity, lastUid: previous.lastUid } : null);
    try {
      const options = { maxMessages: MAILBOX_BATCH, maxBytes: INBOX_MAX_BYTES };
      const result = viaApi ? await mailapi.fetchNew(tenant.imapSettings, position, options) : await imap.fetchNew(tenant.imapSettings, position, options);
      let imported = 0;
      let finalState = result.state;
      for (const entry of result.messages) {
        let message;
        try {
          const parsed = parseEmail(entry.raw);
          message = {
            from: parsed.from,
            subject: parsed.subject,
            text: (parsed.text || stripHtml(parsed.html)).trim(),
            messageId: parsed.messageId || `${label}-${result.state.uidValidity || ''}-${entry.uid ?? entry.id}`,
            attachments: parsed.attachments.map((file) => ({ filename: file.filename, content: file.content }))
          };
        } catch (_) {
          continue;
        }
        const outcome = await ingestEmail({ id: tenantId }, message);
        if (outcome.status === 429) {
          // Stay just before this message: the next round starts here.
          finalState = viaApi ? entry.rewind : { uidValidity: result.state.uidValidity, lastUid: Math.min(result.state.lastUid, entry.uid - 1) };
          break;
        }
        if (outcome.body.id) imported += 1;
      }
      await setTenantImapState(tenantId, { ...finalState, checkedAt: new Date().toISOString(), error: null, imported });
      return { configured: true, imported, skipped: result.skipped };
    } catch (error) {
      await setTenantImapState(tenantId, { ...(previous || {}), checkedAt: new Date().toISOString(), error: String(error.message).slice(0, 200), imported: 0 });
      return { configured: true, error: String(error.message).slice(0, 200) };
    }
  } finally {
    mailboxBusy.delete(tenantId);
  }
}

let mailboxTimer = null;
function startMailboxPoller() {
  if (mailboxTimer) return;
  const round = async () => {
    try {
      for (const tenantId of await listTenantIdsWithImap()) await pollMailbox(tenantId);
    } catch (error) {
      console.error('[mailbox] round failed:', error.message);
    }
  };
  mailboxTimer = setInterval(round, IMAP_POLL_MINUTES * 60 * 1000);
  mailboxTimer.unref();
  setTimeout(round, 20000).unref();
}

// "Sign in with Google / Microsoft": the browser is sent to the provider's consent screen and comes back to the
// callback below with a one-time code. The state value is signed, short-lived and tied to this person and company.
const mailRedirectUri = () => `${PUBLIC_URL}/api/integrations/mail-oauth/callback`;

app.get('/api/settings/mail-oauth/:provider/start', authMiddleware, requirePermission('settings:write'), needsPlan('email'), (req, res) => {
  const { provider } = req.params;
  if (!mailapi.isProvider(provider) || !PUBLIC_URL || !mailapi.enabled(provider)) {
    return res.redirect('/?mailbox=error&reason=' + encodeURIComponent('This sign-in is not set up on the server yet.'));
  }
  const state = jwt.sign({ k: 'mail-oauth', t: req.user.tenantId, u: req.user.id, p: provider }, JWT_SECRET, { expiresIn: '10m' });
  return res.redirect(mailapi.authorizeUrl(provider, { redirectUri: mailRedirectUri(), state }));
});

app.get('/api/integrations/mail-oauth/callback', authMiddleware, requirePermission('settings:write'), async (req, res) => {
  const fail = (reason) => res.redirect(`/?mailbox=error&reason=${encodeURIComponent(String(reason).slice(0, 200))}`);
  let claims;
  try {
    claims = jwt.verify(String(req.query.state || ''), JWT_SECRET);
  } catch (_) {
    return fail('The sign-in took too long or is not valid. Start again.');
  }
  if (claims.k !== 'mail-oauth' || claims.u !== req.user.id || claims.t !== req.user.tenantId || !mailapi.isProvider(claims.p)) {
    return fail('This sign-in belongs to another person. Start again.');
  }
  if (req.query.error || typeof req.query.code !== 'string' || !req.query.code) return fail(req.query.error_description || 'The mailbox was not connected.');
  try {
    const tokens = await mailapi.exchangeCode(claims.p, { code: req.query.code, redirectUri: mailRedirectUri() });
    await setTenantImapSettings(req.user.tenantId, { provider: claims.p, email: tokens.email, refreshToken: tokens.refreshToken });
    audit(req, 'mailbox.connected', `${claims.p}: ${tokens.email}`);
    // Remember "now" so only mail that arrives from this moment is read.
    pollMailbox(req.user.tenantId).catch(() => {});
    return res.redirect('/?mailbox=connected');
  } catch (error) {
    return fail(error.message);
  }
});

// The company's mailbox. Checked by logging in before it is saved; the password is stored encrypted and never returned.
// Leave the password empty to keep the saved one when only the other fields change.
app.put('/api/settings/imap', authMiddleware, requirePermission('settings:write'), needsPlan('email'), async (req, res) => {
  const { host, port, user, password, mailbox } = req.body || {};
  const hostName = typeof host === 'string' ? host.trim().toLowerCase() : '';
  const portNumber = port === undefined || port === '' || port === null ? 993 : Number(port);
  const userName = typeof user === 'string' ? user.trim() : '';
  const folder = typeof mailbox === 'string' && mailbox.trim() ? mailbox.trim() : 'INBOX';
  if (!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(hostName) || !hostName.includes('.') && hostName !== 'localhost') {
    return res.status(400).json({ success: false, message: 'Enter the mail server name, for example imap.gmail.com.' });
  }
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) return res.status(400).json({ success: false, message: 'The port must be a number (usually 993).' });
  if (!userName || userName.length > 254 || folder.length > 100 || /[\r\n\0]/.test(userName + folder)) {
    return res.status(400).json({ success: false, message: 'Enter the mailbox user name (usually the full email address).' });
  }
  try {
    const tenant = await getTenant(req.user.tenantId);
    let secret = typeof password === 'string' ? password : '';
    if (!secret && tenant.imapSettings?.host === hostName && tenant.imapSettings?.user === userName) secret = tenant.imapSettings.password;
    if (!secret || secret.length > 500 || /[\r\n\0]/.test(secret)) {
      return res.status(400).json({ success: false, message: 'Enter the mailbox password (for Gmail and Outlook, an app password).' });
    }
    const settings = { host: hostName, port: portNumber, user: userName, password: secret, mailbox: folder };
    const check = await imap.checkAccess(settings);
    if (!check.ok) return res.status(400).json({ success: false, message: `The mailbox could not be opened: ${check.reason}` });
    await setTenantImapSettings(req.user.tenantId, settings);
    audit(req, 'mailbox.connected', `IMAP: ${userName} on ${hostName}`);
    // Remember the current end of the mailbox now, so only emails that arrive from this moment are read.
    pollMailbox(req.user.tenantId).catch(() => {});
    return res.json({ success: true, mailbox: mailboxStatus({ imapSettings: settings, imapState: null }) });
  } catch (error) {
    return sendError(res, error, 'Mailbox settings could not be saved.', 'imap settings');
  }
});

app.delete('/api/settings/imap', authMiddleware, requirePermission('settings:write'), async (req, res) => {
  try {
    await setTenantImapSettings(req.user.tenantId, null);
    audit(req, 'mailbox.disconnected', null);
    return res.json({ success: true });
  } catch (error) {
    return sendError(res, error, 'Mailbox could not be removed.', 'imap remove');
  }
});

// "Check now": do not wait for the next round.
app.post('/api/settings/imap/check', authMiddleware, requirePermission('settings:write'), async (req, res) => {
  try {
    const result = await pollMailbox(req.user.tenantId);
    if (result.configured === false) return res.status(400).json({ success: false, message: 'No mailbox is connected.' });
    if (result.busy) return res.status(409).json({ success: false, message: 'The mailbox is being checked right now. Try again in a moment.' });
    if (result.error) return res.status(502).json({ success: false, message: `The mailbox could not be read: ${result.error}` });
    return res.json({ success: true, imported: result.imported, skipped: result.skipped });
  } catch (error) {
    return sendError(res, error, 'Mailbox could not be checked.', 'imap check');
  }
});

// A person says which load an email's files belong to.
app.post('/api/inbox/:id/attach', authMiddleware, requirePermission('shipments:document'), async (req, res) => {
  const itemId = Number(req.params.id);
  const shipmentId = parseShipmentId(req.body?.shipmentId);
  if (!Number.isInteger(itemId) || itemId <= 0 || !shipmentId) return res.status(400).json({ success: false, message: 'An email and a load number (for example SHP-12) are required.' });
  try {
    const item = await getInboxItem(req.user.tenantId, itemId);
    if (!item || item.status === 'blocked') return res.status(404).json({ success: false, message: 'Message not found.' });
    if (!item.attachments.length) return res.status(400).json({ success: false, message: 'This email has no files.' });
    const shipment = await getShipment(req.user.tenantId, shipmentId);
    if (!shipment) return res.status(404).json({ success: false, message: 'Shipment not found.' });
    const moved = await attachEmailFilesToShipment(req.user.tenantId, itemId, shipment, { context: `${item.subject || ''} ${item.body}`, uploadedBy: req.user.id });
    if (!moved.documentIds.length && moved.skipped) {
      return res.status(409).json({ success: false, message: `A load can have at most ${DOC_MAX_PER_SHIPMENT} documents.` });
    }
    await updateInboxItem(req.user.tenantId, itemId, { status: 'attached', shipmentId });
    await resolveTasksByKey(req.user.tenantId, `inbox:${itemId}`, { userId: req.user.id });
    moved.documentIds.forEach((documentId) => nexus.emit('document.uploaded', { tenantId: req.user.tenantId, shipmentId, documentId }));
    return res.json({ success: true, shipmentId: `SHP-${shipmentId}`, documents: moved.documentIds.length, skipped: moved.skipped });
  } catch (error) {
    return sendError(res, error, 'Files could not be attached.', 'inbox attach');
  }
});

/* =========================================================
   DELIVERY REPORTS: Twilio tells us what happened to a sent message
   ========================================================= */
// The address holds a one-time secret for one message, and the request must carry a valid signature
// made with that company's Twilio auth token. Both must be right.
app.post(`${TWILIO_STATUS_PREFIX}:token`, twilioStatusLimiter, express.urlencoded({ extended: false, limit: '20kb' }), async (req, res) => {
  try {
    const token = String(req.params.token);
    if (!PUBLIC_URL || !/^[a-f0-9]{48}$/.test(token)) return res.status(404).json({ success: false, message: 'Not found.' });
    const message = await findMessageByCallbackTokenHash(rateLimitKey(token));
    if (!message) return res.status(404).json({ success: false, message: 'Not found.' });
    const { config } = messaging.resolveConfig(await getTenant(message.tenantId), DEFAULT_TENANT_ID);
    const fields = req.body && typeof req.body === 'object' ? req.body : {};
    if (!config || !messaging.validSignature(config.token, `${PUBLIC_URL}${TWILIO_STATUS_PREFIX}${token}`, fields, req.get('x-twilio-signature'))) {
      return res.status(403).json({ success: false, message: 'Invalid signature.' });
    }
    const sid = fields.MessageSid || fields.SmsSid;
    if (message.providerMessageId && sid && sid !== message.providerMessageId) {
      return res.status(400).json({ success: false, message: 'Report does not match the message.' });
    }
    const outcome = await recordMessageDelivery(message.tenantId, message.id, { status: fields.MessageStatus || fields.SmsStatus, errorCode: fields.ErrorCode });
    if (outcome.failedNow) {
      nexus.emit('message.failed', {
        tenantId: message.tenantId, messageId: message.id, shipmentId: message.shipmentId,
        recipient: message.recipientType, to: message.toPhone, errorCode: /^\d{1,6}$/.test(String(fields.ErrorCode || '')) ? String(fields.ErrorCode) : null
      });
    }
    return res.status(204).end();
  } catch (error) {
    return sendError(res, error, 'Report could not be stored.', 'twilio status');
  }
});

/* =========================================================
   DOCUMENTS (VAULT): CMR, proof of delivery, other files
   ========================================================= */
// The real file type comes from the first bytes, not from the name or the browser's claim.
function detectMime(buffer) {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function safeFilename(raw, mime) {
  const base = String(raw || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"<>:*?|]/g, '').trim().slice(0, 120);
  const extension = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[mime];
  return base || `document${extension}`;
}

const rawDocument = express.raw({
  limit: DOC_MAX_BYTES,
  type: (req) => DOC_MIME_TYPES.includes(String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase())
});

app.get('/api/shipments/:id/documents', authMiddleware, requirePermission('shipments:read'), async (req, res) => {
  const shipmentId = parseShipmentId(req.params.id);
  if (!shipmentId) return res.status(400).json({ success: false, message: 'Valid shipment ID is required.' });
  try {
    if (!(await getShipment(req.user.tenantId, shipmentId))) return res.status(404).json({ success: false, message: 'Shipment not found.' });
    return res.json({ success: true, documents: await listDocuments(req.user.tenantId, shipmentId), readsDocuments: aiGateway.isEnabled() });
  } catch (error) {
    return sendError(res, error, 'Documents unavailable.', 'documents list');
  }
});

app.post('/api/shipments/:id/documents', authMiddleware, requirePermission('shipments:document'), documentLimiter, rawDocument, async (req, res) => {
  const shipmentId = parseShipmentId(req.params.id);
  const type = String(req.query.type || 'other');
  if (!shipmentId || !vaultAgent.DOC_TYPES.includes(type)) {
    return res.status(400).json({ success: false, message: `A valid shipment and a document type (${vaultAgent.DOC_TYPES.join(', ')}) are required.` });
  }
  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(415).json({ success: false, message: 'Send a PDF, JPEG, PNG or WebP file as the request body.' });
  }
  const mime = detectMime(req.body);
  const claimed = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!mime || mime !== claimed) {
    return res.status(415).json({ success: false, message: 'The file is not a real PDF, JPEG, PNG or WebP.' });
  }
  try {
    const existing = await listDocuments(req.user.tenantId, shipmentId);
    if (existing.length >= DOC_MAX_PER_SHIPMENT) {
      return res.status(409).json({ success: false, message: `A load can have at most ${DOC_MAX_PER_SHIPMENT} documents.` });
    }
    const { document, duplicate } = await addDocument(req.user.tenantId, shipmentId, {
      type, filename: safeFilename(req.query.filename, mime), mime, content: req.body, uploadedBy: req.user.id
    });
    if (duplicate) return res.json({ success: true, duplicate: true, document });
    nexus.emit('document.uploaded', { tenantId: req.user.tenantId, shipmentId, documentId: document.id });
    return res.status(201).json({ success: true, document });
  } catch (error) {
    return sendError(res, error, 'Document could not be saved.', 'document upload');
  }
});

// Downloads are always an attachment, never shown inside the app's own page.
app.get('/api/shipments/:id/documents/:docId/file', authMiddleware, requirePermission('shipments:read'), async (req, res) => {
  const shipmentId = parseShipmentId(req.params.id);
  const docId = Number(req.params.docId);
  if (!shipmentId || !Number.isInteger(docId) || docId <= 0) return res.status(400).json({ success: false, message: 'Valid IDs are required.' });
  try {
    const file = await getDocumentFile(req.user.tenantId, shipmentId, docId);
    if (!file) return res.status(404).json({ success: false, message: 'Document not found.' });
    res.attachment(file.filename);
    res.type(file.mime);
    return res.send(file.content);
  } catch (error) {
    return sendError(res, error, 'Document unavailable.', 'document download');
  }
});

// Read (or re-read) a document with VAULT. Runs in the background; the list shows the result.
app.post('/api/shipments/:id/documents/:docId/extract', authMiddleware, requirePermission('shipments:document'), aiLimiter, needsPlan('ai'), async (req, res) => {
  const shipmentId = parseShipmentId(req.params.id);
  const docId = Number(req.params.docId);
  if (!shipmentId || !Number.isInteger(docId) || docId <= 0) return res.status(400).json({ success: false, message: 'Valid IDs are required.' });
  try {
    const document = await getDocument(req.user.tenantId, shipmentId, docId);
    if (!document) return res.status(404).json({ success: false, message: 'Document not found.' });
    if (!aiGateway.isEnabled()) return res.status(503).json({ success: false, message: 'AI is not configured. Add OPENROUTER_API_KEY to the server settings.' });
    await updateDocumentExtraction(req.user.tenantId, docId, { status: 'pending' });
    nexus.emit('document.uploaded', { tenantId: req.user.tenantId, shipmentId, documentId: docId, manual: true });
    return res.status(202).json({ success: true, status: 'pending' });
  } catch (error) {
    return sendError(res, error, 'Document could not be read.', 'document extract');
  }
});

app.delete('/api/shipments/:id/documents/:docId', authMiddleware, requirePermission('shipments:status'), async (req, res) => {
  const shipmentId = parseShipmentId(req.params.id);
  const docId = Number(req.params.docId);
  if (!shipmentId || !Number.isInteger(docId) || docId <= 0) return res.status(400).json({ success: false, message: 'Valid IDs are required.' });
  try {
    if (!(await deleteDocument(req.user.tenantId, shipmentId, docId))) return res.status(404).json({ success: false, message: 'Document not found.' });
    await resolveTasksByKey(req.user.tenantId, `doc:${docId}`, { status: 'dismissed', userId: req.user.id });
    return res.json({ success: true });
  } catch (error) {
    return sendError(res, error, 'Document could not be deleted.', 'document delete');
  }
});

// A person says what a file really is (the name and the email can only be guessed).
app.patch('/api/shipments/:id/documents/:docId', authMiddleware, requirePermission('shipments:document'), async (req, res) => {
  const shipmentId = parseShipmentId(req.params.id);
  const docId = Number(req.params.docId);
  const type = req.body?.type;
  if (!shipmentId || !Number.isInteger(docId) || docId <= 0 || !vaultAgent.DOC_TYPES.includes(type)) {
    return res.status(400).json({ success: false, message: `A valid document and a type (${vaultAgent.DOC_TYPES.join(', ')}) are required.` });
  }
  try {
    const document = await getDocument(req.user.tenantId, shipmentId, docId);
    if (!document) return res.status(404).json({ success: false, message: 'Document not found.' });
    if (document.type === type) return res.json({ success: true, document });
    await setDocumentType(req.user.tenantId, shipmentId, docId, type);
    // Old differences belong to the old type; a CMR / proof of delivery is read again, anything else is not.
    await resolveTasksByKey(req.user.tenantId, `doc:${docId}`, { status: 'dismissed', userId: req.user.id });
    await updateDocumentExtraction(req.user.tenantId, docId, { status: 'pending' });
    nexus.emit('document.uploaded', { tenantId: req.user.tenantId, shipmentId, documentId: docId });
    return res.json({ success: true, document: await getDocument(req.user.tenantId, shipmentId, docId) });
  } catch (error) {
    return sendError(res, error, 'Document could not be changed.', 'document type');
  }
});

/* =========================================================
   MARKET PRICES (what PULSE compares with)
   ========================================================= */
app.get('/api/market-rates', authMiddleware, requirePermission('shipments:read'), async (req, res) => {
  try {
    res.json({ success: true, rates: await listMarketRates(req.user.tenantId) });
  } catch (error) {
    return sendError(res, error, 'Market prices unavailable.', 'market rates');
  }
});

// One line per lane: "Origin; Destination; Equipment (optional); Price". Each line is checked on its own;
// good lines are saved, bad lines are reported back with their number.
app.post('/api/market-rates', authMiddleware, requirePermission('carriers:write'), async (req, res) => {
  const text = req.body?.lines;
  if (typeof text !== 'string' || !text.trim() || text.length > 100000) {
    return res.status(400).json({ success: false, message: 'Paste one lane per line: Origin; Destination; Equipment (optional); Price.' });
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 500) return res.status(400).json({ success: false, message: 'At most 500 lines at once.' });
  const errors = [];
  let created = 0;
  let updated = 0;
  try {
    for (const [index, line] of lines.entries()) {
      const parts = line.split(/[;\t]/).map((part) => part.trim());
      const [origin, destination] = parts;
      const rawRate = parts.length >= 4 ? parts[3] : parts[2];
      const equipment = parts.length >= 4 ? parts[2] : '';
      const rate = parseMoney(String(rawRate || '').replace(/\s/g, '').replace(',', '.'));
      if (parts.length < 3 || parts.length > 4 || !origin || !destination || origin.length > MAX_LEN.origin || destination.length > MAX_LEN.destination) {
        errors.push({ line: index + 1, message: 'Use: Origin; Destination; Equipment (optional); Price.' });
      } else if (equipment && !EQUIPMENT.includes(equipment)) {
        errors.push({ line: index + 1, message: `Equipment must be one of: ${EQUIPMENT.join(', ')}.` });
      } else if (rate === null) {
        errors.push({ line: index + 1, message: `The price must be between 0.01 and ${MAX_RATE.toLocaleString('en-US')}.` });
      } else if ((await upsertMarketRate(req.user.tenantId, { origin, destination, equipment, rate })) === 'created') created += 1;
      else updated += 1;
    }
    return res.json({ success: true, created, updated, errors });
  } catch (error) {
    return sendError(res, error, 'Market prices could not be saved.', 'market rates save');
  }
});

app.delete('/api/market-rates/:id', authMiddleware, requirePermission('carriers:write'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, message: 'Valid ID is required.' });
  try {
    if (!(await deleteMarketRate(req.user.tenantId, id))) return res.status(404).json({ success: false, message: 'Not found.' });
    return res.json({ success: true });
  } catch (error) {
    return sendError(res, error, 'Market price could not be deleted.', 'market rate delete');
  }
});

/* =========================================================
   BORDER WAITING TIMES (what ROUTE adds for a crossing)
   ========================================================= */
app.get('/api/border-waits', authMiddleware, requirePermission('shipments:read'), async (req, res) => {
  try {
    res.json({ success: true, waits: await listBorderWaits(req.user.tenantId) });
  } catch (error) {
    return sendError(res, error, 'Border times unavailable.', 'border waits');
  }
});

// One border per line: "UZ; KZ; 6" (two country codes and the usual waiting time in hours).
app.post('/api/border-waits', authMiddleware, requirePermission('carriers:write'), async (req, res) => {
  const text = req.body?.lines;
  if (typeof text !== 'string' || !text.trim() || text.length > 20000) {
    return res.status(400).json({ success: false, message: 'Write one border per line: UZ; KZ; 6 (two country codes and hours of waiting).' });
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 300);
  const errors = [];
  let created = 0;
  let updated = 0;
  try {
    for (const [index, line] of lines.entries()) {
      const [a, b, rawHours, ...extra] = line.split(/[;\t]/).map((part) => part.trim());
      const hours = Number(String(rawHours || '').replace(',', '.'));
      if (extra.length || !/^[A-Za-z]{2}$/.test(a || '') || !/^[A-Za-z]{2}$/.test(b || '') || a.toUpperCase() === b.toUpperCase()) {
        errors.push({ line: index + 1, message: 'Use: UZ; KZ; 6 (two different country codes, then hours).' });
      } else if (!Number.isFinite(hours) || hours < 0 || hours > 240) {
        errors.push({ line: index + 1, message: 'Hours must be between 0 and 240.' });
      } else if ((await upsertBorderWait(req.user.tenantId, a, b, Math.round(hours * 10) / 10)) === 'created') created += 1;
      else updated += 1;
    }
    return res.json({ success: true, created, updated, errors });
  } catch (error) {
    return sendError(res, error, 'Border times could not be saved.', 'border waits save');
  }
});

app.delete('/api/border-waits/:id', authMiddleware, requirePermission('carriers:write'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, message: 'Valid ID is required.' });
  try {
    if (!(await deleteBorderWait(req.user.tenantId, id))) return res.status(404).json({ success: false, message: 'Not found.' });
    return res.json({ success: true });
  } catch (error) {
    return sendError(res, error, 'Border time could not be deleted.', 'border wait delete');
  }
});

/* =========================================================
   AI AGENTS
   ========================================================= */
// FLOW: order text -> shipment draft for a person to review. Nothing is saved here.
app.post('/api/agents/flow/parse', authMiddleware, requirePermission('shipments:create'), aiLimiter, needsPlan('ai'), async (req, res) => {
  const text = req.body?.text;
  if (typeof text !== 'string' || !text.trim() || text.length > flowAgent.MAX_INPUT_CHARS) {
    return res.status(400).json({ success: false, message: `Paste the order text (at most ${flowAgent.MAX_INPUT_CHARS} characters).` });
  }
  try {
    const result = await flowAgent.parseOrder(text, {
      weightUnit: req.user.region.weightUnit,
      currency: req.user.region.currency,
      equipment: EQUIPMENT,
      maxRate: MAX_RATE,
      maxWeight: MAX_WEIGHT
    }, agentLogger(req));
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendError(res, error, 'The AI assistant is unavailable.', 'flow');
  }
});

// SCOUT: ranked carrier suggestions for one load (rules, no language model).
app.get('/api/agents/scout/:id', authMiddleware, requirePermission('shipments:dispatch'), async (req, res) => {
  const shipmentId = parseShipmentId(req.params.id);
  if (!shipmentId) return res.status(400).json({ success: false, message: 'Valid shipment ID is required.' });
  try {
    const data = await getScoutData(req.user.tenantId, shipmentId);
    return res.json({
      success: true,
      recommendations: scoutAgent.rankCarriers(data),
      laneAverageRate: data.laneAverageRate,
      laneLoads: data.laneLoads
    });
  } catch (error) {
    return sendError(res, error, 'Carrier suggestions unavailable.', 'scout');
  }
});

// ROUTE: is the schedule realistic, when will the truck probably arrive, which trucks end up near the pickup.
app.get('/api/agents/route/:id', authMiddleware, requirePermission('shipments:read'), async (req, res) => {
  const shipmentId = parseShipmentId(req.params.id);
  if (!shipmentId) return res.status(400).json({ success: false, message: 'Valid shipment ID is required.' });
  try {
    const data = await getRouteData(req.user.tenantId, shipmentId);
    // The map is a bonus: when it is off or fails, the advice still comes from the company's own history.
    try {
      data.map = await geo.route(data.shipment.origin, data.shipment.destination);
    } catch (error) {
      console.error('[route] map unavailable:', error.message);
    }
    const from = routeAgent.countryOf(data.shipment.origin);
    const to = routeAgent.countryOf(data.shipment.destination);
    if (from && to && from !== to) data.border = await getBorderWait(req.user.tenantId, from, to);
    // Live traffic only for trucks on the road (saves the traffic service's quota).
    if (['Dispatched', 'In Transit'].includes(data.shipment.status)) {
      try {
        data.traffic = await traffic.current(data.shipment.origin, data.shipment.destination);
      } catch (error) {
        console.error('[route] traffic unavailable:', error.message);
      }
    }
    return res.json({ success: true, ...routeAgent.planRoute(data) });
  } catch (error) {
    return sendError(res, error, 'Route advice unavailable.', 'route');
  }
});

// PULSE: what this lane usually costs, a suggested customer price, and whether the given prices are unusual.
app.get('/api/agents/pulse/:id', authMiddleware, requirePermission('shipments:read'), async (req, res) => {
  const shipmentId = parseShipmentId(req.params.id);
  if (!shipmentId) return res.status(400).json({ success: false, message: 'Valid shipment ID is required.' });
  const optionalMoney = (value) => (value === undefined || value === '' ? null : parseMoney(value));
  const rate = optionalMoney(req.query.rate);
  const customerRate = optionalMoney(req.query.customerRate);
  if ((req.query.rate && rate === null) || (req.query.customerRate && customerRate === null)) {
    return res.status(400).json({ success: false, message: 'Prices must be positive numbers.' });
  }
  try {
    return res.json({ success: true, ...pulseAgent.analyzePrices(await getPulseData(req.user.tenantId, shipmentId), { rate, customerRate, formatMoney: moneyIn(req.user.region.currency) }) });
  } catch (error) {
    return sendError(res, error, 'Price advice unavailable.', 'pulse');
  }
});

// SENTINEL: every open load of this company that is at risk right now, worst first.
app.get('/api/agents/sentinel', authMiddleware, requirePermission('shipments:read'), async (req, res) => {
  try {
    const loads = await geo.annotateOffRoute(await listSentinelLoads(req.user.tenantId));
    const risks = sentinelAgent.assess(loads, { staleHours: STALE_TRACKING_HOURS, offRouteKm: geo.offRouteKm() });
    return res.json({ success: true, risks: risks.slice(0, 200), total: risks.length });
  } catch (error) {
    return sendError(res, error, 'Risk check unavailable.', 'sentinel');
  }
});

/* =========================================================
   CARRIERS
   ========================================================= */
app.get('/api/carriers', authMiddleware, requirePermission('carriers:read'), async (req, res) => {
  try {
    const carriers = await listCarriersWithStats(req.user.tenantId);
    res.json(carriers);
  } catch (error) {
    console.error('[carriers] failed:', error.message);
    res.status(500).json({
      success: false,
      message: 'Carriers unavailable'
    });
  }
});

app.post('/api/carriers', authMiddleware, requirePermission('carriers:write'), async (req, res) => {
  const { name, mode } = req.body || {};
  if (typeof name !== 'string' || !name.trim() || name.trim().length > MAX_LEN.carrierName || !CARRIER_MODES.includes(mode)) {
    return res.status(400).json({ success: false, message: `Carrier name (max ${MAX_LEN.carrierName} characters) and a valid mode are required.` });
  }
  const phone = readOptionalPhone(req.body, 'phone');
  const contactName = readOptionalText(req.body, 'contactName', MAX_LEN.contactName);
  const invalid = phone.error || contactName.error;
  if (invalid) return res.status(400).json({ success: false, message: invalid });
  try {
    const carrier = await createCarrier({ name: name.trim(), mode, phone: phone.value, contactName: contactName.value, tenantId: req.user.tenantId });
    return res.status(201).json({ success: true, carrier });
  } catch (error) {
    return sendError(res, error, 'Carrier creation failed', 'create carrier');
  }
});

app.patch('/api/carriers/:id/status', authMiddleware, requirePermission('carriers:write'), async (req, res) => {
  const carrierId = Number(req.params.id);
  const status = req.body?.status;
  if (!Number.isInteger(carrierId) || carrierId <= 0 || !CARRIER_MANUAL_STATUSES.includes(status)) {
    return res.status(400).json({ success: false, message: `A valid carrier ID and status (${CARRIER_MANUAL_STATUSES.join(' or ')}) are required.` });
  }
  try {
    const carrier = await updateCarrierStatus(req.user.tenantId, carrierId, status);
    return res.json({ success: true, carrier });
  } catch (error) {
    return sendError(res, error, 'Carrier update failed', 'carrier status');
  }
});

/* =========================================================
   ACCOUNT AND TEAM
   ========================================================= */
app.get('/api/me', authMiddleware, (req, res) => {
  res.json({
    success: true,
    region: req.user.region,
    user: {
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      role: req.user.role,
      permissions: ROLE_PERMISSIONS[req.user.role] || [],
      tenantId: req.user.tenantId,
      tenantName: req.user.tenantName,
      isPlatformAdmin: req.user.isPlatformAdmin
    }
  });
});

app.get('/api/admin/users', authMiddleware, requirePermission('users:read'), async (req, res) => {
  try {
    const users = await listUsers(req.user.tenantId);
    res.json({
      success: true,
      users
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'User list unavailable'
    });
  }
});

// Admin adds a team member to their own company with a starting password.
app.post('/api/admin/users', authMiddleware, requirePermission('users:write'), async (req, res, next) => {
  try {
    plans.assertCanAddUser(await planOf(req.user.tenantId), await countActiveUsers(req.user.tenantId));
    return next();
  } catch (error) {
    return sendError(res, error, 'User could not be created.', 'create user');
  }
}, async (req, res) => {
  const { name, email, password, role } = req.body || {};
  const identityError = validateNameAndEmail(name, email);
  if (identityError) return res.status(400).json({ success: false, message: identityError });
  if (!ALLOWED_ROLES.includes(role)) {
    return res.status(400).json({ success: false, message: `Role must be one of: ${ALLOWED_ROLES.join(', ')}.` });
  }
  const passwordError = validateNewPassword(password);
  if (passwordError) return res.status(400).json({ success: false, message: passwordError });
  try {
    const normalizedEmail = email.trim().toLowerCase();
    if (await findUserByEmail(normalizedEmail)) {
      return res.status(409).json({ success: false, message: 'A user with this email already exists.' });
    }
    const user = await createUser({
      name: name.trim(),
      email: normalizedEmail,
      password: await bcrypt.hash(password, BCRYPT_COST),
      role,
      tenantId: req.user.tenantId
    });
    audit(req, 'user.created', `${user.email} (${user.role})`);
    return res.status(201).json({ success: true, user: { id: user.id, name: user.name, email: user.email, role: user.role, active: true } });
  } catch (error) {
    if (String(error.code) === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({ success: false, message: 'A user with this email already exists.' });
    }
    console.error('[create user] failed:', error.message);
    return res.status(500).json({ success: false, message: 'User could not be created.' });
  }
});

// Change role and/or enable/disable an account in the same company. Takes effect at once.
app.patch('/api/admin/users/:id', authMiddleware, requirePermission('users:write'), async (req, res) => {
  const userId = Number(req.params.id);
  const { role, active } = req.body || {};
  if (!Number.isInteger(userId) || userId <= 0
    || (role === undefined && active === undefined)
    || (role !== undefined && !ALLOWED_ROLES.includes(role))
    || (active !== undefined && typeof active !== 'boolean')) {
    return res.status(400).json({ success: false, message: `Send a role (${ALLOWED_ROLES.join(', ')}) and/or active (true or false).` });
  }
  try {
    // Turning someone back on takes a seat again.
    if (active === true) {
      const current = (await listUsers(req.user.tenantId)).find((entry) => entry.id === userId);
      if (current && current.active === false) plans.assertCanAddUser(await planOf(req.user.tenantId), await countActiveUsers(req.user.tenantId));
    }
    const user = await updateUser(req.user.tenantId, userId, { role, active }, req.user.id);
    audit(req, 'user.changed', `${user.email}: role ${user.role}, ${user.active ? 'active' : 'disabled'}`);
    return res.json({ success: true, user });
  } catch (error) {
    return sendError(res, error, 'User could not be updated.', 'update user');
  }
});

app.get('/api/admin/shipments', authMiddleware, requirePermission('shipments:read'), async (req, res) => {
  try {
    const shipments = await listShipments(req.user.tenantId, readPaging(req));
    res.json({
      success: true,
      shipments: shipments.map(serializeShipment)
    });
  } catch (error) {
    console.error('[admin shipments] failed:', error.message);
    res.status(500).json({ success: false, message: 'Admin shipment list unavailable' });
  }
});

app.patch('/api/admin/shipments/:id/status', authMiddleware, requirePermission('shipments:status'), async (req, res) => {
  try {
    const shipmentId = parseShipmentId(req.params.id);
    const { status, note } = req.body || {};

    if (!shipmentId || !SHIPMENT_STATUSES.includes(status) || (note !== undefined && note !== null && (typeof note !== 'string' || note.length > MAX_LEN.note))) {
      return res.status(400).json({
        success: false,
        message: `A valid shipment ID and a status (${SHIPMENT_STATUSES.join(', ')}) are required.`
      });
    }

    const result = await updateShipmentStatus(req.user.tenantId, shipmentId, status, req.user.id, note);
    nexus.emit('shipment.status', { tenantId: req.user.tenantId, shipmentId, status });
    return res.json({
      success: true,
      shipment: {
        id: `SHP-${result.id}`,
        status: result.status,
        updated: result.changes > 0
      }
    });
  } catch (error) {
    return sendError(res, error, 'Shipment status update failed', 'status');
  }
});

app.post('/api/admin/shipments/:id/dispatch', authMiddleware, requirePermission('shipments:dispatch'), async (req, res) => {
  try {
    const shipmentId = parseShipmentId(req.params.id);
    const carrierId = typeof req.body?.carrierId === 'number' ? req.body.carrierId : NaN;
    const rate = parseMoney(req.body?.rate);
    if (!Number.isInteger(shipmentId) || shipmentId <= 0 || !Number.isInteger(carrierId) || carrierId <= 0 || rate === null) {
      return res.status(400).json({ success: false, message: `A valid carrier and a rate between 0.01 and ${MAX_RATE.toLocaleString('en-US')} are required.` });
    }
    const hasCustomerRate = req.body?.customerRate !== undefined && req.body?.customerRate !== null && req.body?.customerRate !== '';
    const customerRate = hasCustomerRate ? parseMoney(req.body.customerRate) : null;
    if (hasCustomerRate && customerRate === null) {
      return res.status(400).json({ success: false, message: `Customer price must be between 0.01 and ${MAX_RATE.toLocaleString('en-US')}.` });
    }
    const driverName = readOptionalText(req.body, 'driverName', MAX_LEN.driverName);
    const driverPhone = readOptionalPhone(req.body, 'driverPhone');
    const truckPlate = readOptionalText(req.body, 'truckPlate', MAX_LEN.truckPlate);
    const invalid = driverName.error || driverPhone.error || truckPlate.error;
    if (invalid) return res.status(400).json({ success: false, message: invalid });

    const shipment = await dispatchShipment(req.user.tenantId, shipmentId, carrierId, rate, req.user.id, {
      customerRate,
      driverName: driverName.value,
      driverPhone: driverPhone.value,
      truckPlate: truckPlate.value
    });
    nexus.emit('shipment.dispatched', { tenantId: req.user.tenantId, shipmentId });
    return res.json({ success: true, shipment: { ...shipment, id: `SHP-${shipment.id}` } });
  } catch (error) {
    return sendError(res, error, 'Dispatch failed', 'dispatch');
  }
});

/* =========================================================
   INTEGRATIONS (GPS, messaging, AI status)
   ========================================================= */
app.get('/api/integrations/status', authMiddleware, requirePermission('users:read'), async (req, res) => {
  try {
    const tenant = await getTenant(req.user.tenantId);
    res.json({
      success: true,
      ai: { enabled: aiGateway.isEnabled(), model: process.env.OPENROUTER_MODEL || null },
      messaging: { ...messaging.publicStatus(tenant, DEFAULT_TENANT_ID), deliveryReports: Boolean(PUBLIC_URL) },
      gps: { configured: Boolean(tenant?.gpsTokenHash), webhookPath: GPS_WEBHOOK_PATH, minIntervalMinutes: GPS_MIN_INTERVAL_MINUTES },
      inbox: { configured: Boolean(tenant?.inboxTokenHash), pathPrefix: INBOX_WEBHOOK_PREFIX, allowedSenders: tenant?.allowedSenders || [], dailyLimit: INBOX_DAILY_LIMIT,
        maxMb: INBOX_MAX_BYTES / (1024 * 1024), maxFiles: INBOX_MAX_ATTACHMENTS },
      documents: { reads: aiGateway.isEnabled(), maxMb: DOC_MAX_BYTES / (1024 * 1024) },
      map: { enabled: geo.enabled(), offRouteKm: geo.offRouteKm(), traffic: traffic.enabled() },
      mailbox: mailboxStatus(tenant),
      nexus: { enabled: process.env.NEXUS_ENABLED !== 'false', staleHours: STALE_TRACKING_HOURS, aiDailyLimit: AI_DAILY_LIMIT_PER_TENANT }
    });
  } catch (error) {
    return sendError(res, error, 'Integration status unavailable.', 'integrations');
  }
});

// Which channels (SMS / WhatsApp) this company can send with. Open to every signed-in user: the
// message form needs it. It contains no credentials.
app.get('/api/messaging/status', authMiddleware, async (req, res) => {
  try {
    res.json({ success: true, ...messaging.publicStatus(await getTenant(req.user.tenantId), DEFAULT_TENANT_ID) });
  } catch (error) {
    return sendError(res, error, 'Messaging status unavailable.', 'messaging status');
  }
});

// This company's own Twilio account. Checked with Twilio before saving, stored encrypted,
// never returned. Leave the token empty to keep the saved one when only the numbers change.
app.put('/api/settings/messaging', authMiddleware, requirePermission('settings:write'), needsPlan('messaging'), async (req, res) => {
  const { accountSid, authToken, smsFrom, whatsappFrom } = req.body || {};
  const sid = typeof accountSid === 'string' ? accountSid.trim() : '';
  if (!/^AC[0-9a-fA-F]{32}$/.test(sid)) {
    return res.status(400).json({ success: false, message: 'Account SID looks like AC followed by 32 letters and digits (find it on the Twilio console home page).' });
  }
  const readNumber = (value) => {
    if (value === undefined || value === null || String(value).trim() === '') return { value: '' };
    const number = messaging.toE164(String(value).trim().replace(/^whatsapp:/i, ''));
    return number ? { value: number } : { error: true };
  };
  const sms = readNumber(smsFrom);
  const whatsapp = readNumber(whatsappFrom);
  if (sms.error || whatsapp.error) {
    return res.status(400).json({ success: false, message: 'Sender numbers must be in international format, e.g. +15551234567.' });
  }
  if (!sms.value && !whatsapp.value) {
    return res.status(400).json({ success: false, message: 'Enter at least one sender number (SMS or WhatsApp).' });
  }
  try {
    const tenant = await getTenant(req.user.tenantId);
    let token = typeof authToken === 'string' ? authToken.trim() : '';
    if (!token && tenant.messagingSettings?.sid === sid) token = tenant.messagingSettings.token;
    if (!/^[0-9a-zA-Z]{16,64}$/.test(token)) {
      return res.status(400).json({ success: false, message: 'Enter the Auth Token from the Twilio console.' });
    }
    const settings = { sid, token, smsFrom: sms.value, whatsappFrom: whatsapp.value };
    const check = await messaging.verifyCredentials(settings);
    if (!check.ok) return res.status(400).json({ success: false, message: check.reason });
    await setTenantMessagingSettings(req.user.tenantId, settings);
    audit(req, 'twilio.connected', null);
    return res.json({ success: true, messaging: messaging.publicStatus({ id: req.user.tenantId, messagingSettings: settings }, DEFAULT_TENANT_ID) });
  } catch (error) {
    return sendError(res, error, 'Settings could not be saved.', 'messaging settings');
  }
});

app.delete('/api/settings/messaging', authMiddleware, requirePermission('settings:write'), async (req, res) => {
  try {
    await setTenantMessagingSettings(req.user.tenantId, null);
    audit(req, 'twilio.disconnected', null);
    return res.json({ success: true, messaging: messaging.publicStatus(await getTenant(req.user.tenantId), DEFAULT_TENANT_ID) });
  } catch (error) {
    return sendError(res, error, 'Settings could not be removed.', 'messaging settings delete');
  }
});

// The company's email inbox address. The token is shown once; only its hash is stored.
app.post('/api/settings/inbox/token', authMiddleware, requirePermission('settings:write'), needsPlan('email'), async (req, res) => {
  try {
    const token = `inbox_${crypto.randomBytes(24).toString('hex')}`;
    await setTenantInboxTokenHash(req.user.tenantId, rateLimitKey(token));
    audit(req, 'inbox.address_created', null);
    res.status(201).json({ success: true, token, webhookPath: `${INBOX_WEBHOOK_PREFIX}${token}` });
  } catch (error) {
    return sendError(res, error, 'Token could not be created.', 'inbox token');
  }
});

// Who may send orders in. Empty = anyone who knows the address. Entries: an address or a domain.
app.put('/api/settings/inbox', authMiddleware, requirePermission('settings:write'), async (req, res) => {
  const list = req.body?.allowedSenders;
  if (!Array.isArray(list) || list.length > 50 || list.some((entry) => typeof entry !== 'string' || !/^@?[a-z0-9._+-]+(@[a-z0-9.-]+)?$/i.test(entry.trim()) || entry.length > 254)) {
    return res.status(400).json({ success: false, message: 'Send up to 50 email addresses or domains, e.g. ["customer.com", "boss@partner.com"].' });
  }
  try {
    const cleaned = [...new Set(list.map((entry) => entry.trim().toLowerCase()))];
    await setTenantInboxAllowedSenders(req.user.tenantId, cleaned);
    return res.json({ success: true, allowedSenders: cleaned });
  } catch (error) {
    return sendError(res, error, 'Settings could not be saved.', 'inbox settings');
  }
});

// Creates (or replaces) this company's GPS token. Shown once; only its hash is stored.
app.post('/api/integrations/gps/token', authMiddleware, requirePermission('settings:write'), needsPlan('gps'), async (req, res) => {
  try {
    const token = `gps_${crypto.randomBytes(24).toString('hex')}`;
    await setTenantGpsTokenHash(req.user.tenantId, rateLimitKey(token));
    audit(req, 'gps.token_created', null);
    res.status(201).json({ success: true, token, webhookPath: GPS_WEBHOOK_PATH });
  } catch (error) {
    return sendError(res, error, 'Token could not be created.', 'gps token');
  }
});

function readGpsToken(req) {
  const header = String(req.headers.authorization || '');
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  if (req.headers['x-veyra-token']) return String(req.headers['x-veyra-token']).trim();
  // Some trackers can only call a plain URL, so ?token= is accepted too.
  return typeof req.query.token === 'string' ? req.query.token.trim() : '';
}

function parseGpsPosition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = Number(raw.lat ?? raw.latitude);
  const lng = Number(raw.lng ?? raw.lon ?? raw.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const shipmentId = raw.shipmentId !== undefined ? parseShipmentId(raw.shipmentId) : null;
  const plate = typeof raw.truckPlate === 'string' && raw.truckPlate.length <= MAX_LEN.truckPlate ? normalizePlate(raw.truckPlate) : '';
  if (!shipmentId && !plate) return null;
  const speedNumber = raw.speed === undefined || raw.speed === null ? null : Number(raw.speed);
  const address = typeof raw.address === 'string' && raw.address.trim() && raw.address.trim().length <= MAX_LEN.location ? raw.address.trim() : null;
  return {
    lat,
    lng,
    shipmentId,
    truckPlate: plate,
    speed: Number.isFinite(speedNumber) && speedNumber >= 0 && speedNumber <= 300 ? speedNumber : null,
    address
  };
}

// GPS provider webhook: positions for trucks on active loads. Authenticated by the company's GPS token.
app.post(GPS_WEBHOOK_PATH, async (req, res, next) => {
  const token = readGpsToken(req);
  if (!token) return res.status(401).json({ success: false, message: 'GPS token required.' });
  req.gpsTokenHash = rateLimitKey(token);
  return gpsLimiter(req, res, next);
}, async (req, res) => {
  try {
    const tenant = await findTenantByGpsTokenHash(req.gpsTokenHash);
    if (!tenant) return res.status(401).json({ success: false, message: 'Invalid GPS token.' });
    await requireCapability(tenant.id, 'gps');
    const body = req.body;
    const list = Array.isArray(body) ? body : (Array.isArray(body?.positions) ? body.positions : [body]);
    if (!list.length || list.length > 500) {
      return res.status(400).json({ success: false, message: 'Send between 1 and 500 positions.' });
    }
    const positions = list.map(parseGpsPosition);
    const valid = positions.filter(Boolean);
    const summary = valid.length
      ? await recordGpsPositions(tenant.id, valid, { minIntervalMinutes: GPS_MIN_INTERVAL_MINUTES })
      : { accepted: 0, skipped: 0, unmatched: 0 };
    return res.json({ success: true, ...summary, invalid: positions.length - valid.length });
  } catch (error) {
    return sendError(res, error, 'GPS positions could not be saved.', 'gps webhook');
  }
});

/* =========================================================
   PLATFORM: customer companies (multi-tenant)
   ========================================================= */
app.get('/api/platform/tenants', authMiddleware, requirePlatformAdmin, async (req, res) => {
  try {
    res.json({ success: true, tenants: await listTenants() });
  } catch (error) {
    return sendError(res, error, 'Companies unavailable.', 'tenants');
  }
});

/* ---------- company settings: region and data export ---------- */
/* =========================================================
   API v2: a shipment is the customer's order; it moves in legs (ROAD, OCEAN, AIR, RAIL, WAREHOUSE, LAST_MILE).
   /api/* keeps working as before: a classic single-truck load is shown here as one ROAD leg.
   Everything on a leg is entered by people (no carrier connection behind it); NEXUS does not react to multi-leg loads yet.
   ========================================================= */
const positiveId = (value) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
};
const MAX_LEGS = 12;

function legInput(res, body, options) {
  try {
    return legsLib.readLegInput(body, { parseMoney, ...options });
  } catch (error) {
    if (error instanceof legsLib.LegInputError) {
      res.status(400).json({ success: false, message: error.message });
      return null;
    }
    throw error;
  }
}

async function sendShipmentLegs(res, tenantId, shipmentId, status = 200, extra = {}) {
  const data = await getShipmentLegs(tenantId, shipmentId);
  if (!data) return res.status(404).json({ success: false, message: 'Shipment not found.' });
  const { shipmentId: id, ...rest } = data;
  return res.status(status).json({ success: true, shipment: { id: `SHP-${id}`, status: data.status, currency: data.currency, multi: data.multi }, ...rest, ...extra });
}

app.get('/api/v2/shipments/:id', authMiddleware, requirePermission('shipments:read'), async (req, res) => {
  try {
    const shipmentId = parseShipmentId(req.params.id);
    if (!shipmentId) return res.status(400).json({ success: false, message: 'Valid shipment ID is required.' });
    return await sendShipmentLegs(res, req.user.tenantId, shipmentId);
  } catch (error) {
    return sendError(res, error, 'Shipment could not be loaded.', 'v2 shipment');
  }
});

// A new order made of legs. The load's own status and price follow its legs.
app.post('/api/v2/shipments', authMiddleware, requirePermission('shipments:create'), async (req, res) => {
  try {
    const { customer, reference, origin, destination, pickup, delivery, weight, equipment } = req.body || {};
    const pickupDate = parseIsoDate(pickup);
    const deliveryDate = parseIsoDate(delivery);
    const weightValue = parsePositiveNumber(weight, MAX_WEIGHT);
    for (const [field, value] of Object.entries({ customer, origin, destination })) {
      if (typeof value !== 'string' || !value.trim() || value.trim().length > MAX_LEN[field]) {
        return res.status(400).json({ success: false, message: `${field} is required and must be at most ${MAX_LEN[field]} characters.` });
      }
    }
    if (reference !== undefined && reference !== null && (typeof reference !== 'string' || reference.trim().length > MAX_LEN.reference)) {
      return res.status(400).json({ success: false, message: `reference must be text of at most ${MAX_LEN.reference} characters.` });
    }
    if (weightValue === null || !EQUIPMENT.includes(equipment)) {
      return res.status(400).json({ success: false, message: `A weight up to ${MAX_WEIGHT.toLocaleString('en-US')} ${req.user.region.weightUnit} and valid equipment are required.` });
    }
    if (!pickupDate || !deliveryDate || deliveryDate < pickupDate) {
      return res.status(400).json({ success: false, message: 'Pickup and delivery must be valid dates (YYYY-MM-DD), delivery not before pickup.' });
    }
    const hasRate = req.body?.customerRate !== undefined && req.body?.customerRate !== null && req.body?.customerRate !== '';
    const customerRate = hasRate ? parseMoney(req.body.customerRate) : null;
    if (hasRate && customerRate === null) return res.status(400).json({ success: false, message: 'The customer price is not a valid amount.' });
    const rawLegs = req.body?.legs;
    if (!Array.isArray(rawLegs) || !rawLegs.length || rawLegs.length > MAX_LEGS) {
      return res.status(400).json({ success: false, message: `Give 1 to ${MAX_LEGS} legs.` });
    }
    const legs = [];
    for (const raw of rawLegs) {
      const input = legInput(res, raw || {});
      if (!input) return null;
      legs.push(input);
    }
    await requireShipmentRoom(req.user.tenantId);
    const created = await createShipmentWithLegs({
      customer: customer.trim(), origin: origin.trim(), destination: destination.trim(), pickup, delivery,
      weight: `${weightValue} ${req.user.region.weightUnit}`, equipment, reference: reference?.trim(), customerRate,
      actorId: req.user.id, tenantId: req.user.tenantId, legs
    });
    audit(req, 'shipment.created', `${created.id}: ${legs.map((leg) => leg.mode).join(' > ')}`);
    return await sendShipmentLegs(res, req.user.tenantId, created.shipmentId, 201);
  } catch (error) {
    return sendError(res, error, 'Shipment could not be created.', 'v2 create');
  }
});

app.post('/api/v2/shipments/:id/legs', authMiddleware, requirePermission('shipments:dispatch'), async (req, res) => {
  try {
    const shipmentId = parseShipmentId(req.params.id);
    if (!shipmentId) return res.status(400).json({ success: false, message: 'Valid shipment ID is required.' });
    const input = legInput(res, req.body || {});
    if (!input) return null;
    const leg = await addLeg(req.user.tenantId, shipmentId, input, req.user.id);
    audit(req, 'leg.added', `SHP-${shipmentId} leg ${leg.sequence} ${input.mode}`);
    return await sendShipmentLegs(res, req.user.tenantId, shipmentId, 201, { legId: leg.id });
  } catch (error) {
    return sendError(res, error, 'The leg could not be added.', 'v2 add leg');
  }
});

app.get('/api/v2/legs/:id', authMiddleware, requirePermission('shipments:read'), async (req, res) => {
  try {
    const legId = positiveId(req.params.id);
    const leg = legId ? await getLeg(req.user.tenantId, legId) : null;
    if (!leg) return res.status(404).json({ success: false, message: 'Leg not found.' });
    const data = await getShipmentLegs(req.user.tenantId, leg.shipmentId);
    return res.json({ success: true, leg, events: data.events.filter((event) => event.legId === leg.id), documents: await listLegDocuments(req.user.tenantId, leg.id) });
  } catch (error) {
    return sendError(res, error, 'Leg could not be loaded.', 'v2 leg');
  }
});

app.patch('/api/v2/legs/:id', authMiddleware, requirePermission('shipments:dispatch'), async (req, res) => {
  try {
    const legId = positiveId(req.params.id);
    const current = legId ? await getLeg(req.user.tenantId, legId) : null;
    if (!current) return res.status(404).json({ success: false, message: 'Leg not found.' });
    const input = legInput(res, req.body || {}, { partial: true, mode: current.mode });
    if (!input) return null;
    const result = await updateLeg(req.user.tenantId, legId, input, req.user.id);
    if (result.changed.length) audit(req, 'leg.updated', `leg ${legId}: ${result.changed.join(', ')}`);
    return await sendShipmentLegs(res, req.user.tenantId, current.shipmentId, 200, { changed: result.changed });
  } catch (error) {
    return sendError(res, error, 'The leg could not be updated.', 'v2 update leg');
  }
});

app.post('/api/v2/legs/:id/status', authMiddleware, async (req, res) => {
  try {
    const legId = positiveId(req.params.id);
    const status = String(req.body?.status || '');
    if (!legsLib.LEG_STATUSES.includes(status)) return res.status(400).json({ success: false, message: `Status must be one of ${legsLib.LEG_STATUSES.join(', ')}.` });
    // Booking is a dispatcher's decision; moving a booked leg along is an operator's job.
    if (!hasPermission(req.user, status === 'Booked' ? 'shipments:dispatch' : 'shipments:status')) {
      return res.status(403).json({ success: false, message: `Forbidden: missing ${status === 'Booked' ? 'shipments:dispatch' : 'shipments:status'} permission.` });
    }
    const current = legId ? await getLeg(req.user.tenantId, legId) : null;
    if (!current) return res.status(404).json({ success: false, message: 'Leg not found.' });
    const text = (value, label, max) => {
      if (value === undefined || value === null || value === '') return null;
      if (typeof value !== 'string' || value.trim().length > max) throw httpError(400, `${label} must be text of at most ${max} characters.`);
      return value.trim();
    };
    const handover = req.body?.handover && typeof req.body.handover === 'object'
      ? { location: text(req.body.handover.location, 'Handover location', 200), receivedBy: text(req.body.handover.receivedBy, 'Received by', 120), note: text(req.body.handover.note, 'Handover note', 500) }
      : null;
    const result = await setLegStatus(req.user.tenantId, legId, status, { note: text(req.body?.note, 'Note', 500), handover }, req.user.id);
    audit(req, 'leg.status', `leg ${legId}: ${current.status} > ${status}`);
    return await sendShipmentLegs(res, req.user.tenantId, result.shipmentId, 200, { handoverTo: result.handoverTo });
  } catch (error) {
    return sendError(res, error, 'The leg status could not be changed.', 'v2 leg status');
  }
});

app.post('/api/v2/legs/:id/tracking', authMiddleware, requirePermission('shipments:track'), async (req, res) => {
  try {
    const legId = positiveId(req.params.id);
    const location = typeof req.body?.location === 'string' ? req.body.location.trim() : '';
    if (!legId || !location || location.length > 200) return res.status(400).json({ success: false, message: 'A leg and a location of at most 200 characters are required.' });
    let eta = null;
    try {
      eta = legsLib.readWhen(req.body?.eta, 'eta');
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : null;
    const update = await addLegTracking(req.user.tenantId, legId, { location, eta, note }, req.user.id);
    return res.status(201).json({ success: true, update });
  } catch (error) {
    return sendError(res, error, 'The position could not be saved.', 'v2 leg tracking');
  }
});

// File a document under a leg of its own load (legId null files it back under the load).
app.put('/api/v2/documents/:id/leg', authMiddleware, requirePermission('shipments:document'), async (req, res) => {
  try {
    const documentId = positiveId(req.params.id);
    const raw = req.body?.legId;
    const legId = raw === null ? null : positiveId(raw);
    if (!documentId || (raw !== null && !legId)) return res.status(400).json({ success: false, message: 'A document and a leg number (or null) are required.' });
    return res.json({ success: true, document: await setDocumentLeg(req.user.tenantId, documentId, legId) });
  } catch (error) {
    return sendError(res, error, 'The document could not be filed.', 'v2 document leg');
  }
});

// Background work saved for this company: counts, the latest jobs, and the ones that gave up ("dead").
app.get('/api/jobs', authMiddleware, requirePermission('settings:write'), async (req, res) => {
  try {
    const status = ['queued', 'running', 'done', 'dead'].includes(req.query.status) ? req.query.status : null;
    const [counts, jobs] = await Promise.all([jobStats(req.user.tenantId), listJobs(req.user.tenantId, { status, limit: 50 })]);
    return res.json({ success: true, counts, jobs });
  } catch (error) {
    return sendError(res, error, 'Background jobs could not be loaded.', 'jobs');
  }
});

// Gives a dead job a fresh set of attempts.
app.post('/api/jobs/:id/retry', authMiddleware, requirePermission('settings:write'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, message: 'A valid job is required.' });
    if (!(await retryJob(req.user.tenantId, id))) return res.status(404).json({ success: false, message: 'No failed job with that number.' });
    audit(req, 'job.retry', `#${id}`);
    jobQueue.kick();
    return res.json({ success: true });
  } catch (error) {
    return sendError(res, error, 'The job could not be retried.', 'jobs');
  }
});

app.get('/api/company/settings', authMiddleware, (req, res) => {
  res.json({ success: true, region: req.user.region, currencies: CURRENCIES, weightUnits: WEIGHT_UNITS, timeZones: timeLib.TIMEZONES, locales: timeLib.LOCALES, canChange: hasPermission(req.user, 'settings:write') });
});

// New loads, quotes and prices use the new currency and unit; amounts already saved are not converted.
app.put('/api/company/settings', authMiddleware, requirePermission('settings:write'), async (req, res) => {
  try {
    const region = readRegion(req.body, { required: true });
    await setTenantRegion(req.user.tenantId, region);
    audit(req, 'company.region', `${region.currency}, ${region.weightUnit}, ${region.timeZone || 'zone unchanged'}, ${region.locale || 'format unchanged'}`);
    return res.json({ success: true, region: await regionOf(req.user.tenantId) });
  } catch (error) {
    return sendError(res, error, 'Settings could not be saved.', 'company settings');
  }
});

// Everything the company owns, as one JSON file (GDPR data portability). No passwords or keys.
app.get('/api/company/export', authMiddleware, requirePermission('settings:write'), async (req, res) => {
  try {
    const data = await exportTenantData(req.user.tenantId);
    audit(req, 'company.export', `${data.shipments.length} loads, ${data.users.length} users`);
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="veyra-export-${day}.json"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.type('application/json').send(JSON.stringify(data, null, 2));
  } catch (error) {
    return sendError(res, error, 'The export could not be made.', 'company export');
  }
});

// The company's own plan and how much of it is used (Billing page).
app.get('/api/billing/plan', authMiddleware, async (req, res) => {
  try {
    const [plan, usersUsed, shipmentsUsed] = await Promise.all([
      planOf(req.user.tenantId), countActiveUsers(req.user.tenantId), countShipmentsThisMonth(req.user.tenantId)
    ]);
    return res.json({
      success: true,
      plan: { ...plan, capabilities: Object.fromEntries(Object.entries(plans.CAPABILITIES).map(([key, label]) => [key, { label, on: plan.capabilities.includes(key) }])) },
      usage: { users: usersUsed, shipmentsThisMonth: shipmentsUsed },
      salesEmail: SALES_EMAIL,
      paddle: await paddleStatus(req)
    });
  } catch (error) {
    return sendError(res, error, 'Plan unavailable.', 'billing plan');
  }
});

/* ---------- Paddle: card payments for plans ---------- */
async function paddleStatus(req) {
  if (!paddle.enabled()) return { enabled: false };
  const tenant = await getTenant(req.user.tenantId);
  const available = paddle.prices();
  return {
    enabled: true,
    environment: paddle.environment(),
    clientToken: paddle.clientToken(),
    canPay: hasPermission(req.user, 'settings:write'),
    subscribed: Boolean(tenant.paddleSubscriptionId) && tenant.planStatus !== 'cancelled',
    canManage: paddle.apiEnabled() && Boolean(tenant.paddleCustomerId),
    canSwitch: paddle.apiEnabled() && Boolean(tenant.paddleSubscriptionId) && tenant.planStatus !== 'cancelled',
    period: tenant.billingPeriod || null,
    plans: Object.fromEntries(Object.entries(available).map(([key, byPeriod]) => {
      const listed = plans.publicPlans().find((entry) => entry.key === key);
      return [key, { monthly: Boolean(byPeriod.monthly), yearly: Boolean(byPeriod.yearly), name: listed.name, price: listed.monthly, yearlyPerMonth: listed.yearlyPerMonth }];
    }))
  };
}

function readPlanChoice(body) {
  const plan = body?.plan;
  const period = body?.period;
  if (!paddle.PLAN_KEYS.includes(plan) || !paddle.PERIODS.includes(period)) {
    throw httpError(400, 'Choose a plan (starter, growth, scale) and a period (monthly, yearly). Enterprise is arranged with sales.');
  }
  const priceId = paddle.priceFor(plan, period);
  if (!priceId) throw httpError(400, `The ${plan} ${period} price is not set up for card payment yet.`);
  return { plan, period, priceId };
}

// What the browser needs to open Paddle's checkout. Card details go to Paddle, never to Veyra.
app.post('/api/billing/checkout', authMiddleware, requirePermission('settings:write'), async (req, res) => {
  try {
    if (!paddle.enabled()) return res.status(503).json({ success: false, message: 'Card payment is not set up on this server.' });
    const choice = readPlanChoice(req.body);
    const tenant = await getTenant(req.user.tenantId);
    if (tenant.paddleSubscriptionId && tenant.planStatus !== 'cancelled') {
      return res.status(409).json({ success: false, message: 'This company already has a subscription. Switch plans instead.' });
    }
    audit(req, 'billing.checkout', `${choice.plan} ${choice.period}`);
    return res.json({
      success: true,
      checkout: {
        priceId: choice.priceId,
        environment: paddle.environment(),
        clientToken: paddle.clientToken(),
        email: req.user.email,
        customData: paddle.referenceFor(req.user.tenantId, JWT_SECRET)
      }
    });
  } catch (error) {
    return sendError(res, error, 'Checkout could not start.', 'paddle checkout');
  }
});

// Switch an existing subscription to another plan or period (Paddle charges or credits the difference).
app.post('/api/billing/change-plan', authMiddleware, requirePermission('settings:write'), async (req, res) => {
  try {
    if (!paddle.apiEnabled()) return res.status(503).json({ success: false, message: 'Plan switching needs PADDLE_API_KEY on the server.' });
    const choice = readPlanChoice(req.body);
    const tenant = await getTenant(req.user.tenantId);
    if (!tenant.paddleSubscriptionId || tenant.planStatus === 'cancelled') {
      return res.status(409).json({ success: false, message: 'There is no active subscription to switch. Subscribe first.' });
    }
    const data = await paddle.changePlan(tenant.paddleSubscriptionId, choice.priceId);
    const update = paddle.readSubscriptionEvent({ event_type: 'subscription.updated', data });
    if (update?.plan) await applyPaddleSubscription(req.user.tenantId, update);
    audit(req, 'billing.plan_changed', `${choice.plan} ${choice.period}`);
    return res.json({ success: true, plan: await planOf(req.user.tenantId) });
  } catch (error) {
    return sendError(res, error, 'The plan could not be switched.', 'paddle change');
  }
});

// Paddle's own page for invoices, the card on file and cancelling.
app.post('/api/billing/portal', authMiddleware, requirePermission('settings:write'), async (req, res) => {
  try {
    if (!paddle.apiEnabled()) return res.status(503).json({ success: false, message: 'The billing portal needs PADDLE_API_KEY on the server.' });
    const tenant = await getTenant(req.user.tenantId);
    if (!tenant.paddleCustomerId) return res.status(409).json({ success: false, message: 'This company has not paid by card yet.' });
    const url = await paddle.portalUrl(tenant.paddleCustomerId, tenant.paddleSubscriptionId);
    if (!url || !/^https:\/\/[a-z0-9.-]+\.paddle\.com\//i.test(url)) return res.status(502).json({ success: false, message: 'Paddle did not return a portal link.' });
    return res.json({ success: true, url });
  } catch (error) {
    return sendError(res, error, 'The billing portal could not open.', 'paddle portal');
  }
});

// Paddle's notifications. Only a correctly signed message changes a plan.
app.post(PADDLE_WEBHOOK_PATH, express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
  if (!paddle.enabled()) return res.status(404).json({ success: false, message: 'Not found.' });
  if (!paddle.verifySignature(req.body, req.get('paddle-signature'))) {
    return res.status(401).json({ success: false, message: 'Invalid signature.' });
  }
  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch (_) {
    return res.status(400).json({ success: false, message: 'Body must be JSON.' });
  }
  try {
    const update = paddle.readSubscriptionEvent(event);
    if (!update) return res.json({ success: true, ignored: true });
    // The company comes from the signed reference set at checkout, or from a subscription seen before.
    const tenantId = paddle.tenantFromReference(update.customData, JWT_SECRET) || await findTenantByPaddleSubscription(update.subscriptionId);
    if (!tenantId) return res.json({ success: true, ignored: true, reason: 'unknown company' });
    const applied = await applyPaddleSubscription(tenantId, update);
    if (applied) {
      await recordAudit(tenantId, { actorId: null, action: 'billing.paddle', detail: `${event.event_type}: ${update.plan || 'plan unchanged'}, ${update.status || 'status unchanged'}` }).catch(() => {});
    }
    return res.json({ success: true, applied });
  } catch (error) {
    return sendError(res, error, 'Webhook could not be processed.', 'paddle webhook');
  }
});

// The platform owner changes a company's plan, status, trial or limits (card payments arrive through Paddle).
app.patch('/api/platform/tenants/:id/plan', authMiddleware, requirePlatformAdmin, async (req, res) => {
  try {
    const tenantId = /^\d{1,9}$/.test(String(req.params.id)) ? Number(req.params.id) : null;
    if (!tenantId) return res.status(404).json({ success: false, message: 'Company not found.' });
    const change = plans.validatePlanChange(req.body);
    if (change.trialDays && !change.status) change.status = 'trial';
    const tenant = await updateTenantPlan(tenantId, change);
    const plan = plans.resolvePlan(tenant);
    audit(req, 'company.plan', `${tenant.name}: ${plan.name}, ${plan.status}${plan.trialEndsAt ? ` until ${plan.trialEndsAt}` : ''}`);
    return res.json({ success: true, plan });
  } catch (error) {
    return sendError(res, error, 'The plan could not be changed.', 'tenant plan');
  }
});

// A new customer company with its first administrator. Each company sees only its own data.
app.post('/api/platform/tenants', authMiddleware, requirePlatformAdmin, async (req, res) => {
  const { companyName, adminName, adminEmail, adminPassword, plan = 'growth' } = req.body || {};
  if (!plans.PLANS[plan]) return res.status(400).json({ success: false, message: `Plan must be one of: ${plans.PLAN_KEYS.join(', ')}.` });
  if (typeof companyName !== 'string' || !companyName.trim() || companyName.trim().length > MAX_LEN.companyName) {
    return res.status(400).json({ success: false, message: `Company name is required (at most ${MAX_LEN.companyName} characters).` });
  }
  const identityError = validateNameAndEmail(adminName, adminEmail);
  if (identityError) return res.status(400).json({ success: false, message: identityError });
  const passwordError = validateNewPassword(adminPassword);
  if (passwordError) return res.status(400).json({ success: false, message: passwordError });
  try {
    const result = await createTenantWithAdmin({
      name: companyName.trim(),
      adminName: adminName.trim(),
      adminEmail: adminEmail.trim().toLowerCase(),
      passwordHash: await bcrypt.hash(adminPassword, BCRYPT_COST),
      plan,
      trialDays: plans.TRIAL_DAYS
    });
    audit(req, 'company.created', companyName.trim());
    return res.status(201).json({ success: true, ...result });
  } catch (error) {
    if (String(error.code) === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({ success: false, message: 'A user with this email already exists.' });
    }
    return sendError(res, error, 'Company could not be created.', 'create tenant');
  }
});

app.use('/api', (req, res) => {
  res.status(404).json({ success: false, message: 'Not found.' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Final safety net: never leak internals (stack traces, SQL, paths) to clients.
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: 'Request body must be valid JSON.' });
  }
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: 'Request body is too large.' });
  }
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
    return res.status(error.status).json({ success: false, message: 'Request could not be processed.' });
  }
  console.error('[unhandled] failed:', error?.message || error);
  return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
});

function startServer() {
  return initialize()
    .then(() => new Promise((resolve) => {
      const server = app.listen(PORT, HOST, () => {
        console.log(`VEYRA API running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT} (${isProduction ? 'production' : 'development'}, ${WEIGHT_UNIT}, ${CURRENCY}, sign-up: ${REGISTRATION_MODE}, AI: ${aiGateway.isEnabled() ? 'on' : 'off'}, messaging: ${messaging.channelsOf(messaging.envConfig()).join('+') || 'per company only'}, NEXUS: ${process.env.NEXUS_ENABLED === 'false' ? 'off' : 'on'})`);
        runAsSystem(() => {
          jobQueue.start();
          nexus.startSweeper();
          startMailboxPoller();
          startBackups();
        });
        if (!isProduction) {
          console.warn('[VEYRA] Development mode: demo accounts with public passwords exist. Never expose this server to the internet.');
        }
        resolve(server);
      });
    }))
    .catch((error) => {
      console.error('Database initialization failed:', error);
      process.exit(1);
    });
}

module.exports = {
  app,
  initialize,
  startServer,
  authRateLimiters
};

if (require.main === module) {
  startServer();
}
