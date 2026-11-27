# VEYRA deployment guide

How to put Veyra online and keep it running. The application starts with `npm run prod`, reads the platform-provided `PORT`
and serves `/api/health` for health checks. It needs **a database**: a persistent SQLite file (`DATABASE_PATH`) or, recommended
for production, PostgreSQL (`DATABASE_URL`). Which to choose, what is automatic and what is manual: [docs/DATABASE.md](docs/DATABASE.md).
The first production startup creates one admin from the `INITIAL_ADMIN_*` variables. Development demo accounts and sample
shipments are never created in production.

Other documents: the index is [docs/INDEX.md](docs/INDEX.md); which integrations really work is [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md);
security is [docs/SECURITY.md](docs/SECURITY.md); restore and load drills are [docs/RECOVERY.md](docs/RECOVERY.md).

## Render

1. Push this project to a Git repository and create a Render Blueprint from it.
2. Review `render.yaml`; change `INITIAL_ADMIN_EMAIL` to the admin email you will use. When Render asks for `COMPANY_NAME`, enter your company's name (it appears in the app, on invoices and on the customer tracking page).
3. Deploy the service. The Blueprint provisions a Starter web service and a persistent disk at `/var/data`.
4. In the Render dashboard, retrieve the generated `INITIAL_ADMIN_PASSWORD` and store it in a password manager. Do not put it in the repo.
5. Add a custom domain in Render. HTTPS is provisioned by Render.

The Render disk keeps SQLite data across deploys, but it is a single-instance setup. Do not increase instance count while using SQLite.

## Railway

1. Push the project to GitHub and create a Railway project from the repository.
2. Add a Railway Volume mounted at `/data`.
3. Add these service variables in Railway:

```env
NODE_ENV=production
DATABASE_PATH=/data/veyra.db
JWT_SECRET=<generate a long random secret>
SECRETS_KEY=<another long random secret; keep it, see below>
COMPANY_NAME=<your company name>
INITIAL_ADMIN_NAME=VEYRA Administrator
INITIAL_ADMIN_EMAIL=admin@your-domain.com
INITIAL_ADMIN_PASSWORD=<unique password of at least 12 characters>
```

4. Deploy. `railway.json` builds with the `Dockerfile` (Node 22, nothing to compile) and sets the start command, health check and restart policy.
5. Add a Railway domain or custom domain. Store all generated secrets outside source control.

The volume is persistent but SQLite remains a single-instance database. For production, and for more than one instance, use PostgreSQL: see [docs/DATABASE.md](docs/DATABASE.md) (section 3 for the Railway steps, section 4 to move existing data).
## VPS with systemd and Caddy

Use Ubuntu/Debian with Node.js 22.13 or newer (it includes the SQLite module Veyra uses) and a domain pointed at the VPS.

1. Install Node.js and Caddy, then create the service account and application directory:

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin veyra
sudo mkdir -p /opt/veyra /etc/veyra
sudo chown veyra:veyra /opt/veyra
```

2. Copy the project to `/opt/veyra` (excluding `node_modules`, `.env`, and local database files), then install production dependencies:

```bash
cd /opt/veyra
sudo -u veyra npm ci --omit=dev
```

3. Create `/etc/veyra/veyra.env` with `JWT_SECRET`, `SECRETS_KEY`, `COMPANY_NAME`, `INITIAL_ADMIN_NAME`, `INITIAL_ADMIN_EMAIL`, and a unique `INITIAL_ADMIN_PASSWORD` of at least 12 characters. Protect it:

```bash
sudo chmod 600 /etc/veyra/veyra.env
```

4. Copy `deploy/veyra.service` to `/etc/systemd/system/veyra.service`. Copy `deploy/Caddyfile` to `/etc/caddy/Caddyfile` and replace `veyra.example.com` with your domain.
5. Start both services:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now veyra
sudo systemctl reload caddy
```

