/* =========================================================
   VEYRA — cold chain in the load record (Phase 5.1, see docs/API_V2.md)
   The temperature range a load must stay in, the readings people record, and the stretches outside the range.
   Relies on helpers from script.js: getAuthHeaders, hasPermission, formatTimestamp.
   Readings are typed by people; there is no sensor or logger connection behind them.
   ========================================================= */
(function () {
  const text = (tag, className, value) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined && value !== null) node.textContent = String(value);
    return node;
  };
  const can = (permission) => (typeof hasPermission === 'function' ? hasPermission(permission) : false);
  async function api(method, url, body) {
    const response = await fetch(url, { method, headers: getAuthHeaders(), body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || 'The request failed.');
    return data;
  }
  const input = (name, attrs = {}) => Object.assign(document.createElement('input'), { name, ...attrs });
  const field = (label, control) => {
    const wrap = text('label', '', label);
    wrap.append(control);
    return wrap;
  };

  const view = { shipment: null };

  function render(data) {
    const body = document.getElementById('coldBody');
    const count = document.getElementById('coldCount');
    const nodes = [];
    count.textContent = data.range ? `${data.range.min} to ${data.range.max} °C` : 'No range set';
    const open = data.excursions.filter((item) => item.open);
    if (open.length) {
      const item = open[0];
      nodes.push(text('div', 'leg-meta leg-late', `Now ${item.direction === 'too_warm' ? 'too warm' : 'too cold'}: ${item.peak} °C since ${formatTimestamp(item.startedAt)}`));
    }
    const closed = data.excursions.filter((item) => !item.open);
    if (closed.length) nodes.push(text('div', 'leg-meta', `Earlier outside the range: ${closed.length} time${closed.length === 1 ? '' : 's'} (longest ${Math.max(...closed.map((item) => item.minutes))} min)`));
    const latest = data.readings.slice(-6).reverse();
    if (latest.length) {
      const list = text('ul', 'cold-readings');
      for (const reading of latest) {
        const outside = data.range && (reading.celsius > data.range.max || reading.celsius < data.range.min);
        list.append(text('li', outside ? 'leg-late' : '', `${reading.celsius} °C · ${formatTimestamp(reading.recordedAt)}${reading.note ? ` · ${reading.note}` : ''}${reading.actor ? ` · ${reading.actor}` : ''}`));
      }
      nodes.push(list);
    } else {
      nodes.push(text('p', 'muted', 'No readings yet.'));
    }

    if (can('shipments:status')) {
      const form = text('form', 'cold-form');
      form.append(
        field('Min °C', input('min', { type: 'number', step: '0.1', value: data.range ? data.range.min : '' })),
        field('Max °C', input('max', { type: 'number', step: '0.1', value: data.range ? data.range.max : '' }))
      );
      const save = text('button', 'btn btn-ghost small', data.range ? 'Save range' : 'Set range');
      save.type = 'submit';
      form.append(save);
      form.addEventListener('submit', (event) => submit(event, form, 'PUT', 'temperature-range', () => {
        const value = (name) => form.elements[name].value.trim();
        return value('min') === '' && value('max') === '' ? { min: null, max: null } : { min: value('min'), max: value('max') };
      }));
      nodes.push(form);
    }
    if (can('shipments:track') && !['Cancelled', 'Delivered'].includes(view.shipment.status)) {
      const form = text('form', 'cold-form');
      form.append(
        field('Reading °C', input('celsius', { type: 'number', step: '0.1', required: true })),
        field('Note', input('note', { maxLength: 300, placeholder: 'optional' }))
      );
      const add = text('button', 'btn btn-primary small', 'Add reading');
      add.type = 'submit';
      form.append(add);
      form.addEventListener('submit', (event) => submit(event, form, 'POST', 'temperatures', () => ({ celsius: form.elements.celsius.value, note: form.elements.note.value })));
      nodes.push(form);
    }
    const message = text('p', 'shipment-form-message');
    message.id = 'coldMessage';
    message.setAttribute('role', 'status');
    nodes.push(message);
    body.replaceChildren(...nodes);
  }

  async function submit(event, form, method, path, payload) {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const data = await api(method, `/api/v2/shipments/${encodeURIComponent(view.shipment.id)}/${path}`, payload());
      render(data);
    } catch (error) {
      const message = document.getElementById('coldMessage');
      if (message) message.textContent = error.message;
      button.disabled = false;
    }
  }

  async function show(shipment) {
    const box = document.getElementById('coldSection');
    if (!box) return;
    view.shipment = shipment;
    try {
      render(await api('GET', `/api/v2/shipments/${encodeURIComponent(shipment.id)}/temperatures`));
      box.classList.remove('hidden');
    } catch (_) {
      box.classList.add('hidden');
    }
  }

  window.VeyraColdChain = { show };
})();
