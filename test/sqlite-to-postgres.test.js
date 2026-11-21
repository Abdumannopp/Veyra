// SQLite -> PostgreSQL copy: every row arrives, files stay byte-exact, ids keep counting,
// a second copy into a filled database is refused, and a dry run leaves nothing behind.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const URL = process.env.DATABASE_URL || '';
const skip = /^postgres(ql)?:\/\//i.test(URL) ? false : 'needs PostgreSQL (DATABASE_URL)';
const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-copy-'));
const source = path.join(dir, 'source.db');

function node(args, env) {
  return spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'development', BCRYPT_COST: '10', NEXUS_ENABLED: 'false', ...env } });
}

// One PostgreSQL schema per run, chosen by DATABASE_PATH (see database.js).
function copy(extraArgs, schemaKey) {
  return node(['scripts/sqlite-to-postgres.js', ...extraArgs], { SQLITE_PATH: source, DATABASE_URL: URL, PG_TEST_SCHEMAS: '1', DATABASE_PATH: path.join(dir, schemaKey) });
}

test('copies a real SQLite database into PostgreSQL and verifies it', { skip }, () => {
  const build = node(['-e', `
    const d = require('./database');
    const q = (sql, p=[]) => new Promise((ok, no) => d.db.run(sql, p, (e) => e ? no(e) : ok()));
    d.initialize().then(async () => {
      await q("INSERT INTO tenants (id, name) VALUES (7, 'Second Co')");
      const ship = await new Promise((ok, no) => d.db.get('SELECT id, tenant_id FROM shipments LIMIT 1', [], (e, r) => e ? no(e) : ok(r)));
      await q("INSERT INTO documents (tenant_id, shipment_id, doc_type, filename, mime, size, sha256, content) VALUES (?, ?, 'invoice', 'a.pdf', 'application/pdf', 4, 'x', ?)", [ship.tenant_id, ship.id, Buffer.from([0, 255, 10, 13])]);
      d.db.close(() => process.exit(0));
    }).catch((e) => { console.error(e); process.exit(1); });`], { DATABASE_URL: '', DATABASE_PATH: source });
  assert.equal(build.status, 0, build.stderr);

  const dry = copy(['--dry-run'], 'dry.db');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Dry run: all \d+ tables copied and matched/);
  const again = copy(['--dry-run'], 'dry.db');
  assert.equal(again.status, 0, 'the dry run left nothing behind, so it can run again');

  const real = copy([], 'real.db');
  assert.equal(real.status, 0, real.stderr);
  assert.match(real.stdout, /Done: \d+ rows in \d+ tables copied and verified/);
  assert.doesNotMatch(real.stdout, /DIFFERENT/);

  const twice = copy([], 'real.db');
  assert.notEqual(twice.status, 0);
  assert.match(twice.stderr, /already has \d+ rows/);

  // The app runs on the copy and new rows get fresh ids.
  const check = node(['-e', `
    const d = require('./database');
    const one = (sql, p=[]) => new Promise((ok, no) => d.db.get(sql, p, (e, r) => e ? no(e) : ok(r)));
    d.initialize().then(async () => {
      const doc = await one("SELECT content FROM documents WHERE filename = 'a.pdf'");
      const t = await one("SELECT name FROM tenants WHERE id = 7");
      const id = await new Promise((ok, no) => d.db.run("INSERT INTO tenants (name) VALUES ('Third')", [], function (e) { e ? no(e) : ok(this.lastID); }));
      console.log(JSON.stringify({ hex: Buffer.from(doc.content).toString('hex'), name: t.name, id }));
      d.db.close(() => process.exit(0));
    }).catch((e) => { console.error(e); process.exit(1); });`], { DATABASE_URL: URL, PG_TEST_SCHEMAS: '1', DATABASE_PATH: path.join(dir, 'real.db') });
  assert.equal(check.status, 0, check.stderr);
  const result = JSON.parse(check.stdout.trim().split('\n').pop());
  assert.equal(result.hex, '00ff0a0d');
  assert.equal(result.name, 'Second Co');
  assert.ok(result.id > 7, 'ids continue after the copied ones');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('refuses without a PostgreSQL address', () => {
  const r = node(['scripts/sqlite-to-postgres.js'], { DATABASE_URL: '', SQLITE_PATH: source });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /set DATABASE_URL/);
});
