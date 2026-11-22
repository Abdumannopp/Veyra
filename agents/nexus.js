// NEXUS — the orchestrator. It listens for events (an email arrived, a load reached Sourcing,
// a truck was booked, a document was uploaded, a truck went quiet) and makes the other agents
// do their part, then leaves the result as a TASK for a person.
//
// The rule that keeps this safe: NEXUS only prepares. It never sends a message, books a truck,
// changes a status or creates a load. Every outward action waits for a person to press the button
// on the task ("approve"). What it may do on its own is cheap, reversible work: reading text,
// ranking carriers, drafting messages, comparing a document with a load.
//
// Every reaction is idempotent (tasks carry a dedupe key), runs after the web request has
// finished, and failures are logged, never thrown at the person who triggered the event.
const legsLib = require('../lib/legs');
const db = require('../database');
const { runAsSystem } = require('../lib/tenant-context');
const jobQueue = require('../lib/job-queue');
const studio = require('./studio');
const plans = require('../lib/plans');
const aiGateway = require('../ai/gateway');
const flowAgent = require('./flow');
const scoutAgent = require('./scout');
const relayAgent = require('./relay');
const vaultAgent = require('./vault');
const pulseAgent = require('./pulse');
const sentinelAgent = require('./sentinel');
const tripsAgent = require('../lib/trips');
const geo = require('../integrations/geo');

const defaults = {
  flow: { weightUnit: 'kg', currency: 'USD', equipment: [], maxRate: 10000000, maxWeight: 1000000 },
  staleHours: 12,
  aiDailyLimit: 300,
  formatMoney: (value) => String(value)
};
let settings = { ...defaults };

function configure(next) {
  settings = { ...settings, ...next, flow: { ...settings.flow, ...(next.flow || {}) } };
}

const enabled = () => process.env.NEXUS_ENABLED !== 'false';

// Each company reads orders and writes prices in its own currency and weight unit.
async function regionFor(tenantId) {
  const tenant = await db.getTenant(tenantId);
  const currency = /^[A-Z]{3}$/.test(String(tenant?.currency || '')) ? tenant.currency : settings.flow.currency;
  const weightUnit = ['kg', 'lb'].includes(tenant?.weightUnit) ? tenant.weightUnit : settings.flow.weightUnit;
  return { currency, weightUnit };
}
const moneyFor = (currency) => (value) => {
  try {
    return Number(value).toLocaleString('en-US', { style: 'currency', currency, maximumFractionDigits: 2 });
  } catch (_) {
    return `${Number(value).toFixed(2)} ${currency}`;
  }
};

// The jobs a company can switch on or off in the AI Command Center. Missing = on.
const AUTOMATIONS = {
  readOrders: 'Read order emails with FLOW',
  bookingMessages: 'Draft booking and pickup messages',
  deliveredMessage: 'Draft the "delivered" message',
  readDocuments: 'Read CMR and proof-of-delivery files',
  priceCheck: 'Check prices when a truck is booked',
  quietTrucks: 'Ask quiet trucks where they are',
  riskWatch: 'Warn about loads at risk',
  pooling: 'Suggest loads that can share one truck'
};

async function automationOn(tenantId, key) {
  const tenant = await db.getTenant(tenantId);
  return tenant?.automationSettings?.[key] !== false;
}
const pending = new Set();

// Saves the reaction to an event as a durable job and returns at once. The job survives a restart and is
// retried with growing delays if it fails. One company's events are handled one after another, in the
// order they happened (a truck booked right after "Sourcing" must not leave a stale "book a carrier" task
// behind); different companies do not wait for each other. `idempotencyKey` stops the same event being
// saved twice (for example an email delivered again).
function emit(event, context, { idempotencyKey = null } = {}) {
  if (!enabled()) return;
  const tenantId = context?.tenantId;
  if (!Number.isInteger(tenantId)) {
    console.error(`[NEXUS] ${event} ignored: it has no company.`);
    return;
  }
  const saved = jobQueue.enqueue({ tenantId, kind: 'nexus.event', lane: 'nexus', payload: { event, context }, idempotencyKey })
    .catch((error) => console.error(`[NEXUS] could not save ${event}:`, error.message))
    .finally(() => pending.delete(saved));
  pending.add(saved);
}

jobQueue.register('nexus.event', ({ event, context }) => handle(event, context));

// Resolves when every saved reaction has finished (used by tests and graceful shutdown).
async function idle() {
  while (pending.size) await Promise.allSettled([...pending]);
  await jobQueue.idle();
}

