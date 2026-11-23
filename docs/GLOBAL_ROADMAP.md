# Veyra Global — delivery plan and status

Goal: turn the FTL road-freight app into a modular, multi-transport logistics platform
(road, ocean, air, rail, warehouse, last mile) without breaking the existing FTL workflow.
Modular monolith; every step ships as its own pull request with tests on SQLite and PostgreSQL.

## Phase 1 — PostgreSQL and production foundation
| Step | What | Status |
|---|---|---|
| 1.0 | PostgreSQL support behind `DATABASE_URL`, full suite on both databases in CI | Done |
| 1.1 | Versioned migrations (`schema_migrations`, `npm run migrate`, up/down, lock) | Done |
| 1.2 | SQLite → PostgreSQL copy with row counts and checksums, before switching traffic | Done |
| 1.3 | Tenant-scoped transactions and PostgreSQL Row Level Security | Done |
| 1.4 | Money as exact decimals with an ISO currency per amount | Done |
| 1.5 | Durable background jobs (retries, idempotency keys) for AI, tracking, OCR, notifications | Done |
| 1.6 | Timezone and locale per company; UTC everywhere in storage | Done |
| 1.7 | Documents in encrypted object storage (Cloudflare R2, AES-256-GCM before upload); metadata and checksums in the database; a script moves old files | Done (switched on by settings) |

## Phase 2 — Universal shipment and legs
| Step | What | Status |
|---|---|---|
| 2.1 | `shipment_legs` (mode, sequence, carrier, price, schedule, reference, mode details, tracking), leg status history, handovers, documents per leg, load status and price rolled up from legs, `/api/v2` (see `docs/API_V2.md`); a classic load is one ROAD leg and `/api/*` is unchanged | Done |
| 2.2 | Screens for legs: "Multi-leg order" planner, a "Route legs" section in the load record (book, start, deliver with handover, report a problem, add a position, edit, cancel), multi-leg loads marked in the list | Done |
| 2.3 | NEXUS (per-leg booking message, exceptions, next-leg reminder, quiet leg) and Finance (carriers paid leg by leg) understand multi-leg loads | Done |

## Phase 3 — Road FTL and LTL
| Step | What | Status |
|---|---|---|
| 3.0 | Existing FTL on legs: a classic load is one ROAD leg (nothing rewritten, `/api/*` unchanged) | Done (Phase 2) |
| 3.1 | Trips: one truck run carrying several shipments; capacity (kg and pallets), the truck price shared by weight, loads move with the trip, one position and GPS for all loads on it, `/api/v2/trips` (see `docs/API_V2.md`) | Done |
| 3.2 | Screens for trips: a Trips page with load bars, a trip page (facts, loads with cost share, add and take off loads, book, start, report a problem, add a position, take back, cancel, deliver one by one); loads on a trip are marked and their classic status controls hidden | Done |
| 3.3 | NEXUS for trips (one manifest message to the carrier and one to the driver when booked, one task per problem or silence on the trip) and pooling suggestions (loads on the same lane with close pickups that fit one truck: API, a Trips page panel and a NEXUS task) | Done |

## Phase 4 — Ocean, rail, air
`OceanLegDetails` (vessel, voyage, container, B/L, ports), `RailLegDetails` (wagon, station, CIM/SMGS), `AirLegDetails` (AWB, flight, airports, chargeable weight). Integrations are marked as simulated until a real provider is connected.

| Step | What | State |
|---|---|---|
| 4.1 | Ocean, air and rail details with industry checks: ISO 6346 container numbers, container types, seal and booking; AWB check digit, IATA airports, pieces, weights and chargeable weight; UIC / 1520 wagon numbers, CIM/SMGS notes, border station. Screens show the new fields | Done |
| 4.2 | Schedules and delays: each leg shows if it is late (pickup not started, past the planned delivery, ETA after the plan) or if the leg before will arrive after its pickup; NEXUS makes one task per delay that closes by itself | Done |
| 4.3 | Mode documents: B/L, AWB and rail notes (CIM/SMGS) are read by VAULT, their numbers checked (check digits), compared with the leg of that mode and filed under it; a difference is one task | Done |

## Phase 5 — Multimodal, cold chain, warehouse, last mile
Sequential legs with handovers; temperature ranges and excursions; warehouse receiving and storage; last-mile stops and proof of delivery.

| Step | What | State |
|---|---|---|
| 5.1 | Cold chain: a temperature range per load, readings typed by people (optionally per leg), stretches outside the range, one NEXUS task per stretch, a Temperature section in the load record | Done |
| 5.2 | Warehouse: a booked warehouse leg receives goods (pieces expected/received, damage, free days, price per day), stores them (days and charge) and releases them to the next leg; NEXUS raises short/extra/damaged pieces and storage past the free days | Done |
| 5.3 | Last mile: stops on a last-mile leg (address, receiver, pieces, deliver-by time), proof of delivery per stop (received by, note, a file of the load), failed stops and retries; the last delivered stop completes the leg; NEXUS raises failed stops and missed windows | Done |

## Phase 6 — Compliance, security audit, production readiness
Customs data, dangerous goods, retention rules, external security review, load and recovery tests.

| Step | What | State |
|---|---|---|
| 6.1 | Customs and dangerous goods per load: HS code, countries, declared value, Incoterm, customs status and declaration number; UN number, class, packing group and proper shipping name (format checks, not legal advice); warnings per leg mode; NEXUS tasks for goods held by customs and dangerous goods to check | Done |
| 6.2 | Retention: per company, how long positions, messages and files of finished loads, done tasks and the activity log are kept (off until set, with minimums); a preview, a confirmed "Remove now" and an optional daily run; loads, money and status history are never removed | Done |
| 6.3 | Load and recovery tests (backup restore drill) | Next |
| 6.4 | External security review | Needs an outside reviewer |

## Rules kept throughout
- Existing FTL workflow keeps working after every step (the full test suite runs on both databases).
- Timestamps stored in UTC; money with an explicit currency; weights and sizes normalised but the entered value and unit kept.
- Webhooks and jobs are idempotent; every status change is recorded.
- Every migration is reversible or has a written recovery (restore the backup taken before it).
