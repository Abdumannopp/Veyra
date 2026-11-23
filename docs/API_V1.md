# API v1: the classic `/api` endpoints

The classic endpoints that the application and its tests use. They stay exactly as they are: a classic single-truck load keeps
working, and the newer multi-leg, trip and other features are in [API_V2.md](API_V2.md) (`/api/v2`).

Every endpoint needs a signed-in session (JWT in an HttpOnly cookie) unless it says it is public. Admin shipment controls need
an admin or operations role. The statuses of outside connections (AI, SMS, mail, GPS, map) are in
[INTEGRATIONS.md](INTEGRATIONS.md); setting them up is in [DEPLOYMENT.md](../DEPLOYMENT.md). How a person works a load from
order to delivery is in [USER_GUIDE.md](../USER_GUIDE.md).

## Operations API

- `POST /api/shipments` creates a validated shipment.
- `PATCH /api/admin/shipments/:id/status` advances an allowed lifecycle state.
- `POST /api/admin/shipments/:id/dispatch` assigns an available carrier and rate.
- `GET /api/shipments/:id/events` returns shipment activity history.
- `GET /api/shipments/:id/tracking` lists location updates; `POST` adds one (`location`, optional `eta` as `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`, optional `note`) while the load is Dispatched, In Transit or Exception.
- Dispatch also accepts optional `customerRate`, `driverName`, `driverPhone`, `truckPlate`; shipments return `customerRate`, `margin`, driver/truck fields, `lastLocation` and `eta`.
- `GET /api/config` (public) returns `weightUnit`, `currency`, `equipment` and the sign-up mode.
- `POST /api/admin/users` (admin) adds a team member; `PATCH /api/admin/users/:id` changes `role` and/or `active`. Changes sign the user out immediately.
- `GET /api/shipments/search?page=&limit=&status=&q=&equipment=&sort=` returns one page (`items`, `total`, `pages`, `statusCounts`); `GET /api/alerts` returns the notification counts. Both are computed in SQL, so they stay correct at any volume.

## AI agents and integrations

