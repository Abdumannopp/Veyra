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