const logger = (tenantId, shipmentId = null) => (task) => db.recordAgentTask(tenantId, { ...task, shipmentId, actorId: null })
  .catch((error) => console.error('[NEXUS] agent log failed:', error.message));

// Automatic AI work stops at a daily cap per company, so a flood of emails cannot run up a bill.
async function aiAvailable(tenantId) {
  if (!aiGateway.isEnabled()) return { ok: false, reason: 'AI is off.' };
  const plan = plans.resolvePlan(await db.getTenant(tenantId));
  if (plan.locked || !plan.capabilities.includes('ai')) return { ok: false, reason: `AI agents are not part of the ${plan.name} plan${plan.locked ? ' right now' : ''}.` };
  if ((await db.countAgentTasksToday(tenantId)) >= settings.aiDailyLimit) {
    return { ok: false, reason: 'The daily AI limit for this company was reached.' };
  }
  return { ok: true };
}

async function handle(event, context) {
  await handleBuiltIn(event, context);
  if (WORKFLOW_EVENTS.includes(event)) await runWorkflows(event, context);
}

/* ---------- Automation Studio: the company's own rules ---------- */
const WORKFLOW_EVENTS = Object.keys(studio.TRIGGERS);

// Runs after the built-in reaction, so a rule sees the load as the built-in jobs left it.
// A rule that fails does not stop the others; each run is logged for "Runs & history".
async function runWorkflows(event, context) {
  const { tenantId, shipmentId } = context || {};
  if (!tenantId || !shipmentId) return;
  const workflows = await db.listActiveWorkflows(tenantId, event);
  if (!workflows.length) return;
  // Workflows only run on a plan that includes them (they stay saved if the plan changes).
  const plan = plans.resolvePlan(await db.getTenant(tenantId));
  if (plan.locked || !plan.capabilities.includes('workflows')) return;
  const shipment = await db.getShipment(tenantId, shipmentId);
  if (!shipment) return;
  const facts = { type: event, status: context.status || shipment.status };
  // One run per rule, load and moment: the same status reached twice runs again, a repeated event does not.
  const moment = event === 'document.uploaded' ? `doc${context.documentId}` : event === 'shipment.status' ? `${facts.status}:${await db.countStatusReached(tenantId, shipmentId, facts.status)}` : event === 'shipment.dispatched' ? `booked:${await db.countStatusReached(tenantId, shipmentId, 'Dispatched')}` : 'once';
  for (const workflow of workflows) {
    if (!studio.evaluate(workflow, facts, shipment).matched) continue;
    const done = [];
    try {
      for (const [index, action] of workflow.actions.entries()) {
        const dedupeKey = `wf:${workflow.id}:${shipmentId}:${moment}:${index}`;
        if (action.type === 'create_task') {
          const result = await db.createTask(tenantId, {
            kind: 'attention',
            title: studio.fillText(action.title, shipment).slice(0, 200),
            shipmentId,
            dedupeKey,
            payload: { text: action.note ? studio.fillText(action.note, shipment) : `Created by the workflow "${workflow.name}".`, workflow: workflow.name }
          });
          done.push(result.created ? 'task created' : 'task already open');
        } else {
          const recipient = studio.ACTIONS[action.type].recipient;
          const created = await draftMessageTask(tenantId, shipment, recipient, action.purpose, dedupeKey, ` (${workflow.name})`);
          done.push(created ? `${recipient} message drafted` : `no ${recipient} phone, message skipped`);
        }
      }
      await db.recordWorkflowRun(tenantId, { workflowId: workflow.id, shipmentId, status: 'done', detail: done.join('; ') });
    } catch (error) {
      console.error(`[NEXUS] workflow ${workflow.id} failed:`, error.message);
      await db.recordWorkflowRun(tenantId, { workflowId: workflow.id, shipmentId, status: 'failed', detail: [...done, `stopped: ${error.message}`].join('; ').slice(0, 300) })
        .catch(() => {});
    }
  }
}

async function handleBuiltIn(event, context) {
  switch (event) {
    case 'inbox.received': return onInboxReceived(context);
    case 'shipment.status': return onShipmentStatus(context);
    case 'leg.status': return onLegStatus(context);
    case 'trip.status': return onTripStatus(context);
    case 'shipment.dispatched': return onShipmentDispatched(context);
    case 'document.uploaded': return onDocumentUploaded(context);
    case 'inbox.attached': return onInboxAttached(context);
    case 'message.failed': return onMessageFailed(context);
    default: return undefined;
  }
}

