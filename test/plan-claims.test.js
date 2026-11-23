// What the plans promise is what the server allows. The pricing page and the Billing page show `features` from
// lib/plans.js; the server checks `capabilities` (needsPlan). A feature line that names AI, GPS, email automation,
// messaging or workflows must be backed by that capability on the same plan, and the user guide's table must agree.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { PLANS, CAPABILITIES } = require('../lib/plans');

const root = path.join(__dirname, '..');
const order = ['starter', 'growth', 'scale', 'enterprise'];

// Which words in a feature line promise which capability. "(no AI model)" is an explicit non-promise.
const PROMISES = {
  ai: /\bAI\b|FLOW|VAULT|language model/i,
  gps: /\bGPS\b/i,
  email: /email automation|order inbox|mailbox|gmail|outlook/i,
  messaging: /whatsapp|\bSMS\b|twilio/i,
  workflows: /automation studio|workflow/i
};
const promisedBy = (line) => Object.keys(PROMISES).filter((key) => PROMISES[key].test(line.replace(/\(no AI model\)/i, '')));

// A plan's own lines plus everything it inherits through "All <Plan> features".
function claimsOf(key) {
  const lines = PLANS[key].features;
  const inherited = lines.map((line) => /^All (\w+) features$/.exec(line)).filter(Boolean).map((match) => match[1].toLowerCase());
  return [...lines.filter((line) => !/^All \w+ features$/.test(line)), ...inherited.flatMap(claimsOf)];
}

test('every capability a plan has is advertised, and nothing is advertised that the plan cannot do', () => {
  assert.deepEqual(Object.keys(PROMISES).sort(), Object.keys(CAPABILITIES).sort(), 'every capability has a promise pattern');
  for (const key of order) {
    const promised = [...new Set(claimsOf(key).flatMap(promisedBy))].sort();
    assert.deepEqual(promised, [...PLANS[key].capabilities].sort(), `${key}: the features promise ${promised.join(', ') || 'nothing'}, the server allows ${PLANS[key].capabilities.join(', ') || 'nothing'}`);
  }
});

test('Starter promises no AI model; its only AI words say "no AI model"', () => {
  const lines = claimsOf('starter');
  assert.deepEqual(PLANS.starter.capabilities, []);
  assert.ok(lines.some((line) => /no AI model/i.test(line)));
  assert.deepEqual(lines.filter((line) => /\bAI\b/.test(line) && !/no AI model/i.test(line)), []);
});

test('the routes that call an AI model are closed to plans without the AI capability', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8').split('\n');
  for (const route of ["'/api/agents/flow/parse'", "'/api/inbox/:id/parse'", "'/api/shipments/:id/documents/:docId/extract'"]) {
    const line = server.find((text) => text.includes(route) && /app\.(post|get)\(/.test(text));
    assert.ok(line, route);
    assert.match(line, /needsPlan\('ai'\)/, route);
  }
  // NEXUS reads emails and documents with AI only when the company's plan has it.
  assert.match(fs.readFileSync(path.join(root, 'agents', 'nexus.js'), 'utf8'), /capabilities\.includes\('ai'\)/);
});

test('the user guide plan table matches lib/plans.js (price, users, shipments, where AI starts)', () => {
  const guide = fs.readFileSync(path.join(root, 'USER_GUIDE.md'), 'utf8').split('\n');
  const number = (value) => value.toLocaleString('en-US');
  for (const [index, key] of order.entries()) {
    const plan = PLANS[key];
    const row = guide.find((line) => line.startsWith(`| ${plan.name} |`));
    assert.ok(row, `${plan.name} row in USER_GUIDE.md`);
    const [, , price, users, shipments, adds] = row.split('|').map((cell) => cell.trim());
    assert.ok(price.includes(`$${number(plan.monthly)}`), `${plan.name} price`);
    assert.ok(users.startsWith(String(plan.users)), `${plan.name} users`);
    assert.ok(shipments.startsWith(number(plan.shipments)), `${plan.name} shipments`);
    if (key === 'starter') assert.match(adds, /no AI model/);
    const aiStartsHere = plan.capabilities.includes('ai') && !(index > 0 && PLANS[order[index - 1]].capabilities.includes('ai'));
    if (aiStartsHere) assert.match(adds, /FLOW|VAULT/, `${plan.name} is where the AI agents start`);
  }
});
