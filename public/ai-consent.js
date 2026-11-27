/* =========================================================
   VEYRA — AI data sharing in Team & settings (see docs/AI.md)
   Whether this company's order texts and documents may be sent to the outside AI provider (the one the server uses:
   OpenRouter, OpenAI, Anthropic or Google Gemini). A consent is for one provider: if the server changes provider, the
   administrator must agree again.
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
    const moved = !data.consent && data.consentedProvider && data.consentedProvider !== data.provider
      ? text('p', 'shipment-form-message', `Your company agreed to ${data.consentedProvider}, but its AI provider is now ${data.provider}. Nothing is sent to ${data.provider} until an administrator agrees again.`)
      : null;
    const state = text('p', '', data.consent
      ? `ON: order texts and documents may be sent to ${data.provider} when someone uses an AI agent.`
      : `OFF: nothing is sent to ${data.provider}. AI agents are paused for this company; forms work as usual.`);
    const last = text('small', 'muted', data.changedAt ? `Last changed ${formatTimestamp(data.changedAt)}${data.changedBy ? ` by ${data.changedBy}` : ''}. Every change is in the activity log.` : 'Never changed.');
    const note = text('small', 'muted', `What is sent: order texts (emails, pasted messages) and the uploaded document FILES themselves (PDF and photos of CMR, POD, B/L, AWB, rail notes). Passwords, API keys and tokens are removed from TEXT only; files are sent unchanged, so everything printed or written on a document reaches ${data.provider}, which is outside VEYRA.`);
    const notReady = data.providerReady === false
      ? text('p', 'shipment-form-message', `${data.provider} is not ready on this server: ${data.providerProblem || ''} AI is off for your company until it is fixed or another provider is chosen.`)
      : null;
    body.append(...(moved ? [moved] : []), ...(notReady ? [notReady] : []), state, last, note);
    if (data.canChange && Array.isArray(data.providerOptions)) {
      // The provider: one the server has ready (keys are kept on the server, never here), or the server default.
      const label = text('label', '', 'AI provider for your company');
      const select = document.createElement('select');
      const fallback = data.providerOptions.find((option) => option.isDefault);
      const first = Object.assign(document.createElement('option'), { value: '', textContent: `Server default (${fallback ? fallback.name : 'none'})` });
      select.append(first);
      for (const option of data.providerOptions) {
        const item = Object.assign(document.createElement('option'), { value: option.id, textContent: option.ready ? `${option.name}${option.model ? ` · ${option.model}` : ''}` : `${option.name} (not set up on this server)`, disabled: !option.ready });
        select.append(item);
      }
      select.value = data.providerChoice || '';
      select.addEventListener('change', async () => {
        const provider = select.value || null;
        if (!window.confirm('Change the AI provider? Data sharing must then be allowed again for the new provider before anything is sent.')) {
          select.value = data.providerChoice || '';
          return;
        }
        try {
          render(box, await api('PUT', '/api/settings/ai-provider', { provider }));
          notify('AI provider changed. Allow data sharing for it to use AI again.', 'ok');
        } catch (error) {
          select.value = data.providerChoice || '';
          notify(error.message, 'error');
        }
      });
      label.append(select);
      body.append(label);
    }
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
