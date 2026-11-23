/* =========================================================
   VEYRA — AI data sharing in Team & settings (see docs/AI.md)
   Whether this company's order texts and documents may be sent to the outside AI provider (OpenRouter).
   Off until an administrator switches it on; every change is written to the activity log (who and when).
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
    const body = text('div', 'ai-consent-body');
    const state = text('p', '', data.consent
      ? `ON: order texts and documents may be sent to ${data.provider} when someone uses an AI agent.`
      : `OFF: nothing is sent to ${data.provider}. AI agents are paused for this company; forms work as usual.`);
    const last = text('small', 'muted', data.changedAt ? `Last changed ${formatTimestamp(data.changedAt)}${data.changedBy ? ` by ${data.changedBy}` : ''}. Every change is in the activity log.` : 'Never changed.');
    const note = text('small', 'muted', `What is sent: order texts (emails, pasted messages) and the uploaded document FILES themselves (PDF and photos of CMR, POD, B/L, AWB, rail notes). Passwords, API keys and tokens are removed from TEXT only; files are sent unchanged, so everything printed or written on a document reaches ${data.provider}, which is outside VEYRA.`);
    body.append(state, last, note);
    if (data.canChange) {
      const button = text('button', data.consent ? 'btn btn-ghost small' : 'btn btn-primary small', data.consent ? 'Switch off' : 'Allow sending to the AI provider');
      button.type = 'button';
      button.addEventListener('click', async () => {
        const next = !data.consent;
        if (next && !window.confirm(`Allow VEYRA to send order texts AND document files (PDF, photos, sent unchanged) to ${data.provider} for AI reading?`)) return;
        try {
          render(box, await api('PUT', '/api/settings/ai-consent', { consent: next }));
          notify(next ? 'AI data sharing switched on.' : 'AI data sharing switched off.', 'ok');
        } catch (error) {
          notify(error.message, 'error');
        }
      });
      body.append(button);
    }
    box.querySelector('[data-ai-consent-body]').replaceChildren(body);
  }

  async function show() {
    const box = document.getElementById('aiConsentPanel');
    if (!box) return;
    if (typeof hasPermission !== 'function' || !hasPermission('users:read')) {
      box.classList.add('hidden');
      return;
    }
    try {
      render(box, await api('GET', '/api/settings/ai-consent'));
      box.classList.remove('hidden');
    } catch (_) {
      box.classList.add('hidden');
    }
  }

  window.VeyraAiConsent = { show };
})();
