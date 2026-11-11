# VEYRA — short guide for trucking companies

This guide needs no technical knowledge. It explains how to take one load in VEYRA from order to delivery.

## Roles

| Role | Who | What they can do |
|---|---|---|
| **Admin** | The owner or manager | Everything, plus add staff, change roles, block users |
| **Operations** | Operations manager | Create loads, change status, book a carrier (dispatch), analytics |
| **Operator** | Dispatcher | Create loads, log where the truck is, view lists |

## The life of one load

1. **An order arrives.** Press "New Shipment" and enter the customer, origin, destination, dates, weight (kg) and equipment. You can also enter the price the customer pays (optional).
2. **Find a carrier.** Move the load to **Sourcing**.
3. **Book the truck (Dispatch).** Choose the carrier and enter:
   - the rate paid to the carrier;
   - the rate the customer pays: **the margin (profit) shows at once**; if the load loses money, the system warns you;
   - the truck plate, driver name and driver phone.
4. **On the road.** Open the load (click its ID) and use **"Where is the truck now?"** to enter the location (for example "Shymkent" or "border"), the expected arrival time (ETA) and a note. Log it every time you call the driver.
   - Trucks with no update for 12 hours are flagged by a notification.
5. **Delivered.** Move the status from **In Transit** to **Delivered**. The carrier becomes Available again automatically.
   - If something goes wrong: **Exception**.
   - If a booked truck is cancelled before pickup: Dispatched → **Cancelled**.

## Adding staff

On a live server nobody can sign themselves up. The admin adds staff: **Dashboard → Operations Console → Team Access → Add user**. Give the starting password to the person in private. When someone leaves, **Disable** removes their access immediately.

## Settings (for whoever installs the server)

In the `.env` file:

- `WEIGHT_UNIT=kg`: weight unit (`kg` or `lb`);
- `CURRENCY=USD`: currency (USD, EUR, KZT, UZS …);
- `MAX_RATE=10000000`: largest allowed price; raise it for currencies with big numbers;
- `INITIAL_ADMIN_NAME`, `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_PASSWORD`: the first admin (password of at least 12 characters).

Details: `DEPLOYMENT.md`.

## AI helpers (agents)

| Agent | What it does | What it needs |
|---|---|---|
| **FLOW** | Paste a customer's message (email, WhatsApp) into "New Shipment" and press **Read with AI**: the form fills itself. Missing fields are marked yellow, with a suggested question for the customer. You still press **Create** yourself. | OpenRouter key |
| **SCOUT** | In the Dispatch window it shows the 3 best-fitting carriers: does the trailer fit, how often they delivered this lane, any past problems. It also suggests the usual rate for the lane. One click fills the form. | Nothing (free) |
| **RELAY** | In the load window, "Messages": ready-made text for the driver, carrier or customer, filled from the load. Edit it and press **Send** (SMS/WhatsApp) or **Copy text** and send it from your own phone. | Twilio for automatic sending |
| **NEXUS** | **Starts the other agents by itself** and leaves the result as a **task** (left menu **Inbox & tasks**). Example: an email arrives, FLOW reads it, you get a "New order" task. A load reaches Sourcing, SCOUT picks carriers, you get a "Book a carrier" task. A truck is booked, message drafts for driver, carrier and customer are ready. A truck is silent for 12 hours, a "Where are you?" draft is ready. | Nothing |
| **VAULT** | In the load window, **Documents**: upload a CMR or POD (photo or PDF); AI reads it and compares it with the load: weight, plate, loading and unloading place, customer, date. A mismatch creates a task. Nothing is changed for you. | OpenRouter key and a model that can read images/PDFs |
| **Email inbox** | A customer emails you, VEYRA receives it, FLOW reads it, and you see a ready order in **Inbox & tasks** and press **Create load**. | An email service (below) |
| **GPS** | Your GPS provider sends truck positions; VEYRA links them to the load by truck plate. There is also a link to open the position on a map. | A GPS provider |

**The most important rule (about NEXUS):** NEXUS only **prepares**. It never sends a message, books a truck, creates a load or changes a status by itself. For every outward action you press the button ("Approve & send", "Create load", "Dispatch"). This is deliberate: AI gets no freedom where a mistake is expensive.

