/* =========================================================
   SQLite through Node's built-in node:sqlite, behind the small part of the
   `sqlite3` package's callback API that Veyra uses (run / get / all / exec / close).
   Built in means nothing has to be compiled when the app is installed, so a
   server build cannot fail on a native module.
   ========================================================= */
const { DatabaseSync } = require('node:sqlite');

// SQLite primary result codes → the names `sqlite3` put in error.code (Veyra checks SQLITE_CONSTRAINT).
const CODES = { 1: 'SQLITE_ERROR', 5: 'SQLITE_BUSY', 6: 'SQLITE_LOCKED', 8: 'SQLITE_READONLY', 13: 'SQLITE_FULL', 14: 'SQLITE_CANTOPEN', 19: 'SQLITE_CONSTRAINT', 20: 'SQLITE_MISMATCH', 25: 'SQLITE_RANGE' };

function asSqliteError(error) {
  if (Number.isInteger(error?.errcode)) {
    const name = CODES[error.errcode & 0xff] || 'SQLITE_ERROR';
    error.code = name;
    if (!String(error.message).startsWith(name)) error.message = `${name}: ${error.message || error.errstr}`;
  }
  return error;
}

// `sqlite3` turned true/false into 1/0 and undefined into NULL; node:sqlite refuses them.
function bindValue(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  return value;
}

// Rows as ordinary objects, and BLOBs as Buffers, like `sqlite3` returned them.
function plainRow(row) {
  if (!row) return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Uint8Array && !Buffer.isBuffer(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : value;
  }
  return out;
}

class Database {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.statements = new Map();
  }

  // Prepared statements are reused; the cache is small and cleared when it fills up.
  prepare(sql) {
    let statement = this.statements.get(sql);
    if (!statement) {
      if (this.statements.size >= 500) this.statements.clear();
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  // Callbacks fire on a later tick, as they did with `sqlite3`.
  call(work, callback, context = null) {
    let result;
    let failure = null;
    try {
      result = work();
    } catch (error) {
      failure = asSqliteError(error);
    }
    if (typeof callback === 'function') setImmediate(() => callback.call(failure ? null : context?.(result), failure, result));
    else if (failure) console.error('[db] failed:', failure.message);
  }

  configure(option, value) {
    if (option === 'busyTimeout') this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(Number(value)) || 0)}`);
    return this;
  }

  run(sql, params, callback) {
    if (typeof params === 'function') [callback, params] = [params, []];
    const values = (Array.isArray(params) ? params : params === undefined ? [] : [params]).map(bindValue);
    this.call(
      () => this.prepare(sql).run(...values),
      callback ? function done(error) { callback.call(this, error); } : null,
      (result) => ({ lastID: Number(result.lastInsertRowid), changes: Number(result.changes) })
    );
    return this;
  }

  get(sql, params, callback) {
    if (typeof params === 'function') [callback, params] = [params, []];
    const values = (Array.isArray(params) ? params : params === undefined ? [] : [params]).map(bindValue);
    this.call(() => plainRow(this.prepare(sql).get(...values)), callback ? (error, row) => callback(error, row) : null);
    return this;
  }

  all(sql, params, callback) {
    if (typeof params === 'function') [callback, params] = [params, []];
    const values = (Array.isArray(params) ? params : params === undefined ? [] : [params]).map(bindValue);
    this.call(() => this.prepare(sql).all(...values).map(plainRow), callback ? (error, rows) => callback(error, rows) : null);
    return this;
  }

  exec(sql, callback) {
    this.call(() => this.db.exec(sql), callback ? (error) => callback(error) : null);
    return this;
  }

  close(callback) {
    this.call(() => {
      this.statements.clear();
      this.db.close();
    }, callback ? (error) => callback(error) : null);
  }
}

module.exports = { Database, verbose: () => module.exports };
