/* =========================================================
   Automation Studio: the rules a company writes for itself.
   "When <trigger> and <conditions> then <actions>".
   Pure functions only: checking a rule, testing it against a load, describing it.
   NEXUS runs the rules (agents/nexus.js), the database stores them.
   Rules only prepare work (tasks and message drafts); people still send and book.
   ========================================================= */
const { httpError } = require('../lib/validation');

const STATUSES = ['New', 'Sourcing', 'Pending Approval', 'Dispatched', 'In Transit', 'Exception', 'Delivered', 'Cancelled'];

const TRIGGERS = {
  'shipment.created': 'A new load is created',
  'shipment.status': 'A load changes status',
  'shipment.dispatched': 'A truck is booked',
  'document.uploaded': 'A document is uploaded'
};

const FIELDS = {
  customer: 'Customer',
  origin: 'From',
  destination: 'To',
  equipment: 'Equipment'
};

// Message actions: who gets the draft and which kinds of message exist for them (see agents/relay.js).
const ACTIONS = {
  create_task: { label: 'Create a task', needs: 'title' },
  message_customer: { label: 'Draft a message to the customer', recipient: 'customer', purposes: ['status_update', 'delivered', 'booking_confirmation'] },
  message_carrier: { label: 'Draft a message to the carrier', recipient: 'carrier', purposes: ['booking_confirmation'] },
  message_driver: { label: 'Draft a message to the driver', recipient: 'driver', purposes: ['location_request', 'pickup_details'] }
};

const PURPOSE_LABELS = {
  status_update: 'status update',
  delivered: 'delivered',
  booking_confirmation: 'booking confirmation',
  location_request: 'ask where the truck is',
  pickup_details: 'pickup details'
};

const LIMITS = { name: 80, description: 200, value: 80, title: 140, conditions: 5, actions: 5, perCompany: 50 };

const clean = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

// Checks a rule sent by the browser and returns a clean copy. Anything unknown is refused, not guessed.
function validateWorkflow(body) {
  const input = body && typeof body === 'object' ? body : {};
  const name = clean(input.name, LIMITS.name);
  if (!name) throw httpError(400, 'Give the workflow a name.');
  const trigger = input.trigger;
  if (!TRIGGERS[trigger]) throw httpError(400, 'Choose what starts the workflow.');
  let triggerStatus = null;
  if (trigger === 'shipment.status') {
    if (!STATUSES.includes(input.triggerStatus)) throw httpError(400, 'Choose which status starts the workflow.');
    triggerStatus = input.triggerStatus;
  }
  const rawConditions = Array.isArray(input.conditions) ? input.conditions : [];
  if (rawConditions.length > LIMITS.conditions) throw httpError(400, `At most ${LIMITS.conditions} conditions.`);
  const conditions = rawConditions.map((condition) => {
    const field = condition?.field;
    const value = clean(condition?.value, LIMITS.value);
    if (!FIELDS[field]) throw httpError(400, 'A condition uses an unknown field.');
    if (!value) throw httpError(400, `Fill in the value for "${FIELDS[field]}".`);
    return { field, value };
  });
  const rawActions = Array.isArray(input.actions) ? input.actions : [];
  if (!rawActions.length) throw httpError(400, 'Add at least one action.');
  if (rawActions.length > LIMITS.actions) throw httpError(400, `At most ${LIMITS.actions} actions.`);
  const actions = rawActions.map((action) => {
    const spec = ACTIONS[action?.type];
    if (!spec) throw httpError(400, 'An action is not known.');
    if (action.type === 'create_task') {
      const title = clean(action.title, LIMITS.title);
      if (!title) throw httpError(400, 'Write a title for the task.');
      return { type: 'create_task', title, note: clean(action.note, LIMITS.description) || null };
    }
    const purpose = spec.purposes.includes(action.purpose) ? action.purpose : spec.purposes[0];
    return { type: action.type, purpose };
  });
  return {
    name,
    description: clean(input.description, LIMITS.description) || null,
    trigger,
    triggerStatus,
    conditions,
    actions,
    enabled: input.enabled !== false
  };
}

const norm = (value) => String(value || '').toLowerCase();

// Does this rule apply to this event and load? Returns each condition's result too, for "Run test".
function evaluate(workflow, event, shipment) {
  const triggerOk = workflow.trigger === event.type
    && (workflow.trigger !== 'shipment.status' || workflow.triggerStatus === event.status);
  const conditions = workflow.conditions.map((condition) => ({
    ...condition,
    label: FIELDS[condition.field],
    actual: shipment?.[condition.field] || '',
    ok: norm(shipment?.[condition.field]).includes(norm(condition.value))
  }));
  return { triggerOk, conditions, matched: triggerOk && conditions.every((condition) => condition.ok) };
}