Every AI request is recorded: **Analytics → AI agents** shows how many requests were made and how many tokens were used (your AI provider charges by this). Cost control: each company has a limit of 300 automatic AI requests a day; after that, emails and documents are not read and simply become plain tasks.

## How to get the keys (one-time work)

I cannot get these keys for you: they are accounts opened in your name. Once you have them, give them to whoever installs the server or put them in the `.env` file.

1. **AI (FLOW, VAULT): OpenRouter**
   - Sign up at openrouter.ai and add credit (a small amount is enough to start).
   - Create a key under "Keys" and set `OPENROUTER_API_KEY=`.
   - For FLOW you do not need to choose a model: if left empty, your account's default model is used.
   - **To read CMRs** you need a model that can read images or PDFs. If the default cannot, the document says "could not be read". Then set `OPENROUTER_MODEL=` to an image-capable model from openrouter.ai/models.
2. **SMS / WhatsApp: Twilio (each company uses its own account)**
   - Open an account at twilio.com and note the "Account SID" and "Auth Token".
   - Buy a number for SMS. For WhatsApp, get a WhatsApp sender approved through Twilio (Meta approval is needed and can take a few days).
   - Dashboard → Integrations → **Connect Twilio** → enter the details. VEYRA first **checks** them with Twilio, then stores them **encrypted** and never shows them again.
   - Important: another company **cannot use** your Twilio account. Every customer company connects its own account and pays for its own messages.
   - Write phone numbers in international format: **+1 555 123 4567**.
   - Set `SECRETS_KEY` (a long random string) on the server and **keep it**: if it changes, saved Twilio details become unreadable and must be entered again.
3. **Email (receive orders automatically)**
   - Dashboard → Integrations → **Email inbox → Create address**. The address shown (only once) is a web address, not a mailbox.
   - Give it to an email service: **Postmark** (inbound), **Mailgun** (route → "forward to URL") or **Zapier / Make** (new email → webhook POST). Then set up the address your customers write to in that service, or forward orders from your own mailbox to it.
   - Fill in **Allowed senders** (for example `customer.com, boss@partner.com`): other senders are not read and do not spend AI money.
4. **GPS**
   - Dashboard → Integrations → **Create GPS token**. Give the address and key to your GPS provider (the key is shown only once).
   - The provider sends a plate, latitude (lat) and longitude (lng) for each truck. The plate must match the one entered at dispatch (spaces and dashes do not matter).

## Several companies

You (the first administrator) are the **platform owner**. Use Dashboard → **Companies → Add company** to add a new customer company and its administrator. Each company sees only its own loads, carriers, staff, documents, emails, tasks and Twilio account. A company administrator adds their own team.

## Many loads

The Shipments page shows 50 per page ("Next →"). Search and filters work across all loads. CSV export downloads everything.

## Working with documents

- Accepted: PDF, JPG, PNG, WebP (up to 8 MB). The file type is checked by its real content, not its name; other files are rejected.
- Files are stored inside the database, so a **backup** covers them too. Do not forget to set up backups.
- After a document is read it shows "match" or "differs". "Differs" is only a warning: compare the paper with the load yourself and correct it if needed. The record does not change by itself.

## Files in emails, message status and three more agents

- **Files attached to an email (CMR).** If the subject or text contains a load number (for example `SHP-12`) or the load's own reference, the file is added to that load's documents and VAULT reads it. Without a load number, the file waits with the email in "Inbox & tasks": use "Attach files to a load" to pick the load, or create a new load from the email and the file goes with it. Only PDF, JPG, PNG and WebP are accepted; at most 5 files per email; small signature logos are ignored. Files from senders that are not allowed are not stored.
- **SendGrid and Mailgun.** Emails with attachments are now received directly (SendGrid Inbound Parse, Mailgun, Postmark, Zapier/Make).
- **Message status.** The message list in the load window shows "sent ✓", "delivered ✓✓", "read ✓✓" or "not delivered". "Read" exists only on WhatsApp and only if the recipient has read receipts on. If a message does not arrive, a "call them" task appears. For this the server must know its public address: on Render and Railway this works automatically; elsewhere set `PUBLIC_URL=https://your-address`.
- **ROUTE (trip planning).** In the load window: how many hours this lane took before, whether the promised date is realistic, roughly when the truck will arrive, and trucks that will soon be free near the loading city (for a return load).
- **PULSE (price).** In the load window and the Dispatch window: what is usually paid on this lane, a suggested customer price, and a warning if the price differs from the usual by more than 30% or the load loses money.
- **SENTINEL (risk).** At the top of "Inbox & tasks": no truck found and pickup is today or tomorrow; pickup day passed and the truck has not left; delivery day passed; the driver's ETA is later than the promise; driver phone or truck plate missing; truck silent; message not delivered. When the risk goes away, the task closes by itself.

