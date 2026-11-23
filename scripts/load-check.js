// Load test (Phase 6.3): many people using Veyra at once, measured from outside.
//
//   LOAD_TEST_URL=http://localhost:4000 LOAD_TEST_EMAIL=... LOAD_TEST_PASSWORD=... node scripts/load-check.js
//   Options (environment): LOAD_TEST_USERS (default 20), LOAD_TEST_SECONDS (default 30).
//
// Each simulated user logs in once, then keeps opening the dashboard, the shipment list and one load, as a
// dispatcher would. Only reads: it creates nothing. Run it against a staging copy, not production: it is
// meant to find the limits. A production URL is refused unless LOAD_TEST_ALLOW_PRODUCTION=yes.
// The report: requests per second, error rate, and response times (median, 95th and 99th percentile).
require('dotenv').config({ quiet: true });

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);

async function run({ url, email, password, users = 20, seconds = 30, fetchImpl = fetch } = {}) {
  const base = String(url || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('LOAD_TEST_URL must be the server address, e.g. http://localhost:4000');
  const timings = [];
  let errors = 0;
  const firstErrors = [];
  const timed = async (path, cookie) => {
    const started = performance.now();
    try {
      const response = await fetchImpl(`${base}${path}`, { headers: { cookie } });
      await response.arrayBuffer();
      if (!response.ok) throw new Error(`${path} answered ${response.status}`);
      return response;
    } catch (error) {
      errors += 1;
      if (firstErrors.length < 5) firstErrors.push(error.message);
      return null;
    } finally {
      timings.push(performance.now() - started);
    }
  };
  const login = await fetchImpl(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!login.ok) throw new Error(`Login failed (${login.status}). Check LOAD_TEST_EMAIL and LOAD_TEST_PASSWORD.`);
  const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
  const list = await (await fetchImpl(`${base}/api/shipments`, { headers: { cookie } })).json().catch(() => ({}));
  const ids = (list.shipments || []).slice(0, 20).map((shipment) => shipment.id);
  const end = Date.now() + seconds * 1000;
  const worker = async () => {
    let step = 0;
    while (Date.now() < end) {
      const path = ['/api/dashboard', '/api/shipments', ids.length ? `/api/v2/shipments/${encodeURIComponent(ids[step % ids.length])}` : '/api/shipments'][step % 3];
      await timed(path, cookie);
      step += 1;
    }
  };
  const started = Date.now();
  await Promise.all(Array.from({ length: users }, worker));
  const elapsed = (Date.now() - started) / 1000;
  const sorted = [...timings].sort((a, b) => a - b);
  return {
    users, seconds: Math.round(elapsed), requests: timings.length, perSecond: Math.round(timings.length / elapsed),
    errorRate: timings.length ? Math.round((errors / timings.length) * 1000) / 10 : 0, firstErrors,
    ms: { median: Math.round(percentile(sorted, 50)), p95: Math.round(percentile(sorted, 95)), p99: Math.round(percentile(sorted, 99)) }
  };
}

if (require.main === module) {
  const url = process.env.LOAD_TEST_URL;
  if (/railway\.app|veyra\.(ai|app|com)/i.test(String(url)) && process.env.LOAD_TEST_ALLOW_PRODUCTION !== 'yes') {
    console.error('This looks like production. Use a staging copy, or set LOAD_TEST_ALLOW_PRODUCTION=yes if you really mean it.');
    process.exit(2);
  }
  run({
    url, email: process.env.LOAD_TEST_EMAIL, password: process.env.LOAD_TEST_PASSWORD,
    users: Number(process.env.LOAD_TEST_USERS) || 20, seconds: Number(process.env.LOAD_TEST_SECONDS) || 30
  }).then((report) => {
    console.log(`${report.users} users for ${report.seconds}s: ${report.requests} requests (${report.perSecond}/s), errors ${report.errorRate}%`);
    console.log(`Response time: median ${report.ms.median} ms, 95% under ${report.ms.p95} ms, 99% under ${report.ms.p99} ms`);
    if (report.firstErrors.length) console.log(`First errors: ${report.firstErrors.join('; ')}`);
    process.exit(report.errorRate > 1 ? 1 : 0);
  }).catch((error) => {
    console.error(error.message);
    process.exit(2);
  });
}

module.exports = { run };