/* ---------- an order email arrived ---------- */
async function onInboxReceived({ tenantId, inboxId }) {
  const item = await db.getInboxItem(tenantId, inboxId);
  if (!item) return;
  let parsed = item.parsed;
  let note = null;
  const files = (item.attachments || []).map((file) => ({ id: file.id, filename: file.filename, size: file.size }));
  if (item.status === 'new' && !item.body.trim()) {
    note = 'This email has only files, no text. Attach them to a load, or create a new load.';
  } else if (item.status === 'new' && !(await automationOn(tenantId, 'readOrders'))) {
    note = 'Reading order emails is switched off in the AI Command Center.';
  } else if (item.status === 'new') {
    const ai = await aiAvailable(tenantId);
    if (!ai.ok) {
      note = ai.reason;
    } else {
      try {
        parsed = await flowAgent.parseOrder(`Subject: ${item.subject || ''}\n\n${item.body}`, { ...settings.flow, ...(await regionFor(tenantId)) }, logger(tenantId));
        await db.updateInboxItem(tenantId, inboxId, { status: 'parsed', parsed });
      } catch (error) {
        note = 'FLOW could not read this email automatically.';
        await db.updateInboxItem(tenantId, inboxId, { status: 'failed', error: error.message });
      }
    }
  }
  const draft = parsed?.draft;
  const title = draft?.origin && draft?.destination
    ? `New order: ${draft.customer || item.from || 'customer'} · ${draft.origin} → ${draft.destination}`
    : `New email from ${item.from || 'unknown sender'}`;
  await db.createTask(tenantId, {
    kind: 'review_intake',
    title,
    inboxId,
    dedupeKey: `inbox:${inboxId}`,
    payload: { from: item.from, subject: item.subject, preview: item.body.slice(0, 300), parsed, note, files }
  });
}

/* ---------- an email's files were put on a load ---------- */
// The email named a load (SHP-12 or its reference), so its files went straight to that load's documents.
// A person is told, and each file is read like any uploaded document.
async function onInboxAttached({ tenantId, inboxId, shipmentId, documentIds = [], skipped = 0, from = '' }) {
  if (documentIds.length || skipped) {
    const count = documentIds.length;
    await db.createTask(tenantId, {
      kind: 'attention',
      title: count
        ? `${count} file${count === 1 ? '' : 's'} from an email ${count === 1 ? 'was' : 'were'} added to SHP-${shipmentId}`
        : `Files from an email could not be added to SHP-${shipmentId}`,
      shipmentId,
      inboxId,
      dedupeKey: `inbox:${inboxId}`,
      payload: {
        text: `${from ? `From ${from}. ` : ''}${count ? 'Open the load to see the documents.' : ''}${skipped ? ` ${skipped} file${skipped === 1 ? '' : 's'} did not fit: the load already has the maximum number of documents.` : ''}`.trim()
      }
    });
  }
  for (const documentId of documentIds) await onDocumentUploaded({ tenantId, shipmentId, documentId });
}

/* ---------- the provider reported that a message did not arrive ---------- */
async function onMessageFailed({ tenantId, messageId, shipmentId, recipient, to, errorCode }) {
  const shipment = await db.getShipment(tenantId, shipmentId);
  if (!shipment || ['Delivered', 'Cancelled'].includes(shipment.status)) return;
  await db.createTask(tenantId, {
    kind: 'attention',
    title: `The message to the ${recipient} of SHP-${shipmentId} was not delivered`,
    shipmentId,
    dedupeKey: `msgfail:${messageId}`,
    payload: {
      text: `The number ${to} did not receive it${errorCode ? ` (provider code ${errorCode})` : ''}. Check the number on the load and call instead.`,
      carrierPhone: shipment.carrierPhone || null,
      driverPhone: shipment.driver_phone || null
    }
  });
}

