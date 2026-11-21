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
| 1.4 | Money as exact decimals with an ISO currency per amount | Next |
| 1.5 | Durable background jobs (retries, idempotency keys) for AI, tracking, OCR, notifications | Planned |
| 1.6 | Timezone and locale per company; UTC everywhere in storage | Planned |
| 1.7 | Documents in encrypted object storage; metadata and checksums in PostgreSQL | Storage chosen: Cloudflare R2 |

## Phase 2 — Universal shipment and legs
Shipment as the customer order; `shipment_legs` with mode, sequence, carrier, price, schedule, documents and tracking per leg; handovers between legs; status history per shipment and per leg; `/api/v2` for the new model while `/api/*` keeps today's behaviour (a current FTL load = a shipment with one ROAD leg).

## Phase 3 — Road FTL and LTL
Existing FTL moved onto legs without changing its screens; LTL consolidation and allocation of shipments to trucks.

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