// {id}, {customer}, {origin}, {destination}, {status} in a task title become the load's values.
function fillText(text, shipment) {
  const values = {
    id: `SHP-${shipment.id}`,
    customer: shipment.customer || '',
    origin: shipment.origin || '',
    destination: shipment.destination || '',
    status: shipment.status || ''
  };
  return String(text).replace(/\{(id|customer|origin|destination|status)\}/g, (_, key) => values[key]);
}

function describeTrigger(workflow) {
  return workflow.trigger === 'shipment.status' ? `A load becomes ${workflow.triggerStatus}` : TRIGGERS[workflow.trigger];
}

function describeAction(action, shipment = null) {
  if (action.type === 'create_task') return `Create a task: ${shipment ? fillText(action.title, shipment) : action.title}`;
  return `${ACTIONS[action.type].label}: ${PURPOSE_LABELS[action.purpose] || action.purpose}`;
}

// The jobs NEXUS already does, shown as read-only workflows. Their switch lives in the company settings.
const BUILT_IN = [
  { key: 'readOrders', name: 'Read order emails', trigger: 'An order email arrives', steps: ['FLOW reads the email', 'Fills in a new load'], result: 'Task: check and create the load' },
  { key: 'bookingMessages', name: 'Booking messages', trigger: 'A truck is booked', steps: ['RELAY writes to carrier, customer and driver'], result: 'Three message drafts to send' },
  { key: 'deliveredMessage', name: 'Delivered message', trigger: 'A load becomes Delivered', steps: ['RELAY writes to the customer'], result: 'Message draft to send' },
  { key: 'readDocuments', name: 'Read documents', trigger: 'A CMR or POD is uploaded', steps: ['VAULT reads the file', 'Compares it with the load'], result: 'Task if something does not match' },
  { key: 'priceCheck', name: 'Price check', trigger: 'A truck is booked', steps: ['PULSE compares with the lane', 'Checks the margin'], result: 'Task if the price looks wrong' },
  { key: 'quietTrucks', name: 'Quiet trucks', trigger: 'Every 10 minutes', steps: ['Finds trucks with no update', 'RELAY asks the driver'], result: 'Message draft to the driver' },
  { key: 'riskWatch', name: 'Risk watch', trigger: 'Every 10 minutes', steps: ['SENTINEL checks dates, ETA and route'], result: 'Task for each load at risk' }
];

// Ready-made rules a company can add with one click and then change.
const TEMPLATES = [
  {
    id: 'exception-call',
    name: 'Exception: call the customer',
    description: 'When a load goes into Exception, plan a call and prepare a status update.',
    trigger: 'shipment.status', triggerStatus: 'Exception', conditions: [],
    actions: [{ type: 'create_task', title: 'Call {customer} about {id}', note: 'Explain what happened and give a new time.' }, { type: 'message_customer', purpose: 'status_update' }]
  },
  {
    id: 'pod-chase',
    name: 'Delivered: get the POD',
    description: 'When a load is delivered, remind the team to collect the signed proof of delivery.',
    trigger: 'shipment.status', triggerStatus: 'Delivered', conditions: [],
    actions: [{ type: 'create_task', title: 'Get the signed POD for {id}', note: 'Ask the driver or carrier for a photo of the signed CMR.' }]
  },
  {
    id: 'booked-location',
    name: 'Booked: ask the driver to check in',
    description: 'When a truck is booked, prepare a message asking the driver where the truck is.',
    trigger: 'shipment.dispatched', triggerStatus: null, conditions: [],
    actions: [{ type: 'message_driver', purpose: 'location_request' }]
  },
  {
    id: 'export-papers',
    name: 'Loads to Russia: check papers',
    description: 'For new loads going to Russia, check the CMR, invoice and customs papers.',
    trigger: 'shipment.created', triggerStatus: null, conditions: [{ field: 'destination', value: 'RU' }],
    actions: [{ type: 'create_task', title: 'Check customs papers for {id} · {origin} → {destination}', note: 'CMR, invoice, packing list, T1 / TIR.' }]
  },
  {
    id: 'reefer-temp',
    name: 'Reefer: confirm temperature',
    description: 'For new reefer loads, confirm the temperature with the customer before booking.',
    trigger: 'shipment.created', triggerStatus: null, conditions: [{ field: 'equipment', value: 'Reefer' }],
    actions: [{ type: 'create_task', title: 'Confirm the temperature for {id} with {customer}' }]
  }
];

module.exports = {
  STATUSES, TRIGGERS, FIELDS, ACTIONS, PURPOSE_LABELS, LIMITS, BUILT_IN, TEMPLATES,
  validateWorkflow, evaluate, fillText, describeTrigger, describeAction
};
