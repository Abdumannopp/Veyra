# API v2: shipments made of legs

A **shipment** is the customer's order. It moves in one or more **legs**, each by its own mode:
`ROAD`, `OCEAN`, `AIR`, `RAIL`, `WAREHOUSE`, `LAST_MILE`.

`/api/*` keeps working exactly as before. A classic single-truck load is shown here as **one ROAD leg**
(`synthetic: true`, nothing extra is stored). A load becomes a **multi-leg load** when it is created with legs, or when a
second leg is added to it (allowed until its truck is booked). From then on its status, price and tracking come from its legs
and the classic actions (status change, dispatch, location update) answer `409`.

All amounts are entered by people; there is no carrier, port or airline connection behind these fields.
NEXUS does not react to multi-leg loads yet.

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
