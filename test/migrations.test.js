// Versioned migrations: recorded once, applied in order, reversible step by step,
// a failed migration leaves nothing behind, and the baseline refuses to be reversed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-migrate-'));
Object.assign(process.env, { NODE_ENV: 'development', DATABASE_PATH: path.join(dir, 'm.db'), BCRYPT_COST: '10', NEXUS_ENABLED: 'false', DB_RLS: 'off' });
const { db, initialize, MIGRATIONS, migrate, migrationRunner, isPostgres } = require('../database');

const query = (method, sql, params = []) => new Promise((resolve, reject) => db[method](sql, params, (error, result) => (error ? reject(error) : resolve(result))));
const tableExists = async (name) => (await query('all', 'PRAGMA table_info(' + name + ')')).length > 0;

const extra = [
  ...MIGRATIONS,
  {
    id: '0900_test_widgets',
    name: 'Test table',
    up: (tx) => tx.run('CREATE TABLE test_widgets (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL)'),
    down: (tx) => tx.run('DROP TABLE test_widgets')
  },
  {
    id: '0901_test_broken',
    name: 'Fails halfway',
    up: async (tx) => {
      await tx.run('CREATE TABLE test_half_done (id INTEGER)');
      throw new Error('boom');
    },
    down: (tx) => tx.run('DROP TABLE test_half_done')
  }
];

before(async () => {
  await initialize();
});
after(async () => {
  await new Promise((r) => db.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a fresh database records the baseline once; starting again applies nothing', async () => {
  const status = await migrationRunner.status(MIGRATIONS);
  assert.deepEqual(status.map((row) => [row.id, row.applied]), MIGRATIONS.map((m) => [m.id, true]));
  assert.ok(status[0].appliedAt);
  assert.deepEqual(await migrate(), []);
  await initialize();
  assert.equal((await migrationRunner.applied()).length, MIGRATIONS.length);
});

test('new migrations apply in order; a failing one is rolled back and not recorded', async () => {
  await assert.rejects(migrationRunner.up(extra), /boom/);
  assert.equal(await tableExists('test_widgets'), true);
  assert.equal(await tableExists('test_half_done'), false, 'the failed migration left nothing behind');
  const ids = (await migrationRunner.applied()).map((row) => row.id);
  assert.deepEqual(ids, [...MIGRATIONS.map((m) => m.id), '0900_test_widgets']);
});

test('down reverses the newest migration; the baseline refuses with a recovery note', async () => {
  assert.deepEqual(await migrationRunner.down(extra, { steps: 1 }), ['0900_test_widgets']);
  assert.equal(await tableExists('test_widgets'), false);
  // The newest real migration (time zone and locale) cannot be reversed: it refuses and stays applied.
  await assert.rejects(migrationRunner.down(extra, { steps: 1 }), /cannot be reversed.*restore the database backup/);
  assert.deepEqual((await migrationRunner.applied()).map((row) => row.id), MIGRATIONS.map((m) => m.id));
});

test('bad migration lists are refused before anything runs', async () => {
  await assert.rejects(migrationRunner.up([...MIGRATIONS, { id: 'x', up() {}, down() {} }]), /needs an id/);
  const later = { id: '0950_b', up() {}, down() {} };
  const earlier = { id: '0940_a', up() {}, down() {} };
  await assert.rejects(migrationRunner.up([...MIGRATIONS, later, earlier]), /id order/);
  await assert.rejects(migrationRunner.up([...MIGRATIONS, later, { ...later }]), /share an id/);
  assert.equal(typeof isPostgres, 'boolean');
});
