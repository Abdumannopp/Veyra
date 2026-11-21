/* =========================================================
   The background worker for durable jobs (the rows live in the `jobs` table, see database.js).
   - enqueue(): saves the job first, then wakes the worker. A job survives a restart.
   - A failing job is retried after 30 s, 60 s, 2 min ... (at most 15 min) up to its max attempts, then kept as "dead".
   - Jobs of one company and lane run one after another, in order; companies do not wait for each other.
   - The handler runs as the company that owns the job (row level security applies).
   - idle() resolves when nothing is due or running (tests and graceful shutdown).
   ========================================================= */
const crypto = require('node:crypto');
const db = require('../database');
const { runAsSystem, runAsTenant } = require('./tenant-context');

const handlers = new Map();
const inflight = new Set();
const pendingEnqueues = new Set();
const workerId = `${process.pid}-${crypto.randomBytes(3).toString('hex')}`;

const settings = {
  concurrency: Math.max(1, Number(process.env.JOBS_CONCURRENCY) || 4),
  pollMs: Math.max(200, Number(process.env.JOBS_POLL_MS) || 2000),
  baseDelaySeconds: Math.max(1, Number(process.env.JOBS_RETRY_BASE_SECONDS) || 30),
  visibilitySeconds: Math.max(30, Number(process.env.JOBS_VISIBILITY_SECONDS) || 600)
};

let timer = null;
let ticks = 0;
let pumping = null;

function register(kind, handler) {
  handlers.set(kind, handler);
}

// Bookkeeping on the job row is server work (system); only the handler runs as the job's company.
async function execute(job) {
  const handler = handlers.get(job.kind);
  const bookkeeping = (work) => runAsSystem(work);
  if (!handler) {
    await bookkeeping(() => db.failJob(job, new Error(`No handler is registered for "${job.kind}".`), { permanent: true }));
    return;
  }
  try {
    const payload = JSON.parse(job.payload || '{}');
    await runAsTenant(job.tenantId, () => handler(payload, job));
    await bookkeeping(() => db.completeJob(job.id));
  } catch (error) {
    const outcome = await bookkeeping(() => db.failJob(job, error, { baseDelaySeconds: settings.baseDelaySeconds }));
    console.error(`[jobs] ${job.kind} #${job.id} failed (attempt ${job.attempts}/${job.maxAttempts}, ${outcome}):`, error.message);
  }
}

// Starts as many due jobs as there are free slots. Returns how many it started.
async function pumpOnce() {
  let started = 0;
  while (inflight.size < settings.concurrency) {
    const job = await runAsSystem(() => db.claimJob(workerId));
    if (!job) break;
    started += 1;
    const running = execute(job)
      .catch((error) => console.error('[jobs] bookkeeping failed:', error.message))
      .finally(() => {
        inflight.delete(running);
        kick();
      });
    inflight.add(running);
  }
  return started;
}

// One pump at a time; asking again while it runs makes it look once more.
function pump() {
  if (!pumping) {
    pumping = (async () => {
      try {
        while ((await pumpOnce()) > 0) { /* keep filling free slots */ }
      } catch (error) {
        console.error('[jobs] worker failed:', error.message);
      } finally {
        pumping = null;
      }
    })();
  }
  return pumping;
}

function kick() {
  setImmediate(() => pump());
}

async function enqueue(job) {
  // Saved as the company the job belongs to, whoever asked for it (a request, a background task or a script).
  const work = runAsTenant(job.tenantId, () => db.enqueueJob(job)).then((result) => {
    kick();
    return result;
  });
  pendingEnqueues.add(work);
  try {
    return await work;
  } finally {
    pendingEnqueues.delete(work);
  }
}

async function idle() {
  for (;;) {
    if (pendingEnqueues.size) await Promise.allSettled([...pendingEnqueues]);
    await pump();
    if (!inflight.size && !pendingEnqueues.size) return;
    await Promise.allSettled([...inflight]);
  }
}

function start() {
  if (timer) return;
  const tick = async () => {
    ticks += 1;
    try {
      await runAsSystem(async () => {
        if (ticks % 15 === 1) {
          const recovered = await db.recoverStuckJobs(settings.visibilitySeconds);
          if (recovered.requeued || recovered.dead) console.warn(`[jobs] recovered ${recovered.requeued} stuck job(s), gave up on ${recovered.dead}.`);
        }
        if (ticks % 1800 === 1) await db.pruneJobs(7);
      });
    } catch (error) {
      console.error('[jobs] housekeeping failed:', error.message);
    }
    pump();
  };
  timer = setInterval(tick, settings.pollMs);
  timer.unref();
  setTimeout(tick, 1000).unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { register, enqueue, idle, start, stop, kick, settings };
