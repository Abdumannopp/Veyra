# API v2: shipments made of legs

A **shipment** is the customer's order. It moves in one or more **legs**, each by its own mode:
`ROAD`, `OCEAN`, `AIR`, `RAIL`, `WAREHOUSE`, `LAST_MILE`.

`/api/*` keeps working exactly as before. A classic single-truck load is shown here as **one ROAD leg**
(`synthetic: true`, nothing extra is stored). A load becomes a **multi-leg load** when it is created with legs, or when a
second leg is added to it (allowed until its truck is booked). From then on its status, price and tracking come from its legs
and the classic actions (status change, dispatch, location update) answer `409`.

All amounts are entered by people; there is no carrier, port or airline connection behind these fields.
NEXUS and Finance work per leg (see the end of this page).

Sign in as usual (session cookie). Permissions: read = `shipments:read`; create = `shipments:create`; add or edit a leg and book it =
`shipments:dispatch`; other status changes = `shipments:status`; positions = `shipments:track`; filing documents = `shipments:document`.

| Method and path | What it does |
|---|---|
| `GET /api/v2/shipments/:id` | The load with its legs, handovers and leg history (`shipment.multi` says whether legs are stored) |
| `POST /api/v2/shipments` | New order with `legs` (1 to 12). Same header fields as `/api/shipments` (customer, origin, destination, pickup, delivery, weight, equipment, optional reference and customerRate) |
| `POST /api/v2/shipments/:id/legs` | Add a leg at the end |
| `GET /api/v2/legs/:id` | One leg, its history and its documents |
| `PATCH /api/v2/legs/:id` | Change a leg that is not finished (the mode only while it is `Planned`) |
| `POST /api/v2/legs/:id/status` | `{ "status": "Booked" }` and so on; with `Delivered` an optional `handover: { location, receivedBy, note }` |
| `POST /api/v2/legs/:id/tracking` | `{ location, eta?, note? }` for a Booked, In Transit or Exception leg |
| `PUT /api/v2/legs/:id/payment` | `{ "paid": true }` marks a delivered leg paid to its carrier (`false` undoes it); needs `shipments:finance` |
| `PUT /api/v2/documents/:id/leg` | `{ "legId": 12 }` files a document of the load under a leg (`null` files it back under the load) |

## A leg

`mode`, `origin`, `destination`, optional `carrierId` (one of the company's carriers), `price` and `currency` (rounded to the
currency's minor unit), `scheduledPickup` / `scheduledDelivery` / `eta` (a date `YYYY-MM-DD`, or a date and time in UTC unless it
carries an offset), `reference` (booking, bill of lading, AWB, CMR number) and `details`, which depend on the mode:

| Mode | Details |
|---|---|
| ROAD | truckPlate, driverName, driverPhone, equipment |
| OCEAN | vessel, voyage, containerNo, billOfLading, portOfLoading, portOfDischarge |
| AIR | flightNumber, airWaybill, airportFrom, airportTo |
| RAIL | trainNo, wagonNo, terminalFrom, terminalTo |
| WAREHOUSE | warehouseName, storageDays |
| LAST_MILE | courier, parcelNo |

## Leg status

