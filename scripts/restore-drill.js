// Restore drill (Phase 6.3): proves a backup can be brought back and used, without touching the live database.
//
// SQLite:      node scripts/restore-drill.js path/to/veyra-YYYYMMDD-HHMMSS.db
//              (with no path: the newest file in BACKUP_DIR). The file is copied to a temporary folder first;
//              the backup itself and the live database are never opened for writing.
// PostgreSQL:  restore the provider's backup into a NEW, separate database first (never the live one), then
//              RESTORE_DATABASE_URL=postgres://... node scripts/restore-drill.js
//              The drill upgrades that copy to the current schema, so never point it at production.
//
// It checks: the database opens, the schema upgrades to this version, integrity (SQLite), every company has an
// active administrator, row counts per table, and that a sample of document files can be read and decrypted.
// Exit code 0 = passed, 1 = a check failed, 2 = the drill could not run.
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fail(message) {
  console.error(`Restore drill could not run: ${message}`);
  process.exit(2);
}

function prepare() {
  const restoreUrl = String(process.env.RESTORE_DATABASE_URL || '').trim();
  if (restoreUrl) {
    if (restoreUrl === String(process.env.DATABASE_URL || '').trim()) fail('RESTORE_DATABASE_URL is the live DATABASE_URL. Restore into a separate database.');
    process.env.DATABASE_URL = restoreUrl;
    return { engine: 'postgresql', source: restoreUrl.replace(/\/\/[^@]*@/, '//***@'), cleanup: () => {} };
  }
  delete process.env.DATABASE_URL;
  let file = process.argv[2];
  if (!file) {
    const dir = process.env.BACKUP_DIR || path.join(path.dirname(path.resolve(process.env.DATABASE_PATH || 'veyra.db')), 'backups');
    const newest = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => /^veyra-\d{8}-\d{6}\.db$/.test(name)).sort().pop() : null;
    if (!newest) fail(`no backup file given and none found in ${dir}.`);
    file = path.join(dir, newest);
  }
  if (!fs.existsSync(file)) fail(`${file} does not exist.`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-restore-'));
  const copy = path.join(work, 'restored.db');
  fs.copyFileSync(file, copy);
  process.env.DATABASE_PATH = copy;
  return { engine: 'sqlite', source: file, cleanup: () => fs.rmSync(work, { recursive: true, force: true }) };
}

async function drill({ sampleDocuments = 5 } = {}) {
  const target = prepare();
  process.env.NEXUS_ENABLED = 'false';
  const database = require('../database');
  const { runAsSystem } = require('../lib/tenant-context');
  const report = { engine: target.engine, source: target.source, checks: [], counts: {}, ok: true };
  const check = (name, ok, detail) => {
    report.checks.push({ name, ok, detail: detail || null });
    if (!ok) report.ok = false;
  };
  try {
    await database.initialize();
    const applied = await database.migrationRunner.applied();
    check('schema upgraded to this version', applied.length === database.MIGRATIONS.length, `${applied.length} of ${database.MIGRATIONS.length} migrations applied`);
    await runAsSystem(async () => {
      if (target.engine === 'sqlite') {
        const integrity = await database.checkIntegrity();
        check('integrity', integrity.ok, `${integrity.integrity.join(', ')}; foreign key problems: ${integrity.foreignKeyViolations}`);
      }
      for (const table of ['tenants', 'users', 'shipments', 'shipment_legs', 'trips', 'carriers', 'documents', 'tracking_updates', 'audit_log', 'nexus_tasks', 'jobs']) {
        report.counts[table] = Number((await database.sql.get(`SELECT COUNT(*) AS total FROM ${table}`))?.total) || 0;
      }
      check('has companies and users', report.counts.tenants > 0 && report.counts.users > 0, `${report.counts.tenants} companies, ${report.counts.users} users`);
      const orphans = await database.sql.all(
        "SELECT t.id, t.name FROM tenants t WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = t.id AND u.role = 'admin')"
      );
      check('every company has an administrator', orphans.length === 0, orphans.length ? `without one: ${orphans.map((row) => `#${row.id}`).join(', ')}` : null);
      const sample = await database.sql.all('SELECT id, tenant_id AS tenantId, shipment_id AS shipmentId, size FROM documents ORDER BY id DESC LIMIT ?', [sampleDocuments]);
      let readable = 0;
      const problems = [];
      for (const doc of sample) {
        try {
          const file = await database.getDocumentFile(doc.tenantId, doc.shipmentId, doc.id);
          if (file && file.content.length === Number(doc.size)) readable += 1;
          else problems.push(`#${doc.id} has the wrong size`);
        } catch (error) {
          problems.push(`#${doc.id}: ${error.message}`);
        }
      }
      check('document files can be read', problems.length === 0, sample.length ? `${readable} of ${sample.length} sampled${problems.length ? `; ${problems.join('; ')}` : ''}` : 'no documents to sample');
    });
  } catch (error) {
    check('database opens', false, error.message);
  } finally {
    await new Promise((resolve) => database.db.close(() => resolve()));
    target.cleanup();
  }
  return report;
}

if (require.main === module) {
  drill().then((report) => {
    for (const item of report.checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
    console.log(`Rows: ${Object.entries(report.counts).map(([table, total]) => `${table} ${total}`).join(', ')}`);
    console.log(report.ok ? 'Restore drill PASSED.' : 'Restore drill FAILED.');
    process.exit(report.ok ? 0 : 1);
  }).catch((error) => fail(error.message));
}

module.exports = { drill };