/* ---------- a load changed status ---------- */
async function onShipmentStatus({ tenantId, shipmentId, status }) {
  if (status !== 'Exception') await db.resolveTasksByKey(tenantId, `exception:${shipmentId}:`);

  if (status === 'Delivered' || status === 'Cancelled') {
    await db.resolveTasksForShipment(tenantId, shipmentId);
  }

  const shipment = await db.getShipment(tenantId, shipmentId);
  if (!shipment) return;
  const label = `SHP-${shipmentId}`;

  if (status === 'Sourcing') {
    const data = await db.getScoutData(tenantId, shipmentId);
    const recommendations = scoutAgent.rankCarriers(data).slice(0, 3);
    await db.createTask(tenantId, {
      kind: 'book_carrier',
      title: recommendations.length ? `Book a carrier for ${label} · ${shipment.origin} → ${shipment.destination}` : `No carrier available for ${label}`,
      shipmentId,
      dedupeKey: `book:${shipmentId}`,
      payload: { recommendations, laneAverageRate: data.laneAverageRate, laneLoads: data.laneLoads }
    });
  }

  // A load with several legs raises its exceptions per leg (onLegStatus), which says which leg and carrier.
  // Multi-leg loads and loads on a trip raise their exceptions per leg / per trip (onLegStatus, onTripStatus).
  if (status === 'Exception' && shipment.leg_mode !== 'multi' && !shipment.trip_id) {
    const count = await db.countShipmentExceptions(tenantId, shipmentId);
    await db.createTask(tenantId, {
      kind: 'attention',
      title: `${label} is in Exception · ${shipment.customer}`,
      shipmentId,
      dedupeKey: `exception:${shipmentId}:${count}`,
      payload: { text: 'Find out what happened, tell the customer if the delivery will be late, then move the load on.', carrierPhone: shipment.carrierPhone || null, driverPhone: shipment.driver_phone || null }
    });
  }

  if (status === 'Delivered' && (await automationOn(tenantId, 'deliveredMessage'))) {
    await draftMessageTask(tenantId, shipment, 'customer', 'delivered', `msg:${shipmentId}:customer:delivered`);
  }
}

/* ---------- a leg of a multi-leg load changed status ---------- */
// The load itself is shown to the leg's message templates, with the leg's own route, carrier, price and details.
const MODE_NAMES = { ROAD: 'road', OCEAN: 'ocean', AIR: 'air', RAIL: 'rail', WAREHOUSE: 'warehouse', LAST_MILE: 'last mile' };
const legLabel = (shipmentId, leg) => `SHP-${shipmentId} leg ${leg.sequence} (${MODE_NAMES[leg.mode] || leg.mode})`;
function legView({ leg, shipment, carrierPhone }) {
  return {
    ...shipment, origin: leg.origin, destination: leg.destination, pickup: leg.scheduledPickup || shipment.pickup, delivery: leg.scheduledDelivery || shipment.delivery,
    carrierName: leg.carrierName, carrierPhone, rate: leg.price, truck_plate: leg.details.truckPlate || null, driver_name: leg.details.driverName || null,
    driver_phone: leg.details.driverPhone || null, last_location: leg.lastLocation, eta: leg.eta, status: leg.status
  };
}

async function onLegStatus({ tenantId, shipmentId, legId, status, handoverTo }) {
  const context = await db.getLegContext(tenantId, legId);
  if (!context) return;
  const { leg, shipment } = context;
  const label = legLabel(shipmentId, leg);
  if (status !== 'Exception') await db.resolveTasksByKey(tenantId, `legex:${legId}:`);
  if (['Booked', 'In Transit', 'Cancelled'].includes(status)) await db.resolveTasksByKey(tenantId, `handover:${legId}:`);
  if (['Delivered', 'Cancelled'].includes(status)) await db.resolveTasksByKey(tenantId, `quietleg:${legId}:`);

  if (status === 'Exception') {
    const count = await db.countLegExceptions(tenantId, legId);
    await db.createTask(tenantId, {
      kind: 'attention',
      title: `${label} is in Exception · ${shipment.customer}`,
      shipmentId,
      dedupeKey: `legex:${legId}:${count}`,
      payload: { text: 'Find out what happened on this leg, tell the customer if the delivery will be late, then resume or cancel the leg.', carrierPhone: context.carrierPhone, driverPhone: leg.details.driverPhone || null }
    });
  }

  if (status === 'Booked' && (await automationOn(tenantId, 'bookingMessages'))) {
    await draftMessageTask(tenantId, legView(context), 'carrier', 'booking_confirmation', `msg:${shipmentId}:leg${legId}:carrier:booking`, '', { label, currency: leg.currency || undefined });
  }

  if (status === 'Delivered' && handoverTo) {
    const next = await db.getNextLeg(tenantId, legId);
    if (next) {
      await db.createTask(tenantId, {
        kind: 'attention',
        title: `${label} delivered: leg ${next.sequence} (${MODE_NAMES[next.mode] || next.mode}) is next · ${shipment.customer}`,
        shipmentId,
        dedupeKey: `handover:${next.id}:next`,
        payload: { text: `Handed over at ${next.origin}. ${next.status === 'Planned' ? 'Book the next leg' : 'Start the next leg'} when it is ready.`, carrierPhone: context.carrierPhone }
      });
    }
  }
}

