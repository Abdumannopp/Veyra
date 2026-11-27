# VEYRA — short guide for trucking companies

This guide needs no technical knowledge. It explains how to take one load in VEYRA from order to delivery, and how to use the newer features (legs, trips, temperature, warehouse, last mile, customs).

**Good to know first:** you type the prices, numbers and transport details yourself; positions too, unless a GPS provider is connected (Growth plan and up). Order emails and their attachments can arrive by themselves if an email service is connected, but a person always presses Create load. VEYRA is not connected to shipping lines, airlines, railways, couriers, customs or temperature sensors. Which outside services (AI, SMS, email, maps, card payments) are connected, and how far they have been tested, is in `docs/INTEGRATIONS.md`. The list of all documents is in `docs/INDEX.md`.

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
- `DATABASE_URL`: use PostgreSQL (recommended for a live server); without it VEYRA keeps its data in one SQLite file (`DATABASE_PATH`). See `docs/DATABASE.md`.
- `DOCUMENT_STORAGE`: where uploaded document files are kept: the database (the default) or Cloudflare R2. See `DEPLOYMENT.md`, "Where document files are kept".

Details: `DEPLOYMENT.md`.

## AI helpers (agents)

| Agent | What it does | What it needs |
|---|---|---|
| **FLOW** | Paste a customer's message (email, WhatsApp) into "New Shipment" and press **Read with AI**: the form fills itself. Missing fields are marked yellow, with a suggested question for the customer. You still press **Create** yourself. | Google Gemini key |
| **SCOUT** | In the Dispatch window it shows the 3 best-fitting carriers: does the trailer fit, how often they delivered this lane, any past problems. It also suggests the usual rate for the lane. One click fills the form. | Nothing (free) |
| **RELAY** | In the load window, "Messages": ready-made text for the driver, carrier or customer, filled from the load. Edit it and press **Send** (SMS/WhatsApp) or **Copy text** and send it from your own phone. | Twilio for automatic sending |
| **NEXUS** | **Starts the other agents by itself** and leaves the result as a **task** (left menu **Inbox & tasks**). Example: an email arrives, FLOW reads it, you get a "New order" task. A load reaches Sourcing, SCOUT picks carriers, you get a "Book a carrier" task. A truck is booked, message drafts for driver, carrier and customer are ready. A truck is silent for 12 hours, a "Where are you?" draft is ready. | Nothing |
| **VAULT** | In the load window, **Documents**: upload a CMR or POD (photo or PDF); AI reads it and compares it with the load: weight, plate, loading and unloading place, customer, date. It also reads a **bill of lading, air waybill or rail note** and compares it with the sea, air or rail leg (number, vessel or flight, places, container or wagon numbers, pieces, weight). A mismatch creates a task. Nothing is changed for you. | Google Gemini key |
| **Email inbox** | A customer emails you, VEYRA receives it, FLOW reads it, and you see a ready order in **Inbox & tasks** and press **Create load**. | An email service (below) |
| **GPS** | Your GPS provider sends truck positions; VEYRA links them to the load by truck plate. There is also a link to open the position on a map. | A GPS provider |

**The most important rule (about NEXUS):** NEXUS only **prepares**. It never sends a message, books a truck, creates a load or changes a status by itself. For every outward action you press the button ("Approve & send", "Create load", "Dispatch"). This is deliberate: AI gets no freedom where a mistake is expensive.

Every AI request is recorded: **Analytics → AI agents** shows how many requests were made and how many tokens were used (your AI provider charges by this). Cost control: each company has a limit of AI requests a day (300 by default, screens and automatic work together) and each person a limit per hour (60). After that the screen says so and emails and documents simply become plain tasks.

**AI data sharing (must be switched on once):** the AI helpers send the order text or document to the outside provider Google (Gemini). If the server changes provider, an administrator must allow sharing again. Nothing is sent until an administrator allows it in **Team & settings → AI data sharing**. It can be switched off any time; who changed it and when is in the activity log. Passwords and keys found in typed or emailed **text** are removed before sending. **Document files (PDF, photos) are sent as they are**: anything on the paper reaches the provider.

**When AI leaves a field empty:** a number that can be read two ways (`1,250`: one thousand or one and a quarter?), a weight with no unit, or a date that does not exist is never guessed: the field stays empty with a note "check by hand". A message longer than 4000 characters is not read at all (never half-read): fill the form yourself. Rules: [docs/AI.md](docs/AI.md).

The **Quick Shipment Draft** card on the dashboard just copies your latest load into a new draft; it does not use AI.

## How to get the keys (one-time work)

I cannot get these keys for you: they are accounts opened in your name. Once you have them, give them to whoever installs the server or put them in the `.env` file.

