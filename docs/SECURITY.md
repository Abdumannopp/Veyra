# Security: controls, checks done, and the external review

## Status at a glance

| Item | Status |
|---|---|
| Security controls built into the application (section 1) | In place and covered by automated tests |
| Automated security-related tests (section 2) | Pass on SQLite and PostgreSQL when this was written |
| Dependency check (`npm audit --omit=dev`) | 0 vulnerabilities on 2026-11-23 (re-run before every release) |
| **Independent external security review (step 6.4 of the roadmap)** | **NOT DONE.** Needs an outside reviewer (section 3) |
| External findings and their fixes | None recorded, because no external review has happened yet (section 4) |

**Do not describe Veyra as "security audited" or "penetration tested"** until section 3 is finished and section 4 shows no
open Critical or High finding. Tests written by the people who built the system are useful, but they are not independent.

## 1. Controls in the application

- **XSS**: the frontend builds the page with `textContent` / `createElement` only (no `innerHTML`, `eval`, inline scripts or
  inline handlers); a test scans the sources for these. The Content-Security-Policy is `script-src 'self'` (plus Paddle's
  script host only when card payments are on).
- **Sign-in and sessions**: the token lives only in an HttpOnly, SameSite=Lax cookie (`Secure` in production). Sessions can be
  revoked on the server and are revoked when an administrator changes or disables the account. Login is rate-limited per IP,
  per account per IP and per account across all IPs. One bcrypt cost for all hashes, so accounts cannot be told apart by
  timing. Production never creates demo users; development listens on 127.0.0.1 only.
