# Database, migrations and data rules

This is the one place that explains **which database Veyra uses, how data gets into it, how the schema changes, and the
rules behind money, time and company isolation**. Hosting steps are in [DEPLOYMENT.md](../DEPLOYMENT.md); backup and restore
drills are in [RECOVERY.md](RECOVERY.md).

## 1. Which database

| | SQLite (a single file) | PostgreSQL |
|---|---|---|
| Chosen when | `DATABASE_URL` is **not** set (`DATABASE_PATH` points to the file) | `DATABASE_URL` is set |
| Good for | Local development, tests, a small single-company install on one server | **Production**, many companies, more than one app instance |
| Company isolation | App-level filters only | App-level filters **and** row level security (section 6) |
| Money | Floating point, rounded when saved | Exact `NUMERIC(18,4)` |
| Backups | Veyra writes a daily file copy | Your database provider's backups (Railway: the PostgreSQL service's **Backups** tab); Veyra's own file backup is switched off and the platform backup endpoints answer 409 |
| Tests | `npm test` | CI runs the full suite on both engines |

PostgreSQL support works through `lib/postgres.js`, which translates Veyra's SQL (placeholders, SQLite date functions,
`INSERT OR IGNORE/REPLACE`, case-insensitive `LIKE`, types) and keeps timestamps as UTC text in the same format as before.
One connection runs one statement at a time, like the SQLite file did; that is plenty for hundreds of companies and a
connection pool can come later.

## 2. What is automatic and what is manual

Three different things happen to the database. Only the first is automatic, and two of the commands have similar names.

| What | Automatic? | How | Command |
|---|---|---|---|
| **Create or upgrade the tables** (schema) | **Yes** | Every time the server starts it applies the migrations it has not applied yet, one process at a time. On an empty PostgreSQL database it creates everything, plus the first administrator from `INITIAL_ADMIN_*`. | none; to look: `npm run migrate -- status`; to run by hand: `npm run migrate` |
| **Copy existing data from a SQLite file into PostgreSQL** | **No: manual, once** | Needed only when a running SQLite install moves to PostgreSQL (section 4). It copies the rows, checks them and refuses to continue on any difference. | `npm run migrate:postgres` |
| **Point the app at PostgreSQL** | **No: manual** | Set `DATABASE_URL` on the app and restart (section 3). | none |

In short:
- **New install on PostgreSQL**: nothing to copy. Set `DATABASE_URL`, start the app, done.
- **Existing SQLite install with real data**: run the copy script (section 4) *before* you set `DATABASE_URL`.
- `npm run migrate` changes the **schema** (tables and columns). `npm run migrate:postgres` moves the **data**. They never do each other's job.

## 3. Switching to PostgreSQL (Railway)

1. In the project: **New → Database → PostgreSQL**.
2. In the Veyra service, **Variables**: add `DATABASE_URL=${{Postgres.DATABASE_URL}}` and remove `DATABASE_PATH`.
3. If this is a **new** install, redeploy: on first start Veyra creates its tables and the first administrator from `INITIAL_ADMIN_*`. If you already have data in SQLite, do section 4 **first**.
4. The `/data` volume is no longer needed for the database (keep it until you have checked the app on PostgreSQL).
5. Turn on the provider's backups, then do a restore drill ([RECOVERY.md](RECOVERY.md)).

## 4. Moving existing SQLite data to PostgreSQL (manual, once)

Do this once, when a running SQLite install moves to PostgreSQL. The SQLite file is only read, never changed.

1. Take a backup of the SQLite file (Admin → Backup, or copy the file from the Volume).
2. Create an **empty** PostgreSQL database.
3. Rehearse: `SQLITE_PATH=/data/veyra.db DATABASE_URL=postgres://... npm run migrate:postgres -- --dry-run`.
   Every table is copied, checked (row count and content checksum), then undone.
4. Stop the app (no new writes), then run the same command without `--dry-run`.
   It refuses a database that already has data, and keeps nothing if any table differs.
5. Only after it prints `Done: ... copied and verified`, set `DATABASE_URL` on the app and start it.
6. Keep the SQLite backup until you have checked the app on PostgreSQL.

Document files that are already in Cloudflare R2 stay in the bucket; only their rows are copied.

## 5. Schema migrations

Schema changes are versioned migrations (`database.js` → `MIGRATIONS`, runner in `lib/migrations.js`). Applied ids are kept
in `schema_migrations`; the server applies missing ones at start, one process at a time.

```bash
npm run migrate -- status
npm run migrate
npm run migrate -- down 1
```

