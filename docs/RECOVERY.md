# Recovery and load runbook

Part of the documentation set: see [INDEX.md](INDEX.md). Database background: [DATABASE.md](DATABASE.md).

Two drills to run **before real customers** and then regularly (at least once a month, and after every big upgrade).
Neither touches the live database.

## 1. Restore drill: can a backup really be brought back?

A backup you have never restored is only a hope. The drill copies a backup, upgrades the copy to the current
version and checks it.

**SQLite (one file):**

```bash
npm run restore:drill -- path/to/veyra-YYYYMMDD-HHMMSS.db
```

With no path it takes the newest file in `BACKUP_DIR`. The backup file is copied first and never changed.

**PostgreSQL (Railway):**

1. In Railway, restore the latest database backup into a **new, separate** database (never over the live one).
2. Run the drill with that copy's address:

```bash
RESTORE_DATABASE_URL=postgres://... npm run restore:drill
```

The drill refuses to run if `RESTORE_DATABASE_URL` is the same as the live `DATABASE_URL`. It upgrades the copy,
so the copy cannot be used for anything else afterwards; delete it when the drill is done.

**What it checks** (each line says PASS or FAIL):

- the database opens and upgrades to this version (all migrations);
- integrity and foreign keys (SQLite);
- there are companies and users, and every company has an administrator;
- a sample of document files can be read and decrypted (with `DOCUMENT_STORAGE=r2`, from the bucket, and
  `DOCUMENT_ENCRYPTION_KEY` must be set exactly as in production).

It ends with `Restore drill PASSED.` (exit code 0) or `FAILED.` (exit code 1). Write down the date, the backup
used, the result and how long the restore took: that is your real recovery time.

**If it fails:** do not delete older backups. Check the message: a wrong or missing `DOCUMENT_ENCRYPTION_KEY`
makes encrypted files unreadable; a missing administrator means someone must be given the admin role before
customers rely on that company.

## 2. Load test: how many people at once?

Run it against a **staging copy**, not production (it is meant to find the limits). It only reads; it creates
nothing.

```bash
LOAD_TEST_URL=https://staging.example LOAD_TEST_EMAIL=... LOAD_TEST_PASSWORD=... LOAD_TEST_USERS=20 LOAD_TEST_SECONDS=30 npm run load:test
```

Use a dispatcher account made for the test; never paste a real person's password into chat or a document.
The staging server's `API_RATE_LIMIT_MAX` limits one account to that many requests a minute; raise it on staging
for the test, otherwise most requests are refused (429) by design.

It reports requests per second, the error rate (it exits with 1 above 1%), and response times: the median and
the 95th and 99th percentile. As a rule of thumb for a dispatcher screen: 95% under 500 ms is good, over
1500 ms people will notice. Increase `LOAD_TEST_USERS` step by step (20, 50, 100) to find where it slows down.

## Drill log (roadmap item O-3)

One row per restore drill. Only a row with "Yes" under "Real hosted copy?" and "Passed" closes O-3.

| Date | Backup used | Database | Real hosted copy? | Result | Time to restore | Notes |
|---|---|---|---|---|---|---|
| 2026-11-23 | A backup made by the test suite | SQLite, in the development environment | No | Passed | seconds | `test/recovery.test.js`. This proves the drill script works; it is **not** a drill on the real hosted database, so O-3 stays open. |

## Load-test log (roadmap item O-4)

| Date | Target | Real hosted copy? | Users × seconds | Requests / s | Errors | Median / 95% / 99% (ms) | Notes |
|---|---|---|---|---|---|---|---|
| 2026-11-23 | Local test server (development environment) | No | 4 × 1 | n/a | 0% | n/a | `test/recovery.test.js` checks the script only; it is **not** a load test of a hosted copy, so O-4 stays open. |

## 3. Not covered here

- **An external security review** (penetration test) by an independent specialist: see [SECURITY.md](SECURITY.md), section 3. Veyra's own tests check the
  rules (company isolation, permissions, input checks) but are no substitute.
- Restoring Cloudflare R2: R2 does not keep old versions by default; keep a copy of the bucket elsewhere if files
  must survive an accidental deletion.
