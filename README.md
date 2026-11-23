# VEYRA Logistics Platform

A multi-company logistics platform for freight forwarders and trucking companies. One customer order can travel by
**road, ocean, air, rail, warehouse and last mile**, with a price, a carrier, documents and a status for every leg.
Built with Express (Node 22); it stores data in a single SQLite file or, for production, in PostgreSQL.
AI helpers prepare work (read an email, rank carriers, draft a message, compare a document); **people press every button
that sends, books or changes something.**

> **Honest status.** Everything is entered by people. Veyra has **no live connection** to carriers, ports, airlines,
> railways, couriers, customs, warehouse systems or temperature sensors. The outside services it can use (AI, SMS /
> WhatsApp, mail, maps, card payments, Cloudflare R2) have so far been checked **only against fake responses**; see
> [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md). An **independent security review has not been done**; see
> [docs/SECURITY.md](docs/SECURITY.md).

## What it does

| Area | What you get |
|---|---|
| **Road loads (FTL)** | Create a load, find a carrier, dispatch with the carrier rate and customer price (live margin), log positions, deliver or report an exception, full history. |
| **Multi-leg orders** | Road, ocean, air, rail, warehouse and last-mile legs in order, each with its own carrier, price, schedule, reference and tracking; handovers between legs; the load's status and price follow its legs; carriers are paid leg by leg. |
| **LTL trips** | One truck carrying several loads: capacity in kg and pallets, the truck price shared by weight, one position for all loads, suggestions for loads that could share a truck. |
| **Ocean, air, rail details** | Container, seal and booking; AWB, flight, airports, pieces and chargeable weight; wagon, consignment note and border station. Container, AWB and wagon numbers are checked with their check digits. |
| **Delays** | Each leg shows if it is late or if the leg before will arrive after its pickup; one task per delay. |
| **Cold chain** | A temperature range per load, readings typed by people, stretches outside the range, one task per stretch. |
| **Warehouse** | Receiving (pieces, damage), storage days and charges, release to the next leg. |
| **Last mile** | Several stops per leg, proof of delivery per stop (who received it, a note, a file), failed stops and retries. |
| **Customs and dangerous goods** | HS code, countries, value, Incoterm, customs status; UN number, class, packing group. Format checks and warnings only, not legal advice. |
| **Documents (VAULT)** | CMR, proof of delivery, bill of lading, air waybill and rail notes: stored per company, read by AI, compared with the load by plain rules. Kept in the database by default, or in an encrypted Cloudflare R2 bucket. |
| **AI agents** | FLOW (read an order), SCOUT (rank carriers), RELAY (draft messages), NEXUS (tasks), VAULT (documents), ROUTE, PULSE, SENTINEL, TRACE (GPS). They only prepare; a person decides. |
| **Companies and money** | Many companies, each isolated from the others (plus PostgreSQL row level security); roles; plans and card payments through Paddle; quotes; analytics; invoices; per-company currency, weight unit, time zone and locale. |
| **Operations** | Durable background jobs, versioned database migrations, daily backups, a restore drill, a load test, a per-company retention setting, an activity log. |

## Documentation

Start with **[docs/INDEX.md](docs/INDEX.md)**: it says which file answers which question.

| I want to... | Read |
|---|---|
| Use Veyra day to day | [USER_GUIDE.md](USER_GUIDE.md) |
| Install it and put it online | [DEPLOYMENT.md](DEPLOYMENT.md) |
| Understand the database, migrations and PostgreSQL | [docs/DATABASE.md](docs/DATABASE.md) |
| Call the API | [docs/API_V1.md](docs/API_V1.md) and [docs/API_V2.md](docs/API_V2.md) |
| Know which integrations really work | [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) |
| See security controls and the external review | [docs/SECURITY.md](docs/SECURITY.md) |
| Practise recovery and measure load | [docs/RECOVERY.md](docs/RECOVERY.md) |
| See what is done and what is left | [docs/GLOBAL_ROADMAP.md](docs/GLOBAL_ROADMAP.md) |