`Planned` > `Booked` (needs a carrier or a reference) > `In Transit` > `Delivered`; `Exception` and `Cancelled` where it makes sense.
A leg cannot start or finish before the leg ahead of it (cancelled ones are skipped) is delivered. Delivering a leg records a
**handover** to the next leg (default place: the delivered leg's destination).

The load's own status is rolled up: all legs planned = New; any booked = Dispatched; any moving or some delivered = In Transit;
any exception = Exception; all (non-cancelled) delivered = Delivered; all cancelled = Cancelled. Its price is the sum of its legs'
prices when every leg still going has a price in the load's currency, otherwise empty (never guessed).

## NEXUS and Finance for multi-leg loads

NEXUS only prepares tasks for people; it never sends or books anything.
- A leg is **booked**: a message to that leg's carrier is drafted (naming the leg, with its route, price and reference).
- A leg goes to **Exception**: one task for that leg (not a second one for the whole load); it closes when the leg resumes or ends.
- A leg is **delivered**: a task says which leg is next and where the handover was; it closes when the next leg is booked, started or cancelled.
- A leg is **In Transit** with no position for the stale time (default 12 h): a task to ask the carrier (a drafted message to the driver for a ROAD leg that has a driver phone). One task per silence.
- When the load's own status changes because of its legs, the company's rules (Automation Studio) and the "delivered" message run as for any load, and `shipment.created` runs when a load is created with legs. `shipment.dispatched` and the whole-load "Sourcing" carrier suggestions do not apply (each leg has its own booking).
- The whole-load quiet-truck check and the risk watch look at classic loads only.

Finance: a classic load owes one carrier for the load; a multi-leg load owes each leg's carrier for its own delivered leg. `GET /api/finance/summary` adds `openLegs` (unpaid delivered legs, oldest first) and counts those legs in `payable` / `payableLoads` (other currencies stay apart as before). The whole-load "carrier paid" switch is refused on a multi-leg load (`409`); mark each leg paid instead. The load's own carrier-paid stamp is set when every priced leg is paid. A cancelled load owes nothing.

## Trips (LTL): one truck, several shipments

A **trip** is one truck run booked with one carrier for one price. Several ordinary shipments (customers, documents, invoices,
public tracking pages) travel on it. While a shipment is on a trip, its carrier, truck, driver, cost and status come from the trip;
the classic status, dispatch and location actions on that shipment answer `409`.

| Method and path | What it does |
|---|---|
| `GET /api/v2/trips` | The company's trips (`?status=Planned`); each with its load count and weight |
| `POST /api/v2/trips` | New planned trip: `origin`, `destination`, optional `carrierId`, `capacityWeightKg`, `capacityPallets`, `cost` (+ `currency`), `scheduledPickup` / `scheduledDelivery`, `truckPlate`, `driverName`, `driverPhone`, `notes` |
| `GET /api/v2/trips/suggestions` | Loads waiting for a truck that could share one: `?capacityKg=` (default `LTL_TRUCK_KG`, 20000) and `?windowDays=` (pickups within this many days, default 3) |
| `GET /api/v2/trips/:id` | The trip, its loads (weight, pallets, cost share, stops), totals (weight and pallet use, customers' revenue, margin) and history |
| `PATCH /api/v2/trips/:id` | Edit a planned or booked trip (not the carrier or currency once booked; capacity cannot go below what is on it) |
| `POST /api/v2/trips/:id/shipments` | Put a load on the trip: `{ shipmentId: "SHP-12", weightKg?, pallets? }` (weight defaults to the load's own weight) |
| `DELETE /api/v2/trips/:id/shipments/:shipmentId` | Take a load off a planned or booked trip; it waits for a truck again |
| `POST /api/v2/trips/:id/status` | `Booked`, `Planned` (take it back), `In Transit`, `Exception`, `Cancelled` |
| `POST /api/v2/trips/:id/shipments/:shipmentId/deliver` | One load is delivered; the last one delivers the trip |
| `POST /api/v2/trips/:id/tracking` | `{ location, eta?, note? }` is the position of every load still on the truck |

Rules:
- Only loads still waiting for a truck (New, Sourcing, Pending Approval, no carrier, not multi-leg) can go on a trip, and they must fit the truck's weight and pallet capacity. A load priced in another currency than the trip is refused.
- The truck's price is shared among the loads **by weight**, to the minor unit, so the shares always add up to the price. Once the trip is booked each load's carrier cost (`rate`) is its share, so margins and Finance work per load as before: the carrier is owed each delivered load's share and is paid load by load.
- Booking needs a carrier and at least one load, and makes the carrier busy; it is free again when the trip is delivered, cancelled or taken back to planned. Adding a load to a booked trip books it at once; a trip that has left takes no more loads.
- GPS positions that match the truck's plate reach every load on the truck.
- Booking, taking back, cancelling, editing and putting loads on need `shipments:dispatch`; the other status changes and deliveries need `shipments:status`; positions need `shipments:track`.
- NEXUS and pooling: see the end of this page.

## NEXUS and pooling for trips

NEXUS only prepares tasks for people; it never sends or books anything.
- A trip is **booked**: one manifest message to the carrier (the trip, truck and driver, the route, every load with its weight, the price), one message to the driver (the stops), and one booking message to each load's customer. The carrier gets no message per load.
- A trip goes to **Exception**: one task for the trip (not one per load); it closes when the trip resumes or ends.
- A trip is **In Transit** with no position for the stale time (default 12 h): one task, or one drafted message to the driver, per silence (not one per load). It closes when the trip is delivered or cancelled. The whole-load quiet-truck check skips loads on a trip.
- **Pooling**: NEXUS (periodically) and `GET /api/v2/trips/suggestions` look at loads that still wait for a truck. Loads on the same lane (ignoring case and spacing) with pickups within a few days are packed into trucks of `LTL_TRUCK_KG` (default 20000 kg), heaviest first; a truck with two or more loads is a suggestion. NEXUS makes one task per group ("3 loads can share one truck · A → B"); it closes by itself when the loads are booked, put on a trip or no longer fit together, and a task a person dismissed does not come back. It can be switched off in the AI Command Center ("Suggest loads that can share one truck").
- The Trips page shows the suggestions with a "Plan this trip" button that creates the trip and puts the loads on it; you then choose the carrier and the price and book the truck.