| Migration | What it adds | Can it be reversed? |
|---|---|---|
| `0001_baseline` | The schema before versioning | No: restore the backup |
| `0002_row_level_security` | PostgreSQL row level security (section 6) | Yes (switches it off) |
| `0003_money_currency` | A currency on every amount; exact money on PostgreSQL | **No** |
| `0004_durable_jobs` | Durable background jobs | Yes (drops the jobs table) |
| `0005_company_time_zone_locale` | Per-company time zone and locale | **No** (the new columns are harmless if left) |
| `0006_shipment_legs` | Legs, leg history, handovers | **No** |
| `0007_leg_payments` | Leg payment column | **No** (the new column is harmless if left) |
| `0008_trips` | Trips (LTL) | **No** |
| `0009_document_storage_key` | Documents may live in R2 | Yes, while no file is in R2 |
| `0010_cold_chain` | Temperature range and readings | Yes, while no reading is saved |
| `0011_warehouse_stays` | Warehouse receipts and releases | Yes, while empty |
| `0012_last_mile_stops` | Last-mile stops and proof of delivery | Yes, while empty |
| `0013_shipment_compliance` | Customs and dangerous-goods record | Yes, while empty |
| `0014_retention_settings` | Retention settings on companies | Yes |
| `0015_ai_quota_ledger_consent` | AI quota counters, AI call ledger, AI data-sharing consent on companies | Only while `ai_calls` is empty |
| `0016_ai_provider` | The provider a company agreed to; the provider of each AI call | Yes |
| `0017_ai_provider_per_company` | The AI provider a company chose (empty = server default) | Yes |

"Yes, while empty" means the migration can be undone only until the first record is saved; after that the only way back is
the backup taken before the upgrade.

**Take a backup before every upgrade that brings a new migration**, and treat `0003`, `0005`–`0008` as one-way doors.
`npm run migrate -- status` shows what is applied. New migrations must have a working `down()`, or say in it why not and how
to recover. The restore drill ([RECOVERY.md](RECOVERY.md)) upgrades a *copy* of a backup, so it also proves the next
upgrade will work on your data.

## 6. Company isolation in the database (PostgreSQL)

On PostgreSQL, every company's rows are also protected by the database itself (row level security), not only by the app's own filters.
- Migration `0002_row_level_security` creates a login-less role `veyra_app` and policies on every company table. The app switches to that role after migrating, so policies bind it.
- A signed-in request can only read or write its own company's rows. Server work (login lookup, webhooks, background jobs, platform admins) runs as "system" and is explicit in the code.
- Anything with no company context sees no rows (fail closed).
- The database user from `DATABASE_URL` needs permission to create roles (Railway's default `postgres` user has it). If it cannot, the app starts and logs `row level security is NOT enforced`.
- Set `DB_RLS=off` only for local debugging with one-off scripts that read across companies.
- SQLite installs keep the app-level company filters only.

## 7. Money and currencies

- Every priced record (loads, quotes, market rates) stores its own ISO currency next to the amount. Existing amounts were labelled with the company's currency when migration `0003_money_currency` ran.
- Amounts are rounded to the currency's minor unit when saved (2 decimals; 0 for JPY, KRW, VND and similar; 3 for KWD, BHD and similar). Totals add exact cents.
- PostgreSQL stores money as `NUMERIC(18,4)`. SQLite keeps floating point, rounded on write and in totals, so SQLite is for development and small single-company installs.
- If a company changes its currency, old amounts keep their own currency. The Finance summary adds only amounts in the current currency and lists other currencies under `otherCurrencies`; analytics averages and revenue are not yet split by currency.
- Migration `0003` cannot be reversed; take a database backup before upgrading.

## 8. Time zones and number formats

- Everything is **stored in UTC** (the database clock). A company's time zone and locale only change how people see times, dates and numbers, and what "today" means for that company; they never change what is saved.
- Each company picks a time zone (IANA name, for example `Asia/Tashkent`) and a language/number format (for example `de-DE`) in Settings → Company. The server default is `TIMEZONE` and `LOCALE` (otherwise `UTC` and `en-US`).
- The company's own calendar day is used for the daily charts (shipments per day, AI Command Center) and for quote expiry. Clock changes (daylight saving) are handled.
- Load pickup and delivery dates (`YYYY-MM-DD`) are calendar dates and are not shifted. The public tracking page shows times in the shipping company's zone.
- Not yet localised: the text language of the interface and of drafted messages (English), and AI daily caps (a rolling 24 hours).

## 9. Backups

- **SQLite:** a full copy is written every day to `BACKUP_DIR`; the newest `BACKUP_KEEP` (7) are kept. These copies sit on the
  same disk as the database, so the platform owner should download one regularly (Dashboard → Backups) and keep it elsewhere.
  Settings and restore: see "Accounts, money, customer link, backups, activity log" in [DEPLOYMENT.md](../DEPLOYMENT.md).
- **PostgreSQL:** the provider's backups (section 1).
- **Document files in R2** are **not** in the database backup. See "Where document files are kept" in
  [DEPLOYMENT.md](../DEPLOYMENT.md).
- **A backup you have never restored is only a hope.** Run the restore drill ([RECOVERY.md](RECOVERY.md)) before real
  customers and then monthly.