| Agent | What it does | Needs |
|---|---|---|
| **FLOW** | `POST /api/agents/flow/parse` `{text}` turns a customer's email / WhatsApp message into a shipment draft (weight converted to the configured unit, missing fields listed, questions to ask). Nothing is saved: a person reviews the form and presses Create. | `OPENROUTER_API_KEY` |
| **SCOUT** | `GET /api/agents/scout/:id` ranks available carriers by trailer fit, deliveries on the same lane and past problems, and suggests a rate from lane history. Rules, not a language model: free, instant, explainable. | nothing |
| **RELAY** | `POST /api/shipments/:id/messages/draft` drafts a message to the driver, carrier or customer (English templates filled from the load's real data); `POST /api/shipments/:id/messages` sends it by SMS or WhatsApp. The number always comes from the load record. | Twilio settings to send; drafts and "Copy text" work without |
| **NEXUS** | Reacts to events and leaves **tasks** for a person under *Inbox & tasks*: review an order that arrived by email, book a carrier (SCOUT's top picks), approve drafted messages (booking, pickup details, delivered, "where are you?" for quiet trucks), check a document that differs from the load. It only prepares: nothing is sent, booked or changed until a person presses the button. | nothing (AI only for reading emails) |
| **VAULT** | `POST /api/shipments/:id/documents?type=cmr\|pod\|bill_of_lading\|air_waybill\|rail_waybill\|other&filename=` (raw PDF/JPEG/PNG/WebP body) stores a document; for CMR, proof of delivery, bill of lading, air waybill and rail notes an AI model reads it and plain rules compare weight (10% allowance), truck plate, loading and delivery place, customer and date with the load. Differences become a task; the load is never edited. Also `GET .../documents`, `GET .../documents/:docId/file` (always an attachment), `POST .../documents/:docId/extract`, `DELETE`. The file type is checked from the first bytes, size is capped, files are kept per company (in the database by default, or in an encrypted Cloudflare R2 bucket if the server is set up for it: see DEPLOYMENT.md). | `OPENROUTER_API_KEY` and a model that can read images / PDFs |
| **Email inbox** | `POST /api/integrations/inbox/<company token>` receives incoming email (Postmark JSON, Mailgun and SendGrid Inbound Parse forms incl. multipart with files, generic JSON). Attached PDF/JPEG/PNG/WebP files are kept (type checked from the first bytes, signature logos dropped, files from blocked senders never stored): an email that names a load (`SHP-12` or its reference) puts them on that load and VAULT reads them; otherwise they wait with the email (`GET /api/inbox/:id/attachments/:fileId/file`, `POST /api/inbox/:id/attach {shipmentId}`) and move to the load created from it. Senders can be restricted to an allow-list; duplicates (same Message-ID) are stored once; FLOW reads the email and a task appears. Nothing becomes a load until a person presses *Create load*. Daily cap per company. | an email service that can POST to a URL |
| **ROUTE** | `GET /api/agents/route/:id`: typical transit time on the lane (median of the company's delivered loads), whether the promised dates are realistic, probable arrival, and trucks that unload near the pickup (return loads). Rules only; needs 3 delivered loads on the lane. No map service. | nothing |
| **PULSE** | `GET /api/agents/pulse/:id?rate=&customerRate=`: usual carrier and customer prices on the lane, a suggested customer price, and warnings (price 30%+ off the usual, thin margin, loss). Shown live in the dispatch window; booking at a warned price leaves a task. | nothing |
| **SENTINEL** | `GET /api/agents/sentinel`: open loads at risk (no truck and pickup near, pickup or delivery day passed, ETA after the promised day, missing driver phone / plate, silent truck, undelivered message). Runs every 10 minutes; one task per risk, closed automatically when the risk is gone. | nothing |
| **Delivery reports** | Twilio posts to `/api/integrations/twilio/status/<per-message secret>`; the request must carry a valid `X-Twilio-Signature` for that company's account. Messages show sent / delivered / read / not delivered; a failed message leaves a task. | `PUBLIC_URL` (automatic on Render and Railway) |
| **TRACE (GPS)** | `POST /api/integrations/gps` receives positions from a GPS provider (`Authorization: Bearer <company GPS token>`, body `{"positions":[{"truckPlate","lat","lng","speed","address"}]}`), matches them to the active load by truck plate and stores at most one point per `GPS_MIN_INTERVAL_MINUTES`. Admins create the token under Integrations. | a GPS provider that can POST JSON |

The AI gateway (`ai/gateway.js`) is the only code that talks to a model: OpenRouter, no hard-coded model (`OPENROUTER_MODEL` empty = account default), no `HTTP-Referer` header, 20 s timeout, one retry, the company's AI data-sharing consent, a durable quota per company per day and per person per hour, an `ai_calls` ledger and the `agent_tasks` log (agent, model, tokens, time, result) — visible under Analytics → AI agents. Error codes: `403 AI_CONSENT_REQUIRED`, `429 AI_QUOTA_EXCEEDED` (with `Retry-After` and `details.scope`), `413 AI_INPUT_TOO_LONG` (more than 4000 characters; never cut), `502 AI_INVALID_OUTPUT`, `502 AI_PROVIDER_FAILED`, `503 AI_USAGE_UNAVAILABLE`. Consent: `GET/PUT /api/settings/ai-consent` (`{"consent": true|false}`, admins change it). Full rules: [AI.md](AI.md). Customer text is passed as untrusted data and the model's JSON is validated with the same rules as typed input. No new dependencies (built-in `fetch`).

Tasks: `GET /api/tasks`, `POST /api/tasks/:id/dismiss`, `POST /api/tasks/:id/approve` (sends the drafted message once, optionally edited). Inbox: `GET /api/inbox`, `POST /api/inbox/:id/parse|dismiss`. Settings (admin): `PUT/DELETE /api/settings/messaging` (the company's own Twilio account, checked with Twilio, stored AES-256-GCM encrypted, never returned), `POST /api/settings/inbox/token`, `PUT /api/settings/inbox` (allowed senders).

**Whose Twilio account sends?** A company that connected its own account always uses it. Otherwise only the first company may use the server-wide Twilio settings from the environment; other companies cannot send until they connect their own (or the owner sets `MESSAGING_SHARED_ALL_TENANTS=true`).

## Multiple companies (multi-tenant)

Every user, shipment and carrier belongs to one company (`tenant_id`); every query is scoped to the signed-in user's company and a missing company fails closed. Records of another company behave as if they do not exist (404). The platform owner (the first production admin) adds customer companies with their first administrator under **Companies** (`GET/POST /api/platform/tenants`); each company admin then adds their own team. Data from before this change belongs to company 1.

- `GET /api/carriers` lists carriers with load statistics (loads, active, delivered, exceptions, booked revenue, current load).
- `POST /api/carriers` adds a carrier (`name`, `mode`: Truckload, LTL, Expedited, Reefer, Flatbed, Intermodal; optional `phone`, `contactName`).
- `PATCH /api/carriers/:id/status` sets a carrier `Available` or `Inactive` (refused while the carrier has an active load).
- `GET /api/analytics?days=7|30|90` returns KPIs, daily volume, status pipeline, equipment mix, top lanes, top customers and carrier performance.

## Permissions

- `admin`: full access, including adding users, changing roles and disabling accounts.
- `operations`: dashboard/analytics access, team and shipment reads, shipment creation, status changes, carrier dispatch, location updates, and carrier reads and management.
- `operator` (dispatcher): shipment/dashboard reads, shipment creation, location updates and carrier reads. Analytics, team access, dispatch, and status changes are denied by the API.

Permissions are enforced server-side, and the role is read from the database on every request, so an admin's change applies immediately; hiding a UI panel is not the security boundary.

Who may use the newer features (`/api/v2` and settings):

| Action | Permission | Roles that have it |
|---|---|---|
| Read legs, trips, temperatures, customs record | `shipments:read` | admin, operations, operator |
| Create a multi-leg order | `shipments:create` | admin, operations, operator |
| Add or edit a leg, **book** a leg or a trip (and un-book or cancel a trip), create or change a trip and put loads on it | `shipments:dispatch` | admin, operations |
| Move a leg or a trip along (start, deliver, report a problem), set a temperature range, receive / release warehouse goods, add or change last-mile stops, save the customs record, deliver a load on a trip | `shipments:status` | admin, operations |
| Add a position to a leg or a trip, or a temperature reading | `shipments:track` | admin, operations, operator |
| File a document under a leg | `shipments:document` | admin, operations, operator |
| Mark a leg paid to its carrier | `shipments:finance` | admin, operations |
| Retention settings, automation switches, integrations | `settings:write` | admin |
| Download backups, add companies | platform owner only | the first administrator |

## The plan, for the screens

The screens hide what the company's plan does not include. This is only a hint for the screens: **the server still refuses
every call the plan does not allow** (`402`, see `needsPlan` in `server.js`), whatever a screen shows.

- `GET /api/me` also returns `plan`: `{ key, name, status, locked, capabilities }`, where `capabilities` is a list such as
  `["ai", "gps", "email", "messaging"]` (empty on Starter). `plan` is `null` only if the plan could not be read; the screens
  then treat the company as having no AI.
- `GET /api/billing/plan` returns the same capabilities as `{ ai: { on } , ... }` plus usage.
- `GET /api/shipments/:id/documents` returns `readsDocuments`: true only when the AI model is set up **and** the plan
  includes `ai`.
- `GET /api/ai/command-center` and `GET /api/automation/studio` mark the automations that call an AI model with
  `needsAi: true` (`readOrders`, `readDocuments`); screens of a plan without `ai` leave them out.
- Routes closed to plans without `ai`: `POST /api/agents/flow/parse`, `POST /api/inbox/:id/parse`,
  `POST /api/shipments/:id/documents/:docId/extract`, and NEXUS's automatic reading of emails and documents.
