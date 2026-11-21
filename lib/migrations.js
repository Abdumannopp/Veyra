/* =========================================================
   Versioned database migrations.
   Each migration has an id ("0002_add_x"), a name, up() and down().
   Applied ids are recorded in schema_migrations; startup applies the missing ones in order.
   A migration that cannot be reversed must say so in down() and document the recovery
   (restore the backup taken before it ran).
   ========================================================= */

const RECORD_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`;

function createRunner({ run, get, all, withTransaction, lock = async (work) => work() }) {
  async function ensureTable() {
    await run(RECORD_TABLE);
  }

  async function applied() {
    await ensureTable();
    return (await all('SELECT id, name, applied_at AS appliedAt FROM schema_migrations ORDER BY id')).map((row) => ({ ...row }));
  }

  function check(list) {
    const ids = list.map((m) => m.id);
    for (const m of list) {
      if (!/^\d{4}_[a-z0-9_]+$/.test(m.id) || typeof m.up !== 'function' || typeof m.down !== 'function') {
        throw new Error(`Migration ${m.id || '(no id)'} needs an id like 0002_name, up() and down().`);
      }
    }
    if (new Set(ids).size !== ids.length) throw new Error('Two migrations share an id.');
    if ([...ids].sort().join() !== ids.join()) throw new Error('Migrations must be listed in id order.');
  }

  // Runs one migration step and records it, in one transaction when the migration allows it.
  async function step(m, direction) {
    const record = direction === 'up'
      ? (tx) => tx.run('INSERT INTO schema_migrations (id, name) VALUES (?, ?)', [m.id, m.name || m.id])
      : (tx) => tx.run('DELETE FROM schema_migrations WHERE id = ?', [m.id]);
    if (m.transactional === false) {
      await m[direction]({ run, get, all });
      await record({ run });
      return;
    }
    await withTransaction(async (tx) => {
      await m[direction](tx);
      await record(tx);
    });
  }

  async function status(list) {
    check(list);
    const done = new Map((await applied()).map((row) => [row.id, row]));
    return list.map((m) => ({ id: m.id, name: m.name, applied: done.has(m.id), appliedAt: done.get(m.id)?.appliedAt || null }));
  }

  async function up(list, { to = null } = {}) {
    check(list);
    return lock(async () => {
      const done = new Set((await applied()).map((row) => row.id));
      const ran = [];
      for (const m of list) {
        if (done.has(m.id)) continue;
        if (to && m.id > to) break;
        await step(m, 'up');
        ran.push(m.id);
      }
      return ran;
    });
  }

  // Reverses the newest applied migrations, one at a time.
  async function down(list, { steps = 1 } = {}) {
    check(list);
    return lock(async () => {
      const done = (await applied()).map((row) => row.id);
      const byId = new Map(list.map((m) => [m.id, m]));
      const ran = [];
      for (const id of done.reverse().slice(0, steps)) {
        const m = byId.get(id);
        if (!m) throw new Error(`Migration ${id} is applied but its code is missing; cannot reverse it.`);
        await step(m, 'down');
        ran.push(id);
      }
      return ran;
    });
  }

  return { status, up, down, applied };
}

module.exports = { createRunner };