## App pages

The dashboard uses hash routes, so links can be bookmarked and shared. What you see follows your role.

| Page | What it is |
|---|---|
| `#/dashboard` | Overview, AI assistant, operations console |
| `#/shipments` | All loads: status tabs, search, filters, CSV export, dispatch, multi-leg planner. `#/shipments?status=Pending%20Approval` is the Approvals queue |
| `#/trips` | LTL trips and loads that could share a truck |
| `#/tracking` | Global tracking of booked loads |
| `#/quotes` | Quotes and pricing |
| `#/inbox` | Inbox and tasks (what NEXUS prepared for a person) |
| `#/command` | AI Command Center: what the agents did, switches for the automatic jobs |
| `#/automation` | Automation Studio: your own rules |
| `#/carriers` | Carrier network |
| `#/agents` | The AI agents |
| `#/analytics` | 7 / 30 / 90-day analytics |
| `#/billing` | Plan, usage, payments, carriers owed per leg |
| `#/settings` | Team, company, integrations, backups, keeping old data |

## Quick start (development)

```bash
npm install
cp .env.example .env      # on Windows: copy .env.example .env
npm run dev               # http://127.0.0.1:3000, demo accounts, SQLite file in ./data
```

- Frontend files live in `public/`; only that folder is served statically.
- `npm run dev` listens on 127.0.0.1 only and creates demo users. `npm start` and `npm run prod` run in **production mode**:
  they refuse to start without `JWT_SECRET` and the `INITIAL_ADMIN_*` variables, and never create demo users.
- The database is a SQLite file (`DATABASE_PATH`) unless `DATABASE_URL` points to PostgreSQL. Which to use and how data moves
  between them: [docs/DATABASE.md](docs/DATABASE.md).
- Hosting on Render, Railway or a VPS, every setting and the go-live checklist: [DEPLOYMENT.md](DEPLOYMENT.md).

### Demo users (development only)

- admin@veyra.ai / admin123
- ops@veyra.ai / ops123
- demo@veyra.ai / demo123

They exist only with `npm run dev` and never in production. Never expose a development server to the internet.

## Roles

- **admin**: everything, including adding users, changing roles, settings and integrations.
- **operations**: loads, dispatch and booking, status changes, positions, carriers, analytics.
- **operator** (dispatcher): create loads, log positions, read lists, message drivers; no booking or status changes.

Permissions are checked on the server and the role is read from the database on every request. The full list is in
[docs/API_V1.md](docs/API_V1.md#permissions).

## Sign-up and region settings

In production sign-up is closed: the administrator adds people under Team Access → Add user. `REGISTRATION_INVITE_CODE` lets
people sign up with a code, `ALLOW_OPEN_REGISTRATION=true` is for demos. With card payments set up, new companies can sign up
themselves from the pricing page (see [USER_GUIDE.md](USER_GUIDE.md)). `WEIGHT_UNIT`, `CURRENCY`, `MAX_RATE`, `TIMEZONE` and
`LOCALE` are server defaults; each company can choose its own.

## Tests

```bash
npm test
```

The suite runs on SQLite; a few tests (row level security and the data copy) need PostgreSQL and are skipped on SQLite. CI runs
the full suite on both engines for every pull request. The number of tests is deliberately not written here, so this page
cannot go out of date: `npm test` prints it. `npm run db:check` checks a SQLite file; `npm run restore:drill` and `npm run load:test`
are described in [docs/RECOVERY.md](docs/RECOVERY.md).

## Security in one paragraph

HttpOnly cookie sessions, rate-limited sign-in, server-side permissions, company isolation in the app and (on PostgreSQL) in
the database, validated input, signed webhooks, encrypted secrets and optionally encrypted documents, an activity log.
The full list, what the project checks itself and the **open external review** are in [docs/SECURITY.md](docs/SECURITY.md).

## License

Proprietary. All rights reserved. See [LICENSE](LICENSE). Not for redistribution.
