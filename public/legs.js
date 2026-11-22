/* =========================================================
   VEYRA — shipment legs (screens for /api/v2, see docs/API_V2.md)
   - A "Route legs" section in the load record: legs, handovers, and what can be done with each leg.
   - A planner for a new order made of several legs.
   Relies on helpers from script.js: getAuthHeaders, hasPermission, notify, createTextElement, openShipmentDetails.
   Everything is entered by people; there is no carrier, port or airline connection behind it.
   ========================================================= */
(function () {
  const MODES = { ROAD: 'Road', OCEAN: 'Ocean', AIR: 'Air', RAIL: 'Rail', WAREHOUSE: 'Warehouse', LAST_MILE: 'Last mile' };
  const DETAIL_FIELDS = {
    ROAD: [['truckPlate', 'Truck plate'], ['driverName', 'Driver'], ['driverPhone', 'Driver phone']],
    OCEAN: [['vessel', 'Vessel'], ['voyage', 'Voyage'], ['containerNo', 'Container no.'], ['billOfLading', 'Bill of lading'], ['portOfLoading', 'Port of loading'], ['portOfDischarge', 'Port of discharge']],
    AIR: [['flightNumber', 'Flight'], ['airWaybill', 'Air waybill'], ['airportFrom', 'Airport from'], ['airportTo', 'Airport to']],
    RAIL: [['trainNo', 'Train no.'], ['wagonNo', 'Wagon no.'], ['terminalFrom', 'Terminal from'], ['terminalTo', 'Terminal to']],
    WAREHOUSE: [['warehouseName', 'Warehouse'], ['storageDays', 'Storage days']],
    LAST_MILE: [['courier', 'Courier'], ['parcelNo', 'Parcel no.']]
  };
  const BEFORE_TRUCK = ['New', 'Sourcing', 'Pending Approval'];

  const text = (tag, className, value) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined && value !== null) node.textContent = String(value);
    return node;
  };
  const slug = (value) => String(value || '').toLowerCase().replace(/\s+/g, '-');
  const headers = () => getAuthHeaders();
  const can = (permission) => (typeof hasPermission === 'function' ? hasPermission(permission) : false);

  async function api(method, url, body) {
    const response = await fetch(url, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || 'The request failed.');
    return data;
  }

  function money(value, currency) {
    if (value === null || value === undefined) return '';
    const code = currency || window.VeyraConfig?.currency || 'USD';
    try {
      return Number(value).toLocaleString(window.VeyraConfig?.locale || 'en-US', { style: 'currency', currency: code, maximumFractionDigits: 2 });
    } catch (_) {
      return `${Number(value).toFixed(2)} ${code}`;
    }
  }
  // A date ("YYYY-MM-DD") or a stored UTC time, shown in the company's zone and format.
  function when(value) {
    if (!value) return '';
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDay(value) : formatTimestamp(value);
  }

  /* ---------- the "Route legs" section in the load record ---------- */
  const view = { shipment: null, data: null, form: null };

  function section() {
    return document.getElementById('legsSection');
  }

  async function show(shipment) {
    const box = section();
    if (!box) return;
    view.shipment = shipment;
    view.form = null;
    // A load on a trip is moved with the trip: show where it is, not the legs.
    if (shipment.tripId) {
      document.getElementById('legsCount').textContent = `Trip T-${shipment.tripId}`;
      const open = text('button', 'btn btn-primary small', 'Open the trip');
      open.type = 'button';
      open.addEventListener('click', () => {
        document.getElementById('shipmentDetailsModal')?.classList.add('hidden');
        window.location.hash = `#/trips?trip=${shipment.tripId}`;
      });
      document.getElementById('legsBody').replaceChildren(
        text('p', 'muted', `This load travels on trip T-${shipment.tripId} with its truck, driver and carrier cost share. Its status and position follow the trip.`),
        open
      );
      document.getElementById('legAdd').classList.add('hidden');
      box.classList.remove('hidden');
      return;
    }
    try {
      view.data = await api('GET', `/api/v2/shipments/${encodeURIComponent(shipment.id)}`);
    } catch (error) {
      box.classList.add('hidden');
      return;
    }
    render();
  }

  async function reload() {
    // Refreshes the whole record (status, history, list) after a change.
    if (typeof openShipmentDetails === 'function' && view.shipment) await openShipmentDetails(view.shipment.id);
    else if (view.shipment) await show(view.shipment);
  }

  function render() {
    const box = section();
    if (!box || !view.data) return;
    const { shipment, legs, handovers, multi } = view.data;
    const body = document.getElementById('legsBody');
    const count = document.getElementById('legsCount');
    box.classList.remove('hidden');
    count.textContent = multi ? `${legs.length} legs` : 'One road leg';
    const items = [];
    if (!multi) {
      const leg = legs[0];
      items.push(text('p', 'muted', `This load moves by one truck (${leg.origin} → ${leg.destination}).${canSplit() ? ' Add a leg if part of the way goes by sea, air, rail, a warehouse or a last-mile delivery.' : ''}`));
    } else {
      legs.forEach((leg, index) => {
        items.push(legCard(leg, shipment));
        const next = legs[index + 1];
        const handover = next && handovers.find((entry) => entry.fromLegId === leg.id && entry.toLegId === next.id);
        if (handover) {
          const line = text('div', 'leg-handover');
          line.append(text('strong', '', 'Handed over'), text('span', '', ` at ${handover.location || leg.destination} to leg ${next.sequence}${handover.receivedBy ? ` · received by ${handover.receivedBy}` : ''}${handover.note ? ` · ${handover.note}` : ''} · ${formatTimestamp(handover.createdAt)}`));
          items.push(line);
        }
      });
    }
    body.replaceChildren(...items);
    const addButton = document.getElementById('legAdd');
    addButton.classList.toggle('hidden', !canSplit());
    addButton.textContent = multi ? 'Add a leg' : 'Split into legs';
    if (view.form) body.append(view.form);
  }

  function canSplit() {
    const data = view.data;
    if (!data || !can('shipments:dispatch')) return false;
    if (['Delivered', 'Cancelled'].includes(data.shipment.status)) return false;
    return data.multi || (BEFORE_TRUCK.includes(data.shipment.status) && !data.legs[0].carrierId);
  }

  function legCard(leg, shipment) {
    const card = text('article', `leg-card status-${slug(leg.status)}`);
    const head = text('div', 'leg-head');
    head.append(text('strong', '', `${leg.sequence}. ${MODES[leg.mode] || leg.mode}`), text('span', `status-badge ${slug(leg.status)}`, leg.status));
    const lines = [
      text('div', 'leg-route', `${leg.origin} → ${leg.destination}`)
    ];
    const meta = [
      leg.carrierName ? `Carrier: ${leg.carrierName}` : null,
      leg.price !== null ? `Price: ${money(leg.price, leg.currency)}` : null,
      leg.reference ? `Ref: ${leg.reference}` : null,
      leg.paidAt ? `Paid to the carrier ${formatTimestamp(leg.paidAt)}` : null,
      leg.scheduledPickup ? `Pickup ${when(leg.scheduledPickup)}` : null,
      leg.scheduledDelivery ? `Delivery ${when(leg.scheduledDelivery)}` : null,
      ...(DETAIL_FIELDS[leg.mode] || []).filter(([key]) => leg.details[key]).map(([key, label]) => `${label}: ${leg.details[key]}`)
    ].filter(Boolean);
    if (meta.length) lines.push(text('div', 'leg-meta', meta.join(' · ')));
    if (leg.lastLocation) lines.push(text('div', 'leg-meta', `Now: ${leg.lastLocation}${leg.eta ? ` · ETA ${when(leg.eta)}` : ''}${leg.lastTrackedAt ? ` (${formatTimestamp(leg.lastTrackedAt)})` : ''}`));
    const actions = text('div', 'leg-actions');
    const add = (label, handler, cls = 'btn btn-ghost small') => {
      const button = text('button', cls, label);
      button.type = 'button';
      button.addEventListener('click', handler);
      actions.append(button);
    };
    const canBook = can('shipments:dispatch');
    const canMove = can('shipments:status');
    const canTrack = can('shipments:track');
    if (['Planned', 'Booked', 'In Transit', 'Exception'].includes(leg.status) && canBook) add('Edit', () => openForm({ leg }));
    if (leg.status === 'Delivered' && leg.price !== null && !leg.synthetic && can('shipments:finance')) {
      add(leg.paidAt ? 'Undo payment' : 'Mark paid', () => pay(leg, !leg.paidAt), leg.paidAt ? 'btn btn-ghost small' : 'btn btn-primary small');
    }
    if (leg.status === 'Planned' && canBook) add('Book', () => move(leg, 'Booked'), 'btn btn-primary small');
    if (leg.status === 'Booked' && canMove) add('Start', () => move(leg, 'In Transit'), 'btn btn-primary small');
    if (leg.status === 'In Transit' && canMove) add('Delivered', () => openHandover(leg), 'btn btn-primary small');
    if (leg.status === 'In Transit' && canMove) add('Report problem', () => move(leg, 'Exception'));
    if (leg.status === 'Exception' && canMove) add('Resume', () => move(leg, 'In Transit'), 'btn btn-primary small');
    if (['Booked', 'In Transit', 'Exception'].includes(leg.status) && canTrack) add('Add position', () => openPosition(leg));
    if (['Planned', 'Booked', 'Exception'].includes(leg.status) && canMove) add('Cancel leg', () => move(leg, 'Cancelled'));
    card.append(head, ...lines, actions);
    return card;
  }

  async function pay(leg, paid) {
    try {
      await api('PUT', `/api/v2/legs/${leg.id}/payment`, { paid });
      notify(paid ? `Leg ${leg.sequence} marked paid.` : `Payment of leg ${leg.sequence} undone.`, 'ok');
      await reload();
    } catch (error) {
      notify(error.message, 'error');
    }
  }

  async function move(leg, status, extra = {}) {
    try {
      await api('POST', `/api/v2/legs/${leg.id}/status`, { status, ...extra });
      notify(`Leg ${leg.sequence}: ${status}.`, 'ok');
      await reload();
    } catch (error) {
      notify(error.message, 'error');
    }
  }

  /* ---------- small forms inside the section ---------- */
  function field(label, input) {
    const wrapper = text('label');
    wrapper.append(text('span', '', label), input);
    return wrapper;
  }
  const input = (name, attrs = {}) => Object.assign(document.createElement('input'), { name, ...attrs });

  function formShell(title, onSubmit, submitLabel) {
    const form = text('form', 'leg-form tracking-form');
    form.autocomplete = 'off';
    form.append(text('strong', 'span-2', title));
    const message = text('p', 'shipment-form-message span-2');
    message.setAttribute('role', 'status');
    const footer = text('div', 'tracking-form-footer span-2');
    const cancel = text('button', 'btn btn-ghost small', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => { view.form = null; render(); });
    const submit = text('button', 'btn btn-primary small', submitLabel);
    submit.type = 'submit';
    footer.append(message, cancel, submit);
    form.append(footer);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      submit.disabled = true;
      message.textContent = '';
      try {
        await onSubmit(new FormData(form));
        view.form = null;
        await reload();
      } catch (error) {
        message.textContent = error.message;
      }
      submit.disabled = false;
    });
    return { form, footer, message };
  }

  function openHandover(leg) {
    const { form, footer } = formShell(`Leg ${leg.sequence} delivered: handover`, async (data) => {
      await api('POST', `/api/v2/legs/${leg.id}/status`, {
        status: 'Delivered',
        handover: { location: data.get('location'), receivedBy: data.get('receivedBy'), note: data.get('note') }
      });
      notify(`Leg ${leg.sequence} delivered.`, 'ok');
    }, 'Mark delivered');
    form.insertBefore(field('Handed over at', input('location', { value: leg.destination, maxLength: 200 })), footer);
    form.insertBefore(field('Received by', input('receivedBy', { maxLength: 120, placeholder: 'Person or company (optional)' })), footer);
    form.insertBefore(field('Note', input('note', { maxLength: 500, placeholder: 'Optional' })), footer);
    view.form = form;
    render();
  }

  function openPosition(leg) {
    const { form, footer } = formShell(`Where is leg ${leg.sequence} now?`, async (data) => {
      await api('POST', `/api/v2/legs/${leg.id}/tracking`, { location: data.get('location'), eta: data.get('eta') || undefined, note: data.get('note') || undefined });
      notify('Position saved.', 'ok');
    }, 'Save position');
    form.insertBefore(field('Place', input('location', { required: true, maxLength: 200, placeholder: 'Port, airport, terminal or road' })), footer);
    form.insertBefore(field('ETA date (optional)', input('eta', { type: 'date' })), footer);
    form.insertBefore(field('Note', input('note', { maxLength: 500, placeholder: 'Optional' })), footer);
    view.form = form;
    render();
  }

  // Add (no leg given) or edit a leg.
  async function openForm({ leg = null } = {}) {
    let carriers = [];
    if (can('carriers:read')) {
      try {
        carriers = (await api('GET', '/api/carriers')).carriers || [];
      } catch (_) {
        carriers = [];
      }
    }
    const editing = Boolean(leg);
    const { form, footer } = formShell(editing ? `Edit leg ${leg.sequence}` : 'Add a leg at the end', async (data) => {
      const body = {
        mode: data.get('mode') || leg.mode, origin: data.get('origin'), destination: data.get('destination'),
        carrierId: data.get('carrierId') ? Number(data.get('carrierId')) : null,
        price: data.get('price') === '' ? null : data.get('price'),
        scheduledPickup: data.get('scheduledPickup') || null, scheduledDelivery: data.get('scheduledDelivery') || null,
        reference: data.get('reference') || null, details: detailsFrom(form, data.get('mode') || leg.mode)
      };
      if (editing) await api('PATCH', `/api/v2/legs/${leg.id}`, body);
      else await api('POST', `/api/v2/shipments/${encodeURIComponent(view.shipment.id)}/legs`, body);
      notify(editing ? 'Leg saved.' : 'Leg added.', 'ok');
    }, editing ? 'Save leg' : 'Add leg');

    const mode = document.createElement('select');
    mode.name = 'mode';
    Object.entries(MODES).forEach(([value, label]) => mode.append(Object.assign(document.createElement('option'), { value, textContent: label })));
    mode.value = leg?.mode || 'OCEAN';
    mode.disabled = editing && leg.status !== 'Planned';
    const carrier = document.createElement('select');
    carrier.name = 'carrierId';
    carrier.append(Object.assign(document.createElement('option'), { value: '', textContent: 'No carrier yet' }));
    carriers.forEach((entry) => carrier.append(Object.assign(document.createElement('option'), { value: entry.id, textContent: `${entry.name} (${entry.mode})` })));
    carrier.value = leg?.carrierId ? String(leg.carrierId) : '';
    const detailBox = text('div', 'leg-details span-2');
    const draw = () => {
      detailBox.replaceChildren(...(DETAIL_FIELDS[mode.value] || []).map(([key, label]) => field(label, input(`detail:${key}`, { maxLength: 120, value: (leg && leg.mode === mode.value && leg.details[key]) || '' }))));
    };
    mode.addEventListener('change', draw);
    draw();

    const parts = [
      field('Mode', mode),
      field('Carrier', carrier),
      field('From', input('origin', { required: true, maxLength: 200, value: leg?.origin || '' })),
      field('To', input('destination', { required: true, maxLength: 200, value: leg?.destination || '' })),
      field(`Price (${leg?.currency || window.VeyraConfig?.currency || ''})`, input('price', { type: 'number', min: '0.01', step: '0.01', value: leg?.price ?? '' })),
      field('Reference (booking, B/L, AWB, CMR)', input('reference', { maxLength: 120, value: leg?.reference || '' })),
      field('Pickup date', input('scheduledPickup', { type: 'date', value: /^\d{4}-\d{2}-\d{2}$/.test(leg?.scheduledPickup || '') ? leg.scheduledPickup : '' })),
      field('Delivery date', input('scheduledDelivery', { type: 'date', value: /^\d{4}-\d{2}-\d{2}$/.test(leg?.scheduledDelivery || '') ? leg.scheduledDelivery : '' })),
      detailBox
    ];
    parts.forEach((part) => form.insertBefore(part, footer));
    view.form = form;
    render();
    form.querySelector('[name="origin"]')?.focus();
  }

  // The mode-specific inputs are named "detail:<key>".
  function detailsFrom(form, mode) {
    const details = {};
    (DETAIL_FIELDS[mode] || []).forEach(([key]) => {
      const value = form.elements[`detail:${key}`]?.value.trim();
      if (value) details[key] = value;
    });
    return details;
  }

  /* ---------- planner: a new order made of legs ---------- */
  function bindPlanner() {
    const modal = document.getElementById('legPlannerModal');
    const form = document.getElementById('legPlannerForm');
    const rows = document.getElementById('plannerLegs');
    if (!modal || !form || form.dataset.bound) return;
    form.dataset.bound = '1';
    const message = document.getElementById('legPlannerMessage');
    const close = () => modal.classList.add('hidden');

    const addRow = (preset = {}) => {
      const row = text('div', 'planner-leg shipment-form-grid');
      const mode = document.createElement('select');
      mode.name = 'mode';
      Object.entries(MODES).forEach(([value, label]) => mode.append(Object.assign(document.createElement('option'), { value, textContent: label })));
      mode.value = preset.mode || 'ROAD';
      const remove = text('button', 'btn btn-ghost small planner-remove', 'Remove');
      remove.type = 'button';
      remove.addEventListener('click', () => { if (rows.children.length > 1) { row.remove(); renumber(); } });
      row.append(text('strong', 'planner-number'), field('Mode', mode), field('From', input('origin', { required: true, maxLength: 200, value: preset.origin || '' })),
        field('To', input('destination', { required: true, maxLength: 200, value: preset.destination || '' })),
        field('Price', input('price', { type: 'number', min: '0.01', step: '0.01', placeholder: 'Optional' })),
        field('Reference', input('reference', { maxLength: 120, placeholder: 'Optional' })), remove);
      rows.append(row);
      renumber();
    };
    const renumber = () => Array.from(rows.children).forEach((row, index) => { row.querySelector('.planner-number').textContent = `Leg ${index + 1}`; });

    const open = () => {
      if (!isSignedIn()) {
        notify('Sign in to plan an order.', 'info');
        document.getElementById('loginTrigger')?.click();
        return;
      }
      if (!can('shipments:create')) {
        notify('Your role cannot create shipments.', 'error');
        return;
      }
      form.reset();
      rows.replaceChildren();
      const today = new Date();
      const later = new Date(today.getTime() + 14 * 86400000);
      form.elements.pickup.value = today.toISOString().slice(0, 10);
      form.elements.delivery.value = later.toISOString().slice(0, 10);
      addRow({ mode: 'ROAD' });
      addRow({ mode: 'OCEAN' });
      message.textContent = '';
      modal.classList.remove('hidden');
      form.elements.customer.focus();
    };
    document.querySelectorAll('[data-plan-legs]').forEach((button) => button.addEventListener('click', open));
    document.getElementById('plannerAddLeg')?.addEventListener('click', () => { if (rows.children.length < 12) addRow(); });
    document.getElementById('closeLegPlanner')?.addEventListener('click', close);
    modal.addEventListener('click', (event) => { if (event.target === modal) close(); });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      message.textContent = '';
      try {
        const legs = Array.from(rows.children).map((row) => {
          const get = (name) => row.querySelector(`[name="${name}"]`).value.trim();
          return { mode: get('mode'), origin: get('origin'), destination: get('destination'), price: get('price') === '' ? undefined : get('price'), reference: get('reference') || undefined };
        });
        const body = {
          customer: form.elements.customer.value.trim(), origin: form.elements.orderOrigin.value.trim(), destination: form.elements.orderDestination.value.trim(),
          pickup: form.elements.pickup.value, delivery: form.elements.delivery.value, weight: Number(form.elements.weight.value), equipment: form.elements.equipment.value,
          reference: form.elements.orderReference.value.trim() || undefined, customerRate: form.elements.customerRate.value === '' ? undefined : form.elements.customerRate.value, legs
        };
        const result = await api('POST', '/api/v2/shipments', body);
        close();
        notify(`${result.shipment.id} planned with ${legs.length} legs.`, 'ok');
        if (location.hash !== '#/shipments') location.hash = '#/shipments';
        else window.dispatchEvent(new HashChangeEvent('hashchange'));
        if (typeof openShipmentDetails === 'function') openShipmentDetails(result.shipment.id);
      } catch (error) {
        message.textContent = error.message;
      }
      submit.disabled = false;
    });
  }

  function bindSection() {
    const add = document.getElementById('legAdd');
    if (add && !add.dataset.bound) {
      add.dataset.bound = '1';
      add.addEventListener('click', () => openForm());
    }
  }

  function init() {
    bindPlanner();
    bindSection();
    // Fill the equipment list of the planner like the other forms.
    const equipment = document.querySelector('#legPlannerForm [data-equipment-select]');
    if (equipment && window.VeyraConfig?.equipment) {
      equipment.replaceChildren(...window.VeyraConfig.equipment.map((name) => Object.assign(document.createElement('option'), { value: name, textContent: name })));
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.VeyraLegs = { show, init, refreshEquipment: init };
})();