/* ---------- a trip (one truck, several loads) changed status ---------- */
// One manifest message to the carrier and one to the driver instead of one per load; one task per problem on the road.
const formatWeightFor = (unit) => (kg) => (unit === 'lb' ? `${Math.round((kg / 0.45359237) * 10) / 10} lb` : `${Math.round(kg * 10) / 10} kg`);

async function draftTripTask(tenantId, data, recipient, purpose, dedupeKey, extraTitle = '') {
  const tenant = await db.getTenant(tenantId);
  const region = await regionFor(tenantId);
  const draft = relayAgent.draftTripMessage({
    trip: data.trip, shipments: data.shipments, recipient, purpose, company: tenant?.name || '',
    formatMoney: moneyFor(data.trip.currency || region.currency), formatWeight: formatWeightFor(region.weightUnit)
  });
  if (!draft?.to) return false;
  const what = { booking_confirmation: 'booking', pickup_details: 'stops', location_request: 'ask for location' }[draft.purpose] || draft.purpose;
  const result = await db.createTask(tenantId, {
    kind: 'message', title: `Message the ${recipient} about trip ${data.trip.number}: ${what}${extraTitle}`, shipmentId: null, dedupeKey,
    payload: { recipient, purpose: draft.purpose, body: draft.body, to: draft.to, tripId: data.trip.id }
  });
  return result.created;
}

async function onTripStatus({ tenantId, tripId, status }) {
  const data = await db.getTrip(tenantId, tripId);
  if (!data) return;
  const { trip } = data;
  if (status !== 'Exception') await db.resolveTasksByKey(tenantId, `tripex:${tripId}:`);
  if (['Delivered', 'Cancelled'].includes(status)) await db.resolveTasksByKey(tenantId, `quiettrip:${tripId}:`);

  if (status === 'Exception') {
    const count = await db.countTripExceptions(tenantId, tripId);
    await db.createTask(tenantId, {
      kind: 'attention',
      title: `Trip ${trip.number} is in Exception · ${data.shipments.length} load${data.shipments.length === 1 ? '' : 's'} on the truck`,
      dedupeKey: `tripex:${tripId}:${count}`,
      payload: { text: 'Find out what happened, tell the customers whose loads will be late, then resume the trip.', carrierPhone: trip.carrierPhone, driverPhone: trip.driverPhone }
    });
  }

  if (status === 'Booked' && (await automationOn(tenantId, 'bookingMessages'))) {
    await draftTripTask(tenantId, data, 'carrier', 'booking_confirmation', `msg:trip${tripId}:carrier:booking`);
    await draftTripTask(tenantId, data, 'driver', 'pickup_details', `msg:trip${tripId}:driver:pickup`);
    for (const item of data.shipments) {
      const shipment = await db.getShipment(tenantId, Number(item.shipmentId.replace('SHP-', '')));
      if (shipment) await draftMessageTask(tenantId, shipment, 'customer', 'booking_confirmation', `msg:${shipment.id}:customer:booking`);
    }
  }
}

/* ---------- a truck was booked ---------- */
async function onShipmentDispatched({ tenantId, shipmentId }) {
  await db.resolveTasksByKey(tenantId, `book:${shipmentId}`);
  const shipment = await db.getShipment(tenantId, shipmentId);
  if (!shipment) return;
  if (await automationOn(tenantId, 'bookingMessages')) {
    for (const [recipient, purpose] of [['carrier', 'booking_confirmation'], ['customer', 'booking_confirmation'], ['driver', 'pickup_details']]) {
      await draftMessageTask(tenantId, shipment, recipient, purpose, `msg:${shipmentId}:${recipient}:booking`);
    }
  }
  if (!(await automationOn(tenantId, 'priceCheck'))) return;
  // PULSE: a price far from what this lane usually costs, or a load that loses money, is worth a second look.
  const prices = pulseAgent.analyzePrices(await db.getPulseData(tenantId, shipmentId), { formatMoney: moneyFor((await regionFor(tenantId)).currency) });
  const warnings = prices.flags.filter((flag) => flag.level === 'warn');
  if (warnings.length) {
    await db.createTask(tenantId, {
      kind: 'attention',
      title: `Check the prices on SHP-${shipmentId} · ${shipment.origin} → ${shipment.destination}`,
      shipmentId,
      dedupeKey: `pulse:${shipmentId}`,
      payload: { text: warnings.map((flag) => flag.text).join(' '), carrierPhone: shipment.carrierPhone || null }
    });
  }
}

