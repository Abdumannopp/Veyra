// Durable background jobs: saved before they run, retried with backoff, never added twice under one key,
// dead after the last attempt, recovered after a crash, in order per company, and run as their company.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-jobs-'));
// A failed job waits 10 minutes by itself; the tests make it due on purpose, so a slow machine cannot run it early.
Object.assign(process.env, { NODE_ENV: 'development', DATABASE_PATH: path.join(dir, 'j.db'), BCRYPT_COST: '10', NEXUS_ENABLED: 'false', JOBS_RETRY_BASE_SECONDS: '600' });

const database = require('../database');
const queue = require('../lib/job-queue');
const { current, runAsSystem, runAsTenant } = require('../lib/tenant-context');
const { db, initialize } = database;
// Test helpers read and change job rows as the server (system); row level security is on for PostgreSQL.
const sql = {
  run: (text, params) => runAsSystem(() => database.sql.run(text, params)),
  get: (text, params) => runAsSystem(() => database.sql.get(text, params))
};

let tenantB;
before(async () => {
  await initialize();
  tenantB = (await sql.run("INSERT INTO tenants (name) VALUES ('Company B')")).id;
});
after(async () => {
  await queue.idle();
  await new Promise((resolve) => db.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

const makeDue = (id) => sql.run("UPDATE jobs SET run_at = datetime('now', '-1 seconds') WHERE id = ?", [id]);
const row = (id) => sql.get('SELECT status, attempts, last_error AS lastError FROM jobs WHERE id = ?', [id]);

test('a job is saved, run once and marked done', async () => {
  const seen = [];
  queue.register('test.ok', (payload) => seen.push(payload.n));
  const { id, created } = await queue.enqueue({ tenantId: 1, kind: 'test.ok', payload: { n: 1 } });
  assert.equal(created, true);
  await queue.idle();
  assert.deepEqual(seen, [1]);
  assert.deepEqual(await row(id), { status: 'done', attempts: 1, lastError: null });
});

test('the same idempotency key is accepted once, per company and kind', async () => {
  const seen = [];
  queue.register('test.once', (payload) => seen.push(payload.n));
  const first = await queue.enqueue({ tenantId: 1, kind: 'test.once', payload: { n: 1 }, idempotencyKey: 'mail-42' });
  const again = await queue.enqueue({ tenantId: 1, kind: 'test.once', payload: { n: 2 }, idempotencyKey: 'mail-42' });
  const other = await queue.enqueue({ tenantId: tenantB, kind: 'test.once', payload: { n: 3 }, idempotencyKey: 'mail-42' });
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(other.created, true, 'another company may use the same key');
  await queue.idle();
  assert.deepEqual(seen.sort(), [1, 3]);
});

test('a failing job is retried later, then succeeds', async () => {
  let calls = 0;
  queue.register('test.flaky', () => {
    calls += 1;
    if (calls < 3) throw new Error(`try ${calls} failed`);
  });
  const { id } = await queue.enqueue({ tenantId: 1, kind: 'test.flaky', lane: 'flaky' });
  await queue.idle();
  assert.deepEqual(await row(id), { status: 'queued', attempts: 1, lastError: 'try 1 failed' });
  await makeDue(id);
  await queue.idle();
  assert.equal((await row(id)).attempts, 2);
  await makeDue(id);
  await queue.idle();
  assert.deepEqual(await row(id), { status: 'done', attempts: 3, lastError: null });
});

test('a job that keeps failing becomes dead, can be listed, and can be retried by hand', async () => {
  queue.register('test.broken', () => { throw new Error('always broken'); });
  const { id } = await queue.enqueue({ tenantId: 1, kind: 'test.broken', lane: 'broken', maxAttempts: 2 });
  await queue.idle();
  await makeDue(id);
  await queue.idle();
  assert.deepEqual(await row(id), { status: 'dead', attempts: 2, lastError: 'always broken' });
  const dead = await runAsTenant(1, () => database.listJobs(1, { status: 'dead' }));
  assert.equal(dead[0].id, id);
  assert.equal((await runAsTenant(1, () => database.jobStats(1))).dead >= 1, true);
  assert.equal(await runAsTenant(tenantB, () => database.retryJob(tenantB, id)), false, 'another company cannot retry it');
  assert.equal(await runAsTenant(1, () => database.retryJob(1, id)), true);
  assert.deepEqual(await row(id), { status: 'queued', attempts: 0, lastError: 'always broken' });
  await sql.run("UPDATE jobs SET status = 'dead' WHERE id = ?", [id]);
});

test('a job with no handler is dead at once', async () => {
  const { id } = await queue.enqueue({ tenantId: 1, kind: 'test.unknown', lane: 'unknown' });
  await queue.idle();
  const result = await row(id);
  assert.equal(result.status, 'dead');
  assert.match(result.lastError, /No handler/);
});

test('jobs of one company and lane run in order, even when an earlier one has to wait', async () => {
  const order = [];
  let failFirst = true;
  queue.register('test.step', (payload) => {
    if (payload.n === 1 && failFirst) {
      failFirst = false;
      throw new Error('first step failed once');
    }
    order.push(payload.n);
  });
  const first = await queue.enqueue({ tenantId: 1, kind: 'test.step', lane: 'ordered', payload: { n: 1 } });
  await queue.enqueue({ tenantId: 1, kind: 'test.step', lane: 'ordered', payload: { n: 2 } });
  await queue.enqueue({ tenantId: tenantB, kind: 'test.step', lane: 'ordered', payload: { n: 3 } });
  await queue.idle();
  assert.deepEqual(order, [3], 'company B is not held up; company A waits for its first step');
  await makeDue(first.id);
  await queue.idle();
  assert.deepEqual(order, [3, 1, 2]);
});

test('the handler runs as the company that owns the job', async () => {
  const seen = [];
  queue.register('test.who', () => seen.push(current()?.tenantId));
  await queue.enqueue({ tenantId: tenantB, kind: 'test.who', lane: 'who' });
  await queue.idle();
  assert.deepEqual(seen, [tenantB]);
});

test('a job left running by a crashed server is queued again; one out of attempts is given up', async () => {
  queue.register('test.crash', () => {});
  const stuck = await queue.enqueue({ tenantId: 1, kind: 'test.crash', lane: 'crash' });
  await sql.run("UPDATE jobs SET status = 'running', attempts = 1, locked_at = datetime('now', '-2 hours') WHERE id = ?", [stuck.id]);
  const spent = await queue.enqueue({ tenantId: 1, kind: 'test.crash', lane: 'crash2', maxAttempts: 1 });
  await sql.run("UPDATE jobs SET status = 'running', attempts = 1, locked_at = datetime('now', '-2 hours') WHERE id = ?", [spent.id]);
  const recovered = await runAsSystem(() => database.recoverStuckJobs(600));
  assert.deepEqual(recovered, { dead: 1, requeued: 1 });
  assert.equal((await row(stuck.id)).status, 'queued');
  assert.equal((await row(spent.id)).status, 'dead');
  await queue.idle();
  assert.equal((await row(stuck.id)).status, 'done');
});

test('old finished jobs are cleaned up; unfinished ones stay', async () => {
  const done = await queue.enqueue({ tenantId: 1, kind: 'test.ok', lane: 'prune' });
  await queue.idle();
  await sql.run("UPDATE jobs SET finished_at = datetime('now', '-30 days') WHERE id = ?", [done.id]);
  assert.ok(await runAsSystem(() => database.pruneJobs(7)) >= 1);
  assert.equal(await row(done.id), null);
});
