# Integrations: what works, what is only tested with fakes, what is not connected

**Read this before promising a customer anything about an outside connection.** It is the single place that says how
ready each integration is. The status is taken from what the repository's automated tests actually exercise (they run on SQLite and
on PostgreSQL), not from live trials. If you try an integration with the real service, record the result in the
"Last tried with the real service" column and change its status.

## Status words

| Status | Meaning |
|---|---|
| **Working** | Runs inside Veyra, needs no outside service, and is covered by the automated tests. |
| **Partial** | Works, but only in part: it needs set-up by you, accepts one fixed format, or the data is typed by a person. The limit is written next to it. |
| **Test mode** | The code and its automated tests exist, but it has **only been checked against fake responses**. It has never been tried against the real service. Try it with a test or sandbox account first, and check the first results yourself. |
| **In development** | Being built right now. |
| **Not connected** | Not in Veyra. People type the data in. |

Nothing in Veyra is labelled "production-proven against a real provider". That status does not exist yet for any outside
service.

## Built in (no outside service)

| Feature | Status | Notes |
|---|---|---|
| Loads, carriers, dispatch, margins, analytics, quotes, billing records, activity log | Working | Core application. |
| Multi-leg orders (road, ocean, air, rail, warehouse, last mile), handovers, per-leg prices and payments | Working | Everything is typed by people. |
| Trips (LTL), cost split by weight, pooling suggestions | Working | |
| Ocean, air and rail identifiers: container (ISO 6346), AWB, wagon number checks; air chargeable weight | Working | **Format checks only** (check digits, lists of codes). Veyra does not look the numbers up anywhere. |
| Delays and handover risk | Working | Compares the plan with the ETAs people enter. |
| Cold chain (temperature readings and excursions) | Partial | Readings are typed by people. No sensor or logger is connected. |
| Warehouse receipts, storage days and charges | Partial | Typed by warehouse staff. No warehouse system (WMS) is connected. |
| Last-mile stops and proof of delivery | Partial | Typed by dispatchers and drivers. No courier system is connected. The proof is a name, a note and optionally a file. |
| Customs and dangerous-goods record | Partial | **Format checks and warnings only**, not legal or dangerous-goods advice. No customs system (single window, broker) is connected. |
| SCOUT, ROUTE, PULSE, SENTINEL, NEXUS tasks | Working | Rules, no AI model. ROUTE and PULSE need at least 3 delivered loads on a lane. |
| Customer tracking link, company data download, retention | Working | |
| Daily file backup (SQLite) | Working | On the same disk, so also download a copy. PostgreSQL uses the provider's backups. |
| Restore drill and load test (`npm run restore:drill`, `npm run load:test`) | Working | Scripts in this repository; see [RECOVERY.md](RECOVERY.md). They have not been run against a real hosted database yet. |

## Outside services