// A drafted message waits for approval. It is only created when the load has a number to send it to.
// options.label: what the message is about when it is one leg of a load; options.currency: the currency of its price.
async function draftMessageTask(tenantId, shipment, recipient, purpose, dedupeKey, extraTitle = '', options = {}) {
  const tenant = await db.getTenant(tenantId);
  const draft = relayAgent.draftMessage({
    shipment, recipient, purpose, company: tenant?.name || '', formatMoney: moneyFor(options.currency || (await regionFor(tenantId)).currency), label: options.label || null
  });
  if (!draft?.to) return false;
  const what = { booking_confirmation: 'booking', pickup_details: 'pickup details', location_request: 'ask for location', status_update: 'status update', delivered: 'delivered' }[draft.purpose] || draft.purpose;
  const result = await db.createTask(tenantId, {
    kind: 'message',
    title: `Message the ${recipient} about ${options.label || `SHP-${shipment.id}`}: ${what}${extraTitle}`,
    shipmentId: shipment.id,
    dedupeKey,
    payload: { recipient, purpose: draft.purpose, body: draft.body, to: draft.to }
  });
  return result.created;
}

/* ---------- a document was uploaded ---------- */
// manual: a person pressed "Read with AI", so the automatic-reading switch does not apply.
async function onDocumentUploaded({ tenantId, shipmentId, documentId, manual = false }) {
  const document = await db.getDocument(tenantId, shipmentId, documentId);
  if (!document) return;
  if (!vaultAgent.READABLE_TYPES.includes(document.type)) {
    await db.updateDocumentExtraction(tenantId, documentId, { status: 'skipped', error: 'Only CMR and proof of delivery files are read automatically.' });
    return;
  }
  if (!manual && !(await automationOn(tenantId, 'readDocuments'))) {
    await db.updateDocumentExtraction(tenantId, documentId, { status: 'skipped', error: 'Reading documents automatically is switched off in the AI Command Center.' });
    return;
  }
  const ai = await aiAvailable(tenantId);
  if (!ai.ok) {
    await db.updateDocumentExtraction(tenantId, documentId, { status: 'skipped', error: ai.reason });
    return;
  }
  const file = await db.getDocumentFile(tenantId, shipmentId, documentId);
  const shipment = await db.getShipment(tenantId, shipmentId);
  if (!file || !shipment) return;
  try {
    const fields = await vaultAgent.extractFields({ content: file.content, mime: file.mime, filename: file.filename }, { ...settings.flow, ...(await regionFor(tenantId)) }, logger(tenantId, shipmentId));
    const comparison = vaultAgent.compareWithShipment(fields, shipment);
    await db.updateDocumentExtraction(tenantId, documentId, { status: 'done', extracted: fields, comparison });
    if (comparison.mismatches > 0) {
      await db.createTask(tenantId, {
        kind: 'check_document',
        title: `${file.filename}: ${comparison.mismatches} difference${comparison.mismatches === 1 ? '' : 's'} from SHP-${shipmentId}`,
        shipmentId,
        dedupeKey: `doc:${documentId}`,
        payload: { documentId, filename: file.filename, mismatches: comparison.checks.filter((check) => check.status === 'mismatch') }
      });
    }
  } catch (error) {
    await db.updateDocumentExtraction(tenantId, documentId, { status: 'failed', error: error.message });
  }
}

/* ---------- trucks that went quiet (periodic) ---------- */
// Looks at every company's booked trucks. One task per truck per "silence": a new task appears only
// after the truck has reported again and then gone quiet again.
async function sweep() {
  return runAsSystem(sweepAllCompanies);
}

