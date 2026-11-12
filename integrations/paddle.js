/* =========================================================
   Paddle Billing: card payments for Veyra plans.
   - The browser opens Paddle's own checkout (Paddle.js); card details never touch Veyra.
   - Paddle tells Veyra what happened through a signed webhook; only that changes a plan.
   - With an API key, admins can open Paddle's billing portal and switch plans.
   Everything is off until the keys are set (see .env.example).
   ========================================================= */
const crypto = require('crypto');

const PLAN_KEYS = ['starter', 'growth', 'scale'];
const PERIODS = ['monthly', 'yearly'];
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

let transport = (url, init) => fetch(url, init);
function setTransport(fn) {
  transport = fn || ((url, init) => fetch(url, init));
}

const env = (name) => String(process.env[name] || '').trim();
const environment = () => (env('PADDLE_ENV').toLowerCase() === 'production' ? 'production' : 'sandbox');
const apiBase = () => (environment() === 'production' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com');

// Price ids from the Paddle dashboard, one per plan and billing period.
function prices() {
  const out = {};
  for (const plan of PLAN_KEYS) {
    for (const period of PERIODS) {
      const id = env(`PADDLE_PRICE_${plan.toUpperCase()}_${period.toUpperCase()}`);
      if (/^pri_[a-z0-9_]{10,60}$/i.test(id)) {
        out[plan] = out[plan] || {};
        out[plan][period] = id;
      }
    }
  }
  return out;
}

function enabled() {
  return Boolean(env('PADDLE_CLIENT_TOKEN') && env('PADDLE_WEBHOOK_SECRET') && Object.keys(prices()).length);
}
const apiEnabled = () => enabled() && Boolean(env('PADDLE_API_KEY'));

function priceFor(plan, period) {
  return prices()[plan]?.[period] || null;
}

function planForPrice(priceId) {
  for (const [plan, byPeriod] of Object.entries(prices())) {
    for (const [period, id] of Object.entries(byPeriod)) {
      if (id === priceId) return { plan, period };
    }
  }
  return null;
}

// Paddle-Signature: "ts=1700000000;h1=<hex>" (more than one h1 during secret rotation).
// The signed text is "<ts>:<raw body>", HMAC-SHA256 with the notification secret.
function verifySignature(rawBody, header, secret = env('PADDLE_WEBHOOK_SECRET'), now = Date.now()) {
  if (!secret || !header || !Buffer.isBuffer(rawBody)) return false;
  const parts = String(header).split(';').map((part) => part.trim().split('='));
  const ts = parts.find(([key]) => key === 'ts')?.[1];
  const signatures = parts.filter(([key]) => key === 'h1').map(([, value]) => value || '');
  if (!/^\d{1,12}$/.test(ts || '') || !signatures.length) return false;
  if (Math.abs(now / 1000 - Number(ts)) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${ts}:`).update(rawBody).digest();
  return signatures.some((signature) => {
    if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
    return crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'));
  });
}

// The checkout carries the company it is for, signed so nobody can pay "for" a company and have
// a webhook move another company's plan.
function referenceFor(tenantId, secret) {
  const id = String(tenantId);
  return { veyra_tenant: id, veyra_sig: crypto.createHmac('sha256', secret).update(`paddle-tenant:${id}`).digest('hex') };
}

function tenantFromReference(customData, secret) {
  const id = String(customData?.veyra_tenant || '');
  const sig = String(customData?.veyra_sig || '');
  if (!/^\d{1,9}$/.test(id) || !/^[a-f0-9]{64}$/.test(sig)) return null;
  const expected = Buffer.from(referenceFor(id, secret).veyra_sig, 'hex');
  return crypto.timingSafeEqual(expected, Buffer.from(sig, 'hex')) ? Number(id) : null;
}

// Paddle subscription status → Veyra plan status.
function mapStatus(status) {
  if (status === 'active' || status === 'trialing') return 'active';
  if (status === 'past_due') return 'past_due';
  if (status === 'canceled' || status === 'paused') return 'cancelled';
  return null;
}

// Reads a subscription.* webhook into what Veyra stores. Returns null when it is not about a plan.
function readSubscriptionEvent(event) {
  if (!event || typeof event !== 'object' || !String(event.event_type || '').startsWith('subscription.')) return null;
  const data = event.data || {};
  const item = (data.items || []).find((entry) => planForPrice(entry?.price?.id));
  const match = item ? planForPrice(item.price.id) : null;
  return {
    subscriptionId: typeof data.id === 'string' ? data.id : null,
    customerId: typeof data.customer_id === 'string' ? data.customer_id : null,
    status: mapStatus(data.status),
    plan: match?.plan || null,
    period: match?.period || null,
    customData: data.custom_data || null,
    // Paddle can send events out of order; the newest change wins.
    changedAt: data.updated_at || event.occurred_at || null
  };
}

async function call(method, pathname, body) {
  const response = await transport(`${apiBase()}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${env('PADDLE_API_KEY')}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {
    payload = null;
  }
  if (!response.ok) {
    const error = new Error(payload?.error?.detail || `Paddle answered ${response.status}.`);
    error.statusCode = 502;
    throw error;
  }
  return payload?.data || null;
}

// A link to Paddle's portal: invoices, card, cancel. Valid for a short time.
async function portalUrl(customerId, subscriptionId) {
  const data = await call('POST', `/customers/${encodeURIComponent(customerId)}/portal-sessions`, subscriptionId ? { subscription_ids: [subscriptionId] } : {});
  return data?.urls?.general?.overview || null;
}

// Switches the plan right away; Paddle charges or credits the difference.
async function changePlan(subscriptionId, priceId) {
  return call('PATCH', `/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    items: [{ price_id: priceId, quantity: 1 }],
    proration_billing_mode: 'prorated_immediately'
  });
}

module.exports = {
  PLAN_KEYS, PERIODS, setTransport, environment, enabled, apiEnabled, prices, priceFor, planForPrice,
  verifySignature, referenceFor, tenantFromReference, mapStatus, readSubscriptionEvent, portalUrl, changePlan,
  clientToken: () => env('PADDLE_CLIENT_TOKEN')
};
