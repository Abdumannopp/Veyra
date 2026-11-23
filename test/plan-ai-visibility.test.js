// The AI card and the AI controls follow the plan. Starter has no AI agents: it must not see the "Veyra AI" card on the
// dashboard or the controls of FLOW / VAULT, and the server must still refuse every AI call. Growth, Scale and
// Enterprise keep everything. Each plan is checked through the real server answers and the real screen code
// (public/plan-ui.js, run here against a small fake page).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { after, before, test } = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-planai-'));
Object.assign(process.env, { NODE_ENV: 'development', DATABASE_PATH: path.join(dir, 'p.db'), PORT: '0', BCRYPT_COST: '10', API_RATE_LIMIT_MAX: '5000', NEXUS_ENABLED: 'false', OPENROUTER_API_KEY: 'sk-or-test' });
const { app, initialize } = require('../server');
const { db } = require('../database');
const { PLANS } = require('../lib/plans');

const root = path.join(__dirname, '..');
const PLAN_KEYS = ['starter', 'growth', 'scale', 'enterprise'];
const hasAi = (key) => PLANS[key].capabilities.includes('ai');

let server; let base; let owner; let boss; let tenantId; let shipmentId;
const call = (cookie, method, url, body) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
const json = async (...args) => (await call(...args)).json();
async function login(email, password) { return (await call(null, 'POST', '/api/login', { email, password })).headers.get('set-cookie').split(';')[0]; }
const setPlan = (plan) => call(owner, 'PATCH', `/api/platform/tenants/${tenantId}/plan`, { plan, status: 'active' });

before(async () => {
  await initialize();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  owner = await login('admin@veyra.ai', 'admin123');
  const created = await json(owner, 'POST', '/api/platform/tenants', { companyName: 'Plan AI Co', adminName: 'Pat', adminEmail: 'pat@planai.example', adminPassword: 'plan-company-pass-1', plan: 'starter' });
  tenantId = created.tenant.id;
  boss = await login('pat@planai.example', 'plan-company-pass-1');
  const shipment = await json(boss, 'POST', '/api/shipments', { customer: 'C', origin: 'Austin, US', destination: 'Dallas, US', pickup: '2030-05-10', delivery: '2030-05-12', weight: 100, equipment: 'Dry Van' });
  shipmentId = Number(String(shipment.shipment.id).replace('SHP-', ''));
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => db.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

// The real screen code, against a fake page with the three elements it touches.
function screen() {
  const element = () => {
    const classes = new Set();
    return { text: '', get textContent() { return this.text; }, set textContent(value) { this.text = value; }, classList: { toggle: (name, force) => (force ? classes.add(name) : classes.delete(name)), contains: (name) => classes.has(name) } };
  };
  const card = element(); const promo = element(); const intake = element();
  const sandbox = {
    VeyraConfig: { ai: { enabled: true } },
    document: { querySelector: (selector) => (selector === '.assistant-card' ? card : null), getElementById: (id) => ({ sidePromoText: promo, aiIntake: intake })[id] || null }
  };
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'plan-ui.js'), 'utf8'), sandbox);
  return { ai: sandbox.VeyraAi, card, promo, intake, sandbox };
}

test('every plan: the card, the AI intake and the sidebar text follow what /api/me says about the plan', async () => {
  for (const key of PLAN_KEYS) {
    assert.equal((await setPlan(key)).status, 200, key);
    const me = await json(boss, 'GET', '/api/me');
    assert.equal(me.plan.key, key);
    assert.equal(me.plan.capabilities.includes('ai'), hasAi(key), `${key}: capabilities`);

    const { ai, card, promo, intake } = screen();
    ai.set(me.plan);
    ai.apply();
    assert.equal(card.classList.contains('hidden'), !hasAi(key), `${key}: the "Veyra AI" card is ${hasAi(key) ? 'shown' : 'hidden'}`);
    assert.equal(intake.classList.contains('hidden'), !hasAi(key), `${key}: the order-reading panel`);
    assert.equal(/reads orders/.test(promo.text), hasAi(key), `${key}: the sidebar text only says "reads orders" where the plan can`);
    assert.match(promo.text, /ranks carriers/, `${key}: the sidebar text stays`);
    assert.equal(ai.allowed(), hasAi(key));
  }
});