async function sweepAllCompanies() {
  const stale = await db.listStaleLoadsAllTenants(settings.staleHours);
  let created = 0;
  // Trips on the road with no position for a while: one task (or one message to the driver) per trip, not per load.
  for (const row of await db.listStaleTripsAllTenants(settings.staleHours)) {
    if (!(await automationOn(row.tenantId, 'quietTrucks'))) continue;
    const data = await db.getTrip(row.tenantId, row.id);
    if (!data) continue;
    const key = `quiettrip:${row.id}:${row.lastTrackedAt || 'none'}`;
    if (await draftTripTask(row.tenantId, data, 'driver', 'location_request', key, ` (no update for ${settings.staleHours}h+)`)) {
      created += 1;
      continue;
    }
    const result = await db.createTask(row.tenantId, {
      kind: 'attention',
      title: `Trip ${data.trip.number}: no position update for ${settings.staleHours}h+ — ask the carrier`,
      dedupeKey: key,
      payload: { text: 'Ask the carrier or driver where the truck is, then log the position on the trip.', carrierPhone: data.trip.carrierPhone }
    });
    if (result.created) created += 1;
  }
  // Legs of multi-leg loads that are on the way with no position for a while.
  for (const row of await db.listStaleLegsAllTenants(settings.staleHours)) {
    if (!(await automationOn(row.tenantId, 'quietTrucks'))) continue;
    const context = await db.getLegContext(row.tenantId, row.id);
    if (!context) continue;
    const label = legLabel(row.shipmentId, context.leg);
    const key = `quietleg:${row.id}:${row.lastTrackedAt || 'none'}`;
    const view = legView(context);
    if (context.leg.mode === 'ROAD' && view.driver_phone && await draftMessageTask(row.tenantId, view, 'driver', 'location_request', key, ` (no update for ${settings.staleHours}h+)`, { label })) {
      created += 1;
      continue;
    }
    const result = await db.createTask(row.tenantId, {
      kind: 'attention',
      title: `${label}: no position update for ${settings.staleHours}h+ — ask the carrier`,
      shipmentId: row.shipmentId,
      dedupeKey: key,
      payload: { text: 'Ask the carrier where this leg is, then log the position on the leg.', carrierPhone: context.carrierPhone }
    });
    if (result.created) created += 1;
  }
  for (const row of stale) {
    if (!(await automationOn(row.tenantId, 'quietTrucks'))) continue;
    const shipment = await db.getShipment(row.tenantId, row.id);
    if (!shipment) continue;
    const key = `stale:${row.id}:${row.lastTrackedAt || 'none'}`;
    const made = await draftMessageTask(row.tenantId, shipment, 'driver', 'location_request', key, ` (no update for ${settings.staleHours}h+)`);
    if (made) {
      created += 1;
      continue;
    }
    // No driver number on the load: a plain reminder to call.
    const result = await db.createTask(row.tenantId, {
      kind: 'attention',
      title: `SHP-${row.id}: no location update for ${settings.staleHours}h+ — call the driver`,
      shipmentId: row.id,
      dedupeKey: key,
      payload: { text: 'No driver phone number is on this load. Call the carrier, then log the location.', carrierPhone: shipment.carrierPhone || null }
    });
    if (result.created) created += 1;
  }
  return created;
}

/* ---------- SENTINEL: loads that are about to go wrong (periodic) ---------- */
// One task per load per kind of risk. When the risk is gone (a truck was booked, the load moved on),
// its task closes by itself. A task a person dismissed does not come back.
async function sentinelSweep(now = Date.now()) {
  return runAsSystem(() => sentinelSweepAllCompanies(now));
}

async function sentinelSweepAllCompanies(now) {
  const loads = await geo.annotateOffRoute(await db.listSentinelLoads(null), { fetchMissing: true, now });
  const tenantOf = new Map(loads.map((load) => [load.id, load.tenantId]));
  const active = new Set();
  let created = 0;
  for (const risk of sentinelAgent.assess(loads, { now, staleHours: settings.staleHours, offRouteKm: geo.offRouteKm() })) {
    if (!sentinelAgent.TASK_RISKS.includes(risk.type)) continue;
    const shipmentId = Number(risk.shipmentId.slice(4));
    const tenantId = tenantOf.get(shipmentId);
    if (!(await automationOn(tenantId, 'riskWatch'))) continue;
    // A new ETA that is late again is a new warning; everything else is raised once per load.
    const key = `risk:${shipmentId}:${risk.type}${risk.detail ? `:${risk.detail}` : ''}`;
    active.add(`${tenantId}|${key}`);
    const result = await db.createTask(tenantId, {
      kind: 'attention',
      title: risk.title,
      shipmentId,
      dedupeKey: key,
      payload: { text: risk.advice, carrierPhone: risk.carrierPhone, driverPhone: risk.driverPhone, severity: risk.severity }
    });
    if (result.created) created += 1;
  }
  for (const task of await db.listOpenTasksByKeyPrefix(null, 'risk:')) {
    if (!active.has(`${task.tenantId}|${task.dedupeKey}`)) await db.resolveTask(task.tenantId, task.id, { status: 'done' });
  }
  return created;
}

/* ---------- DELAYS: legs that are late or put the next handover at risk (periodic) ---------- */
// One task per leg per kind of delay. A later ETA that is still late keeps the same task; the task closes by
// itself when the leg is on time again, delivered or cancelled. A task a person dismissed does not come back.
const DELAY_TITLES = {
  pickup_missed: 'pickup has not started',
  overdue: 'past the planned delivery',
  eta_late: 'ETA is after the planned delivery',
  handover_risk: 'the leg before will arrive after this pickup'
};
const DELAY_ADVICE = {
  pickup_missed: 'Ask the carrier when the pickup happens, then update the leg (or its plan).',
  overdue: 'Ask the carrier where the cargo is, log the position and a new ETA, or mark the leg delivered.',
  eta_late: 'Tell the customer about the new time, and check the next leg can wait.',
  handover_risk: 'Move this leg\'s pickup (and tell its carrier), or speed up the leg before.'
};

