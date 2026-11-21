/* =========================================================
   Who is this database work for?
   - runAsTenant(id, fn): everything inside sees only that company's rows (PostgreSQL row level security).
   - runAsSystem(fn): server-owned work that spans companies (login lookup, webhooks, background jobs, startup).
   - Outside both, PostgreSQL shows no company data at all (fail closed).
   The context follows async calls automatically, so data functions need no extra argument.
   ========================================================= */
const { AsyncLocalStorage } = require('node:async_hooks');

const store = new AsyncLocalStorage();

function runAsTenant(tenantId, work) {
  if (!Number.isInteger(tenantId) || tenantId <= 0) throw new Error('A tenant is required for this operation.');
  return store.run({ tenantId }, work);
}

function runAsSystem(work) {
  return store.run({ system: true }, work);
}

const current = () => store.getStore() || null;

// Settings PostgreSQL receives for a context.
function settingsFor(context) {
  if (context?.system) return { tenantId: '', system: 'on' };
  if (context?.tenantId) return { tenantId: String(context.tenantId), system: 'off' };
  return { tenantId: '', system: 'off' };
}

module.exports = { runAsTenant, runAsSystem, current, settingsFor };