| Integration | What it does | Status | What the tests cover | Set-up and limits | Last tried with the real service | Test files |
|---|---|---|---|---|---|---|
| **AI model** (OpenRouter): FLOW reads order emails, VAULT reads CMR / POD / B/L / AWB / rail notes | Turns text and document images into fields; plain code then checks them | Test mode | The gateway, its limits and logging, validation of the model's answer, and every comparison rule, all with a fake model | `OPENROUTER_API_KEY` and a model that can read images / PDFs. How well it reads real, messy documents is **unknown**: check the first ones yourself. Needs the company's AI data sharing consent; durable daily (company) and hourly (person) quota; rules in [AI.md](AI.md). | Not yet | agents, agents-next, vault, vault-transport, ai-hardening |
| **SMS / WhatsApp** (Twilio): RELAY sending and delivery reports | Sends drafted messages after a person approves; shows sent / delivered / read / failed | Test mode | Sending, per-company accounts, encrypted tokens and the signature check on delivery reports, with a fake Twilio | Twilio account; for WhatsApp an approved sender. `PUBLIC_URL` for delivery reports. Numbers in international format. | Not yet | messaging-tenant, agents, nexus |
| **Email inbox (webhook)**: Postmark, Mailgun, SendGrid Inbound Parse, Zapier / Make | Receives incoming mail, keeps attachments, FLOW reads it | Test mode | Parsing of each provider's format and of generic JSON from sample payloads; sender allow-list, duplicates, caps | The address contains a secret; treat it like a password. | Not yet | agents-next, nexus |
| **Mailbox over IMAP** | Reads an order mailbox (read-only) | Test mode | Against a fake local IMAP server | TLS only; private-network servers refused unless `IMAP_ALLOW_PRIVATE=true`. Gmail / Outlook need an app password. | Not yet | imap |
| **Gmail / Outlook sign-in** (OAuth APIs) | Reads mail without an app password | Test mode | OAuth flow and mail reading with fake Google / Microsoft services | Needs your own Google / Microsoft apps. **Google asks for a security review** before apps that read mail can be used by outside accounts. | Not yet | mail-api-traffic |
| **Map** (Nominatim, OSRM) | Road distance and off-route warnings | Test mode | With a fake map service | `GEO_PROVIDER=osm`. The public servers are for light use only; place names of loads are sent to them. | Not yet | map-market, tracking |
| **Live traffic** (TomTom) | Delays for trucks on the road | Test mode | With a fake traffic service | `TRAFFIC_PROVIDER=tomtom`, `TOMTOM_API_KEY`. | Not yet | mail-api-traffic |
| **GPS positions (TRACE)** | Receives positions from a GPS provider and matches them to loads by truck plate | Partial | The receiving address, token, plate matching and rate limits, with simulated posts | Veyra accepts **its own JSON format** only. The provider (or Zapier / Make) must be able to post it. No provider-specific adapter exists. | Not yet | agents, map-market, tracking |
| **Card payments** (Paddle) | Plans, checkout, invoices, plan changes, portal | Test mode | Signed webhooks, ordering, tampering, plan switching and the portal, with a fake Paddle API | Start in Paddle's **sandbox**; Paddle must approve your website before live use. | Not yet | paddle, signup |
| **Document storage** (Cloudflare R2) | Keeps document files in an encrypted bucket | Test mode | Request signing against AWS's published example, and upload / download / delete against a fake bucket. AES-256-GCM encryption is tested directly. | Optional. The default is the database. See "Where document files are kept" in [DEPLOYMENT.md](../DEPLOYMENT.md). | Not yet | document-storage |
| **Border waiting times, market prices** | Used by the map, ROUTE and PULSE | Partial | Entry and use | Typed by hand. There is no free live source. | n/a | mail-api-traffic, map-market |

## In development