`StateDirectory=veyra` creates `/var/lib/veyra` for the persistent SQLite database. Caddy obtains and renews HTTPS certificates automatically. Check app logs with `sudo journalctl -u veyra -f`.

## Local production smoke test

On a new database, set a strong JWT secret and first admin values before running:

```powershell
$env:NODE_ENV='production'
$env:JWT_SECRET='replace-with-a-long-random-secret'
$env:INITIAL_ADMIN_NAME='VEYRA Administrator'
$env:INITIAL_ADMIN_EMAIL='admin@example.com'
$env:INITIAL_ADMIN_PASSWORD='replace-with-a-unique-password'
$env:DATABASE_PATH='./data/production-test.db'
npm run prod
```

Verify `http://localhost:3000/api/health` returns `{"status":"ok"}`. Delete only the disposable test DB when the process is stopped.

## Company name

`COMPANY_NAME` names the first company. It is read on the first start only (when the database is created); changing the variable later does not rename an existing company.

## Region and team settings

- `WEIGHT_UNIT` (`kg` or `lb`) and `CURRENCY` (ISO code such as `USD`, `EUR`, `UZS`, `KZT`) set how loads and prices are shown. For large-number currencies raise `MAX_RATE` (for `UZS`, e.g. `10000000000`).
- Sign-up is **closed** in production. The first administrator signs in with the `INITIAL_ADMIN_*` account and adds the team from **Dashboard → Operations Console → Team Access → Add user**, where roles can also be changed and accounts disabled (takes effect immediately).
- To let people sign up themselves, set `REGISTRATION_INVITE_CODE` (they need the code and become operators) or, for demos only, `ALLOW_OPEN_REGISTRATION=true`.

## Optional services (AI, messaging, email, map, GPS)

Everything below is off until configured, and the app works without it.

**How ready is each one?** Read [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md). Most of these have so far been checked only against fake services, so try each with a test or sandbox account and check the first results yourself before you rely on it or promise it to a customer.

