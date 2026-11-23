/* =========================================================
   VEYRA — customs and dangerous goods in the load record (Phase 6.1, see docs/API_V2.md)
   Relies on helpers from script.js: getAuthHeaders, hasPermission, formatTimestamp, notify.
   Entered by people; no customs system is connected. The checks are format checks, not legal advice.
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
  const select = (name, values, current, empty) => {
    const node = document.createElement('select');
    node.name = name;
    if (empty !== undefined) node.append(new Option(empty, ''));
    for (const value of values) node.append(new Option(value, value));
    node.value = current || '';
    return node;
  };
  const field = (label, control) => {
    const wrap = text('label', '', label);
    wrap.append(control);
    return wrap;
  };

  const view = { shipment: null };

  function summaryLine(record) {
    if (!record) return 'Nothing recorded yet.';
    const parts = [
      `Customs: ${record.customsStatus}${record.declarationNo ? ` (${record.declarationNo})` : ''}`,
      record.hsCode ? `HS ${record.hsCode}` : null,
      record.originCountry && record.destinationCountry ? `${record.originCountry} → ${record.destinationCountry}` : null,
      record.incoterm,
      record.dangerous ? `Dangerous: ${record.unNumber} class ${record.dgClass}${record.packingGroup ? ` PG ${record.packingGroup}` : ''}` : null
    ];
    return parts.filter(Boolean).join(' · ');
  }

  function render(data) {
    const record = data.compliance;
    document.getElementById('complianceCount').textContent = record?.dangerous ? 'Dangerous goods' : (record ? record.customsStatus : '');
    const nodes = [text('div', record?.customsStatus === 'Held' ? 'leg-meta leg-late' : 'leg-meta', summaryLine(record))];
    for (const warning of data.warnings) nodes.push(text('div', 'leg-meta leg-late', warning.text));
    if (can('shipments:status')) {
      const form = text('form', 'cold-form compliance-form');
      const value = (key) => (record && record[key] !== null && record[key] !== undefined ? record[key] : '');
      form.append(
        field('Goods', input('goodsDescription', { maxLength: 300, value: value('goodsDescription') })),
        field('HS code', input('hsCode', { maxLength: 14, value: value('hsCode'), placeholder: '0806.10' })),
        field('From country', input('originCountry', { maxLength: 2, value: value('originCountry'), placeholder: 'UZ' })),
        field('To country', input('destinationCountry', { maxLength: 2, value: value('destinationCountry'), placeholder: 'KZ' })),
        field('Declared value', input('declaredValue', { type: 'number', min: 0, step: '0.01', value: value('declaredValue') })),
        field('Incoterm', select('incoterm', data.options.incoterms, value('incoterm'), '—')),
        field('Customs status', select('customsStatus', data.options.customsStatuses, value('customsStatus') || 'Not started')),
        field('Declaration no.', input('declarationNo', { maxLength: 60, value: value('declarationNo') }))
      );
      const dangerous = input('dangerous', { type: 'checkbox', checked: Boolean(record?.dangerous) });
      const dgBox = text('div', 'cold-form');
      dgBox.append(
        field('UN number', input('unNumber', { maxLength: 6, value: value('unNumber'), placeholder: 'UN1203' })),
        field('Class', select('dgClass', data.options.dgClasses, value('dgClass'), '—')),
        field('Packing group', select('packingGroup', ['I', 'II', 'III'], value('packingGroup'), '—')),
        field('Proper shipping name', input('properShippingName', { maxLength: 200, value: value('properShippingName') }))
      );
      dgBox.hidden = !dangerous.checked;
      dangerous.addEventListener('change', () => { dgBox.hidden = !dangerous.checked; });
      form.append(field('Dangerous goods', dangerous), dgBox);
      const message = text('p', 'shipment-form-message');
      const save = text('button', 'btn btn-primary small', 'Save customs data');
      save.type = 'submit';
      form.append(save, message);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        save.disabled = true;
        const get = (name) => form.elements[name].value.trim();
        try {
          render(await api('PUT', `/api/v2/shipments/${encodeURIComponent(view.shipment.id)}/compliance`, {
            goodsDescription: get('goodsDescription'), hsCode: get('hsCode'), originCountry: get('originCountry'), destinationCountry: get('destinationCountry'),
            declaredValue: get('declaredValue'), incoterm: get('incoterm'), customsStatus: get('customsStatus'), declarationNo: get('declarationNo'),
            dangerous: dangerous.checked, unNumber: get('unNumber'), dgClass: get('dgClass'), packingGroup: get('packingGroup'), properShippingName: get('properShippingName')
          }));
          if (typeof notify === 'function') notify('Customs data saved.', 'ok');
        } catch (error) {
          message.textContent = error.message;
          save.disabled = false;
        }
      });
      nodes.push(form);
    }
    document.getElementById('complianceBody').replaceChildren(...nodes);
  }

  async function show(shipment) {
    const box = document.getElementById('complianceSection');
    if (!box) return;
    view.shipment = shipment;
    try {
      render(await api('GET', `/api/v2/shipments/${encodeURIComponent(shipment.id)}/compliance`));
      box.classList.remove('hidden');
    } catch (_) {
      box.classList.add('hidden');
    }
  }

  window.VeyraCompliance = { show };
})();
