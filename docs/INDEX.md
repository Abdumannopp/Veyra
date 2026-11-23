# Documentation index

Start here. Every document has **one job**; when two documents seem to say the same thing, the one named as the *source of
truth* below wins, and the other should only link to it.

## 1. About the project

| Document | What it is for |
|---|---|
| [README.md](../README.md) | What Veyra is and does, the honest status, quick start, links. Short on purpose. |
| [docs/GLOBAL_ROADMAP.md](GLOBAL_ROADMAP.md) | What has been built (phases 1 to 6), what is left, and the rules every step follows. |

## 2. Installing and running

| Document | What it is for |
|---|---|
| [README.md](../README.md#quick-start-development) | Run it on your own computer. |
| [DEPLOYMENT.md](../DEPLOYMENT.md) | Hosting (Render, Railway, VPS), every setting, where documents are kept (database or R2), card payments, the go-live checklist, upgrade notes. |
| [docs/RECOVERY.md](RECOVERY.md) | The restore drill and the load test: how to prove a backup works and how many people the system carries. |

## 3. Using Veyra

| Document | What it is for |
|---|---|
| [USER_GUIDE.md](../USER_GUIDE.md) | A guide for trucking and forwarding staff, no technical knowledge needed: from order to delivery, every feature, plans and billing. |

## 4. API

| Document | What it is for |
|---|---|
| [docs/API_V1.md](API_V1.md) | The classic `/api` endpoints: loads, carriers, tasks, agents, companies, and the permission table. |
| [docs/API_V2.md](API_V2.md) | `/api/v2`: legs, trips, delays, documents per mode, cold chain, warehouse, last mile, customs, retention. |

## 5. Database and migrations

| Document | What it is for |
|---|---|
| [docs/DATABASE.md](DATABASE.md) | SQLite or PostgreSQL, what is automatic and what is manual, moving data, the list of schema migrations and which can be reversed, company isolation, money, time zones, backups. |

## 6. Integrations

| Document | What it is for |
|---|---|
| [docs/INTEGRATIONS.md](INTEGRATIONS.md) | **Source of truth** for how ready each integration is: working, partial, test mode, in development, not connected. |
| [DEPLOYMENT.md](../DEPLOYMENT.md#optional-services-ai-messaging-email-map-gps) | How to set each one up (keys, addresses, variables). |

## 7. Security

| Document | What it is for |
|---|---|
| [docs/SECURITY.md](SECURITY.md) | The controls, the checks the project did itself, the status of the independent external review, the findings register and how findings are fixed. |

## 8. Roadmap and future plans

| Document | What it is for |
|---|---|
| [docs/GLOBAL_ROADMAP.md](GLOBAL_ROADMAP.md) | Steps done and open. The open items are the external security review and anything you add. |

## 9. Design files

| Folder | What it is for |
|---|---|
| [docs/design/](design/README.md) | Editable SVG drawings of the 12 main screens (in Uzbek). |

## Which document is the truth for what

| Question | Source of truth | Others should |
|---|---|---|
| Does integration X really work? | INTEGRATIONS.md | link to it, never repeat a status |
| Which database, and how does data move? | DATABASE.md | link to it |
| Which migrations exist and can they be undone? | DATABASE.md (section 5) | link to it |
| Where are document files kept, and how do I set up R2? | DEPLOYMENT.md ("Where document files are kept") | link to it; USER_GUIDE says only what a user sees |
| What are the endpoints and who may call them? | API_V1.md / API_V2.md | link to it |
| Is it security reviewed? | SECURITY.md | say "see SECURITY.md" (the README front-page banner is the one allowed short copy) |
| What is done and what is left? | GLOBAL_ROADMAP.md | link to it |
| How does a person do their job in Veyra? | USER_GUIDE.md | link to it |

## Keeping the documents true

When a change touches behaviour, update in the same pull request:
1. the **source-of-truth** document from the table above;
2. [USER_GUIDE.md](../USER_GUIDE.md) if a person sees the change;
3. [docs/GLOBAL_ROADMAP.md](GLOBAL_ROADMAP.md) if a step starts or finishes;
4. this index if a document is added, renamed or removed.

Do not copy a status, a number or a command from one document into another; link to it instead. Do not write that an
integration is "ready" or "connected" unless INTEGRATIONS.md says so.
