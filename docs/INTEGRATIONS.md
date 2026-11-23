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

| Integration | What it does | Status | What the tests cover | Set-up and limits | Last tried with the real service |
|---|---|---|---|---|---|
| **AI model** (OpenRouter): FLOW reads order emails, VAULT reads CMR / POD / B/L / AWB / rail notes | Turns text and document images into fields; plain code then checks them | Test mode | The gateway, its limits and logging, validation of the model's answer, and every comparison rule, all with a fake model | `OPENROUTER_API_KEY` and a model that can read images / PDFs. How well it reads real, messy documents is **unknown**: check the first ones yourself. Per-company daily cap applies. | Not yet |
| **SMS / WhatsApp** (Twilio): RELAY sending and delivery reports | Sends drafted messages after a person approves; shows sent / delivered / read / failed | Test mode | Sending, per-company accounts, encrypted tokens and the signature check on delivery reports, with a fake Twilio | Twilio account; for WhatsApp an approved sender. `PUBLIC_URL` for delivery reports. Numbers in international format. | Not yet |
| **Email inbox (webhook)**: Postmark, Mailgun, SendGrid Inbound Parse, Zapier / Make | Receives incoming mail, keeps attachments, FLOW reads it | Test mode | Parsing of each provider's format and of generic JSON from sample payloads; sender allow-list, duplicates, caps | The address contains a secret; treat it like a password. | Not yet |
| **Mailbox over IMAP** | Reads an order mailbox (read-only) | Test mode | Against a fake local IMAP server | TLS only; private-network servers refused unless `IMAP_ALLOW_PRIVATE=true`. Gmail / Outlook need an app password. | Not yet |
| **Gmail / Outlook sign-in** (OAuth APIs) | Reads mail without an app password | Test mode | OAuth flow and mail reading with fake Google / Microsoft services | Needs your own Google / Microsoft apps. **Google asks for a security review** before apps that read mail can be used by outside accounts. | Not yet |
| **Map** (Nominatim, OSRM) | Road distance and off-route warnings | Test mode | With a fake map service | `GEO_PROVIDER=osm`. The public servers are for light use only; place names of loads are sent to them. | Not yet |
| **Live traffic** (TomTom) | Delays for trucks on the road | Test mode | With a fake traffic service | `TRAFFIC_PROVIDER=tomtom`, `TOMTOM_API_KEY`. | Not yet |
| **GPS positions (TRACE)** | Receives positions from a GPS provider and matches them to loads by truck plate | Partial | The receiving address, token, plate matching and rate limits, with simulated posts | Veyra accepts **its own JSON format** only. The provider (or Zapier / Make) must be able to post it. No provider-specific adapter exists. | Not yet |
| **Card payments** (Paddle) | Plans, checkout, invoices, plan changes, portal | Test mode | Signed webhooks, ordering, tampering, plan switching and the portal, with a fake Paddle API | Start in Paddle's **sandbox**; Paddle must approve your website before live use. | Not yet |
| **Document storage** (Cloudflare R2) | Keeps document files in an encrypted bucket | Test mode | Request signing against AWS's published example, and upload / download / delete against a fake bucket. AES-256-GCM encryption is tested directly. | Optional. The default is the database. See "Where document files are kept" in [DEPLOYMENT.md](../DEPLOYMENT.md). | Not yet |
| **Border waiting times, market prices** | Used by the map, ROUTE and PULSE | Partial | Entry and use | Typed by hand. There is no free live source. | n/a |

## In development

Nothing is being built right now. The one open item on the roadmap is the independent security review
([SECURITY.md](SECURITY.md), step 6.4), which needs an outside reviewer.

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

## How to move an integration up a status

1. Try it with a **test or sandbox account** of the real service, with non-sensitive data.
2. Write down what you did, the date and the result in the table above, and change the status only if it really worked
   end to end (for example "Partial" or "Working" after a successful live message, mail or payment).
3. If it did not work, open an issue and leave it in Test mode.
4. Keep [README.md](../README.md), [USER_GUIDE.md](../USER_GUIDE.md) and [DEPLOYMENT.md](../DEPLOYMENT.md) consistent with this
   page: they point here instead of repeating statuses.
