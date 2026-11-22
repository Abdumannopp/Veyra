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
| 1.7 | Documents in encrypted object storage; metadata and checksums in PostgreSQL | Storage chosen: Cloudflare R2 |

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
| 3.2 | Screens for trips (plan a trip, put loads on it, book, track, deliver one by one) | Next |
| 3.3 | NEXUS for trips (one booking message to the carrier with the whole manifest) and consolidation suggestions (LTL loads on the same lane that fit one truck) | Planned |

## Phase 4 — Ocean, rail, air
`OceanLegDetails` (vessel, voyage, container, B/L, ports), `RailLegDetails` (wagon, station, CIM/SMGS), `AirLegDetails` (AWB, flight, airports, chargeable weight). Integrations are marked as simulated until a real provider is connected.

## Phase 5 — Multimodal, cold chain, warehouse, last mile
Sequential legs with handovers; temperature ranges and excursions; warehouse receiving and storage; last-mile stops and proof of delivery.

## Phase 6 — Compliance, security audit, production readiness
Customs data, dangerous goods, retention rules, external security review, load and recovery tests.

## Rules kept throughout
- Existing FTL workflow keeps working after every step (the full test suite runs on both databases).
- Timestamps stored in UTC; money with an explicit currency; weights and sizes normalised but the entered value and unit kept.
- Webhooks and jobs are idempotent; every status change is recorded.
- Every migration is reversible or has a written recovery (restore the backup taken before it).