test('every plan: the Billing answer gives the same result as /api/me (a plan change shows at once)', async () => {
  for (const key of PLAN_KEYS) {
    await setPlan(key);
    const billing = await json(boss, 'GET', '/api/billing/plan');
    const { ai, card } = screen();
    ai.setPlan(billing.plan);
    assert.equal(card.classList.contains('hidden'), !hasAi(key), key);
    assert.equal(ai.allowed(), hasAi(key), key);
  }
  // Upgrading while the page is open: Starter -> Growth shows the card.
  await setPlan('starter');
  const { ai, card } = screen();
  ai.setPlan((await json(boss, 'GET', '/api/billing/plan')).plan);
  assert.equal(card.classList.contains('hidden'), true);
  await setPlan('growth');
  ai.setPlan((await json(boss, 'GET', '/api/billing/plan')).plan);
  assert.equal(card.classList.contains('hidden'), false);
});

test('signed out the sample dashboard is unchanged; signed in without a known plan counts as no AI', () => {
  const out = screen();
  out.ai.set(null);
  out.ai.apply();
  assert.equal(out.card.classList.contains('hidden'), false, 'signed out: the sample card is shown');
  assert.equal(out.ai.allowed(), true);
  const unknown = screen();
  unknown.ai.set({ capabilities: [] });
  unknown.ai.apply();
  assert.equal(unknown.card.classList.contains('hidden'), true, 'a missing plan hides the AI card');
  assert.equal(unknown.ai.allowed(), false);
  const noModel = screen();
  noModel.sandbox.VeyraConfig.ai.enabled = false;
  noModel.ai.set({ capabilities: ['ai'] });
  noModel.ai.apply();
  assert.equal(noModel.card.classList.contains('hidden'), false, 'the card follows the plan, not the model key');
  assert.equal(noModel.intake.classList.contains('hidden'), true, 'the reading panel also needs the model key, as before');
});

test('every plan: the server answers for AI exactly as before (402 on Starter), whatever the screen shows', async () => {
  for (const key of PLAN_KEYS) {
    await setPlan(key);
    const results = [
      await call(boss, 'POST', '/api/agents/flow/parse', { text: 'Pick up 5 t in Austin for Dallas tomorrow' }),
      await call(boss, 'POST', '/api/inbox/999/parse'),
      await call(boss, 'POST', `/api/shipments/${shipmentId}/documents/999/extract`)
    ];
    for (const res of results) {
      if (hasAi(key)) assert.notEqual(res.status, 402, `${key}: not blocked by the plan`);
      else {
        assert.equal(res.status, 402, `${key}: blocked by the plan`);
        assert.match((await res.json()).message, /plan/);
      }
    }
  }
});

test('document reading is offered only where the plan includes AI', async () => {
  for (const key of PLAN_KEYS) {
    await setPlan(key);
    const list = await json(boss, 'GET', `/api/shipments/${shipmentId}/documents`);
    assert.equal(list.readsDocuments, hasAi(key), key);
  }
});

test('the AI automations are marked for the screens; rule-based ones are not', async () => {
  await setPlan('starter');
  const center = await json(boss, 'GET', '/api/ai/command-center');
  assert.deepEqual(center.automations.filter((item) => item.needsAi).map((item) => item.key).sort(), ['readDocuments', 'readOrders']);
  const studio = await json(boss, 'GET', '/api/automation/studio');
  assert.deepEqual(studio.builtIn.filter((item) => item.needsAi).map((item) => item.key).sort(), ['readDocuments', 'readOrders']);
  assert.ok(studio.builtIn.some((item) => item.key === 'priceCheck' && !item.needsAi), 'price check needs no AI model');
});

test('the page wires it up: the card, the sidebar text and the AI panel exist and plan-ui.js loads before script.js', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  assert.match(html, /class="card assistant-card"/);
  assert.match(html, /id="sidePromoText"/);
  assert.match(html, /id="aiIntake"/);
  assert.ok(html.indexOf('plan-ui.js') > -1 && html.indexOf('plan-ui.js') < html.indexOf('src="script.js"'), 'plan-ui.js must load first');
  const script = fs.readFileSync(path.join(root, 'public', 'script.js'), 'utf8');
  assert.match(script, /window\.VeyraAi\.set\(result\.plan/, 'sign-in keeps the plan');
  assert.match(script, /window\.VeyraAi\.apply\(\)/, 'the chrome applies it');
  const views = fs.readFileSync(path.join(root, 'public', 'views.js'), 'utf8');
  assert.match(views, /VeyraAi\?\.setPlan\(billing\.plan\)/, 'the Billing page keeps the plan in step');
  assert.match(views, /Part of the Growth plan and above/, 'the agents page explains it without a button');
});