ROUTE, PULSE and SENTINEL work without an AI key: they only look at the history of your own loads. So until a lane has at least 3 delivered loads, ROUTE and PULSE say "not enough data".

## Reading a mailbox, the map and market prices

- **Mailbox (IMAP).** Under "Integrations → Order mailbox" enter the mail server (for example `imap.gmail.com`), user name and password. For Gmail and Outlook an "app password" is needed, not your normal password. VEYRA signs in to check before connecting; the password is stored encrypted and never shown. It then reads new emails every 5 minutes, as if they had arrived at the inbox address (a CMR is added to its load, an order becomes a task). Emails from before connecting are not imported; nothing in the mailbox is changed or marked as read. Private (internal) network addresses are refused for safety.
- **Changing a file type.** A document card has a type list: if the guess is wrong, pick the right one; for CMR/POD it is read again.
- **Map (distance, off-route).** OFF by default, because load city names are sent to OpenStreetMap services. To turn it on set `GEO_PROVIDER=osm` on the server. ROUTE then shows road distance and driving time in the load window (and estimates from them when there is no history), and SENTINEL warns when a truck with GPS is more than 60 km (`OFF_ROUTE_KM`) from its route. The public services are for light use; each lane is requested once and then saved.
- **Market prices.** Under "Integrations → Market prices" enter prices from your broker or load board by hand (one per line: `Origin; Destination; Equipment (optional); Price`). PULSE shows them next to your own history and warns if a price is more than 30% above the market.

## Gmail/Outlook sign-in, traffic and border waits

- **Gmail / Outlook (no IMAP, no app password).** Under "Integrations → Order mailbox" there are "Connect Gmail" and "Connect Outlook" buttons. Pressing one opens the Google or Microsoft window, you grant access and come back. VEYRA never sees your password: only "read only" access and an encrypted long-lived key are stored. Emails are only read (not deleted, not marked); emails from before connecting are not imported.
  **Important:** for these buttons to work, the VEYRA owner (you) must register an "app" once with Google Cloud and Microsoft Entra and put `GOOGLE_CLIENT_ID`/`SECRET` and `MICROSOFT_CLIENT_ID`/`SECRET` on the server (steps are in `DEPLOYMENT.md`). Google reviews apps that read other companies' mail, which takes time. Until then IMAP works. Without a key the button is disabled and says why.
- **Traffic on the road.** Needs `TRAFFIC_PROVIDER=tomtom` and a TomTom key (the map must be on too). It is shown only for trucks that are on the road ("Traffic now: 90 min of delay") and cached for 30 minutes. For a trip a week away today's traffic is not used, since it says nothing about then.
- **Border waits.** There is no free open source for live border queues, so under "Integrations → Border waiting times" you enter the usual wait in hours per border yourself (`UZ; KZ; 6`). Place names must end with the country code ("Tashkent, UZ"). ROUTE adds this wait only when you have no history on the lane yet (trips in your history already include it).

## Password, editing a load, payments, customer link, backups, activity log