1. **AI (FLOW, VAULT): Google Gemini**
   - Sign in at aistudio.google.com with a Google account and create an API key (set up billing for real use).
   - Set `GEMINI_API_KEY=` in the server settings. Nothing else is needed: the model is `gemini-2.5-flash-lite`, which
     reads text, PDFs and photos.
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
- Choose the type when you upload: CMR, proof of delivery, bill of lading, air waybill, rail note (CIM/SMGS) or other. A bill of lading, air waybill or rail note is filed under the matching leg of the load.
- **Where the files are kept** is decided by whoever installs the server, and you do not see the difference. By default they are inside the database, so the database **backup** covers them. The installer can instead keep them in an encrypted Cloudflare R2 bucket; then the bucket needs its own backup (see `DEPLOYMENT.md`, "Where document files are kept"). Ask your administrator which one is used.
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
- **Backups.** With the default SQLite file, a copy of the whole database is made every day and the last 7 are kept (with PostgreSQL, the database provider makes the copies, and document files kept in R2 need the bucket's own backup). **Important:** these copies sit on the server disk, so if the disk is lost they are lost too. Download them now and then with "Dashboard → Backups → Download" and keep them elsewhere (computer, cloud). Only the platform owner can do this, because the file holds every company's data.
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

## Multi-leg orders (road, sea, air, rail, warehouse, last mile)

One customer order can travel in several legs. On **Shipments**, press **+ Multi-leg order**: enter the customer and the whole route, then add the legs in order (for example Road → Ocean → Last mile) with a price and a booking number for each if you have them.

Open the load and look at **Route legs**:
- **Edit** a leg to add the carrier, reference (booking, bill of lading, air waybill, CMR), dates and the details of that mode (truck plate, vessel and container, flight, train and wagon, warehouse, courier).
- **Book** a leg once it has a carrier or a reference. **Start** it when it leaves. **Add position** to note where it is. **Delivered** closes the leg and records the **handover** to the next one (where, who received it). **Report problem** marks an exception; **Resume** continues. **Cancel leg** drops one that is no longer needed.
- A leg cannot start before the leg before it is delivered.
- The load's own status and total price follow its legs. The total price is shown only when every leg that is still going has a price.
- An ordinary single-truck load is one road leg. Before its truck is booked you can press **Split into legs** to add more.
- On a multi-leg load, use the legs for status and location; the usual "Move to" and "Dispatch" buttons are hidden.

- **Mark paid** on a delivered leg (or in **Billing → Carriers owed per leg**) records that its carrier was paid. Each leg's carrier is owed for its own leg.
- NEXUS helps per leg: it drafts the booking message to a leg's carrier, raises a task when a leg has a problem, reminds you which leg is next after a handover, and asks for a position when a leg on the way has been quiet. You still press Send yourself.

You enter all prices, numbers and positions yourself: Veyra is not connected to shipping lines, airlines or rail operators.

## Trips: one truck, several loads (LTL)

Use **Trips** when one truck carries part loads for several customers.

1. **+ New trip**: enter where it goes, the carrier, the truck price, and how much the truck takes (weight and pallet places).
2. Open the trip and **Put a load on this trip**: only loads that still wait for a truck appear. A load that does not fit the truck is refused with the reason.
3. **Book the truck**: every load gets the carrier, truck and driver, and becomes *Dispatched*. The truck price is shared among the loads **by weight**, so each load shows its **cost share**; margins and Finance then work load by load.
4. **Start** when the truck leaves. **Add position** gives one position for every load on the truck. **Report problem** / **Resume** for trouble on the road.
5. When a customer receives their goods press **Delivered** on that load. When the last load is delivered the trip is complete and the carrier is free.
- Before the truck leaves you can **Take off** a load (it waits for a truck again), add another, or **Take back to planned** / **Cancel trip**.
- A load on a trip is marked *Trip T-n* in Shipments; its status, truck and position follow the trip, so the usual "Move to" and "Dispatch" controls are hidden for it.
- The carrier is owed each load's cost share, and you mark them paid load by load in Billing.
- **Loads that can share one truck**: at the top of Trips (and as a task in Inbox & tasks) Veyra suggests loads on the same lane with pickups within a few days that fit one truck. Press **Plan this trip**, then choose the carrier and the price and book it.
- When you book a trip, Veyra drafts one message to the carrier with every load listed, one to the driver with the stops, and one to each customer. You read and press Send yourself. If a trip goes quiet or has a problem you get one task for the whole truck.

## Sea, air and rail legs: what to enter

When you **Edit** a leg, the fields depend on its mode. VEYRA checks the numbers and refuses a wrong one with the reason (spaces and dashes are removed for you):

- **Ocean:** shipping line, booking no., vessel, voyage, **container no.** (4 letters and 7 digits, with the check digit, for example `CSQU3054383`), container type (for example 40HC, 20RF), seal no., bill of lading, port of loading, port of discharge.
- **Air:** airline, flight (for example `TK 1234`), **air waybill** (11 digits, for example `235-12345675`), airports as 3-letter codes (`TAS`, `IST`), pieces, gross weight (kg) and volume (m³). VEYRA works out the **chargeable weight** (the larger of the gross weight and the volume weight, rounded up to 0.5 kg) and shows it.
- **Rail:** train no., **wagon no.** (8 or 12 digits with the check digit), consignment note type (CIM, SMGS or CIM/SMGS) and number, terminals, border station.

These are format checks only: VEYRA does not look the numbers up anywhere.

## Late legs

On a multi-leg load, a leg that is late shows a red line, for example "Late: 51.3 h past the planned delivery". It means one of these: the planned pickup passed and the leg has not started; the planned delivery passed; the latest ETA is after the planned delivery; or the leg before will arrive after this leg's pickup (the handover is at risk). A difference of up to one hour is ignored, and a date with no time counts as the end of that day. NEXUS leaves one task per delay in **Inbox & tasks**; the task closes by itself when the leg is on time again, delivered or cancelled. It all depends on the dates and ETAs you enter.

## Temperature (cold chain)

In the load window, the **Temperature** section is for loads that must stay in a range (fruit, medicine, frozen goods).
1. **Set range:** the lowest and highest allowed temperature in °C (Operations or Admin).
2. **Add reading** each time you learn the temperature (for example when the driver reports it). Everyone who may log positions can add readings. Readings are typed by people: no sensor is connected.
3. A reading outside the range turns red, and the section says "Now too warm / too cold". NEXUS leaves **one task per stretch** outside the range, not one per reading. When the temperature comes back and goes out again, that is a new task.

## Warehouse legs

A **warehouse leg** receives goods, stores them and hands them to the next leg (Operations or Admin).
1. Book the warehouse leg. Press **Receive goods**: pieces expected, pieces received, damaged pieces, free storage days, the price per day (optional) and a note. The leg is now "in storage" and shows the days stored and the storage charge. Storage is charged per started day after the free days.
2. If pieces are missing, extra or damaged, NEXUS leaves a task. If the goods stay longer than the free days, you get a task too ("charges are running"); it closes when you release the goods.
3. Press **Release goods** (the number of pieces released starts at the good pieces). The leg is delivered and handed over to the next leg.

## Last mile: stops and proof of delivery

A **last-mile leg** can have many stops (Operations or Admin).
1. **Add stop:** address, receiver, phone, pieces and a deliver-by time (in UTC).
2. When the leg is **In Transit**, each stop has **Delivered** and **Not delivered**.
   - **Delivered:** enter **who received it** (required) and a note. To attach the signed paper or a photo, first upload it in the load's **Documents**, then pick it in the list ("Proof of delivery file").
   - **Not delivered:** enter the reason. NEXUS leaves a task. Press **Try again** to make the stop pending again.
3. A pending stop can be **Removed**. When **every stop is delivered**, the leg is completed by itself and handed over to the next leg.
4. A stop whose deliver-by time passed more than an hour ago gets a task; it closes when the stop is delivered.

## Customs and dangerous goods

In the load window, **Customs & dangerous goods** holds what the border and special cargo need (Operations or Admin can save it):
- **Customs:** goods description, HS code (6 to 10 digits), the two country codes (for example `UZ`, `TR`), declared value, Incoterm, customs status (not started, documents requested, declared, held, cleared) and the declaration number once declared.
- **Dangerous goods:** tick the box, then the UN number (`UN1263`), class, packing group and the proper shipping name.
- VEYRA shows **warnings** (never decisions): for example dangerous goods on an air leg (check the airline accepts them), on a sea leg or on a road leg (driver training, plates), or a border crossing with no HS code, value or Incoterm. If customs **hold** the goods, NEXUS leaves a task until the status changes.
- **Important:** these are format checks and reminders only. They are **not legal or dangerous-goods advice**, and no customs system is connected. Your customs broker and dangerous-goods adviser decide.

## Keeping old data (administrators)

In **Team & settings → Keeping old data** an administrator chooses how many days VEYRA keeps: positions, messages and files of **finished** loads (at least 30, 30 and 90 days), done NEXUS tasks (30) and the activity log (365). **An empty box keeps that kind of data for ever; everything starts empty.**
- **Save** removes nothing. Beside each box you see how many items a removal would take now.
- **Remove now** asks you to confirm, then removes them for good. You can also tick **Remove automatically once a day**.
- **Never removed:** the loads themselves, money, status history, legs and trips. Tasks you dismissed stay, so their warning does not come back. Files kept in R2 are deleted from R2 too.
- Removal cannot be undone, so keep regular backups.

## Not available yet

- **No live connections** to shipping lines, airlines, railways, ports, couriers, customs, warehouse systems or temperature sensors. You type the data; the screens and checks are built around that.
- Live border queues (no free open source; entered by hand for now).
- Automatic market prices from the internet (entered by hand).
- **Not yet tried with the real services:** the AI model, SMS / WhatsApp, email, Gmail / Outlook, the map, traffic, card payments and Cloudflare R2 were only checked with fake responses. At the first connection, use a test account and check the result yourself. The current status of each one is in `docs/INTEGRATIONS.md`.
- Security review status: see `docs/SECURITY.md`.

## Plans and pricing

The public price list is at `/pricing` (no sign-in needed). There are four plans:

| Plan | Price | Users | Shipments / month | Adds |
|---|---|---|---|---|
| Starter | $99 / month | 3 | 100 | Shipments, multi-leg orders, trips, carriers, tracking with positions you enter, quotes, analytics, and the rule-based helpers (SCOUT, ROUTE, PULSE, SENTINEL: no AI model) |
| Growth | $249 / month | 10 | 500 | AI agents (FLOW, VAULT), GPS, email automation, WhatsApp / SMS |
| Scale | $599 / month | 25 | 2,000 | Automation Studio workflows |
| Enterprise | from $1,499 / month | 50+ | 5,000+ | Everything in Scale; user and shipment limits set per company |

Yearly billing costs 10 months (shown as "Save 17%").

The AI agents that use a language model (FLOW reading orders, VAULT reading documents, and NEXUS when it reads an email) need **Growth or higher**; on Starter those buttons answer with a message naming the plan. The "Veyra AI" card on the dashboard (it proposes a draft load from your latest one), the "Read with AI" panel in New Shipment, the AI button on documents, the AI row in Integrations and the two AI automations are shown only on Growth and higher. On Starter you do not see them, and the server would refuse them anyway. If you upgrade while VEYRA is open, they appear as soon as the plan change reaches the page (open Billing or reload).

- **New companies** start a 14-day free trial of the plan chosen in **Companies → Add company**.
- **Paying by card (Paddle):** a company administrator opens **Billing → Pay by card**, picks Monthly or Yearly and a plan, and pays in Paddle's secure window. The plan becomes Active by itself a few seconds later. Later, "Switch to …" changes the plan and "Invoices, card and cancel" opens Paddle's own page. Setup: see "Card payments (Paddle Billing)" in `DEPLOYMENT.md`.
- **The platform owner** can still change a company's plan and status by hand in **Team & settings → Companies** (Trial, Active, Payment overdue, Cancelled, or +14 trial days), for example for Enterprise customers who pay by bank transfer.
- **When a trial ends, a payment is overdue or a plan is cancelled**, everything stays readable, but no new loads or people can be added until the plan is active again.
- **Limits:** a company cannot add more people than its plan allows (disabled people do not count) or more loads in a calendar month. Features outside the plan answer with a short message naming the plan that includes them.
- **Billing page:** each company sees its plan, trial days left, how much of its limits it has used and what the plan includes.
- Set `SALES_EMAIL` on the server so "Start free trial", "Contact sales" and "Change plan" open an email to you.

## Self sign-up

When card payment (Paddle) is set up, new customers do everything themselves:

1. On `/pricing` they press **Start free trial** under a plan (Starter, Growth or Scale).
2. On `/signup` they enter the company name, their name, email and password. Their company is created with them as its administrator, on a 14-day trial of that plan, and they are signed in.
3. Veyra opens Paddle's checkout for the plan they chose. After payment the plan becomes **Active** and the company works with exactly that plan's limits and features.

Each signed-up company is separate and sees only its own data. Enterprise is still arranged with sales. Set `COMPANY_SIGNUP=false` to close sign-up, or `true` to open it without card payment (trial only).

## Selling worldwide

- **Legal pages:** `/terms`, `/privacy` and `/refunds` are public and linked from every page footer. Fill in `LEGAL_ENTITY`, `LEGAL_ADDRESS`, `LEGAL_COUNTRY` and `LEGAL_EMAIL` on the server, set `REFUND_DAYS`, and have a lawyer review the texts for your country before selling. Paddle checks these pages when it approves your website.
- **Consent:** new companies must tick "I accept the Terms of Service and the Privacy Policy" at sign-up; the accepted version and time are saved.
- **Currency and weight unit per company:** chosen at sign-up (guessed from the browser's country) and changed by an administrator in **Team & settings → Company**. New loads, quotes, invoices and prices use them. Amounts already saved are not converted.
- **Company data download:** administrators press **Download company data** in Team & settings to get everything the company owns as one file (no passwords or keys). Deletion requests are handled by email, as the Privacy Policy says.