async function delaySweep(now = new Date()) {
  return runAsSystem(() => delaySweepAllCompanies(now));
}

async function delaySweepAllCompanies(now) {
  const active = new Set();
  let created = 0;
  for (const row of await db.listOpenMultiLegShipmentsAllTenants()) {
    if (!(await automationOn(row.tenantId, 'riskWatch'))) continue;
    const data = await db.getShipmentLegs(row.tenantId, row.id);
    if (!data?.multi) continue;
    const timing = legsLib.legTiming(data.legs, { now });
    for (const [index, leg] of data.legs.entries()) {
      for (const issue of timing[index].issues) {
        const key = `legdelay:${leg.id}:${issue.kind}`;
        active.add(`${row.tenantId}|${key}`);
        const label = legLabel(row.id, leg);
        const result = await db.createTask(row.tenantId, {
          kind: 'attention',
          title: `${label}: ${DELAY_TITLES[issue.kind]} (${issue.hours} h)`,
          shipmentId: row.id,
          dedupeKey: key,
          payload: { text: `${label}: ${issue.text}. ${DELAY_ADVICE[issue.kind]}`, severity: issue.kind === 'eta_late' ? 'medium' : 'high' }
        });
        if (result.created) created += 1;
      }
    }
  }
  for (const task of await db.listOpenTasksByKeyPrefix(null, 'legdelay:')) {
    if (!active.has(`${task.tenantId}|${task.dedupeKey}`)) await db.resolveTask(task.tenantId, task.id, { status: 'done' });
  }
  return created;
}

/* ---------- POOLING: loads that could share one truck (periodic) ---------- */
// One task per group of loads on the same lane with close pickups that fit one truck. When the loads are booked, put on a trip
// or no longer fit together, the task closes by itself. A task a person dismissed does not come back.
async function poolingSweep() {
  return runAsSystem(poolingSweepAllCompanies);
}

async function poolingSweepAllCompanies() {
  const capacityKg = Number(process.env.LTL_TRUCK_KG) > 0 ? Number(process.env.LTL_TRUCK_KG) : 20000;
  const byTenant = new Map();
  for (const load of await db.listPoolableLoads(null)) byTenant.set(load.tenantId, [...(byTenant.get(load.tenantId) || []), load]);
  const active = new Set();
  let created = 0;
  for (const [tenantId, loads] of byTenant) {
    if (!(await automationOn(tenantId, 'pooling'))) continue;
    for (const pool of tripsAgent.suggestPools(loads, { capacityKg })) {
      const ids = pool.loads.map((load) => load.id);
      const key = `pool:${ids.join('-')}`;
      active.add(`${tenantId}|${key}`);
      const result = await db.createTask(tenantId, {
        kind: 'attention',
        title: `${ids.length} loads can share one truck · ${pool.origin} → ${pool.destination}`,
        dedupeKey: key,
        payload: {
          text: `${ids.map((id) => `SHP-${id}`).join(', ')} go the same way within a few days and weigh ${Math.round(pool.totalWeightKg)} kg together (${Math.round(pool.utilization * 100)}% of a ${capacityKg} kg truck). Plan one trip in Trips and book the truck once.`,
          shipmentIds: ids, totalWeightKg: pool.totalWeightKg, utilization: pool.utilization
        }
      });
      if (result.created) created += 1;
    }
  }
  for (const task of await db.listOpenTasksByKeyPrefix(null, 'pool:')) {
    if (!active.has(`${task.tenantId}|${task.dedupeKey}`)) await db.resolveTask(task.tenantId, task.id, { status: 'done' });
  }
  return created;
}

let sweepTimer = null;

function startSweeper(intervalMinutes = 10) {
  if (!enabled() || sweepTimer) return;
  const run = () => sweep()
    .then(() => sentinelSweep())
    .then(() => delaySweep())
    .then(() => poolingSweep())
    .catch((error) => console.error('[NEXUS] sweep failed:', error.message));
  sweepTimer = setInterval(run, intervalMinutes * 60 * 1000);
  sweepTimer.unref();
  setTimeout(run, 15000).unref();
}

function stopSweeper() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

module.exports = { AUTOMATIONS, configure, emit, idle, sweep, sentinelSweep, delaySweep, poolingSweep, startSweeper, stopSweeper };