- **Password.** The "Password" button at the top lets anyone change their own password (other devices are signed out). If a staff member forgets theirs, the administrator sets a new one with "Team Access → New password". There is no "forgot password" email: if the only administrator forgets their password there is no way to recover it, so keep it somewhere safe.
- **Editing a load.** In the load window "Edit load": correct dates, weight, price, address, driver and so on. Every change is written to the load history (what changed, from what to what). A delivered or cancelled load cannot be edited.
- **Payments.** The load window has an invoice number and three marks: "Invoice sent", "Customer paid", "Carrier paid". "Open invoice" opens a printable invoice (in the browser: Print → Save as PDF). "Analytics → Open money" shows what customers owe you and what you owe carriers. Only the admin and operations roles see this.
- **Customer link.** In the load window "Customer tracking link": send the link to the customer; they open it without a password and see only where the load is (no price, phone or carrier name). A new link replaces the old one; "Remove link" deletes it completely.
- **Backups.** A copy of the whole database is made every day and the last 7 are kept. **Important:** these copies sit on the server disk, so if the disk is lost they are lost too. Download them now and then with "Dashboard → Backups → Download" and keep them elsewhere (computer, cloud). Only the platform owner can do this, because the file holds every company's data.
- **Activity log.** The administrator sees in "Activity log" who changed accounts, passwords, settings, payments, customer links and backups.

## Quotes & Pricing

"Quotes" in the side menu. To give a customer a price before there is a load:

1. Enter the lane, equipment and weight and press "Check price". PULSE shows a suggested price, the usual carrier cost and the margin from your own loads on that lane and the market prices you entered (at least 3 loads are needed).
2. Enter the customer name, price and validity and press "Save quote": the quote is saved as a draft (Q-1, Q-2 …).
3. "Print" opens a printable quote for the customer (can be saved as PDF). It does not show the carrier cost or the margin.
4. "Mark sent" when sent; when the customer agrees, "Won → create load" creates a load from the quote (its price becomes the customer rate); if they decline, "Lost". A quote past its validity shows as "Expired" by itself.

## AI Command Center

"AI Command Center" in the side menu. One page shows:

- **AI agents**: the eight agents and whether each is on.
- **Veyra AI**: quick buttons: Plan (route), Price (quote), Read (read an order), Approve (approve work), Watch (loads at risk), Analyze (analytics).
- **Live operations**: trucks on the road right now, loads waiting for a truck, work waiting for approval and loads at risk.
- **Automations**: switch on or off what the agents do by themselves (administrator only): reading order emails, booking messages, the "delivered" message, reading documents, price check, asking silent trucks, risk warnings. When one is off, the agent stops preparing that work. Every change is written to the log. Agents never send a message or book a truck by themselves; that is always a person.
- **AI performance**: work prepared in 30 days, the share reviewed by people, average time to review, AI calls.
- **Recent AI activity**: the latest prepared work.

## Global Tracking

**Tracking** in the left menu. The page shows every load on the road:

- at the top: active loads, share arriving on time, loads in transit and problem loads;
- on the map: cities, lanes and trucks (when GPS data has arrived);
- click a load: its steps, driver, truck plate and warnings appear; "Call driver" phones the driver;
- below: the list of all loads and active alerts.

For the map to know city positions, `GEO_PROVIDER=osm` must be set in `.env`. The page refreshes itself every 2 minutes.

## Automation Studio (your own rules)

**Automation Studio** in the left menu. Build a rule without code: "when this happens to a load, prepare the next step".

- **1. When:** a new load is created, a load changes status (for example Exception or Delivered), a truck is booked or a document is uploaded.
- **2. Only if (optional):** customer, origin, destination or equipment contains a word (for example destination = "RU").
- **3. Then:** create a task, or draft a message to the customer, carrier or driver. In a task title, `{id}`, `{customer}`, `{origin}`, `{destination}` and `{status}` become the load's values.
- **Run test:** enter a load number (for example SHP-12) and see whether the rule matches it. A test creates nothing.
- **Templates:** ready-made rules, added with one click and editable.
- **Runs & history:** when each rule ran, on which load, and the result.

Rules only prepare: sending a message and booking a truck still happen with a person's button. Only an administrator can change a rule.

## Not available yet

- Live border queues (no free open source; entered by hand for now).
- Automatic market prices from the internet (entered by hand).
- Gmail/Outlook, traffic and the map have not been tried with the real services yet: they were only checked with fake responses. At the first connection, check the result yourself.