- **Permissions**: checked on the server for every request, and the role is read from the database each time, so a change
  applies at once. Hiding a button is never the boundary. Roles and what they may do: [API_V1.md](API_V1.md#permissions).
- **Company isolation**: every query is scoped to the signed-in user's company, and a missing company fails closed. Another
  company's record behaves as if it did not exist (404). On PostgreSQL the database enforces the same with row level
  security ([DATABASE.md](DATABASE.md#6-company-isolation-in-the-database-postgresql)).
- **Input checks**: strict IDs, ISO dates, positive bounded numbers, a 50 kb JSON limit; malformed input returns 400, never
  500. Identifier formats (container, AWB, wagon, UN number, HS code) are checked before saving.
- **Errors**: a global handler returns generic messages; details are logged on the server only.
- **Bookings and status changes** run in a single database transaction, so two operators cannot book the same carrier or load.
- **Secrets at rest**: a company's Twilio token and mailbox password are stored AES-256-GCM encrypted with `SECRETS_KEY`
  and never returned. Document files can be encrypted the same way with `DOCUMENT_ENCRYPTION_KEY`.
- **Uploaded files**: the type is checked from the first bytes, size is capped, files are kept per company, and downloads are
  always an attachment. Files from blocked email senders are never stored.
- **Webhooks**: Twilio reports must carry a valid `X-Twilio-Signature` and a per-message secret; Paddle webhooks must be
  correctly signed (5-minute window); the inbound-email address contains a secret and can be restricted to allowed senders;
  GPS posts need the company's bearer token.
- **Outbound requests**: the mailbox reader refuses private-network servers unless you allow them; the map only sends place
  names to the servers you configure.
- **AI provider** ([AI.md](AI.md)): data goes to OpenRouter only after the company's administrator switches on "AI data
  sharing" (off by default, every change in the activity log). Every model call goes through one gateway that takes a
  durable per-company and per-person quota in the database first, removes passwords, keys and tokens from the text, logs
  the call (tokens, model, status) without prompts or secrets, and accepts only an answer of the expected shape.
- **Activity log**: administrators see who changed accounts, passwords, integrations, payments, customer links, backups and
  data removal.
- **Data removal**: companies choose how long old detail is kept ([USER_GUIDE.md](../USER_GUIDE.md)). Nothing is removed until
  an administrator sets it and confirms.
- **Production start**: `NODE_ENV=production`, `JWT_SECRET` and (first start only) `INITIAL_ADMIN_NAME/EMAIL/PASSWORD`
  (12+ characters) are required; the server refuses to start without them. The document-storage settings are checked at start-up too.

## 2. Checks done by the project itself

- `npm test`: the full automated suite. A few tests (row level security and the SQLite-to-PostgreSQL copy) need PostgreSQL and are
  skipped on SQLite; CI runs everything on both engines for every pull request. The files
  most relevant to security: `hardening`, `validation-security`, `auth-rate-limits`, `user-admin`, `production-mode`,
  `multi-tenant`, `rls`, `messaging-tenant`, `paddle`, `document-storage`, `shipment-transactions`.
- `npm audit --omit=dev`: **0 vulnerabilities on 2026-11-23**. Run it again before every release and after adding a dependency.
- `npm run db:check`: integrity and foreign-key check of a SQLite file.
- `npm run restore:drill` and `npm run load:test` ([RECOVERY.md](RECOVERY.md)): recovery and load, not security.

What these do **not** prove: that the rules are free of mistakes nobody thought to test, how the system behaves behind your
real hosting and network, or how it holds up against someone actively trying to break it. That is what an outside review is for.

## 3. The independent external review (open)

**Status: not started.** Veyra's authors cannot do this step. It needs a security specialist or firm that did not build
the system.

**How to run it**
1. Choose a reviewer and agree the scope and dates **in writing**.
2. Give them a **staging copy** with test data only (never production data or real customers). Use
   [RECOVERY.md](RECOVERY.md) to build it from a restored backup if you want realistic volumes, with personal data removed.
3. Ask for a written report with a severity for every finding and a way to reproduce it.
4. Record every finding in section 4, fix them (section 5), and ask the reviewer to **retest** the fixes.

**Suggested scope**
- Sign-in, sessions, password reset by administrators, rate limits.
- **Company isolation on every route** (`/api/*` and `/api/v2/*`): try to read or change another company's loads, legs, trips,
  documents, tasks, settings and backups; try to bypass PostgreSQL row level security.
- Input handling and injection, including the SQL translation layer in `lib/postgres.js`.
- File upload and download (types, size, storage keys, the R2 path, decryption failures).
- Webhooks and inbound addresses: Twilio, Paddle, inbound email, GPS; replay and tampering.
- Server-side request risks: the IMAP host, the map and traffic URLs.
- Secrets handling: `JWT_SECRET`, `SECRETS_KEY`, `DOCUMENT_ENCRYPTION_KEY`, environment variables, logs.
- Roles and permissions: what each role can do through the API compared with the screens.
- Security headers, CORS, cookies, HTTPS configuration of the real hosting.
- The data-removal (retention) and backup features: can they be abused to destroy or leak data?
- A dependency review beyond `npm audit`.

**Go-live gate:** do not accept real customers' data until the review is finished and section 4 has **no open Critical or
High finding**. Medium findings need a dated plan.

## 4. Findings register

Add one row per finding. Keep fixed ones in the table, marked "Fixed and retested".

| ID | Date found | Severity | Area | Finding (short) | Status | Fixed in (PR) | Retested by / date |
|---|---|---|---|---|---|---|---|
| | | | | *No external review has been done yet, so there are no external findings.* | | | |

Severity: **Critical** (data of other companies exposed, account takeover, remote code), **High** (serious abuse that needs
some conditions), **Medium** (limited impact or hard to exploit), **Low** (hardening, best practice).
Status values: Open, In progress, Fixed (waiting for retest), Fixed and retested, Accepted risk (needs the owner's written reason).

## 5. Fixing findings

Proposed targets (the platform owner should confirm or change them):

| Severity | Plan made | Fix released |
|---|---|---|
| Critical | Within 1 day | Before go-live, or within 7 days if already live (switch the affected feature off meanwhile) |
| High | Within 3 days | Before go-live, or within 14 days |
| Medium | Within 14 days | Within 30 days |
| Low | At the next planning | Next release |

For each finding: write a test that fails because of it, fix it in its own pull request, link the pull request in section 4,
ask the reviewer to retest, then change the status. Findings about leaked secrets also need the secret **replaced**, not only
the code fixed. Never put the details of an open Critical or High finding in a public place.

## 6. Reporting a problem

Send security reports to the platform owner (the address in `LEGAL_EMAIL` on the server). Include what you did, what you
expected and what happened. Do not test against other companies' real data.
