/* =========================================================
   Plans: what each subscription includes and allows.
   One source of truth for the pricing page, the Billing page and the server checks.
   ========================================================= */
const { httpError } = require('./validation');

const TRIAL_DAYS = 14;
// Yearly billing: two months free (10 × monthly), shown as "Save 17%".
const YEARLY_MONTHS_PAID = 10;

// Capabilities a plan switches on. Anything not listed is available on every plan.
// Every line in a plan's `features` is a promise on the pricing page: it must be something the product does for that
// plan (a capability below, or something every plan has), or a service the owner delivers (support, onboarding, SLA).
// test/plan-claims.test.js checks that the AI, GPS, email, messaging and workflow claims match `capabilities`.
const CAPABILITIES = {
  ai: 'AI agents that read orders and documents (FLOW, VAULT)',
  gps: 'GPS tracking integrations',
  email: 'Email automation (order inbox, mailbox, Gmail / Outlook)',
  messaging: 'WhatsApp / SMS integrations',
  workflows: 'Advanced AI automation (Automation Studio workflows)'
};

const PLANS = {
  starter: {
    key: 'starter',
    name: 'Starter',
    tagline: 'For small teams getting started',
    monthly: 99,
    users: 3,
    shipments: 100,
    capabilities: [],
    features: ['3 users', '100 shipments / month', 'Shipments, multi-leg orders and trips', 'Carrier management', 'Analytics', 'Rule-based helpers (no AI model): carrier ranking, lane times, price checks, risk alerts', 'Tracking with positions your team enters', 'Email support']
  },
  growth: {
    key: 'growth',
    name: 'Growth',
    tagline: 'For growing logistics businesses',
    monthly: 249,
    users: 10,
    shipments: 500,
    popular: true,
    capabilities: ['ai', 'gps', 'email', 'messaging'],
    features: ['10 users', '500 shipments / month', 'All Starter features', 'AI agents that read order emails and documents (FLOW, VAULT)', 'GPS tracking integration', 'Email automation (order inbox, mailbox, Gmail / Outlook)', 'WhatsApp / SMS through your own Twilio account', 'Priority support']
  },
  scale: {
    key: 'scale',
    name: 'Scale',
    tagline: 'For established operations',
    monthly: 599,
    users: 25,
    shipments: 2000,
    capabilities: ['ai', 'gps', 'email', 'messaging', 'workflows'],
    features: ['25 users', '2,000 shipments / month', 'All Growth features', 'Automation Studio workflows (your own rules)', 'Dedicated onboarding', 'Priority support']
  },
  enterprise: {
    key: 'enterprise',
    name: 'Enterprise',
    tagline: 'For large logistics networks',
    monthly: 1499,
    priceFrom: true,
    users: 50,
    shipments: 5000,
    custom: true,
    capabilities: ['ai', 'gps', 'email', 'messaging', 'workflows'],
    features: ['50+ users', '5,000+ shipments / month', 'All Scale features', 'User and shipment limits set for your company', 'Integrations built to order (by agreement)', 'Dedicated account manager', 'Custom SLA', 'Enterprise support']
  }
};

const PLAN_KEYS = Object.keys(PLANS);
const STATUSES = ['trial', 'active', 'past_due', 'cancelled'];

// What the public pricing page needs: no limits that are only for the server.
function publicPlans() {
  return PLAN_KEYS.map((key) => {
    const plan = PLANS[key];
    return {
      key,
      name: plan.name,
      tagline: plan.tagline,
      monthly: plan.monthly,
      yearlyPerMonth: Math.round((plan.monthly * YEARLY_MONTHS_PAID) / 12),
      priceFrom: Boolean(plan.priceFrom),
      popular: Boolean(plan.popular),
      contactSales: Boolean(plan.custom),
      features: plan.features
    };
  });
}

const daysLeft = (iso, now = Date.now()) => (iso ? Math.ceil((Date.parse(iso) - now) / 86400000) : null);