- **AI (FLOW, VAULT)**: choose ONE provider with `AI_PROVIDER` (`openrouter`, `openai`, `anthropic` or `google`) and set its key and model: `OPENROUTER_API_KEY` + `OPENROUTER_MODEL` (model optional, the server warns), `OPENAI_API_KEY` + `OPENAI_MODEL`, `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL`, or `GEMINI_API_KEY` + `GEMINI_MODEL` (these three need the model). You may set several providers: `AI_PROVIDER` is the default, and each company can choose another ready one in Team & settings. A company whose provider changes must allow AI data sharing again. Each company's administrator must switch on Team & settings → **AI data sharing** before anything is sent. Use is limited per company per day (`AI_DAILY_LIMIT_PER_TENANT`) and per person per hour (`AI_RATE_LIMIT_PER_HOUR`), counted in the database, and logged under Analytics → AI agents. Rules: [docs/AI.md](docs/AI.md).
- **SMS / WhatsApp (RELAY)**: in a Twilio account get the Account SID, Auth Token and a sender number (and an approved WhatsApp sender for WhatsApp). Set `MESSAGING_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FROM` and/or `TWILIO_WHATSAPP_FROM`. Phone numbers on loads must be in international format (+998…).
- **Each company uses its own Twilio account** (Dashboard -> Integrations -> Connect Twilio). The token is checked with Twilio, stored encrypted with `SECRETS_KEY` and never shown again. The server-wide Twilio settings above belong to the first company only, unless `MESSAGING_SHARED_ALL_TENANTS=true`. Set `SECRETS_KEY` once and keep it: if it (or `JWT_SECRET`, when `SECRETS_KEY` is empty) changes, saved Twilio settings can no longer be read and must be entered again.
- **Orders by email**: an administrator opens Integrations -> Email inbox -> Create address. The address is a web address that an email service posts incoming mail to: Postmark (inbound stream), Mailgun (route, "forward to URL"), SendGrid Inbound Parse or Zapier / Make (new email -> webhook POST). Attached files (PDF, JPG, PNG, WebP; up to `INBOX_MAX_ATTACHMENTS` per email, whole email up to `INBOX_MAX_MB`) are kept: if the email names a load (`SHP-12` or the load's reference) they go to that load's documents, otherwise they wait with the email. The address contains a secret, so treat it like a password (it can appear in your email provider's settings and logs; create a new one if it leaks). Set the allowed senders so strangers cannot use the address: other senders are stored as blocked and never reach the AI.
- **Delivery reports (delivered / read / failed)**: Twilio reports back to `https://<your-domain>/api/integrations/twilio/status/...`. The app must know its public https address: Render and Railway provide it automatically; elsewhere set `PUBLIC_URL`. Each report must carry a valid Twilio signature and a per-message secret. "Read" exists only on WhatsApp.
- **Order mailbox (IMAP)**: an administrator connects a mailbox under Integrations (TLS only, certificate checked, read-only `EXAMINE`/`BODY.PEEK`: nothing is marked read or changed; mail present at connection time is not imported). The password is stored encrypted with `SECRETS_KEY`. Polled every `IMAP_POLL_MINUTES` (default 5). Private-network mail servers are refused unless `IMAP_ALLOW_PRIVATE=true`.
- **Gmail / Outlook sign-in (API, no app password)**: the platform owner registers one app per provider and sets the client id and secret: Google Cloud (OAuth client, Gmail API, scope `gmail.readonly`) as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, and Microsoft Entra (Microsoft Graph delegated `Mail.Read`, `offline_access`, `User.Read`) as `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` (`MICROSOFT_TENANT`, default `common`). Register this redirect address with both: `https://<your-domain>/api/integrations/mail-oauth/callback`; `PUBLIC_URL` must be set. Google asks for a security review before apps that read mail can be used by outside accounts. Each company then clicks *Connect Gmail / Outlook*; only an encrypted refresh token is kept, mail is only read, and mail that was there before connecting is not imported.
- **Live traffic** (optional): `TRAFFIC_PROVIDER=tomtom` and `TOMTOM_API_KEY` (needs the map on). Used for trucks that are on the road, cached 30 minutes per lane. **Border waiting times** are entered by hand under Integrations (there is no free live source of border queues).
- **Map** (optional): `GEO_PROVIDER=osm` turns on road distance and off-route warnings using Nominatim and OSRM (`NOMINATIM_URL`, `OSRM_URL`; the public servers are for light use only, point them at your own for heavy use). Place names of loads are sent to those servers; answers are cached. `OFF_ROUTE_KM` (default 60).
- **Market prices**: entered by hand under Integrations; PULSE compares with them.
- **ROUTE, PULSE, SENTINEL**: built in, no keys. They use only the company's own past loads (at least 3 delivered loads on a lane before ROUTE and PULSE give numbers). SENTINEL runs with the NEXUS check every 10 minutes.
- **Documents**: CMR, proof of delivery, bill of lading, air waybill, rail notes and other files (PDF, JPG, PNG, WebP, up to `DOC_MAX_MB`) are kept **in the database by default**, so the database backup covers them; or in an encrypted Cloudflare R2 bucket if you set that up (see "Where document files are kept" below). Reading these files with AI needs a model that can read images or PDFs: set `OPENROUTER_MODEL` to one if the account default cannot.
- **GPS**: an administrator opens Dashboard → Integrations → Create GPS token and gives the provider the address `https://<your-domain>/api/integrations/gps` and the token. The provider sends positions with the truck plate; plates are matched ignoring spaces and dashes.
## NEXUS (the orchestrator)

NEXUS reacts to events (an order email arrives, a load reaches Sourcing, a truck is booked, a document is uploaded, a truck goes quiet) and leaves **tasks** under Inbox & tasks. It prepares things: reads emails, ranks carriers, drafts messages, compares documents with the load. It never sends a message, books a truck, creates a load or changes a status: every one of those waits for a person to press the button. Trucks with no location update for `STALE_TRACKING_HOURS` get a drafted "where are you?" message (checked every 10 minutes). `NEXUS_ENABLED=false` switches it off.

## Accounts, money, customer link, backups, activity log

- **Passwords**: everyone changes their own under *Password* (other devices are signed out). An administrator can set a new password for a team member who forgot theirs (Team Access -> New password). There is no "forgot password" email: the administrator is the way back in. If the only administrator forgets theirs, a new first admin cannot be created automatically; keep that password in a password manager.
- **Editing a load**: the load window -> *Edit load*. Every correction is written to the load's history. Delivered and cancelled loads are not edited.
- **Payments**: invoice number, *Invoice sent*, *Customer paid*, *Carrier paid* in the load window; *Open invoice* gives a printable page (browser -> Print -> Save as PDF); Analytics -> *Open money* lists what is still unpaid. Role needed: admin or operations.
- **Customer tracking link**: the load window -> *Customer tracking link*. The page shows only route, dates, status, last place, ETA and truck plate. A new link replaces the old one; *Remove link* switches it off. Set `PUBLIC_URL` so the link uses your domain.
- **Backups**: a full copy of the database is written every day to `BACKUP_DIR` (default: `backups/` next to the database), the newest `BACKUP_KEEP` (7) are kept; `BACKUP_ENABLED=false` switches it off. These copies sit on the same disk as the database, so they protect against mistakes, not against losing the disk: the platform owner should download one regularly (Dashboard -> Backups) and keep it elsewhere. The file holds every company's data. To restore: stop the app, replace the database file with the backup, start the app. With PostgreSQL the provider's backups are used instead ([docs/DATABASE.md](docs/DATABASE.md), section 9). Prove that a backup can be restored with the restore drill ([docs/RECOVERY.md](docs/RECOVERY.md)); document files kept in R2 are not in the database backup.
- **Activity log**: administrators see who changed accounts, passwords, integrations, payments, customer links and backups.
## Background jobs

Automatic reactions (reading order emails with AI, reading CMR/POD documents, drafting booking and delivery messages, price checks, workflow rules) are saved as jobs in the database before they run, so a restart or crash does not lose them.
- A failing job is retried after 30 s, 1 min, 2 min ... (up to 15 min), 5 attempts by default, then kept as "dead" so nobody has to guess what failed.
- The same event is never saved twice under one idempotency key (for example an email delivered again).
- A job left "running" by a server that died is queued again after 10 minutes.
- Jobs of one company run in the order they were added; companies do not wait for each other. Several servers can share one PostgreSQL database; each job is taken by only one.
- Admins see counts and failed jobs at `GET /api/jobs` and can give a dead job new attempts with `POST /api/jobs/:id/retry`.
- Optional settings: `JOBS_CONCURRENCY` (4), `JOBS_POLL_MS` (2000), `JOBS_RETRY_BASE_SECONDS` (30), `JOBS_VISIBILITY_SECONDS` (600). Finished jobs are deleted after 7 days.
- Still timer-based (they only re-check state and are safe to repeat): the NEXUS sweeps, mailbox polling and daily backups.

## Where document files are kept (database by default, R2 optional)

Document files (CMR, proof of delivery, B/L, AWB, rail notes, and attachments that came with an email) are kept in one of two places.

| | **Database (the default)** | **Cloudflare R2 (optional)** |
|---|---|---|
| Chosen when | `DOCUMENT_STORAGE` is empty or `database` | `DOCUMENT_STORAGE=r2` |
| What you must set up | Nothing | An R2 bucket, an access token and six variables (below) |
| Where the bytes are | Inside the database row | In the bucket; the row keeps only a storage key |
| Covered by the database backup | **Yes** | **No**: the bucket needs its own backup |
| Encrypted | Only if `DOCUMENT_ENCRYPTION_KEY` is set | Yes, with the same key, before the file leaves the server |
| Good for | Development and small installs | Production with many or large files: keeps the database small |
| Readiness | Working | **Test mode**: tested only against a fake bucket, never against real R2 ([docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)) |

People using Veyra see no difference ([USER_GUIDE.md](USER_GUIDE.md)). Encryption and the storage place are separate choices:
you can encrypt files while they stay in the database. Files saved before a key was set stay readable.

### Setting up R2, step by step

Cloudflare's screens change from time to time; the names below may differ slightly.

1. In the Cloudflare dashboard open **R2** and create a bucket, for example `veyra-documents`. Keep it **private** (no public access).
2. In R2, open **Manage API tokens** and create a token with **Object Read & Write**, limited to that one bucket. Copy the
   **Access Key ID** and the **Secret Access Key** now: the secret is shown only once.
3. Note your **Account ID** (on the R2 overview page).
4. Make the encryption key and **save a copy in a password manager before you go on**:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

5. Set these variables in the host's settings (Railway → Variables). Never in chat, email or the code:

   | Variable | Value |
   |---|---|
   | `DOCUMENT_STORAGE` | `r2` |
   | `R2_ACCOUNT_ID` | the Cloudflare Account ID |
   | `R2_ACCESS_KEY_ID` | from step 2 |
   | `R2_SECRET_ACCESS_KEY` | from step 2 |
   | `R2_BUCKET` | the bucket name |
   | `DOCUMENT_ENCRYPTION_KEY` | the key from step 4 (base64, or 64 hex characters) |

6. Redeploy. The start-up line must say `documents: r2 encrypted`. If a setting is wrong or missing the server **refuses to
   start** and says which variable.
7. **Test it** on a test load: upload a file. In the Cloudflare dashboard an object appears under
   `documents/t<company>/s<load>/`; downloading the file from Veyra gives back the same file; the object in the bucket cannot
   be opened as a PDF (it is encrypted).
8. **Move the files you already have** (they are still in the database): take a backup, then run once in the host's shell
   `npm run documents:move`. Each file is read back from R2 before the database copy is removed; running it again is safe.
9. **Back up the bucket.** R2 does not keep old versions by default. Copy it regularly to another bucket or provider, and run the
   restore drill ([docs/RECOVERY.md](docs/RECOVERY.md)): it reads a sample of documents, including from R2.

### Rules to remember

- **Keep a copy of `DOCUMENT_ENCRYPTION_KEY` for ever and never change it once files are saved.** Without it the files cannot be opened.
- There is **no script to move files back** from R2 to the database. Once files are in R2 keep `DOCUMENT_STORAGE=r2`. If it is
  set back, downloading those files fails with an error (never an empty file).
- If R2 cannot be reached, an upload fails and nothing is saved; a download fails with an error.
- Migration 0009 adds the `storage_key` column; it can be reversed only while no file is in R2.
- Keeping old data (retention) deletes the R2 file together with its record.

## Card payments (Paddle Billing)

Veyra sells its Starter, Growth and Scale plans through Paddle (Enterprise is arranged with sales). Paddle is the merchant of record: it takes the card, charges tax and sends invoices. Card details never reach Veyra.

1. Create a Paddle account (start in the **sandbox**: sandbox-vendors.paddle.com).
2. **Catalog → Products:** one product per plan (Starter, Growth, Scale), each with a monthly price and, if you sell it, a yearly price (USD 99 / 249 / 599 a month; yearly 990 / 2,490 / 5,990). Copy each price id (`pri_...`).
3. **Developer tools → Authentication:** create a client-side token → `PADDLE_CLIENT_TOKEN`; optionally an API key with subscription and customer-portal access → `PADDLE_API_KEY`.
4. **Developer tools → Notifications:** new destination `https://<your-domain>/api/integrations/paddle/webhook`, events `subscription.created`, `subscription.updated`, `subscription.activated`, `subscription.past_due`, `subscription.paused`, `subscription.resumed`, `subscription.canceled`. Copy its secret → `PADDLE_WEBHOOK_SECRET`.
5. **Checkout → Website approval:** add your domain (needed in production).
6. Set the variables from `.env.example` (`PADDLE_ENV=sandbox` first), redeploy, and pay for a plan from Billing with a Paddle test card. The plan changes within seconds, when the webhook arrives.
7. When it works, repeat steps 2–5 in the live account and set `PADDLE_ENV=production`.

What happens: a company administrator opens **Billing → Pay by card** and picks a plan; Paddle's checkout opens on top of Veyra. Paddle's signed webhook then sets the plan to Active. If a renewal fails, Paddle reports *past due* and Veyra locks adding new loads and people until it is paid; a cancelled subscription ends the same way when the paid period is over. With `PADDLE_API_KEY`, administrators can also switch plans (Paddle charges or credits the difference) and open Paddle's portal for invoices, the card on file and cancelling.

Only correctly signed webhooks are accepted (5-minute window), each company is identified by a signed reference set at checkout, and older events never overwrite newer ones.

## Legal pages and regions

`/terms`, `/privacy` and `/refunds` are generated from `lib/legal.js` with the `LEGAL_*` settings and `REFUND_DAYS`. They are a starting point for a B2B SaaS sold through Paddle, not legal advice: have them reviewed. Raise `TERMS_VERSION` in `lib/legal.js` when the texts change in substance; sign-up records the version each company accepted.

`CURRENCY` and `WEIGHT_UNIT` are now only defaults: each company sets its own in Team & settings → Company.

## Before real traffic (go-live checklist)

Do these in order. A line you cannot tick is a reason to wait.

1. **Secrets**: a long random `JWT_SECRET`, a separate `SECRETS_KEY` (keep it: saved Twilio and mailbox passwords depend on it),
   a unique admin password of 12+ characters, the example admin email changed. Nothing secret in the repository.
2. **Database**: PostgreSQL for production ([docs/DATABASE.md](docs/DATABASE.md)); provider backups switched on. If you start from
   SQLite with real data, the data copy has been done and checked.
3. **Backups**: a backup taken before every upgrade that brings a migration (the table in docs/DATABASE.md, section 5, shows
   which cannot be undone).
4. **Restore drill** done on a copy and the result written down ([docs/RECOVERY.md](docs/RECOVERY.md)). Re-run it monthly.
5. **Load test** run against a staging copy, not production ([docs/RECOVERY.md](docs/RECOVERY.md)).
6. **Document storage** chosen: the default (database), or R2 set up, tested with a real upload, the key copied to a password manager and the bucket backed up (section above).
7. **Integrations**: each one you will use tried with a test account of the real service ([docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)). Promise customers only what is marked Working there, and tell them everything else is typed by people.
8. **Security**: the independent external review done and no open Critical or High finding ([docs/SECURITY.md](docs/SECURITY.md): **check its status table first**).
9. **Legal pages** reviewed by a lawyer; for card payments the Paddle sandbox tested and the website approved ("Card payments" above).
10. Set `ALLOWED_ORIGIN` only if a separate trusted frontend domain needs cross-origin access (same-origin hosting does not).
11. Monitoring and log access in place; someone knows who to call at 3 a.m.

## Upgrade notes by feature

Take a **database backup before every upgrade** that brings a migration. The full list of migrations, what each adds and which
can be reversed is in [docs/DATABASE.md](docs/DATABASE.md) (section 5). Notes by feature:

### Shipment legs (API v2)

One customer order can move in several legs (road, ocean, air, rail, warehouse, last mile). See `docs/API_V2.md`.
- Migration `0006_shipment_legs` adds the leg, leg history and handover tables (protected by row level security on PostgreSQL) and cannot be reversed; take a backup before upgrading.
- Existing loads and `/api/*` are unchanged: a classic load is shown as one ROAD leg and nothing is rewritten.
- A multi-leg load rejects the classic status, dispatch and location actions (`409`); use its legs.
- Prices and tracking are entered by people. There is no carrier, port or airline connection yet.
- NEXUS and Finance work per leg (booking message, exception, next-leg reminder, quiet leg; carriers paid leg by leg). Migration `0007_leg_payments` adds the leg payment column and cannot be reversed; take a backup before upgrading.
- Price fields now keep up to 4 decimals on input and are rounded to the currency's minor unit when saved (before, input was cut to 2 decimals first, which was wrong for currencies like KWD).

### Trips (LTL)

One truck run can carry several shipments (see `docs/API_V2.md`, "Trips"). Migration `0008_trips` adds the trip tables (protected by row level security on PostgreSQL) and `shipments.trip_id`; it cannot be reversed, so take a backup before upgrading.
- Shipments and `/api/*` are unchanged. While a shipment is on a trip its status, carrier and cost follow the trip, and the classic status, dispatch and location actions answer `409` for it.
- The truck's price is shared among the loads by weight (to the minor unit); each delivered load owes the carrier its share in Finance.
- A GPS position that matches a truck's plate now reaches every active load on that truck (before, only the newest load).
- Screens: **Trips** in the side menu (plan a trip, put loads on it, book the truck, start, add a position, deliver load by load).
- NEXUS: one manifest message to the carrier and driver when a trip is booked, one task per problem or silence on the trip, and pooling suggestions for loads that could share one truck. `LTL_TRUCK_KG` (default 20000) is the truck size used for suggestions. No migration.

### Ocean, air and rail details, delays, mode documents

No migration. Details are checked and saved as before; documents of the new types (`bill_of_lading`, `air_waybill`,
`rail_waybill`) are read by VAULT when AI is on ([docs/API_V2.md](docs/API_V2.md)).

### Cold chain (temperature)

Migration 0010 adds a temperature range to loads and a table of temperature readings. It can be reversed only while no reading is saved; after that, recovery is the backup taken before the upgrade. **Take a backup before deploying.** Readings are typed by people; no sensor is connected.

### Warehouse

Migration 0011 adds the table of warehouse receipts and releases. It can be reversed only while it is empty; after that, recovery is the backup taken before the upgrade. **Take a backup before deploying.**

### Last-mile stops

Migration 0012 adds the table of last-mile stops. It can be reversed only while it is empty; after that, recovery is the backup taken before the upgrade. **Take a backup before deploying.**

### Customs and dangerous goods

Migration 0013 adds the customs and dangerous-goods record per load. It can be reversed only while it is empty; after that, recovery is the backup taken before the upgrade. **Take a backup before deploying.** The checks are format checks only, not legal or dangerous-goods advice.

### Keeping old data (retention)

Migration 0017 lets each company choose its own AI provider among those the server has ready (reversible). Nothing changes until a company administrator chooses one. Put the key and model of every provider you want to offer in the server settings. **Take a backup before deploying.**

Migration 0016 records which AI provider each company agreed to and which provider answered each AI call (reversible). Existing consents are kept for OpenRouter. **Take a backup before deploying.** If you then set `AI_PROVIDER` to another provider, companies must allow sharing again in Team & settings.

Migration 0015 adds the AI quota counters (`ai_quota`), the AI call ledger (`ai_calls`) and the AI data-sharing consent on companies. **Take a backup before deploying.** It can be reversed only while `ai_calls` is empty. After the upgrade **AI data sharing is OFF for every company**: FLOW and VAULT answer "switched off" and NEXUS leaves emails for a person until an administrator switches it on in Team & settings. Set `OPENROUTER_MODEL` if it is empty. The in-memory AI limiter is gone: limits now live in the database and hold across restarts and instances.

Migration 0014 adds two settings columns to companies (reversible). Nothing is removed until a company administrator sets days in Team & settings → "Keeping old data" and presses "Remove now" or switches on the daily run. Removal cannot be undone: **keep regular backups.**

### Document storage key

Migration 0009 (see "Where document files are kept"). Reversible while no file is in R2.
