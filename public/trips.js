/* =========================================================
   VEYRA — Trips (LTL): one truck run that carries several shipments. Screens for /api/v2/trips, see docs/API_V2.md.
   - A list of trips with a load bar (how full the truck is).
   - One trip: its facts, the loads on it (cost share, deliver one by one), adding and taking off loads, and the actions
     of a trip (book, start, report a problem, add a position, take back, cancel).
   Relies on helpers from script.js: getAuthHeaders, hasPermission, isSignedIn, notify, openShipmentDetails, formatDay, formatTimestamp.
   Everything is entered by people; no carrier is contacted.
   ========================================================= */
(function () {
  const STATUSES = ['Planned', 'Booked', 'In Transit', 'Exception', 'Delivered', 'Cancelled'];
  const KG_PER_LB = 0.45359237;
  const state = { filter: 'all', form: null, eligible: null };

  const slug = (value) => String(value || '').toLowerCase().replace(/\s+/g, '-');
  const can = (permission) => (typeof hasPermission === 'function' ? hasPermission(permission) : false);
  const root = () => document.getElementById('tripsView');

  function h(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => {
      if (value === undefined || value === null || value === false) return;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = String(value);
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, value);
    });
    [].concat(children).forEach((child) => {
      if (child === null || child === undefined || child === false) return;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    });
    return node;
  }

  async function api(method, url, body) {
    const response = await fetch(url, { method, headers: getAuthHeaders(), body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || 'The request failed.');
    return data;
  }

  /* ---------- weights are kept in kg; the company sees its own unit ---------- */
  const unit = () => (window.VeyraConfig?.weightUnit === 'lb' ? 'lb' : 'kg');
  const fromKg = (kg) => (unit() === 'lb' ? kg / KG_PER_LB : kg);
  const toKg = (value) => (unit() === 'lb' ? Number(value) * KG_PER_LB : Number(value));
  const weight = (kg) => (kg === null || kg === undefined ? '—' : `${Math.round(fromKg(kg) * 10) / 10} ${unit()}`);

  function money(value, currency) {
    if (value === null || value === undefined) return '—';
    const code = currency || window.VeyraConfig?.currency || 'USD';
    try {
      return Number(value).toLocaleString(window.VeyraConfig?.locale || 'en-US', { style: 'currency', currency: code, maximumFractionDigits: 2 });
    } catch (_) {
      return `${Number(value).toFixed(2)} ${code}`;
    }
  }
  const when = (value) => (!value ? '—' : (/^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDay(value) : formatTimestamp(value)));

  function bar(used, capacity, label) {
    if (!capacity) return h('div', { class: 'trip-bar-row' }, [h('span', { class: 'muted', text: `${label}: no limit set` })]);
    const share = Math.min(100, Math.round((used / capacity) * 100));
    return h('div', { class: 'trip-bar-row' }, [
      h('div', { class: 'trip-bar-label' }, [h('span', { text: label }), h('strong', { text: `${share}%` })]),
      h('div', { class: `trip-bar${share >= 100 ? ' full' : ''}`, role: 'img', 'aria-label': `${label} ${share}% full` }, h('span', { style: `width:${share}%` }))
    ]);
  }

  function params() {
    return new URLSearchParams((window.location.hash.split('?')[1]) || '');
  }

  /* ---------- the view ---------- */
  async function render() {
    const box = root();
    if (!box) return;
    if (!isSignedIn()) {
      box.replaceChildren(h('p', { class: 'muted', text: 'Sign in to see trips.' }));
      return;
    }
    const openId = Number(params().get('trip'));
    try {
      if (Number.isInteger(openId) && openId > 0) await renderTrip(box, openId);
      else await renderList(box);
    } catch (error) {
      box.replaceChildren(h('p', { class: 'muted', text: error.message }), h('button', { class: 'btn btn-ghost small', type: 'button', onclick: render }, 'Try again'));
    }
  }

  async function renderList(box) {
    const { trips } = await api('GET', '/api/v2/trips');
    const counts = Object.fromEntries(STATUSES.map((status) => [status, trips.filter((trip) => trip.status === status).length]));
    const shown = state.filter === 'all' ? trips : trips.filter((trip) => trip.status === state.filter);
    const chips = h('div', { class: 'status-tabs' }, ['all', ...STATUSES].map((key) => h('button', {
      class: `status-tab${state.filter === key ? ' active' : ''}`, type: 'button', 'aria-pressed': state.filter === key ? 'true' : 'false',
      onclick: () => { state.filter = key; render(); }
    }, [key === 'all' ? 'All' : key, h('b', { text: key === 'all' ? trips.length : counts[key] })])));
    const head = h('div', { class: 'trips-head' }, [
      chips,
      can('shipments:dispatch') ? h('button', { class: 'btn btn-primary small', type: 'button', onclick: () => { state.form = state.form === 'new' ? null : 'new'; render(); } }, '+ New trip') : null
    ]);
    const parts = [head];
    if (state.form === 'new') parts.push(await tripForm(null));
    const pools = await suggestions();
    if (pools.length) parts.push(suggestionPanel(pools));
    if (!shown.length) {
      parts.push(h('p', { class: 'muted trips-empty', text: trips.length
        ? 'No trips with this status.'
        : 'No trips yet. A trip is one truck run that carries several loads: put loads on it, book the truck once, and the price is shared by weight.' }));
    } else {
      parts.push(h('div', { class: 'trip-grid' }, shown.map(tripCard)));
    }
    box.replaceChildren(...parts);
  }

  /* ---------- loads that could share one truck ---------- */
  async function suggestions() {
    if (!can('shipments:dispatch')) return [];
    try {
      return (await api('GET', '/api/v2/trips/suggestions')).suggestions || [];
    } catch (_) {
      return [];
    }
  }

  function suggestionPanel(pools) {
    const cards = pools.slice(0, 6).map((pool) => h('div', { class: 'trip-card trip-suggestion' }, [
      h('div', { class: 'trip-card-head' }, [h('strong', { text: `${pool.loads.length} loads` }), h('span', { class: 'status-badge planned', text: 'Suggestion' })]),
      h('div', { class: 'trip-route', text: `${pool.origin} → ${pool.destination}` }),
      h('div', { class: 'trip-meta', text: pool.loads.map((load) => `${load.shipmentId} ${load.customer} (${weight(load.weightKg)})`).join(' · ') }),
      bar(pool.totalWeightKg, pool.capacityKg, `${weight(pool.totalWeightKg)} of a ${weight(pool.capacityKg)} truck`),
      h('div', { class: 'trip-meta', text: pool.pickupFrom ? `Pickup ${when(pool.pickupFrom)}${pool.pickupTo && pool.pickupTo !== pool.pickupFrom ? ` to ${when(pool.pickupTo)}` : ''}` : 'No pickup date' }),
      h('button', { class: 'btn btn-primary small', type: 'button', onclick: (event) => planFrom(pool, event.currentTarget) }, 'Plan this trip')
    ]));
    return h('div', { class: 'trip-suggestions' }, [
      h('div', { class: 'detail-timeline-head' }, [h('strong', { text: 'Loads that can share one truck' }), h('span', { text: 'Same lane, pickups within a few days, they fit one truck' })]),
      h('div', { class: 'trip-grid' }, cards)
    ]);
  }

  // Plans the trip with these loads on it; you choose the carrier and the price and book it on the trip page.
  async function planFrom(pool, button) {
    button.disabled = true;
    let tripId = null;
    try {
      const created = await api('POST', '/api/v2/trips', { origin: pool.origin, destination: pool.destination, capacityWeightKg: pool.capacityKg, scheduledPickup: pool.pickupFrom || undefined });
      tripId = created.trip.id;
      for (const load of pool.loads) await api('POST', `/api/v2/trips/${tripId}/shipments`, { shipmentId: load.shipmentId, weightKg: load.weightKg });
      state.eligible = null;
      notify(`${created.trip.number} planned with ${pool.loads.length} loads. Choose the carrier and book the truck.`, 'ok');
    } catch (error) {
      notify(error.message, 'error');
      button.disabled = false;
    }
    if (tripId) window.location.hash = `#/trips?trip=${tripId}`;
  }

  function tripCard(trip) {
    const card = h('button', { class: 'trip-card', type: 'button', onclick: () => { window.location.hash = `#/trips?trip=${trip.id}`; } }, [
      h('div', { class: 'trip-card-head' }, [h('strong', { text: trip.number }), h('span', { class: `status-badge ${slug(trip.status)}`, text: trip.status })]),
      h('div', { class: 'trip-route', text: `${trip.origin} → ${trip.destination}` }),
      h('div', { class: 'trip-meta', text: [trip.carrierName || 'No carrier yet', trip.truckPlate, trip.scheduledPickup ? `Pickup ${when(trip.scheduledPickup)}` : null].filter(Boolean).join(' · ') }),
      bar(trip.allocatedWeightKg, trip.capacityWeightKg, `${trip.shipmentCount} load${trip.shipmentCount === 1 ? '' : 's'} · ${weight(trip.allocatedWeightKg)}${trip.capacityWeightKg ? ` of ${weight(trip.capacityWeightKg)}` : ''}`),
      h('div', { class: 'trip-meta', text: trip.cost !== null ? `Truck price ${money(trip.cost, trip.currency)}` : 'No price yet' })
    ]);
    return card;
  }

  /* ---------- one trip ---------- */
  async function renderTrip(box, id) {
    const data = await api('GET', `/api/v2/trips/${id}`);
    const { trip, shipments, events } = data;
    const editable = ['Planned', 'Booked'].includes(trip.status);
    const parts = [];
    parts.push(h('div', { class: 'trips-head' }, [
      h('button', { class: 'btn btn-ghost small', type: 'button', onclick: () => { state.form = null; window.location.hash = '#/trips'; } }, '← All trips'),
      h('span', { class: `status-badge ${slug(trip.status)}`, text: trip.status })
    ]));
    parts.push(h('h3', { class: 'trip-title', text: `${trip.number} · ${trip.origin} → ${trip.destination}` }));
    const facts = [
      ['Carrier', trip.carrierName ? `${trip.carrierName}${trip.carrierPhone ? ` · ${trip.carrierPhone}` : ''}` : 'Not chosen yet'],
      ['Truck / driver', [trip.truckPlate, trip.driverName, trip.driverPhone].filter(Boolean).join(' · ') || '—'],
      ['Truck price', trip.cost !== null ? money(trip.cost, trip.currency) : '—'],
      ['Pickup / delivery', `${when(trip.scheduledPickup)} / ${when(trip.scheduledDelivery)}`],
      ['Position', trip.lastLocation ? `${trip.lastLocation}${trip.eta ? ` · ETA ${when(trip.eta)}` : ''}${trip.lastTrackedAt ? ` (${formatTimestamp(trip.lastTrackedAt)})` : ''}` : '—'],
      ['Customers pay / margin', trip.totals.revenue !== null ? `${money(trip.totals.revenue, trip.currency)}${trip.totals.margin !== null ? ` / ${money(trip.totals.margin, trip.currency)}` : ''}` : '—']
    ];
    parts.push(h('dl', { class: 'shipment-detail-grid trip-facts' }, facts.map(([label, value]) => h('div', {}, [h('dt', { text: label }), h('dd', { text: value })]))));
    if (trip.notes) parts.push(h('p', { class: 'muted', text: trip.notes }));
    parts.push(h('div', { class: 'trip-bars' }, [
      bar(trip.totals.weightKg, trip.capacityWeightKg, `Weight ${weight(trip.totals.weightKg)}${trip.capacityWeightKg ? ` of ${weight(trip.capacityWeightKg)}` : ''}`),
      trip.capacityPallets ? bar(trip.totals.pallets, trip.capacityPallets, `Pallets ${trip.totals.pallets} of ${trip.capacityPallets}`) : null
    ]));
    parts.push(actions(trip));
    if (state.form === 'edit') parts.push(await tripForm(trip));
    if (state.form === 'position') parts.push(positionForm(trip));

    parts.push(h('div', { class: 'detail-timeline-head' }, [h('strong', { text: 'Loads on this truck' }), h('span', { text: trip.status === 'Planned' ? 'The price is shared by weight when the trip is booked' : 'Cost share = the truck price by weight' })]));
    parts.push(loadsTable(trip, shipments));
    if (editable && can('shipments:dispatch')) parts.push(await addLoadPanel(trip));

    parts.push(h('div', { class: 'detail-timeline-head' }, [h('strong', { text: 'History' }), h('span', { text: 'Newest first' })]));
    parts.push(h('div', { class: 'detail-timeline' }, events.length ? events.map((event) => h('div', { class: 'detail-timeline-item' }, [
      h('span', { class: 'timeline-marker' }),
      h('div', {}, [h('strong', { text: event.toStatus }), h('p', { text: event.note || '' }), h('time', { text: `${formatTimestamp(event.createdAt)}${event.actor ? ` · ${event.actor}` : ''}` })])
    ])) : [h('p', { class: 'muted', text: 'No history yet.' })]));
    box.replaceChildren(...parts.filter(Boolean));
  }

  function actions(trip) {
    const row = h('div', { class: 'trip-actions' });
    const add = (label, handler, cls = 'btn btn-ghost small') => row.append(h('button', { class: cls, type: 'button', onclick: handler }, label));
    const dispatch = can('shipments:dispatch');
    const move = can('shipments:status');
    const status = (next, message) => async () => {
      try {
        await api('POST', `/api/v2/trips/${trip.id}/status`, { status: next });
        notify(message, 'ok');
        state.form = null;
        render();
      } catch (error) {
        notify(error.message, 'error');
      }
    };
    if (['Planned', 'Booked'].includes(trip.status) && dispatch) add('Edit', () => { state.form = state.form === 'edit' ? null : 'edit'; render(); });
    if (trip.status === 'Planned' && dispatch) add('Book the truck', status('Booked', `${trip.number} booked: every load is on the truck.`), 'btn btn-primary small');
    if (trip.status === 'Booked' && move) add('Start', status('In Transit', `${trip.number} is on the road.`), 'btn btn-primary small');
    if (trip.status === 'Booked' && dispatch) add('Take back to planned', status('Planned', `${trip.number} is planned again; the carrier is free.`));
    if (trip.status === 'In Transit' && move) add('Report problem', status('Exception', `${trip.number}: problem reported.`));
    if (trip.status === 'Exception' && move) add('Resume', status('In Transit', `${trip.number} continues.`), 'btn btn-primary small');
    if (['Booked', 'In Transit', 'Exception'].includes(trip.status) && can('shipments:track')) add('Add position', () => { state.form = state.form === 'position' ? null : 'position'; render(); });
    if (['Planned', 'Booked'].includes(trip.status) && dispatch) add('Cancel trip', () => { if (window.confirm(`Cancel ${trip.number}? Its loads wait for a truck again.`)) status('Cancelled', `${trip.number} cancelled.`)(); });
    return row;
  }

  function loadsTable(trip, shipments) {
    if (!shipments.length) return h('p', { class: 'muted', text: 'No loads yet. Add loads that are still waiting for a truck.' });
    const canDeliver = can('shipments:status') && trip.status === 'In Transit';
    const canRemove = can('shipments:dispatch') && ['Planned', 'Booked'].includes(trip.status);
    const rows = shipments.map((item) => h('tr', {}, [
      h('td', {}, h('button', { class: 'link-btn id-link', type: 'button', onclick: () => openShipmentDetails(item.shipmentId) }, item.shipmentId)),
      h('td', { text: item.customer }),
      h('td', {}, [h('span', { text: item.origin }), h('small', { class: 'cell-sub', text: `→ ${item.destination}` })]),
      h('td', { text: weight(item.weightKg) }),
      h('td', { text: item.pallets || '—' }),
      h('td', { text: item.costShare !== null ? money(item.costShare, trip.currency) : '—' }),
      h('td', {}, h('span', { class: `status-badge ${slug(item.status)}`, text: item.status })),
      h('td', {}, [
        canDeliver && !item.deliveredAt ? h('button', { class: 'btn btn-primary small', type: 'button', onclick: () => deliver(trip, item) }, 'Delivered') : null,
        canRemove ? h('button', { class: 'btn btn-ghost small', type: 'button', onclick: () => remove(trip, item) }, 'Take off') : null
      ])
    ]));
    return h('div', { class: 'table-scroll' }, h('table', { class: 'data-table compact' }, [
      h('thead', {}, h('tr', {}, ['Load', 'Customer', 'Lane', 'Weight', 'Pallets', 'Cost share', 'Status', ''].map((title) => h('th', { text: title })))),
      h('tbody', {}, rows)
    ]));
  }

  async function deliver(trip, item) {
    try {
      const result = await api('POST', `/api/v2/trips/${trip.id}/shipments/${item.shipmentId}/deliver`, {});
      notify(result.trip.status === 'Delivered' ? `${item.shipmentId} delivered. ${trip.number} is complete.` : `${item.shipmentId} delivered.`, 'ok');
      render();
    } catch (error) {
      notify(error.message, 'error');
    }
  }

  async function remove(trip, item) {
    try {
      await api('DELETE', `/api/v2/trips/${trip.id}/shipments/${item.shipmentId}`);
      state.eligible = null;
      notify(`${item.shipmentId} is off the trip and waits for a truck.`, 'ok');
      render();
    } catch (error) {
      notify(error.message, 'error');
    }
  }

  // Loads still waiting for a truck: not booked, not on a trip, not several legs.
  async function loadEligible() {
    if (state.eligible) return state.eligible;
    const found = [];
    for (const status of ['New', 'Sourcing', 'Pending Approval']) {
      const result = await api('GET', `/api/shipments/search?status=${encodeURIComponent(status)}&limit=100`).catch(() => ({ items: [] }));
      found.push(...result.items);
    }
    state.eligible = found.filter((item) => !item.carrierId && !item.tripId && item.legMode !== 'multi');
    return state.eligible;
  }

  async function addLoadPanel(trip) {
    const eligible = await loadEligible();
    const form = h('form', { class: 'tracking-form trip-add', autocomplete: 'off' });
    const message = h('p', { class: 'shipment-form-message span-2', role: 'status' });
    if (!eligible.length) {
      return h('p', { class: 'muted', text: 'No loads are waiting for a truck right now. Create a load (equipment LTL for part loads) and it will appear here.' });
    }
    const select = h('select', { name: 'shipmentId', required: true }, [
      h('option', { value: '', text: 'Choose a load…' }),
      ...eligible.map((item) => h('option', { value: item.id, text: `${item.id} · ${item.customer} · ${item.origin} → ${item.destination} · ${item.weight || ''}` }))
    ]);
    const weightInput = h('input', { name: 'weight', type: 'number', min: '0.01', step: '0.01', placeholder: `${unit()} (default: the load's own weight)` });
    const pallets = h('input', { name: 'pallets', type: 'number', min: '0', max: '200', step: '1', placeholder: 'Optional' });
    form.append(
      h('strong', { class: 'span-2', text: 'Put a load on this trip' }),
      h('label', { class: 'span-2' }, [h('span', { text: 'Load' }), select]),
      h('label', {}, [h('span', { text: `Weight on the truck (${unit()})` }), weightInput]),
      h('label', {}, [h('span', { text: 'Pallet places' }), pallets]),
      h('div', { class: 'tracking-form-footer span-2' }, [message, h('button', { class: 'btn btn-primary small', type: 'submit' }, 'Add to trip')])
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      message.textContent = '';
      try {
        const body = { shipmentId: select.value };
        if (weightInput.value !== '') body.weightKg = toKg(weightInput.value);
        if (pallets.value !== '') body.pallets = Number(pallets.value);
        await api('POST', `/api/v2/trips/${trip.id}/shipments`, body);
        state.eligible = null;
        notify(`${select.value} is on ${trip.number}.`, 'ok');
        render();
      } catch (error) {
        message.textContent = error.message;
      }
    });
    return form;
  }

  /* ---------- forms: new / edit trip, position ---------- */
  async function carriers() {
    if (!can('carriers:read')) return [];
    try {
      const list = await api('GET', '/api/carriers');
      return Array.isArray(list) ? list : [];
    } catch (_) {
      return [];
    }
  }

  async function tripForm(trip) {
    const editing = Boolean(trip);
    const list = await carriers();
    const form = h('form', { class: 'tracking-form trip-form', autocomplete: 'off' });
    const message = h('p', { class: 'shipment-form-message span-2', role: 'status' });
    const input = (name, label, attrs = {}) => h('label', {}, [h('span', { text: label }), h('input', { name, ...attrs })]);
    const carrierSelect = h('select', { name: 'carrierId', disabled: editing && trip.status === 'Booked' }, [
      h('option', { value: '', text: 'Not chosen yet' }),
      ...list.map((carrier) => h('option', { value: carrier.id, text: `${carrier.name} (${carrier.mode})`, selected: editing && trip.carrierId === carrier.id }))
    ]);
    form.append(
      h('strong', { class: 'span-2', text: editing ? `Edit ${trip.number}` : 'Plan a new trip' }),
      input('origin', 'From', { required: true, maxlength: '200', value: trip?.origin || '' }),
      input('destination', 'To', { required: true, maxlength: '200', value: trip?.destination || '' }),
      h('label', {}, [h('span', { text: 'Carrier' }), carrierSelect]),
      input('cost', `Truck price (${trip?.currency || window.VeyraConfig?.currency || ''})`, { type: 'number', min: '0.01', step: '0.01', value: trip?.cost ?? '', placeholder: 'Optional now' }),
      input('capacityWeight', `Weight the truck takes (${unit()})`, { type: 'number', min: '1', step: '1', value: trip?.capacityWeightKg ? Math.round(fromKg(trip.capacityWeightKg) * 10) / 10 : '' }),
      input('capacityPallets', 'Pallet places', { type: 'number', min: '1', max: '200', step: '1', value: trip?.capacityPallets ?? '' }),
      input('scheduledPickup', 'Pickup date', { type: 'date', value: /^\d{4}-\d{2}-\d{2}$/.test(trip?.scheduledPickup || '') ? trip.scheduledPickup : '' }),
      input('scheduledDelivery', 'Delivery date', { type: 'date', value: /^\d{4}-\d{2}-\d{2}$/.test(trip?.scheduledDelivery || '') ? trip.scheduledDelivery : '' }),
      input('truckPlate', 'Truck plate', { maxlength: '20', value: trip?.truckPlate || '' }),
      input('driverName', 'Driver', { maxlength: '120', value: trip?.driverName || '' }),
      input('driverPhone', 'Driver phone', { type: 'tel', maxlength: '40', value: trip?.driverPhone || '' }),
      input('notes', 'Notes', { maxlength: '500', value: trip?.notes || '' }),
      h('div', { class: 'tracking-form-footer span-2' }, [
        message,
        h('button', { class: 'btn btn-ghost small', type: 'button', onclick: () => { state.form = null; render(); } }, 'Cancel'),
        h('button', { class: 'btn btn-primary small', type: 'submit' }, editing ? 'Save trip' : 'Create trip')
      ])
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      message.textContent = '';
      const get = (name) => form.elements[name]?.value.trim();
      const body = {
        origin: get('origin'), destination: get('destination'),
        cost: get('cost') === '' ? null : get('cost'),
        capacityWeightKg: get('capacityWeight') === '' ? null : toKg(get('capacityWeight')),
        capacityPallets: get('capacityPallets') === '' ? null : Number(get('capacityPallets')),
        scheduledPickup: get('scheduledPickup') || null, scheduledDelivery: get('scheduledDelivery') || null,
        truckPlate: get('truckPlate') || null, driverName: get('driverName') || null, driverPhone: get('driverPhone') || null, notes: get('notes') || null
      };
      if (!carrierSelect.disabled) body.carrierId = get('carrierId') ? Number(get('carrierId')) : null;
      try {
        if (editing) {
          await api('PATCH', `/api/v2/trips/${trip.id}`, body);
          notify('Trip saved.', 'ok');
          state.form = null;
          render();
        } else {
          const created = await api('POST', '/api/v2/trips', body);
          notify(`${created.trip.number} planned. Now put loads on it.`, 'ok');
          state.form = null;
          window.location.hash = `#/trips?trip=${created.trip.id}`;
        }
      } catch (error) {
        message.textContent = error.message;
      }
    });
    return form;
  }

  function positionForm(trip) {
    const form = h('form', { class: 'tracking-form trip-form', autocomplete: 'off' });
    const message = h('p', { class: 'shipment-form-message span-2', role: 'status' });
    form.append(
      h('strong', { class: 'span-2', text: `Where is ${trip.number} now?` }),
      h('label', {}, [h('span', { text: 'Place' }), h('input', { name: 'location', required: true, maxlength: '200', placeholder: 'City, border crossing or road' })]),
      h('label', {}, [h('span', { text: 'ETA date (optional)' }), h('input', { name: 'eta', type: 'date' })]),
      h('label', { class: 'span-2' }, [h('span', { text: 'Note (optional)' }), h('input', { name: 'note', maxlength: '500' })]),
      h('p', { class: 'muted span-2', text: 'This is the position of every load still on the truck.' }),
      h('div', { class: 'tracking-form-footer span-2' }, [
        message,
        h('button', { class: 'btn btn-ghost small', type: 'button', onclick: () => { state.form = null; render(); } }, 'Cancel'),
        h('button', { class: 'btn btn-primary small', type: 'submit' }, 'Save position')
      ])
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      message.textContent = '';
      try {
        const result = await api('POST', `/api/v2/trips/${trip.id}/tracking`, { location: form.elements.location.value.trim(), eta: form.elements.eta.value || undefined, note: form.elements.note.value.trim() || undefined });
        notify(`Position saved for ${result.update.loads} load${result.update.loads === 1 ? '' : 's'}.`, 'ok');
        state.form = null;
        render();
      } catch (error) {
        message.textContent = error.message;
      }
    });
    return form;
  }

  window.VeyraTrips = { render };
})();