// The plan a company is on right now, with its limits. Enterprise limits can be raised per company.
function resolvePlan(tenant, now = Date.now()) {
  const key = PLANS[tenant?.plan] ? tenant.plan : 'growth';
  const plan = PLANS[key];
  const status = STATUSES.includes(tenant?.planStatus) ? tenant.planStatus : 'active';
  const trialDaysLeft = status === 'trial' ? daysLeft(tenant?.trialEndsAt, now) : null;
  const trialOver = status === 'trial' && trialDaysLeft !== null && trialDaysLeft <= 0;
  return {
    key,
    name: plan.name,
    monthly: plan.monthly,
    priceFrom: Boolean(plan.priceFrom),
    status,
    trialEndsAt: status === 'trial' ? tenant?.trialEndsAt || null : null,
    trialDaysLeft: trialOver ? 0 : trialDaysLeft,
    // A finished trial, an unpaid or a cancelled plan keeps every record readable but adds nothing new.
    locked: trialOver || status === 'past_due' || status === 'cancelled',
    users: Number(tenant?.userLimit) > 0 ? Number(tenant.userLimit) : plan.users,
    shipments: Number(tenant?.shipmentLimit) > 0 ? Number(tenant.shipmentLimit) : plan.shipments,
    capabilities: plan.capabilities,
    features: plan.features
  };
}

function lockedMessage(plan) {
  if (plan.status === 'trial') return 'Your free trial has ended. Choose a plan to keep adding loads and people.';
  if (plan.status === 'past_due') return 'Your subscription payment is overdue. Pay the open invoice to keep adding loads and people.';
  return 'Your subscription is cancelled. Choose a plan to keep adding loads and people.';
}

// Throws a 402 the browser can show as is. Reading data is never blocked.
function assertCapability(plan, capability) {
  if (plan.locked) throw httpError(402, lockedMessage(plan));
  if (!plan.capabilities.includes(capability)) {
    const needed = PLAN_KEYS.find((key) => PLANS[key].capabilities.includes(capability));
    throw httpError(402, `${CAPABILITIES[capability]} ${capability === 'workflows' ? 'are' : 'is'} part of the ${PLANS[needed].name} plan and above. You are on ${plan.name}.`);
  }
}

function assertCanAddShipment(plan, usedThisMonth) {
  if (plan.locked) throw httpError(402, lockedMessage(plan));
  if (usedThisMonth >= plan.shipments) {
    throw httpError(402, `Your ${plan.name} plan includes ${plan.shipments.toLocaleString('en-US')} shipments a month and this month's are used. Upgrade to add more.`);
  }
}

function assertCanAddUser(plan, activeUsers) {
  if (plan.locked) throw httpError(402, lockedMessage(plan));
  if (activeUsers >= plan.users) {
    throw httpError(402, `Your ${plan.name} plan includes ${plan.users} users. Disable someone or upgrade to add more.`);
  }
}

function validatePlanChange(body) {
  const input = body && typeof body === 'object' ? body : {};
  const out = {};
  if (input.plan !== undefined) {
    if (!PLANS[input.plan]) throw httpError(400, `Plan must be one of: ${PLAN_KEYS.join(', ')}.`);
    out.plan = input.plan;
  }
  if (input.status !== undefined) {
    if (!STATUSES.includes(input.status)) throw httpError(400, `Status must be one of: ${STATUSES.join(', ')}.`);
    out.status = input.status;
  }
  if (input.trialDays !== undefined) {
    const days = Number(input.trialDays);
    if (!Number.isInteger(days) || days < 1 || days > 90) throw httpError(400, 'Trial length must be 1 to 90 days.');
    out.trialDays = days;
  }
  for (const [field, max] of [['userLimit', 100000], ['shipmentLimit', 10000000]]) {
    if (input[field] === undefined) continue;
    if (input[field] === null || input[field] === '') {
      out[field] = null;
      continue;
    }
    const value = Number(input[field]);
    if (!Number.isInteger(value) || value < 1 || value > max) throw httpError(400, `${field} must be a whole number from 1 to ${max}, or empty for the plan default.`);
    out[field] = value;
  }
  if (!Object.keys(out).length) throw httpError(400, 'Nothing to change.');
  return out;
}

module.exports = {
  TRIAL_DAYS, PLANS, PLAN_KEYS, STATUSES, CAPABILITIES,
  publicPlans, resolvePlan, assertCapability, assertCanAddShipment, assertCanAddUser, validatePlanChange
};
