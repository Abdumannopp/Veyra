# VEYRA deployment guide

The application starts with `npm run prod`, reads the platform-provided `PORT`, serves `/api/health` for health checks, and requires a persistent SQLite path. The first production startup creates one admin from the `INITIAL_ADMIN_*` variables. Development demo accounts and sample shipments are not seeded in production.

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

The volume is persistent but SQLite remains a single-instance database. For multiple replicas, migrate to PostgreSQL first.

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

## AI, SMS / WhatsApp and GPS (optional)

All three are off until configured, and the app works without them.

- **AI (FLOW)**: create a key at openrouter.ai, set `OPENROUTER_API_KEY`. Optionally pick a model in `OPENROUTER_MODEL`; empty uses your OpenRouter account default. Use is limited per person (`AI_RATE_LIMIT_PER_HOUR`) and logged under Analytics → AI agents.
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
- **Documents**: CMR, proof of delivery and other files (PDF, JPG, PNG, WebP, up to `DOC_MAX_MB`) are stored inside the database file, so the database backup covers them. Reading CMR files with AI needs a model that can read images or PDFs: set `OPENROUTER_MODEL` to one if the account default cannot.
- **GPS**: an administrator opens Dashboard → Integrations → Create GPS token and gives the provider the address `https://<your-domain>/api/integrations/gps` and the token. The provider sends positions with the truck plate; plates are matched ignoring spaces and dashes.

## NEXUS (the orchestrator)

NEXUS reacts to events (an order email arrives, a load reaches Sourcing, a truck is booked, a document is uploaded, a truck goes quiet) and leaves **tasks** under Inbox & tasks. It prepares things: reads emails, ranks carriers, drafts messages, compares documents with the load. It never sends a message, books a truck, creates a load or changes a status: every one of those waits for a person to press the button. Trucks with no location update for `STALE_TRACKING_HOURS` get a drafted "where are you?" message (checked every 10 minutes). `NEXUS_ENABLED=false` switches it off.

## Accounts, money, customer link, backups, activity log

- **Passwords**: everyone changes their own under *Password* (other devices are signed out). An administrator can set a new password for a team member who forgot theirs (Team Access -> New password). There is no "forgot password" email: the administrator is the way back in. If the only administrator forgets theirs, a new first admin cannot be created automatically; keep that password in a password manager.
- **Editing a load**: the load window -> *Edit load*. Every correction is written to the load's history. Delivered and cancelled loads are not edited.
- **Payments**: invoice number, *Invoice sent*, *Customer paid*, *Carrier paid* in the load window; *Open invoice* gives a printable page (browser -> Print -> Save as PDF); Analytics -> *Open money* lists what is still unpaid. Role needed: admin or operations.
- **Customer tracking link**: the load window -> *Customer tracking link*. The page shows only route, dates, status, last place, ETA and truck plate. A new link replaces the old one; *Remove link* switches it off. Set `PUBLIC_URL` so the link uses your domain.
- **Backups**: a full copy of the database is written every day to `BACKUP_DIR` (default: `backups/` next to the database), the newest `BACKUP_KEEP` (7) are kept; `BACKUP_ENABLED=false` switches it off. These copies sit on the same disk as the database, so they protect against mistakes, not against losing the disk: the platform owner should download one regularly (Dashboard -> Backups) and keep it elsewhere. The file holds every company's data. To restore: stop the app, replace the database file with the backup, start the app.
- **Activity log**: administrators see who changed accounts, passwords, integrations, payments, customer links and backups.

## Before real traffic

- Change the example admin email and all generated placeholder values.
- Keep SQLite on persistent storage and configure backups. SQLite is suitable for one app instance; use PostgreSQL before horizontal scaling.
- Configure `ALLOWED_ORIGIN` only if a separate trusted frontend domain needs cross-origin API access. Same-origin hosting does not require it.
- Add monitoring and restore-test your backups.

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

## PostgreSQL (recommended for production)

Veyra runs on PostgreSQL when `DATABASE_URL` is set, and on a single SQLite file (`DATABASE_PATH`) when it is not. Tests and local development keep using SQLite; CI runs the full suite on both.

**Railway:**
1. In the project, **New → Database → PostgreSQL**.
2. In the Veyra service, **Variables**: add `DATABASE_URL=${{Postgres.DATABASE_URL}}` and remove `DATABASE_PATH`.
3. Redeploy. On first start Veyra creates its tables and the first administrator from `INITIAL_ADMIN_*`.
4. The `/data` volume is no longer needed for the database.

**Backups:** with PostgreSQL, Veyra's own daily file backup is switched off; use the database provider's backups (Railway: the PostgreSQL service's **Backups** tab). The platform backup endpoints answer 409 with that message.

**How it works:** `lib/postgres.js` translates Veyra's SQL (placeholders, SQLite date functions, `INSERT OR IGNORE/REPLACE`, case-insensitive `LIKE`, types) and keeps timestamps as UTC text in the same format as before. One connection runs one statement at a time, like the SQLite file did; that is plenty for hundreds of companies, and a connection pool can come later.

**Moving existing SQLite data:** not automated yet. A fresh PostgreSQL database is created on first start; if you already have companies in a SQLite file, ask for a migration script before switching.

## Moving existing data from SQLite to PostgreSQL

Do this once, when a running SQLite install moves to PostgreSQL. The SQLite file is only read, never changed.

1. Take a backup of the SQLite file (Admin → Backup, or copy the file from the Volume).
2. Create an **empty** PostgreSQL database.
3. Rehearse: `SQLITE_PATH=/data/veyra.db DATABASE_URL=postgres://... npm run migrate:postgres -- --dry-run`.
   Every table is copied, checked (row count and content checksum), then undone.
4. Stop the app (no new writes), then run the same command without `--dry-run`.
   It refuses a database that already has data, and keeps nothing if any table differs.
5. Only after it prints `Done: ... copied and verified`, set `DATABASE_URL` on the app and start it.
6. Keep the SQLite backup until you have checked the app on PostgreSQL.

## Company isolation in the database (PostgreSQL)

On PostgreSQL, every company's rows are also protected by the database itself (row level security), not only by the app's own filters.
- Migration `0002_row_level_security` creates a login-less role `veyra_app` and policies on every company table. The app switches to that role after migrating, so policies bind it.
- A signed-in request can only read or write its own company's rows. Server work (login lookup, webhooks, background jobs, platform admins) runs as "system" and is explicit in the code.
- Anything with no company context sees no rows (fail closed).
- The database user from `DATABASE_URL` needs permission to create roles (Railway's default `postgres` user has it). If it cannot, the app starts and logs `row level security is NOT enforced`.
- Set `DB_RLS=off` only for local debugging with one-off scripts that read across companies.
- SQLite installs keep the app-level company filters only.

## Database migrations

Schema changes are versioned migrations (`database.js` → `MIGRATIONS`, runner in `lib/migrations.js`). Applied ids are kept in `schema_migrations`; the server applies missing ones at start, one process at a time.

```bash
npm run migrate -- status
npm run migrate
npm run migrate -- down 1
```

Take a backup before upgrading. `0001_baseline` (the schema before versioning) cannot be reversed: recovery is restoring that backup. New migrations must have a working `down()`, or say in it why not and how to recover.