No integration is being built right now. Unfinished work, including trying every service above with a real account
(item **O-2**), is listed in one place: [GLOBAL_ROADMAP.md, Open items](GLOBAL_ROADMAP.md#open-items).

## Not connected

Veyra has **no live connection** to any of these. People type the data in, and the documents and screens are built around
that:

- ocean carriers and shipping lines (bookings, B/L, container tracking) and ports;
- airlines and air-cargo systems (AWB tracking);
- railways and rail operators;
- couriers and last-mile providers;
- warehouse management systems (WMS);
- temperature sensors and data loggers;
- customs systems, single windows and brokers;
- accounting systems (an invoice is a printable page);
- other transport or enterprise systems (TMS, ERP).

Tell customers this plainly. Do not describe any of the above as integrated.

## Real-service trial plan (roadmap item O-2)

Fake services prove that Veyra's own code does what it should; they do not prove the real service answers the same way.
Each trial below uses a **test or sandbox account and test data only**, on a staging copy (never production data or real
customers). Keys go only into the host's variables (Railway → Variables), never into chat, email or the code.
**Until a trial has a "Passed" row in the log below, the status stays "Test mode" and the integration must not be described
as ready.**

| Service | What you need first | Steps | Passed when |
|---|---|---|---|
| AI model (OpenRouter) | An OpenRouter account with a little credit; `OPENROUTER_API_KEY`; a model that reads images and PDFs (`OPENROUTER_MODEL`); a Growth or higher plan on the test company | 1. Paste three real-looking order emails into New Shipment → Read with AI. 2. Upload one clear CMR, one phone photo of a CMR, one B/L and one AWB (made-up data). 3. Look at Analytics → AI agents. | Every read field is either right or empty (never invented); differences become tasks; every call is logged with its cost |
| SMS / WhatsApp (Twilio) | A Twilio trial account, a verified test phone, `PUBLIC_URL`; for WhatsApp the Twilio sandbox | 1. Connect Twilio under Integrations. 2. Send a drafted message to the verified phone. 3. Turn the phone off and send again. | The message arrives; the status changes to delivered (and read on WhatsApp); the failed one shows "not delivered" and leaves a task |
| Email inbox (webhook) | A Postmark, Mailgun or SendGrid test domain pointing to the inbox address | 1. Send an order email with a PDF attached. 2. Send one naming a load number. 3. Send one from a sender not on the allow-list. | The order becomes a task; the file lands on the named load; the blocked sender is stored as blocked and never reaches the AI |
| Mailbox (IMAP) | A test mailbox with an app password | 1. Connect it. 2. Send two emails to it. 3. Wait for the next poll (`IMAP_POLL_MINUTES`). | Both emails appear once; nothing in the mailbox is marked read or changed |
| Gmail / Outlook (OAuth) | Your own Google Cloud and Microsoft Entra apps, the redirect address registered, `PUBLIC_URL` | 1. Connect a test Gmail and a test Outlook account. 2. Send an order email to each. 3. Disconnect. | The emails arrive as tasks; only a refresh token is stored; disconnecting stops the reading. (Google may ask for a security review before outside accounts can use the app.) |
| Map (Nominatim, OSRM) | `GEO_PROVIDER=osm`; for more than light use, your own servers | Open five loads on real lanes (e.g. Tashkent → Almaty). | Road distances are plausible; an off-route position gives a warning |
| Live traffic (TomTom) | A TomTom developer key, the map on | Put a load In Transit with a GPS position on a busy road. | A traffic delay is shown, and cached for 30 minutes per lane |
| GPS positions | A GPS provider (or Zapier / Make) that can post Veyra's JSON format, a company GPS token | Send positions for a test truck plate for one hour. | Positions land on the right load, at most one per `GPS_MIN_INTERVAL_MINUTES` |
| Card payments (Paddle) | A Paddle **sandbox** account, the price ids, client token, webhook secret | 1. Pay for a plan with a Paddle test card. 2. Switch plan. 3. Cancel. 4. Let a test payment fail. | The plan becomes Active within seconds; the switch and the cancel are reflected; a failed payment locks adding new loads |
| Document storage (Cloudflare R2) | A private bucket, a token for that bucket only, the six variables, the encryption key saved in a password manager | Follow "Setting up R2, step by step" in [DEPLOYMENT.md](../DEPLOYMENT.md), then run `npm run restore:drill` against a copy. | The start-up line says `documents: r2 encrypted`; the upload appears in the bucket encrypted; the download is the same file; the drill reads documents from R2 |

## Trial log

One row per trial. Change an integration's status in the tables above only after a "Passed" row for it exists here.

| Date | Service | Account (test or sandbox) | Result | Notes |
|---|---|---|---|---|
| 2026-11-23 | All outside services | none | Not run | The development environment blocks outside hosts (openrouter.ai, nominatim.openstreetmap.org and router.project-osrm.org were refused) and has no accounts or keys. This is not a result: every service stays in Test mode. |

## How to move an integration up a status

1. Run its trial above and add a row to the trial log.
2. Change its status only if the trial **passed** end to end; "Working" for an outside service needs a "Passed" row
   (`test/docs.test.js` checks this).
3. If it did not pass, leave it in Test mode and write down what failed.
4. Keep [README.md](../README.md), [USER_GUIDE.md](../USER_GUIDE.md) and [DEPLOYMENT.md](../DEPLOYMENT.md) consistent with this
   page: they point here instead of repeating statuses. When every service has passed, set roadmap item O-2 to Done.
