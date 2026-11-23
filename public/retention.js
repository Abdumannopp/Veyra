/* =========================================================
   VEYRA — retention settings in Team & settings (Phase 6.2, see docs/API_V2.md)
   How long old detail of finished loads is kept. Saving removes nothing; "Remove now" asks first.
   Relies on helpers from script.js: getAuthHeaders, hasPermission, formatTimestamp, notify.
   ========================================================= */
(function () {
  const text = (tag, className, value) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined && value !== null) node.textContent = String(value);
    return node;
  };
  async function api(method, url, body) {
    const response = await fetch(url, { method, headers: getAuthHeaders(), body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || 'The request failed.');
    return data;
  }

  function render(box, data) {
    const form = text('form', 'cold-form retention-form');
    for (const category of data.categories) {
      const label = text('label', '', `${category.label} — days (min ${category.minDays})`);
      const input = Object.assign(document.createElement('input'), { name: category.key, type: 'number', min: category.minDays, max: 3650, step: 1, placeholder: 'keep for ever', value: data.settings[category.key] ?? '' });
      const count = data.preview[category.key];
      label.append(input, text('small', 'muted', count === null ? 'Kept for ever' : `${count} item(s) would be removed now`));
      form.append(label);
    }
    const auto = Object.assign(document.createElement('input'), { type: 'checkbox', name: 'auto', checked: data.settings.auto });
    const autoLabel = text('label', '', 'Remove automatically once a day');
    autoLabel.append(auto);
    const save = text('button', 'btn btn-ghost small', 'Save');
    save.type = 'submit';
    const runNow = text('button', 'btn btn-primary small', 'Remove now');
    runNow.type = 'button';
    const total = Object.values(data.preview).reduce((sum, count) => sum + (count || 0), 0);
    runNow.disabled = total === 0;
    const message = text('p', 'shipment-form-message', data.lastRun ? `Last removal: ${formatTimestamp(data.lastRun)}` : '');
    form.append(autoLabel, save, runNow, message);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const body = { auto: auto.checked };
      for (const category of data.categories) body[category.key] = form.elements[category.key].value.trim();
      try {
        render(box, await api('PUT', '/api/settings/retention', body));
        notify('Retention saved. Nothing was removed.', 'ok');
      } catch (error) {
        message.textContent = error.message;
      }
    });
    runNow.addEventListener('click', async () => {
      if (!window.confirm(`Remove ${total} old item(s) for good? This cannot be undone. Make sure you have a backup.`)) return;
      try {
        const result = await api('POST', '/api/settings/retention/run', { confirm: true });
        render(box, result);
        notify('Old data removed.', 'ok');
      } catch (error) {
        message.textContent = error.message;
      }
    });
    box.querySelector('[data-retention-body]').replaceChildren(form);
  }

  async function show() {
    const box = document.getElementById('retentionPanel');
    if (!box) return;
    if (typeof hasPermission !== 'function' || !hasPermission('settings:write')) {
      box.classList.add('hidden');
      return;
    }
    try {
      render(box, await api('GET', '/api/settings/retention'));
      box.classList.remove('hidden');
    } catch (_) {
      box.classList.add('hidden');
    }
  }

  window.VeyraRetention = { show };
})();
