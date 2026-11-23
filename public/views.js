/* =========================================================
   VEYRA — app views: Shipments, Carriers, Analytics
   Hash routing (#/dashboard, #/shipments, #/carriers, #/analytics).
   Relies on helpers defined in script.js:
   createTextElement, getAuthHeaders, getCurrentPermissions,
   openShipmentDetails, allowedShipmentStatuses,
   fetchDashboardData, loadAdminConsole.
   ========================================================= */
(function () {
  const VIEWS = ['dashboard', 'shipments', 'trips', 'tracking', 'quotes', 'inbox', 'command', 'automation', 'carriers', 'agents', 'analytics', 'billing', 'settings'];
  const STATUS_ORDER = ['New', 'Sourcing', 'Pending Approval', 'Dispatched', 'In Transit', 'Exception', 'Delivered', 'Cancelled'];
  const STATUS_COLORS = {
    New: '#2563ff',
    Sourcing: '#38bdf8',
    'Pending Approval': '#fbbf24',
    Dispatched: '#a78bfa',
    'In Transit': '#7dd3fc',
    Delivered: '#14b8a6',
    Exception: '#f87171',
    Cancelled: '#64748b'
  };
  const equipmentList = () => window.VeyraConfig?.equipment || ['Dry Van', 'Tent / Curtainsider', 'Reefer', 'Flatbed', 'LTL', 'Expedited'];
  const TRACKABLE = ['Dispatched', 'In Transit', 'Exception'];
  const CARRIER_MODES = ['Truckload', 'LTL', 'Expedited', 'Reefer', 'Flatbed', 'Intermodal'];

  const state = {
    view: 'dashboard',
    params: new URLSearchParams(),
    shipments: { items: [], total: 0, allCount: 0, statusCounts: {}, page: 1, pages: 1, loaded: false, status: 'all', q: '', equipment: '', sort: 'newest' },
    carriers: { list: [], filter: 'all', q: '', formOpen: false },
    analytics: { days: 7, data: null }
  };

  /* ---------- helpers ---------- */
  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => {
      if (value === undefined || value === null || value === false) return;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = String(value);
      else if (key === 'style') node.setAttribute('style', value);
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else node.setAttribute(key, value === true ? '' : value);
    });
    (Array.isArray(children) ? children : [children]).forEach((child) => {
      if (child === null || child === undefined || child === false) return;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    });
    return node;
  }

  function icon(name, cls = 'ico') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', cls);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  const currentUser = () => {
    try {
      return JSON.parse(localStorage.getItem('veyraUser') || 'null');
    } catch (_) {
      return null;
    }
  };
  const can = (permission) => {
    const permissions = getCurrentPermissions();
    return permissions.includes('*') || permissions.includes(permission);
  };
  const slug = (value) => String(value || '').toLowerCase().replace(/\s+/g, '-');
  const money = (value, digits = 0) => formatMoney(value, digits);
  const pct = (value) => (value === null || value === undefined ? '—' : `${Math.round(Number(value) * 100)}%`);
  const prettyDate = (value) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return value || '—';
    return new Date(Date.UTC(+match[1], +match[2] - 1, +match[3])).toLocaleDateString(window.VeyraConfig?.locale || 'en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  };

  async function api(url, options = {}) {
    const response = await fetch(url, { headers: getAuthHeaders(), ...options });
    let body = null;
    try {
      body = await response.json();
    } catch (_) {
      body = null;
    }
    if (!response.ok) throw new Error(body?.message || `Request failed (${response.status})`);
    return body;
  }

  let toastTimer;
  function toast(message, type = 'ok') {
    const node = document.getElementById('toast');
    if (!node) return;
    node.textContent = message;
    node.className = `toast ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.add('hidden'), 3600);
  }

  function gate(container, kind) {
    const signedOut = kind === 'signin';
    const box = el('div', { class: 'card empty-state' }, [
      el('span', { class: 'empty-icon' }, icon(signedOut ? 'eye' : 'alert')),
      el('h3', { text: signedOut ? 'Sign in to open this page' : 'You don\'t have access to this page' }),
      el('p', {
        text: signedOut
          ? 'Live shipments, carriers and analytics are available to workspace members.'
          : 'Your role doesn\'t include this permission. Ask an administrator for access.'
      }),
      signedOut ? el('button', { class: 'btn btn-primary small', type: 'button', onclick: () => document.getElementById('loginTrigger')?.click() }, 'Sign in') : null
    ]);
    container.replaceChildren(box);
  }

  function loading(container) {
    container.replaceChildren(el('div', { class: 'card empty-state' }, [el('span', { class: 'spinner' }), el('p', { text: 'Loading…' })]));
  }

  function errorState(container, message, retry) {
    container.replaceChildren(el('div', { class: 'card empty-state' }, [
      el('span', { class: 'empty-icon danger' }, icon('alert')),
      el('h3', { text: 'Something went wrong' }),
      el('p', { text: message }),
      el('button', { class: 'btn btn-ghost small', type: 'button', onclick: retry }, 'Try again')
    ]));
  }

  function statusTag(status) {
    return el('span', { class: `tag ${slug(status)}`, text: status });
  }

  /* ---------- router ---------- */
  function parseHash() {
    const raw = window.location.hash.replace(/^#\/?/, '');
    const [path, query = ''] = raw.split('?');
    const view = VIEWS.includes(path) ? path : 'dashboard';
    return { view, params: new URLSearchParams(query) };
  }

  function navigate(view, params = {}) {
    const query = new URLSearchParams(params).toString();
    const target = `#/${view}${query ? `?${query}` : ''}`;
    if (window.location.hash === target) route();
    else window.location.hash = target;
  }

  function route() {
    const { view, params } = parseHash();
    state.view = view;
    state.params = params;
    const TITLES = { dashboard: 'Dashboard', shipments: 'Shipments', trips: 'Trips', tracking: 'Global Tracking', quotes: 'Quotes', command: 'AI Command Center', automation: 'Automation Studio', inbox: 'Inbox & tasks', carriers: 'Carriers', agents: 'AI Agents', analytics: 'Analytics', billing: 'Billing', settings: 'Team & settings' };
    document.title = `${TITLES[view]} | Veyra`;

    document.querySelectorAll('.view[data-view]').forEach((node) => node.classList.toggle('hidden', node.dataset.view !== view));
    document.querySelector('.dashboard-panel')?.classList.toggle('is-wide', view !== 'dashboard');

    const activeNav = view === 'shipments' && params.get('status') === 'Pending Approval' ? 'approvals' : view;
    document.querySelectorAll('.side-nav [data-nav]').forEach((link) => {
      const isActive = link.dataset.nav === activeNav;
      link.classList.toggle('active', isActive);
      if (isActive) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });

    const search = document.getElementById('globalSearch');
    if (view === 'shipments') {
      state.shipments.status = params.get('status') && STATUS_ORDER.includes(params.get('status')) ? params.get('status') : 'all';
      state.shipments.q = params.get('q') || '';
      state.shipments.page = 1;
      if (search) search.value = state.shipments.q;
      renderShipments();
    } else if (view === 'carriers') {
      if (search) search.value = state.carriers.q;
      renderCarriers();
    } else if (view === 'inbox') {
      if (search) search.value = '';
      renderInbox();
    } else if (view === 'analytics') {
      if (search) search.value = '';
      renderAnalytics();
    } else if (view === 'agents') {
      if (search) search.value = '';
      renderAgents();
    } else if (view === 'quotes') {
      if (search) search.value = '';
      renderQuotes();
    } else if (view === 'command') {
      if (search) search.value = '';
      renderCommand();
    } else if (view === 'automation') {
      if (search) search.value = '';
      renderStudio();
    } else if (view === 'trips') {
      if (search) search.value = '';
      window.VeyraTrips?.render();
    } else if (view === 'tracking') {
      if (search) search.value = '';
      renderTracking();
    } else if (view === 'billing') {
      if (search) search.value = '';
      renderBilling();
    } else if (view === 'settings') {
      if (search) search.value = '';
      renderSettings();
      window.VeyraRetention?.show();
    } else {
      if (search) search.value = '';
      // Coming back to the dashboard shows fresh numbers, not the ones from when the page first opened.
      if (view === 'dashboard' && currentUser()) fetchDashboardData();
    }
  }

  /* =========================================================
     SHIPMENTS
     ========================================================= */
  const PAGE_SIZE = 50;
  let searchTimer;

  function shipmentQuery(page = state.shipments.page, pageSize = PAGE_SIZE) {
    const s = state.shipments;
    const params = new URLSearchParams({ page: String(page), limit: String(pageSize), sort: s.sort });
    if (s.status !== 'all') params.set('status', s.status);
    if (s.q.trim()) params.set('q', s.q.trim());
    if (s.equipment) params.set('equipment', s.equipment);
    return `/api/shipments/search?${params.toString()}`;
  }

  // The server filters, sorts and pages, so this works the same with 50 or 50,000 loads.
  async function renderShipments() {
    const container = document.getElementById('shipmentsView');
    if (!container) return;
    if (!currentUser()) return gate(container, 'signin');
    if (!can('shipments:read')) return gate(container, 'denied');
    if (!state.shipments.loaded) loading(container);
    try {
      const result = await api(shipmentQuery());
      Object.assign(state.shipments, {
        items: result.items, total: result.total, allCount: result.allCount, statusCounts: result.statusCounts,
        pages: result.pages, page: result.page, loaded: true
      });
    } catch (error) {
      return errorState(container, error.message, renderShipments);
    }
    if (state.view !== 'shipments') return;
    if (!document.getElementById('shipmentsTableBody')) buildShipmentsLayout(container);
    updateShipmentList();
  }

  function reloadFirstPage() {
    state.shipments.page = 1;
    renderShipments();
  }

  function buildShipmentsLayout(container) {
    const s = state.shipments;
    const tabs = el('div', { class: 'status-tabs', id: 'shipmentStatusTabs', role: 'group', 'aria-label': 'Filter by status' });
    const searchInput = el('input', {
      type: 'search', placeholder: 'Search ID, customer, city, carrier, truck…', value: s.q, 'aria-label': 'Search shipments',
      oninput: (event) => {
        s.q = event.target.value;
        const global = document.getElementById('globalSearch');
        if (global) global.value = s.q;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(reloadFirstPage, 300);
      }
    });
    searchInput.value = s.q;
    const equipmentSelect = el('select', {
      'aria-label': 'Equipment',
      onchange: (event) => { s.equipment = event.target.value; reloadFirstPage(); }
    }, [el('option', { value: '', text: 'All equipment' }), ...equipmentList().map((item) => el('option', { value: item, text: item }))]);
    equipmentSelect.value = s.equipment;
    const sortSelect = el('select', {
      'aria-label': 'Sort',
      onchange: (event) => { s.sort = event.target.value; reloadFirstPage(); }
    }, [
      el('option', { value: 'newest', text: 'Newest first' }),
      el('option', { value: 'oldest', text: 'Oldest first' }),
      el('option', { value: 'customer', text: 'Customer A–Z' }),
      el('option', { value: 'rate', text: 'Rate: high to low' })
    ]);
    sortSelect.value = s.sort;

    const toolbar = el('div', { class: 'view-toolbar' }, [
      el('label', { class: 'search inline' }, [icon('search'), searchInput]),
      equipmentSelect,
      sortSelect
    ]);

    const table = el('table', { class: 'data-table' }, [
      el('thead', {}, el('tr', {}, ['ID', 'Customer', 'Lane', 'Pickup → Delivery', 'Freight', 'Carrier', 'Status', 'Actions'].map((h) => el('th', { text: h })))),
      el('tbody', { id: 'shipmentsTableBody' })
    ]);

    container.replaceChildren(
      tabs,
      el('div', { class: 'card table-card' }, [
        toolbar,
        el('div', { class: 'table-scroll' }, table),
        el('div', { class: 'table-footer', id: 'shipmentsFooter' })
      ])
    );
  }

  function updateShipmentList() {
    const s = state.shipments;
    const tabs = document.getElementById('shipmentStatusTabs');
    const body = document.getElementById('shipmentsTableBody');
    const footer = document.getElementById('shipmentsFooter');
    if (!tabs || !body) return;

    const counts = s.statusCounts || {};
    tabs.replaceChildren(...[['all', 'All', s.allCount || 0], ...STATUS_ORDER.map((status) => [status, status, counts[status] || 0])]
      .map(([value, label, count]) => el('button', {
        type: 'button',
        class: `status-tab${s.status === value ? ' active' : ''}`,
        'aria-pressed': s.status === value ? 'true' : 'false',
        onclick: () => {
          const params = {};
          if (value !== 'all') params.status = value;
          if (s.q) params.q = s.q;
          navigate('shipments', params);
        }
      }, [value !== 'all' ? el('span', { class: 'dot', style: `--c:${STATUS_COLORS[value]}` }) : null, label, el('b', { text: count })])));

    const list = s.items || [];
    const canStatus = can('shipments:status');
    const canDispatch = can('shipments:dispatch');
    const filtered = s.q.trim() || s.equipment || s.status !== 'all';

    if (!list.length) {
      body.replaceChildren(el('tr', {}, el('td', { colspan: '8', class: 'empty-cell' }, filtered
        ? 'No shipments match these filters.'
        : 'No shipments yet. Create your first load with “New Shipment”.')));
    } else {
      body.replaceChildren(...list.map((shipment) => {
        const actions = el('div', { class: 'row-actions' }, [
          el('button', { class: 'table-detail-button', type: 'button', onclick: () => openShipmentDetails(shipment.id) }, 'View')
        ]);
        // A load with several legs or on a trip is moved through those, not by hand.
        const multi = shipment.legMode === 'multi' || Boolean(shipment.tripId);
        const options = multi ? [] : allowedShipmentStatuses(shipment.status);
        if (canStatus && options.length) {
          const select = el('select', {
            class: 'status-select', 'aria-label': `Change status of ${shipment.id}`,
            onchange: (event) => changeStatus(shipment.id, event.target.value, event.target)
          }, [el('option', { value: '', text: 'Move to…' }), ...options.map((option) => el('option', { value: option, text: option }))]);
          actions.append(select);
        }
        if (canDispatch && !multi && ['Sourcing', 'Pending Approval'].includes(shipment.status) && !shipment.carrierId) {
          actions.append(el('button', { class: 'dispatch-button', type: 'button', onclick: () => openDispatch(shipment) }, 'Dispatch'));
        }
        return el('tr', {}, [
          el('td', {}, [
            el('button', { class: 'link-btn id-link', type: 'button', onclick: () => openShipmentDetails(shipment.id) }, shipment.id),
            shipment.reference ? el('small', { class: 'cell-sub', text: shipment.reference }) : null,
            shipment.legMode === 'multi' ? el('small', { class: 'cell-sub', text: 'Multi-leg' }) : null,
            shipment.tripId ? el('small', { class: 'cell-sub', text: `Trip T-${shipment.tripId}` }) : null
          ]),
          el('td', { text: shipment.customer }),
          el('td', {}, [el('span', { text: shipment.origin }), el('small', { class: 'cell-sub', text: `→ ${shipment.destination}` })]),
          el('td', {}, [el('span', { text: prettyDate(shipment.pickup) }), el('small', { class: 'cell-sub', text: `→ ${prettyDate(shipment.delivery)}` })]),
          el('td', {}, [el('span', { text: shipment.weight || '—' }), el('small', { class: 'cell-sub', text: shipment.equipment || '' })]),
          el('td', {}, shipment.carrierName
            ? [
              el('span', { text: shipment.carrierName }),
              el('small', { class: 'cell-sub', text: [money(shipment.rate, 2), shipment.truckPlate].filter(Boolean).join(' · ') }),
              TRACKABLE.includes(shipment.status)
                ? el('small', {
                  class: `cell-sub${shipment.lastLocation ? ' location-line' : ' warn-line'}`,
                  text: shipment.lastLocation
                    ? `Now: ${shipment.lastLocation}${shipment.eta ? ` · ETA ${formatEta(shipment.eta)}` : ''}`
                    : 'No location yet'
                })
                : null
            ]
            : [el('span', { class: 'muted', text: 'Unassigned' })]),
          el('td', {}, statusTag(shipment.status)),
          el('td', {}, actions)
        ]);
      }));
    }
    if (footer) {
      const from = s.total ? (s.page - 1) * PAGE_SIZE + 1 : 0;
      const to = Math.min(s.page * PAGE_SIZE, s.total);
      const go = (page) => { s.page = page; renderShipments(); };
      footer.replaceChildren(
        el('span', { text: `Showing ${from}–${to} of ${s.total} shipments` }),
        s.pages > 1 ? el('span', { class: 'pager' }, [
          el('button', { class: 'btn btn-ghost small', type: 'button', disabled: s.page <= 1, onclick: () => go(s.page - 1) }, '← Previous'),
          el('span', { class: 'muted', text: `Page ${s.page} of ${s.pages}` }),
          el('button', { class: 'btn btn-ghost small', type: 'button', disabled: s.page >= s.pages, onclick: () => go(s.page + 1) }, 'Next →')
        ]) : ''
      );
    }
  }

  async function changeStatus(shipmentId, status, select) {
    if (!status) return;
    select.disabled = true;
    try {
      await api(`/api/admin/shipments/${encodeURIComponent(shipmentId)}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status, note: `Status changed to ${status}` })
      });
      toast(`${shipmentId} moved to ${status}.`);
      await refreshAll();
    } catch (error) {
      toast(error.message, 'error');
      select.disabled = false;
      select.value = '';
    }
  }

  /* ---------- dispatch modal ---------- */
  let dispatchTarget = null;
  async function openDispatch(shipment) {
    const modal = document.getElementById('dispatchModal');
    const form = document.getElementById('dispatchForm');
    const select = document.getElementById('dispatchCarrier');
    const message = document.getElementById('dispatchFormMessage');
    if (!modal || !form || !select) return;
    dispatchTarget = shipment;
    form.reset();
    message.textContent = '';
    // Pre-fill the customer price if it was agreed at order intake.
    if (shipment.customerRate !== null && shipment.customerRate !== undefined) form.elements.customerRate.value = String(shipment.customerRate);
    updateDispatchMargin();
    document.getElementById('dispatchModalTitle').textContent = `Dispatch ${shipment.id}`;
    document.getElementById('dispatchModalSubtitle').textContent = `${shipment.customer} · ${shipment.origin} → ${shipment.destination} · ${shipment.equipment || ''}`;
    select.replaceChildren(el('option', { value: '', text: 'Loading carriers…' }));
    modal.classList.remove('hidden');
    try {
      const carriers = (await api('/api/carriers')).filter((carrier) => carrier.status === 'Available');
      select.replaceChildren(
        el('option', { value: '', text: carriers.length ? 'Select an available carrier' : 'No carriers available' }),
        ...carriers.map((carrier) => el('option', { value: String(carrier.id), text: `${carrier.name} · ${carrier.mode}` }))
      );
      form.querySelector('button[type="submit"]').disabled = carriers.length === 0;
      if (!carriers.length) message.textContent = 'Every carrier is busy or inactive. Reactivate one on the Carriers page.';
      select.focus();
    } catch (error) {
      message.textContent = error.message;
    }
    renderScout(shipment);
    document.getElementById('dispatchPulse')?.replaceChildren();
    renderPulse();
  }

  // SCOUT: ranked carrier suggestions with reasons and a suggested rate. A person still decides.
  async function renderScout(shipment) {
    const box = document.getElementById('dispatchSuggestions');
    const form = document.getElementById('dispatchForm');
    if (!box || !form) return;
    box.replaceChildren(el('p', { class: 'muted', text: 'SCOUT is ranking carriers…' }));
    try {
      const { recommendations } = await api(`/api/agents/scout/${encodeURIComponent(shipment.id)}`);
      if (dispatchTarget?.id !== shipment.id) return;
      if (!recommendations.length) {
        box.replaceChildren(el('p', { class: 'muted', text: 'SCOUT: no available carriers to suggest.' }));
        return;
      }
      box.replaceChildren(
        el('div', { class: 'scout-head' }, [el('strong', { text: 'SCOUT suggestions' }), el('small', { class: 'muted', text: 'Based on trailer fit and past loads. Click to use.' })]),
        ...recommendations.slice(0, 3).map((item, index) => el('button', {
          type: 'button',
          class: `scout-item${index === 0 ? ' best' : ''}`,
          onclick: () => {
            form.elements.carrierId.value = String(item.carrierId);
            if (item.suggestedRate && !form.elements.rate.value) form.elements.rate.value = String(item.suggestedRate);
            updateDispatchMargin();
            schedulePulse();
            form.elements.rate.focus();
          }
        }, [
          el('span', { class: 'scout-title' }, [el('strong', { text: item.name }), el('span', { class: 'scout-score', text: `${item.score} pts` })]),
          el('small', { text: item.reasons.join(' · ') || item.mode }),
          item.suggestedRate ? el('small', { class: 'scout-rate', text: `Suggested ${money(item.suggestedRate)} — ${item.rateBasis}` }) : null
        ]))
      );
    } catch (error) {
      box.replaceChildren(el('p', { class: 'muted', text: `SCOUT unavailable: ${error.message}` }));
    }
  }

  // Live "you earn X on this load" line while the dispatcher types prices.
  function updateDispatchMargin() {
    const form = document.getElementById('dispatchForm');
    const line = document.getElementById('dispatchMargin');
    if (!form || !line) return;
    const rate = Number(form.elements.rate.value);
    const price = Number(form.elements.customerRate.value);
    line.classList.remove('negative');
    if (!form.elements.rate.value || !form.elements.customerRate.value || !rate || !price) {
      line.textContent = 'Enter both prices to see your margin.';
      return;
    }
    const margin = price - rate;
    line.textContent = `Margin: ${money(margin, 2)} (${Math.round((margin / price) * 100)}%)`;
    line.classList.toggle('negative', margin < 0);
  }

  // PULSE: is this price usual for the lane? Refreshed a moment after the dispatcher stops typing.
  let pulseTimer = null;
  function schedulePulse() {
    clearTimeout(pulseTimer);
    pulseTimer = setTimeout(renderPulse, 400);
  }

  async function renderPulse() {
    const form = document.getElementById('dispatchForm');
    const box = document.getElementById('dispatchPulse');
    const target = dispatchTarget;
    if (!form || !box || !target) return;
    const query = new URLSearchParams();
    if (Number(form.elements.rate.value) > 0) query.set('rate', form.elements.rate.value);
    if (Number(form.elements.customerRate.value) > 0) query.set('customerRate', form.elements.customerRate.value);
    try {
      const pulse = await api(`/api/agents/pulse/${encodeURIComponent(target.id)}?${query}`);
      if (dispatchTarget?.id !== target.id) return;
      box.replaceChildren(window.VeyraAdviceBlock('PULSE · prices', window.VeyraPulseLines(pulse)));
    } catch (_) {
      box.replaceChildren();
    }
  }

  function bindDispatchModal() {
    const modal = document.getElementById('dispatchModal');
    const form = document.getElementById('dispatchForm');
    const close = () => modal?.classList.add('hidden');
    form?.addEventListener('input', schedulePulse);
    document.getElementById('closeDispatch')?.addEventListener('click', close);
    modal?.addEventListener('click', (event) => { if (event.target === modal) close(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
    form?.addEventListener('input', updateDispatchMargin);
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!dispatchTarget) return;
      const carrierId = Number(form.elements.carrierId.value);
      const rate = Number(form.elements.rate.value);
      const customerRate = form.elements.customerRate.value ? Number(form.elements.customerRate.value) : undefined;
      const message = document.getElementById('dispatchFormMessage');
      if (!carrierId || !Number.isFinite(rate) || rate <= 0) {
        message.textContent = 'Choose a carrier and enter a positive rate.';
        return;
      }
      if (customerRate !== undefined && customerRate < rate
        && !window.confirm('The customer price is lower than the carrier rate, so this load loses money. Book it anyway?')) {
        return;
      }
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      message.textContent = 'Dispatching…';
      const optional = (name) => form.elements[name].value.trim() || undefined;
      try {
        await api(`/api/admin/shipments/${encodeURIComponent(dispatchTarget.id)}/dispatch`, {
          method: 'POST',
          body: JSON.stringify({
            carrierId,
            rate,
            customerRate,
            driverName: optional('driverName'),
            driverPhone: optional('driverPhone'),
            truckPlate: optional('truckPlate')
          })
        });
        close();
        toast(`${dispatchTarget.id} dispatched.`);
        await refreshAll();
      } catch (error) {
        message.textContent = error.message;
      }
      submit.disabled = false;
    });
  }

  /* ---------- CSV export ---------- */
  function csvCell(value) {
    let text = value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; // block spreadsheet formula injection
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  async function exportCsv() {
    if (!currentUser()) {
      document.getElementById('loginTrigger')?.click();
      return;
    }
    try {
      // Every page, with the filters on screen (Shipments page) or everything (elsewhere).
      const onShipments = state.view === 'shipments';
      const saved = { ...state.shipments };
      if (!onShipments) Object.assign(state.shipments, { status: 'all', q: '', equipment: '', sort: 'newest' });
      const rows = [];
      try {
        for (let page = 1; page <= 100; page += 1) {
          const result = await api(shipmentQuery(page, 200));
          rows.push(...result.items);
          if (page >= result.pages) break;
        }
      } finally {
        if (!onShipments) Object.assign(state.shipments, saved);
      }
      const currency = window.VeyraConfig?.currency || 'USD';
      const header = ['ID', 'Reference', 'Customer', 'Origin', 'Destination', 'Pickup', 'Delivery', 'Weight', 'Equipment', 'Carrier', `Carrier rate (${currency})`,
        `Customer price (${currency})`, `Margin (${currency})`, 'Truck plate', 'Driver', 'Driver phone', 'Last location', 'ETA', 'Status', 'Tracking'];
      const lines = [header, ...rows.map((s) => [s.id, s.reference, s.customer, s.origin, s.destination, s.pickup, s.delivery, s.weight, s.equipment, s.carrierName, s.rate,
        s.customerRate, s.margin, s.truckPlate, s.driverName, s.driverPhone, s.lastLocation, s.eta, s.status, s.trackingNumber])]
        .map((row) => row.map(csvCell).join(','));
      const blob = new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
      const link = el('a', { href: URL.createObjectURL(blob), download: `veyra-shipments-${new Date().toISOString().slice(0, 10)}.csv` });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      toast(`Exported ${rows.length} shipments.`);
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  /* =========================================================
     CARRIERS
     ========================================================= */
  async function renderCarriers() {
    const container = document.getElementById('carriersView');
    const addToggle = document.getElementById('addCarrierToggle');
    if (!container) return;
    addToggle?.classList.toggle('hidden', !currentUser() || !can('carriers:write'));
    if (!currentUser()) return gate(container, 'signin');
    if (!can('carriers:read')) return gate(container, 'denied');
    if (!state.carriers.list.length) loading(container);
    try {
      state.carriers.list = await api('/api/carriers');
    } catch (error) {
      return errorState(container, error.message, renderCarriers);
    }
    if (state.view !== 'carriers') return;
    buildCarriersLayout(container);
  }

  function buildCarriersLayout(container) {
    const c = state.carriers;
    const list = c.list;
    const count = (status) => list.filter((carrier) => carrier.status === status).length;

    const kpis = el('div', { class: 'stats-grid' }, [
      kpiCard('Total Carriers', list.length, 'In your network', 'carrier', 'blue'),
      kpiCard('Available', count('Available'), 'Ready for dispatch', 'check-circle', 'green'),
      kpiCard('Busy', count('Busy'), 'On an active load', 'truck', 'sky'),
      kpiCard('Inactive', count('Inactive'), 'Not taking loads', 'alert', 'amber')
    ]);

    const nameInput = el('input', { name: 'name', required: true, maxlength: '120', placeholder: 'Carrier company name' });
    const modeSelect = el('select', { name: 'mode', required: true }, [el('option', { value: '', text: 'Choose mode' }), ...CARRIER_MODES.map((mode) => el('option', { text: mode }))]);
    const phoneInput = el('input', { name: 'phone', type: 'tel', maxlength: '40', placeholder: 'Dispatch phone' });
    const contactInput = el('input', { name: 'contactName', maxlength: '120', placeholder: 'Contact person' });
    const formMessage = el('p', { class: 'shipment-form-message', role: 'status' });
    const form = el('form', {
      class: `card add-carrier${c.formOpen ? '' : ' hidden'}`,
      id: 'addCarrierForm',
      onsubmit: async (event) => {
        event.preventDefault();
        const submit = event.target.querySelector('button[type="submit"]');
        submit.disabled = true;
        formMessage.textContent = '';
        try {
          const result = await api('/api/carriers', {
            method: 'POST',
            body: JSON.stringify({
              name: nameInput.value.trim(),
              mode: modeSelect.value,
              phone: phoneInput.value.trim() || undefined,
              contactName: contactInput.value.trim() || undefined
            })
          });
          c.formOpen = false;
          toast(`${result.carrier.name} added to your network.`);
          await refreshAll();
        } catch (error) {
          formMessage.textContent = error.message;
          submit.disabled = false;
        }
      }
    }, [
      el('div', { class: 'add-carrier-head' }, [el('strong', { text: 'Add a carrier' }), el('small', { text: 'New carriers start as Available.' })]),
      el('div', { class: 'add-carrier-fields' }, [
        el('label', {}, ['Name', nameInput]),
        el('label', {}, ['Mode', modeSelect]),
        el('label', {}, ['Phone', phoneInput]),
        el('label', {}, ['Contact', contactInput]),
        el('button', { class: 'btn btn-primary small', type: 'submit' }, 'Add carrier')
      ]),
      formMessage
    ]);

    const tabs = el('div', { class: 'status-tabs' }, [['all', 'All', list.length], ['Available', 'Available', count('Available')], ['Busy', 'Busy', count('Busy')], ['Inactive', 'Inactive', count('Inactive')]]
      .map(([value, label, n]) => el('button', {
        type: 'button',
        class: `status-tab${c.filter === value ? ' active' : ''}`,
        'aria-pressed': c.filter === value ? 'true' : 'false',
        onclick: () => { c.filter = value; buildCarriersLayout(container); }
      }, [label, el('b', { text: n })])));

    const q = c.q.trim().toLowerCase();
    const visible = list.filter((carrier) => (c.filter === 'all' || carrier.status === c.filter)
      && (!q || `${carrier.name} ${carrier.mode}`.toLowerCase().includes(q)));
    const canWrite = can('carriers:write');

    const grid = el('div', { class: 'carrier-grid', id: 'carrierGrid' }, visible.length ? visible.map((carrier) => {
      const initials = carrier.name.split(/\s+/).slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join('');
      let toggle = null;
      if (canWrite) {
        if (carrier.activeLoads > 0) {
          toggle = el('button', { class: 'btn btn-ghost small', type: 'button', disabled: true, title: 'Carrier is on an active load' }, 'On a load');
        } else {
          const next = carrier.status === 'Available' ? 'Inactive' : 'Available';
          toggle = el('button', {
            class: `btn small ${next === 'Available' ? 'btn-primary' : 'btn-ghost'}`,
            type: 'button',
            onclick: (event) => setCarrierStatus(carrier, next, event.currentTarget)
          }, next === 'Inactive' ? 'Set inactive' : carrier.status === 'Busy' ? 'Mark available' : 'Reactivate');
        }
      }
      return el('article', { class: `card carrier-card ${slug(carrier.status)}` }, [
        el('header', {}, [
          el('span', { class: 'carrier-avatar', text: initials }),
          el('div', { class: 'carrier-title' }, [
            el('strong', { text: carrier.name }),
            el('small', { text: [carrier.mode, carrier.contactName, carrier.phone].filter(Boolean).join(' · ') })
          ]),
          el('span', { class: `carrier-status ${slug(carrier.status)}`, text: carrier.status })
        ]),
        el('div', { class: 'carrier-metrics' }, [
          metric('Loads', carrier.totalLoads),
          metric('Active', carrier.activeLoads),
          metric('Delivered', carrier.deliveredLoads),
          metric('Booked', money(carrier.revenue))
        ]),
        el('div', { class: 'carrier-current' }, carrier.currentShipment
          ? [icon('truck', 'ico sm'), 'Current load ', el('button', { class: 'link-btn', type: 'button', onclick: () => openShipmentDetails(carrier.currentShipment) }, carrier.currentShipment)]
          : [el('span', { class: 'muted', text: carrier.averageRate ? `Avg. rate ${money(carrier.averageRate)}` : 'No loads booked yet' })]),
        el('footer', {}, [
          el('button', { class: 'btn btn-ghost small', type: 'button', onclick: () => navigate('shipments', { q: carrier.name }) }, 'View loads'),
          toggle
        ])
      ]);
    }) : [el('div', { class: 'card empty-state wide' }, [el('p', { text: list.length ? 'No carriers match this filter.' : 'No carriers yet. Add your first carrier to start dispatching.' })])]);

    container.replaceChildren(kpis, form, tabs, grid);
  }

  function metric(label, value) {
    return el('div', {}, [el('small', { text: label }), el('strong', { text: value })]);
  }

  function kpiCard(label, value, meta, iconName, tone) {
    return el('div', { class: 'stat-card' }, [
      el('div', { class: 'stat-top' }, [el('span', { text: label }), el('span', { class: `stat-icon ${tone}` }, icon(iconName, ''))]),
      el('div', { class: 'stat-value', text: value }),
      el('div', { class: 'stat-meta', text: meta })
    ]);
  }

  async function setCarrierStatus(carrier, status, button) {
    button.disabled = true;
    try {
      await api(`/api/carriers/${Number(carrier.id)}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
      toast(`${carrier.name} is now ${status}.`);
      await refreshAll();
    } catch (error) {
      toast(error.message, 'error');
      button.disabled = false;
    }
  }

  /* =========================================================
     ANALYTICS
     ========================================================= */
  async function renderAnalytics() {
    const container = document.getElementById('analyticsView');
    const range = document.getElementById('analyticsRange');
    if (!container) return;
    range?.classList.toggle('hidden', !currentUser() || !can('analytics:read'));
    if (!currentUser()) return gate(container, 'signin');
    if (!can('analytics:read')) return gate(container, 'denied');
    range?.querySelectorAll('button').forEach((button) => {
      const active = Number(button.dataset.days) === state.analytics.days;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    if (!state.analytics.data) loading(container);
    try {
      state.analytics.data = await api(`/api/analytics?days=${state.analytics.days}`);
      state.analytics.finance = can('shipments:finance') ? await api('/api/finance/summary').catch(() => null) : null;
    } catch (error) {
      return errorState(container, error.message, renderAnalytics);
    }
    if (state.view !== 'analytics') return;
    buildAnalyticsLayout(container, state.analytics.data);
  }

  function buildAnalyticsLayout(container, data) {
    const stats = data.stats || {};
    const kpis = el('div', { class: 'kpi-grid' }, [
      kpiCard('Total Shipments', stats.totalShipments ?? 0, `${stats.activeShipments ?? 0} still open`, 'truck', 'blue'),
      kpiCard('Pending Approval', stats.pendingApproval ?? 0, 'Waiting for a decision', 'doc', 'amber'),
      kpiCard('Delivery Rate', pct(stats.deliveryRate), 'Delivered of closed loads', 'check-circle', 'green'),
      kpiCard('Exceptions', stats.exceptions ?? 0, `${pct(stats.exceptionRate)} of all loads`, 'alert', 'red'),
      kpiCard('Carrier Cost Booked', money(stats.bookedRevenue), `${stats.pricedLoads ?? 0} loads · avg ${money(stats.averageRate)}`, 'chart', 'sky'),
      kpiCard('Gross Margin', money(stats.grossMargin), stats.marginLoads
        ? `${pct(stats.marginRate)} on ${stats.marginLoads} loads with a customer price`
        : 'Add customer prices to see margin', 'bolt', 'blue')
    ]);

    // Volume bar chart
    const volume = data.weeklyVolume || [];
    const maxVolume = Math.max(1, ...volume.map((point) => point.total));
    const created = volume.reduce((sum, point) => sum + point.total, 0);
    const labelEvery = volume.length > 30 ? 15 : volume.length > 7 ? 5 : 1;
    const bars = el('div', { class: 'bar-chart', role: 'img', 'aria-label': `Shipments created per day over the last ${data.rangeDays} days` }, volume.map((point, index) => el('div', { class: 'bar-col', title: `${point.label}: ${point.total}` }, [
      el('span', { class: `bar${point.total ? '' : ' zero'}`, style: `height:${Math.max(point.total ? 4 : 1, (point.total / maxVolume) * 100)}%` }),
      el('small', { class: index % labelEvery === 0 || index === volume.length - 1 ? '' : 'ghost', text: point.label })
    ])));
    const volumeCard = el('div', { class: 'card panel-card span-2' }, [
      el('div', { class: 'mini-head' }, [
        el('span', {}, [el('strong', { text: 'Shipments created' }), el('small', { text: `Last ${data.rangeDays} days · peak ${maxVolume === 1 && !created ? 0 : maxVolume}/day` })]),
        el('span', { class: 'big-number', text: created })
      ]),
      created ? bars : el('div', { class: 'empty-inline', text: 'No shipments were created in this range.' })
    ]);

    const statusRows = STATUS_ORDER.map((status) => ({ label: status, total: data.statuses?.[status] || 0, color: STATUS_COLORS[status] }));
    const statusCard = el('div', { class: 'card panel-card' }, [
      el('div', { class: 'mini-head' }, el('span', {}, [el('strong', { text: 'Pipeline by status' }), el('small', { text: 'All shipments, current state' })])),
      hbars(statusRows)
    ]);

    const equipmentRows = (data.equipment || []).map((row, index) => ({ ...row, color: ['#2563ff', '#38bdf8', '#a78bfa', '#14b8a6', '#fbbf24', '#64748b'][index % 6] }));
    const equipmentCard = el('div', { class: 'card panel-card' }, [
      el('div', { class: 'mini-head' }, el('span', {}, [el('strong', { text: 'Equipment mix' }), el('small', { text: 'Share of all loads' })])),
      equipmentRows.length ? hbars(equipmentRows) : el('div', { class: 'empty-inline', text: 'No shipments yet.' })
    ]);

    const lanesCard = el('div', { class: 'card panel-card' }, [
      el('div', { class: 'mini-head' }, el('span', {}, [el('strong', { text: 'Top lanes' }), el('small', { text: 'Most frequent origin → destination' })])),
      miniTable(['Lane', 'Loads', 'Avg. rate'], (data.topLanes || []).map((lane) => [
        el('span', {}, [lane.origin, el('small', { class: 'cell-sub', text: `→ ${lane.destination}` })]),
        lane.total,
        money(lane.averageRate)
      ]), 'No lanes yet.')
    ]);

    const customersCard = el('div', { class: 'card panel-card' }, [
      el('div', { class: 'mini-head' }, el('span', {}, [el('strong', { text: 'Top customers' }), el('small', { text: 'By number of loads' })])),
      miniTable(['Customer', 'Loads', 'Open', 'Booked'], (data.topCustomers || []).map((row) => [
        el('button', { class: 'link-btn', type: 'button', onclick: () => navigate('shipments', { q: row.customer }) }, row.customer),
        row.total,
        row.active,
        money(row.revenue)
      ]), 'No customers yet.')
    ]);

    const carrierRows = [...(data.carrierPerformance || [])].sort((a, b) => b.totalLoads - a.totalLoads || b.revenue - a.revenue);
    const carriersCard = el('div', { class: 'card panel-card span-2' }, [
      el('div', { class: 'mini-head' }, [
        el('span', {}, [el('strong', { text: 'Carrier performance' }), el('small', { text: 'Loads, outcomes and booked revenue per carrier' })]),
        el('a', { class: 'view-all', href: '#/carriers' }, ['Manage carriers ', icon('chevron', 'ico sm rot')])
      ]),
      miniTable(['Carrier', 'Status', 'Loads', 'Active', 'Delivered', 'Exceptions', 'Booked', 'Avg. rate'], carrierRows.map((carrier) => [
        el('span', {}, [carrier.name, el('small', { class: 'cell-sub', text: carrier.mode })]),
        el('span', { class: `carrier-status ${slug(carrier.status)}`, text: carrier.status }),
        carrier.totalLoads,
        carrier.activeLoads,
        carrier.deliveredLoads,
        carrier.exceptionLoads,
        money(carrier.revenue),
        money(carrier.averageRate)
      ]), 'No carriers yet.')
    ]);

    // Every AI call is logged; this is where its use and cost (tokens) are visible.
    const agentRows = data.agents || [];
    const agentsCard = el('div', { class: 'card panel-card span-2' }, [
      el('div', { class: 'mini-head' }, el('span', {}, [el('strong', { text: 'AI agents' }), el('small', { text: `Calls in the last ${data.rangeDays} days · tokens are what the AI provider bills` })])),
      miniTable(['Agent', 'Calls', 'Succeeded', 'Tokens in', 'Tokens out', 'Avg. time'], agentRows.map((row) => [
        row.agent,
        row.calls,
        `${row.succeeded} (${row.calls ? Math.round((row.succeeded / row.calls) * 100) : 0}%)`,
        row.inputTokens.toLocaleString('en-US'),
        row.outputTokens.toLocaleString('en-US'),
        row.avgLatencyMs === null ? '—' : `${(row.avgLatencyMs / 1000).toFixed(1)} s`
      ]), window.VeyraConfig?.ai?.enabled ? 'No AI calls in this period.' : 'AI is off. Add OPENROUTER_API_KEY to turn on FLOW.')
    ]);

    // Money that is still open: delivered loads the customer has not paid, carriers not yet paid.
    const finance = state.analytics.finance;
    const financeCard = finance ? el('div', { class: 'card panel-card span-2' }, [
      el('div', { class: 'mini-head' }, el('span', {}, [
        el('strong', { text: 'Open money' }),
        el('small', { text: `Customers owe ${money(finance.receivable)} (${finance.receivableLoads} loads, ${finance.notInvoiced} not invoiced yet) · you owe carriers ${money(finance.payable)} (${finance.payableLoads} loads)` })
      ])),
      miniTable(['Load', 'Customer', 'Customer owes', 'Carrier is owed', 'Delivered'], finance.open.map((row) => [
        el('button', { class: 'link-button', type: 'button', onclick: () => openShipmentDetails(row.id) }, row.id),
        el('span', {}, [row.customer, el('small', { class: 'cell-sub', text: row.invoiceNumber ? `Invoice ${row.invoiceNumber}` : (row.invoicedAt ? 'Invoice sent' : 'Not invoiced') })]),
        row.customerPaidAt || row.customerRate === null ? '—' : money(row.customerRate),
        row.carrierPaidAt || row.rate === null ? '—' : el('span', {}, [money(row.rate), el('small', { class: 'cell-sub', text: row.carrierName || '' })]),
        row.daysSinceDelivery === null ? '—' : `${row.daysSinceDelivery} day${row.daysSinceDelivery === 1 ? '' : 's'} ago`
      ]), 'Nothing is open: every delivered load is paid on both sides.')
    ]) : null;

    container.replaceChildren(kpis, el('div', { class: 'analytics-grid' }, [financeCard, volumeCard, statusCard, equipmentCard, lanesCard, customersCard, carriersCard, agentsCard].filter(Boolean)));
  }

  function hbars(rows) {
    const total = rows.reduce((sum, row) => sum + row.total, 0);
    const max = Math.max(1, ...rows.map((row) => row.total));
    return el('div', { class: 'hbars' }, rows.map((row) => el('div', { class: 'hbar' }, [
      el('span', { class: 'hbar-label' }, [el('span', { class: 'dot', style: `--c:${row.color}` }), row.label]),
      el('span', { class: 'hbar-track' }, el('i', { style: `width:${(row.total / max) * 100}%;background:${row.color}` })),
      el('span', { class: 'hbar-value' }, [el('b', { text: row.total }), el('small', { text: total ? ` ${Math.round((row.total / total) * 100)}%` : '' })])
    ])));
  }

  function miniTable(headers, rows, emptyText) {
    if (!rows.length) return el('div', { class: 'empty-inline', text: emptyText });
    return el('div', { class: 'table-scroll' }, el('table', { class: 'data-table compact' }, [
      el('thead', {}, el('tr', {}, headers.map((header) => el('th', { text: header })))),
      el('tbody', {}, rows.map((cells) => el('tr', {}, cells.map((cell) => el('td', {}, cell)))))
    ]));
  }

  /* =========================================================
     INBOX & TASKS (what NEXUS and the other agents prepared)
     ========================================================= */
  async function renderInbox() {
    const container = document.getElementById('inboxView');
    if (!container) return;
    if (!currentUser()) return gate(container, 'signin');
    if (!can('shipments:read')) return gate(container, 'denied');
    if (!container.children.length) loading(container);
    try {
      const [{ tasks }, inbox, sentinel] = await Promise.all([
        api('/api/tasks'),
        can('shipments:create') ? api('/api/inbox') : Promise.resolve({ items: [] }),
        api('/api/agents/sentinel').catch(() => ({ risks: [] }))
      ]);
      if (state.view !== 'inbox') return;
      state.inbox = { tasks, items: inbox.items, risks: sentinel.risks || [] };
    } catch (error) {
      return errorState(container, error.message, renderInbox);
    }
    buildInboxLayout(container);
    loadNotifications();
  }

  function taskCard(task) {
    const when = typeof formatTimestamp === 'function' ? formatTimestamp(task.createdAt) : task.createdAt;
    const body = el('div', { class: 'task-body' });
    const actions = el('div', { class: 'task-actions' });
    const dismiss = (label) => el('button', { class: 'btn btn-ghost small', type: 'button', onclick: (event) => taskAction(event.currentTarget, `/api/tasks/${task.id}/dismiss`, {}, 'Task closed.') }, label);
    const openLoad = () => el('button', { class: 'btn btn-ghost small', type: 'button', onclick: () => openShipmentDetails(task.shipmentId) }, 'Open load');
    const payload = task.payload || {};

    if (task.kind === 'review_intake') {
      const draft = payload.parsed?.draft;
      const missing = payload.parsed?.missing || [];
      body.append(el('p', { class: 'muted', text: `${payload.from || 'Unknown sender'}${payload.subject ? ` · ${payload.subject}` : ''}` }));
      if (draft) {
        body.append(el('ul', { class: 'task-facts' }, [
          ['Customer', draft.customer], ['Route', draft.origin && draft.destination ? `${draft.origin} → ${draft.destination}` : null],
          ['Pickup', draft.pickup], ['Delivery', draft.delivery],
          ['Weight', draft.weight ? `${draft.weight} ${window.VeyraConfig?.weightUnit || 'kg'}` : null], ['Equipment', draft.equipment],
          ['Price', draft.customerRate ? money(draft.customerRate) : null]
        ].map(([label, value]) => el('li', { class: value ? '' : 'missing' }, [el('span', { text: label }), el('strong', { text: value || 'missing' })]))));
        (payload.parsed.questions || []).forEach((question) => body.append(el('p', { class: 'task-question', text: `Ask the customer: ${question}` })));
        (payload.parsed.notes || []).forEach((note) => body.append(el('p', { class: 'muted', text: note })));
      } else {
        body.append(el('p', { text: payload.preview || '' }));
        body.append(el('p', { class: 'warn-line', text: payload.note || 'Not read yet.' }));
      }
      const files = (state.inbox?.items || []).find((entry) => entry.id === task.inboxId)?.attachments || [];
      if (files.length) body.append(fileList(task.inboxId, files));
      if (files.length && can('shipments:document')) actions.append(attachButton(task.inboxId));
      actions.append(
        el('button', {
          class: 'btn btn-primary small', type: 'button',
          onclick: () => {
            const item = (state.inbox?.items || []).find((entry) => entry.id === task.inboxId);
            if (typeof window.openShipmentModal === 'function') {
              window.openShipmentModal({ ...(draft || {}) }, { inboxId: task.inboxId, missing, emailText: item ? `${item.subject ? `Subject: ${item.subject}\n\n` : ''}${item.body}` : (payload.preview || '') });
            }
          }
        }, 'Create load'),
        dismiss('Dismiss')
      );
    } else if (task.kind === 'book_carrier') {
      const recommendations = payload.recommendations || [];
      if (!recommendations.length) body.append(el('p', { class: 'warn-line', text: 'No carrier is available. Add or reactivate one on the Carriers page.' }));
      recommendations.forEach((item, index) => body.append(el('div', { class: `task-reco${index === 0 ? ' best' : ''}` }, [
        el('span', { class: 'scout-title' }, [el('strong', { text: item.name }), el('span', { class: 'scout-score', text: `${item.score} pts` })]),
        el('small', { text: item.reasons.join(' · ') || item.mode }),
        item.suggestedRate ? el('small', { class: 'scout-rate', text: `Suggested ${money(item.suggestedRate)} — ${item.rateBasis}` }) : null
      ])));
      actions.append(
        el('button', {
          class: 'btn btn-primary small', type: 'button',
          onclick: async () => {
            try {
              const shipment = await api(`/api/shipments/${encodeURIComponent(task.shipmentId)}`);
              openDispatch(shipment);
            } catch (error) {
              toast(error.message, 'error');
            }
          }
        }, 'Open dispatch'),
        openLoad(),
        dismiss('Dismiss')
      );
    } else if (task.kind === 'message') {
      const channels = window.VeyraConfig?.messaging?.channels || [];
      const textarea = el('textarea', { rows: '3', maxlength: '1000', 'aria-label': 'Message text' });
      textarea.value = payload.body || '';
      const channelSelect = el('select', { 'aria-label': 'Send by' }, ['whatsapp', 'sms'].map((channel) => el('option', { value: channel, text: channel === 'sms' ? 'SMS' : 'WhatsApp', disabled: !channels.includes(channel) })));
      const firstOn = ['whatsapp', 'sms'].find((channel) => channels.includes(channel));
      if (firstOn) channelSelect.value = firstOn;
      body.append(el('p', { class: 'muted', text: `To the ${payload.recipient}: ${payload.to || 'no number'}` }), textarea);
      if (!channels.length) body.append(el('p', { class: 'warn-line', text: 'Sending is off for your company. Copy the text and send it from your phone, then close the task.' }));
      if (can('shipments:message')) {
        actions.append(el('span', { class: 'task-send' }, [channelSelect, el('button', {
          class: 'btn btn-primary small', type: 'button', disabled: !channels.length,
          onclick: (event) => taskAction(event.currentTarget, `/api/tasks/${task.id}/approve`, { channel: channelSelect.value, body: textarea.value }, 'Message sent.')
        }, 'Approve & send')]));
      }
      actions.append(
        el('button', {
          class: 'btn btn-ghost small', type: 'button',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(textarea.value);
              toast('Text copied. Paste it into WhatsApp or SMS.');
            } catch (_) {
              textarea.select();
              toast('Select the text and copy it (Ctrl+C).', 'info');
            }
          }
        }, 'Copy'),
        openLoad(),
        dismiss('Skip')
      );
    } else if (task.kind === 'check_document') {
      body.append(el('div', { class: 'table-scroll' }, el('table', { class: 'data-table compact' }, [
        el('thead', {}, el('tr', {}, ['Field', 'Document says', 'Load says', ''].map((h) => el('th', { text: h })))),
        el('tbody', {}, (payload.mismatches || []).map((check) => el('tr', {}, [
          el('td', { text: check.label }), el('td', { text: check.document ?? '—' }), el('td', { text: check.load ?? '—' }), el('td', { class: 'warn-line', text: check.hint || '' })
        ])))
      ])));
      actions.append(openLoad(), dismiss('Checked'));
    } else {
      body.append(el('p', { text: payload.text || '' }));
      [['Carrier', payload.carrierPhone], ['Driver', payload.driverPhone]].filter(([, phone]) => phone).forEach(([who, phone]) => body.append(
        el('p', { class: 'muted' }, [`${who}: `, el('a', { href: `tel:${String(phone).replace(/[^+\d]/g, '')}`, text: phone })])
      ));
      actions.append(openLoad(), dismiss('Done'));
    }
    return el('article', { class: `card task-card kind-${task.kind}` }, [
      el('header', {}, [el('strong', { text: task.title }), el('small', { class: 'muted', text: when })]),
      body,
      actions
    ]);
  }

  // Files that came with an email: each is a download link.
  function fileList(inboxId, files) {
    return el('p', { class: 'file-list' }, [
      el('span', { class: 'muted', text: `${files.length} file${files.length === 1 ? '' : 's'}: ` }),
      ...files.map((file) => el('a', {
        class: 'file-chip', href: `/api/inbox/${inboxId}/attachments/${file.id}/file`, download: file.filename,
        text: `${file.filename} (${Math.max(1, Math.round(file.size / 1024))} KB)`
      }))
    ]);
  }

  function attachButton(inboxId) {
    return el('button', {
      class: 'btn btn-ghost small', type: 'button',
      onclick: (event) => {
        const answer = window.prompt('Which load do these files belong to? Type its number, for example SHP-12');
        if (!answer) return;
        const shipmentId = answer.trim().toUpperCase().replace(/^(\d+)$/, 'SHP-$1').replace(/\s+/g, '');
        taskAction(event.currentTarget, `/api/inbox/${inboxId}/attach`, { shipmentId }, `Files added to ${shipmentId}.`);
      }
    }, 'Attach files to a load');
  }

  // SENTINEL: loads that are in trouble or about to be, worst first.
  function riskPanel(risks) {
    const label = { high: 'Urgent', medium: 'Soon', low: 'Note' };
    return el('section', { class: 'card risk-panel' }, [
      el('header', {}, [el('strong', { text: `SENTINEL · ${risks.length} risk${risks.length === 1 ? '' : 's'} on open loads` }), el('small', { class: 'muted', text: 'Checked now' })]),
      el('ul', { class: 'risk-list' }, risks.slice(0, 12).map((risk) => el('li', { class: `risk-${risk.severity}` }, [
        el('span', { class: 'risk-level', text: label[risk.severity] || risk.severity }),
        el('div', {}, [
          el('button', { class: 'link-button', type: 'button', onclick: () => openShipmentDetails(risk.shipmentId) }, risk.title),
          el('small', { class: 'muted', text: `${risk.customer} · ${risk.lane} — ${risk.advice}` })
        ])
      ]))),
      risks.length > 12 ? el('p', { class: 'muted', text: `…and ${risks.length - 12} more.` }) : null
    ]);
  }

  async function taskAction(button, url, body, doneText) {
    button.disabled = true;
    try {
      await api(url, { method: 'POST', body: JSON.stringify(body) });
      toast(doneText);
      await Promise.allSettled([renderInbox(), loadNotifications()]);
    } catch (error) {
      toast(error.message, 'error');
      button.disabled = false;
    }
  }

  function buildInboxLayout(container) {
    const { tasks, items, risks = [] } = state.inbox;
    const blocked = items.filter((item) => item.status === 'blocked');
    const hasTaskEmail = (id) => tasks.some((task) => task.inboxId === id);
    const waiting = items.filter((item) => item.status !== 'blocked' && !hasTaskEmail(item.id));

    const taskList = tasks.length
      ? tasks.map(taskCard)
      : [el('div', { class: 'card empty-state wide' }, [el('p', { text: 'Nothing is waiting for you. New orders by email, bookings and late trucks will show up here.' })])];

    const sections = [];
    if (risks.length) sections.push(riskPanel(risks));
    sections.push(el('div', { class: 'task-list' }, taskList));
    if (waiting.length) {
      sections.push(el('h3', { class: 'task-heading', text: 'Emails without a task' }), ...waiting.map((item) => emailCard(item)));
    }
    if (blocked.length) {
      sections.push(
        el('h3', { class: 'task-heading', text: 'Blocked emails' }),
        el('p', { class: 'muted', text: 'These senders are not on your allowed list, so they were not read.' }),
        ...blocked.map((item) => emailCard(item, true))
      );
    }
    container.replaceChildren(...sections);
  }

  function emailCard(item, blocked = false) {
    return el('article', { class: 'card task-card' }, [
      el('header', {}, [el('strong', { text: item.subject || '(no subject)' }), el('small', { class: 'muted', text: item.from || '' })]),
      el('div', { class: 'task-body' }, [
        el('p', { text: item.body.slice(0, 400) }),
        !blocked && item.attachments?.length ? fileList(item.id, item.attachments) : null
      ]),
      el('div', { class: 'task-actions' }, [
        !blocked && item.attachments?.length && can('shipments:document') ? attachButton(item.id) : null,
        blocked ? null : el('button', {
          class: 'btn btn-primary small', type: 'button',
          onclick: () => window.openShipmentModal?.({}, { inboxId: item.id, emailText: `${item.subject ? `Subject: ${item.subject}\n\n` : ''}${item.body}` })
        }, 'Create load'),
        el('button', { class: 'btn btn-ghost small', type: 'button', onclick: (event) => taskAction(event.currentTarget, `/api/inbox/${item.id}/dismiss`, {}, 'Email dismissed.') }, 'Dismiss')
      ])
    ]);
  }

  /* =========================================================
     NOTIFICATIONS (derived from real shipments and carriers)
     ========================================================= */
  const notifications = { items: [], open: false, failed: false };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  async function loadNotifications() {
    if (!currentUser() || !can('shipments:read')) {
      notifications.items = [];
      notifications.failed = false;
      document.getElementById('navInboxBadge')?.classList.add('hidden');
      renderNotifications();
      return;
    }
    try {
      notifications.failed = false;
      // Counts come from the server, so they are right at any number of loads.
      const { alerts } = await api('/api/alerts');
      const items = [];
      const { exceptions, pendingApproval: pending, new: fresh, sourcing, staleTracking, staleHours } = alerts;
      const available = can('carriers:read') ? alerts.availableCarriers : null;
      if (exceptions) items.push({ tone: 'danger', title: `${plural(exceptions, 'shipment is', 'shipments are')} in Exception`, hint: 'Review and resolve', href: '#/shipments?status=Exception' });
      if (staleTracking) items.push({ tone: 'warn', title: `${plural(staleTracking, 'truck has', 'trucks have')} no location update in ${staleHours}h`, hint: 'Call the driver or check GPS', href: '#/shipments?status=In%20Transit' });
      if (pending) items.push({ tone: 'warn', title: `${plural(pending, 'shipment is', 'shipments are')} waiting for approval`, hint: 'Open the approvals queue', href: '#/shipments?status=Pending%20Approval' });
      if (available === 0 && (sourcing || pending)) items.push({ tone: 'danger', title: 'No carriers are available', hint: 'Reactivate or add a carrier', href: '#/carriers' });
      else if (sourcing) items.push({ tone: 'info', title: `${plural(sourcing, 'load needs', 'loads need')} a carrier`, hint: 'In Sourcing', href: '#/shipments?status=Sourcing' });
      if (fresh) items.push({ tone: 'info', title: `${plural(fresh, 'new load is', 'new loads are')} waiting to be sourced`, hint: 'Move to Sourcing', href: '#/shipments?status=New' });
      if (alerts.openTasks) items.unshift({ tone: 'warn', title: `${plural(alerts.openTasks, 'task is', 'tasks are')} waiting for you`, hint: 'Orders, bookings and messages the agents prepared', href: '#/inbox' });
      const badge = document.getElementById('navInboxBadge');
      if (badge) {
        badge.textContent = alerts.openTasks;
        badge.classList.toggle('hidden', !alerts.openTasks);
      }
      notifications.items = items;
    } catch (_) {
      notifications.items = [];
      notifications.failed = true;
    }
    renderNotifications();
  }

  function renderNotifications() {
    const dot = document.getElementById('notifDot');
    const list = document.getElementById('notifList');
    const count = document.getElementById('notifCount');
    const button = document.getElementById('notifBtn');
    const items = notifications.items;
    dot?.classList.toggle('hidden', items.length === 0);
    if (button) button.setAttribute('aria-label', items.length ? `Notifications, ${items.length} need attention` : 'Notifications');
    if (count) count.textContent = items.length ? `${items.length} need attention` : '';
    if (!list) return;
    if (!currentUser()) {
      list.replaceChildren(el('div', { class: 'notif-empty' }, [
        el('p', { text: 'Sign in to see alerts about your loads.' }),
        el('button', { class: 'btn btn-primary small', type: 'button', onclick: () => { setNotificationsOpen(false); document.getElementById('loginTrigger')?.click(); } }, 'Sign in')
      ]));
      return;
    }
    if (notifications.failed) {
      list.replaceChildren(el('div', { class: 'notif-empty' }, [
        el('p', { text: 'Couldn\'t load alerts right now.' }),
        el('button', { class: 'btn btn-ghost small', type: 'button', onclick: loadNotifications }, 'Try again')
      ]));
      return;
    }
    list.replaceChildren(...(items.length ? items.map((item) => el('a', {
      class: `notif-item ${item.tone}`,
      href: item.href,
      onclick: () => setNotificationsOpen(false)
    }, [el('span', { class: 'notif-bullet' }), el('span', {}, [el('strong', { text: item.title }), el('small', { text: item.hint })])]))
      : [el('div', { class: 'notif-empty' }, [el('p', { text: 'You\'re all caught up. Nothing needs attention.' })])]));
  }

  function setNotificationsOpen(open) {
    notifications.open = open;
    document.getElementById('notifPanel')?.classList.toggle('hidden', !open);
    document.getElementById('notifBtn')?.setAttribute('aria-expanded', String(open));
    if (open) loadNotifications();
  }

  function bindNotifications() {
    // New emails and tasks can arrive while someone works on another page: refresh the counts quietly.
    setInterval(() => {
      if (!document.hidden && currentUser()) loadNotifications();
    }, 60000);
    document.getElementById('notifBtn')?.addEventListener('click', () => setNotificationsOpen(!notifications.open));
    document.addEventListener('click', (event) => {
      if (notifications.open && !event.target.closest('.notif-wrap')) setNotificationsOpen(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && notifications.open) {
        setNotificationsOpen(false);
        document.getElementById('notifBtn')?.focus();
      }
    });
    renderNotifications();
  }



  /* =========================================================
     QUOTES & PRICING
     ========================================================= */
  const QUOTE_LABELS = { draft: 'Draft', sent: 'Sent', accepted: 'Won', declined: 'Lost', expired: 'Expired' };
  const QUOTE_TONES = { draft: 'cancelled', sent: 'in-transit', accepted: 'delivered', declined: 'exception', expired: 'pending-approval' };
  const quoteState = { lane: null, estimate: null, filter: 'open' };

  async function renderQuotes() {
    const container = document.getElementById('quotesView');
    if (!container) return;
    if (!currentUser()) return gate(container, 'signin');
    if (!container.children.length) loading(container);
    let quotes;
    try {
      quotes = (await api('/api/quotes')).quotes;
    } catch (error) {
      return errorState(container, error.message, renderQuotes);
    }
    if (state.view !== 'quotes') return;
    const canWrite = can('shipments:create');
    const soon = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const open = quotes.filter((q) => ['draft', 'sent'].includes(q.status));
    const decided = quotes.filter((q) => ['accepted', 'declined', 'expired'].includes(q.status));
    const won = quotes.filter((q) => q.status === 'accepted');
    const kpis = el('div', { class: 'stats-grid kpi-grid' }, [
      kpiCard('Open quotes', String(open.length), `${open.filter((q) => q.status === 'draft').length} not sent yet`, 'doc', 'violet'),
      kpiCard('Waiting for an answer', money(open.filter((q) => q.status === 'sent').reduce((sum, q) => sum + q.price, 0)), 'Total of sent quotes', 'wallet', 'blue'),
      kpiCard('Win rate', decided.length ? `${Math.round((won.length / decided.length) * 100)}%` : '—', decided.length ? `${won.length} won of ${decided.length} decided` : 'No answers yet', 'check-circle', 'green'),
      kpiCard('Expiring soon', String(open.filter((q) => q.validUntil <= soon).length), 'Valid for 2 days or less', 'alert', 'amber')
    ]);
    container.replaceChildren(kpis, canWrite ? quoteBuilder() : '', quoteList(quotes, canWrite));
  }

  function quoteBuilder() {
    const field = (label, input) => el('label', { class: 'quote-field' }, [el('span', { text: label }), input]);
    const origin = el('input', { name: 'origin', maxlength: '160', placeholder: 'e.g. Tashkent, UZ', required: true });
    const destination = el('input', { name: 'destination', maxlength: '160', placeholder: 'e.g. Almaty, KZ', required: true });
    const equipment = el('select', { name: 'equipment' }, equipmentList().map((item) => el('option', { value: item, text: item })));
    const weight = el('input', { name: 'weight', type: 'number', min: '0.01', step: '0.01', placeholder: window.VeyraConfig?.weightUnit || 'kg' });
    const lane = quoteState.lane;
    if (lane) {
      origin.value = lane.origin;
      destination.value = lane.destination;
      equipment.value = lane.equipment;
      weight.value = lane.weight || '';
    }
    const result = el('div', { class: 'quote-result' });
    const form = el('form', { class: 'card quote-lane', autocomplete: 'off' }, [
      field('Origin', origin),
      el('button', { class: 'icon-btn swap-btn', type: 'button', 'aria-label': 'Swap origin and destination', onclick: () => { [origin.value, destination.value] = [destination.value, origin.value]; } }, '⇄'),
      field('Destination', destination),
      field('Equipment', equipment),
      field(`Weight (${window.VeyraConfig?.weightUnit || 'kg'})`, weight),
      el('button', { class: 'btn btn-primary', type: 'submit' }, 'Check price')
    ]);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!origin.value.trim() || !destination.value.trim()) return toast('Enter the origin and the destination.', 'error');
      quoteState.lane = { origin: origin.value.trim(), destination: destination.value.trim(), equipment: equipment.value, weight: weight.value };
      result.replaceChildren(el('p', { class: 'muted', text: 'PULSE is checking this lane…' }));
      try {
        const query = new URLSearchParams({ origin: quoteState.lane.origin, destination: quoteState.lane.destination, equipment: quoteState.lane.equipment });
        quoteState.estimate = await api(`/api/quotes/estimate?${query}`);
        result.replaceChildren(...quoteOffer());
      } catch (error) {
        result.replaceChildren(el('p', { class: 'warn-line', text: error.message }));
      }
    });
    if (lane && quoteState.estimate) result.replaceChildren(...quoteOffer());
    return el('section', { class: 'quote-builder' }, [form, result]);
  }

  // PULSE's view of the lane, and the form to save an offer at a chosen price.
  function quoteOffer() {
    const lane = quoteState.lane;
    const est = quoteState.estimate;
    const lines = [];
    if (est.carrier) lines.push(['Carriers usually charge', `${money(est.carrier.typical)}`, `${money(est.carrier.lowest)} – ${money(est.carrier.highest)} · ${est.carrier.loads} loads`]);
    if (est.customer) lines.push(['Customers usually pay', money(est.customer.typical), `${est.customer.loads} loads on this lane`]);
    if (est.market) lines.push(['Your market price', money(est.market.rate), est.market.equipment || 'any trailer']);
    if (est.typicalMarginShare !== null && est.typicalMarginShare !== undefined) lines.push(['Your usual margin', `${Math.round(est.typicalMarginShare * 100)}%`, 'on this lane']);
    const suggested = est.suggestedCustomerPrice;
    const overview = el('div', { class: 'card quote-overview' }, [
      el('div', { class: 'mini-head' }, el('span', {}, [el('strong', { text: 'Price overview' }), el('small', { text: `${lane.origin} → ${lane.destination} · ${lane.equipment}` })])),
      suggested
        ? el('div', { class: 'quote-suggested' }, [el('span', { text: 'Suggested price' }), el('strong', { text: money(suggested) }), el('small', { text: est.suggestionBasis })])
        : el('p', { class: 'muted', text: 'Not enough history on this lane yet (3 loads needed), and no market price entered. Set the price yourself; it will count from the next loads on.' }),
      lines.length ? el('dl', { class: 'quote-facts' }, lines.map(([label, value, sub]) => el('div', {}, [el('dt', { text: label }), el('dd', {}, [el('strong', { text: value }), el('small', { text: sub })])]))) : ''
    ]);

    const input = (name, attrs = {}) => el('input', { name, ...attrs });
    const price = input('price', { type: 'number', min: '0.01', step: '0.01', required: true, value: suggested ? String(suggested) : '' });
    const cost = input('carrierCost', { type: 'number', min: '0.01', step: '0.01', value: est.expectedCarrierCost ? String(est.expectedCarrierCost) : '' });
    const marginLine = el('p', { class: 'dispatch-margin muted' });
    const updateMargin = () => {
      const p = Number(price.value);
      const c = Number(cost.value);
      marginLine.classList.remove('negative');
      if (!p || !c) { marginLine.textContent = 'Enter a price and the expected carrier cost to see the margin.'; return; }
      marginLine.textContent = `Margin: ${money(p - c, 2)} (${Math.round(((p - c) / p) * 100)}%)`;
      marginLine.classList.toggle('negative', p < c);
    };
    const validUntil = input('validUntil', { type: 'date', value: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10) });
    const field = (label, control, wide) => el('label', { class: wide ? 'span-2' : '' }, [label, control]);
    const message = el('p', { class: 'shipment-form-message', role: 'status' });
    const form = el('form', { class: 'card quote-form tracking-form', autocomplete: 'off' }, [
      el('div', { class: 'mini-head span-2' }, el('span', {}, [el('strong', { text: 'New quote' }), el('small', { text: 'Saved as a draft. Print it or send it, then mark the answer.' })])),
      field('Customer', input('customer', { maxlength: '120', required: true })),
      field('Customer phone', input('customerPhone', { type: 'tel', maxlength: '40', placeholder: 'Optional' })),
      field(`Price to the customer (${window.VeyraConfig?.currency || 'USD'})`, price),
      field('Expected carrier cost', cost),
      field('Pickup', input('pickup', { type: 'date' })),
      field('Delivery', input('delivery', { type: 'date' })),
      field('Valid until', validUntil),
      field('Notes for the customer', input('notes', { maxlength: '1000', placeholder: 'Optional, e.g. loading time, customs' })),
      el('div', { class: 'span-2' }, marginLine),
      el('div', { class: 'tracking-form-footer span-2' }, [message, el('button', { class: 'btn btn-primary', type: 'submit' }, 'Save quote')])
    ]);
    form.addEventListener('input', updateMargin);
    updateMargin();
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const f = form.elements;
      const optional = (value) => (value.trim() ? value.trim() : undefined);
      message.textContent = 'Saving…';
      try {
        const { quote } = await api('/api/quotes', {
          method: 'POST',
          body: JSON.stringify({
            customer: f.customer.value.trim(), customerPhone: optional(f.customerPhone.value), origin: lane.origin, destination: lane.destination,
            equipment: lane.equipment, weight: lane.weight ? Number(lane.weight) : undefined, price: Number(f.price.value),
            carrierCost: f.carrierCost.value ? Number(f.carrierCost.value) : undefined, pickup: optional(f.pickup.value), delivery: optional(f.delivery.value),
            validUntil: f.validUntil.value, notes: optional(f.notes.value)
          })
        });
        toast(`${quote.number} saved.`);
        quoteState.lane = null;
        quoteState.estimate = null;
        renderQuotes();
      } catch (error) {
        message.textContent = error.message;
      }
    });
    return [overview, form];
  }

  function quoteList(quotes, canWrite) {
    const filters = { open: ['draft', 'sent'], won: ['accepted'], closed: ['declined', 'expired'], all: null };
    const shown = quotes.filter((q) => !filters[quoteState.filter] || filters[quoteState.filter].includes(q.status));
    const tabs = el('div', { class: 'segmented quote-tabs', role: 'group', 'aria-label': 'Show quotes' }, [['open', 'Open'], ['won', 'Won'], ['closed', 'Lost & expired'], ['all', 'All']].map(([key, label]) => el('button', {
      type: 'button', class: quoteState.filter === key ? 'active' : '', 'aria-pressed': String(quoteState.filter === key),
      onclick: () => { quoteState.filter = key; renderQuotes(); }
    }, label)));
    const action = (label, handler, primary) => el('button', { class: `btn ${primary ? 'btn-primary' : 'btn-ghost'} small`, type: 'button', onclick: handler }, label);
    const rows = shown.map((q) => {
      const actions = [el('a', { class: 'btn btn-ghost small', href: `/api/quotes/${q.id}/print`, target: '_blank', rel: 'noopener' }, 'Print')];
      if (canWrite && !q.shipmentId) {
        if (q.status === 'draft') actions.push(action('Mark sent', () => setQuoteStatus(q, 'sent')));
        if (['draft', 'sent', 'expired'].includes(q.status)) {
          actions.push(action('Won → create load', () => convertQuote(q), true));
          actions.push(action('Lost', () => setQuoteStatus(q, 'declined')));
        }
      }
      if (q.shipmentId) actions.push(action(`Open ${q.shipmentId}`, () => openShipmentDetails(q.shipmentId)));
      return [
        el('span', {}, [el('strong', { class: 'id-link', text: q.number }), el('small', { class: 'cell-sub', text: (q.createdAt || '').slice(0, 10) })]),
        el('span', {}, [q.customer, el('small', { class: 'cell-sub', text: q.customerPhone || '' })]),
        el('span', {}, [`${q.origin} → ${q.destination}`, el('small', { class: 'cell-sub', text: [q.equipment, q.weight ? `${q.weight} ${window.VeyraConfig?.weightUnit || 'kg'}` : ''].filter(Boolean).join(' · ') })]),
        el('span', {}, [el('strong', { text: money(q.price) }), el('small', { class: 'cell-sub', text: q.margin === null ? '' : `margin ${money(q.margin)}` })]),
        el('span', { class: `tag ${QUOTE_TONES[q.status] || ''}`, text: QUOTE_LABELS[q.status] || q.status }),
        q.validUntil,
        el('span', { class: 'quote-actions' }, actions)
      ];
    });
    return el('div', { class: 'card panel-card' }, [
      el('div', { class: 'mini-head' }, [el('span', {}, [el('strong', { text: `Quotes (${shown.length})` }), el('small', { text: 'Newest first' })]), tabs]),
      miniTable(['Quote', 'Customer', 'Lane', 'Price', 'Status', 'Valid until', ''], rows, quoteState.filter === 'open' ? 'No open quotes. Check a lane above to make one.' : 'Nothing here yet.')
    ]);
  }

  async function setQuoteStatus(quote, status) {
    try {
      await api(`/api/quotes/${quote.id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      toast(`${quote.number}: ${QUOTE_LABELS[status].toLowerCase()}.`);
      renderQuotes();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  // The customer said yes. Missing dates or weight are asked for, then the load is created.
  async function convertQuote(quote) {
    const body = {};
    const askDate = (label, fallback) => window.prompt(`${label} (YYYY-MM-DD)`, fallback || '');
    if (!quote.pickup) body.pickup = askDate('Pickup date', new Date().toISOString().slice(0, 10));
    if (!quote.pickup && !body.pickup) return;
    if (!quote.delivery) body.delivery = askDate('Delivery date', body.pickup || quote.pickup);
    if (!quote.delivery && !body.delivery) return;
    if (!quote.weight) {
      body.weight = window.prompt(`Weight (${window.VeyraConfig?.weightUnit || 'kg'})`, '');
      if (!body.weight) return;
    }
    try {
      const result = await api(`/api/quotes/${quote.id}/convert`, { method: 'POST', body: JSON.stringify(body) });
      toast(`${quote.number} won: ${result.shipmentId} created.`);
      await renderQuotes();
      openShipmentDetails(result.shipmentId);
    } catch (error) {
      toast(error.message, 'error');
    }
  }



  /* =========================================================
     GLOBAL TRACKING
     ========================================================= */
  const trackState = { data: null, filter: 'all', selected: null, timer: null };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs = {}, children = []) {
    const node = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, String(value));
    });
    children.forEach((child) => child && node.append(child));
    return node;
  }
  const shortPlace = (place) => String(place || '').split(',')[0].trim();

  async function renderTracking() {
    const container = document.getElementById('trackingView');
    if (!container) return;
    clearTimeout(trackState.timer);
    if (!currentUser()) return gate(container, 'signin');
    if (!container.children.length) loading(container);
    try {
      trackState.data = await api('/api/tracking/overview');
    } catch (error) {
      return errorState(container, error.message, renderTracking);
    }
    if (state.view !== 'tracking') return;
    const { loads } = trackState.data;
    if (!loads.some((load) => load.id === trackState.selected)) trackState.selected = (loads.find((l) => l.status !== 'Delivered') || loads[0])?.id || null;
    buildTracking(container);
    // Positions change while the page is open: refresh every two minutes.
    trackState.timer = setTimeout(() => { if (state.view === 'tracking') renderTracking(); }, 120000);
  }

  function buildTracking(container) {
    const { summary, loads, alerts, map } = trackState.data;
    const kpis = el('div', { class: 'stats-grid kpi-grid' }, [
      kpiCard('Active loads', String(summary.active), `${summary.withGps} with live GPS`, 'box', 'blue'),
      kpiCard('On time', summary.onTimeShare === null ? '—' : `${summary.onTimeShare}%`, 'Expected before the promised day', 'check-circle', 'green'),
      kpiCard('In transit', String(summary.inTransit), `${summary.booked} booked, not left yet`, 'truck', 'violet'),
      kpiCard('Exceptions', String(summary.exceptions), alerts.length ? `${alerts.length} alert${alerts.length === 1 ? '' : 's'} open` : 'No alerts', 'alert', summary.exceptions ? 'red' : 'green')
    ]);
    const filters = { all: () => true, 'In Transit': (l) => l.status === 'In Transit', Dispatched: (l) => l.status === 'Dispatched', Exception: (l) => l.status === 'Exception', Delivered: (l) => l.status === 'Delivered' };
    const shown = loads.filter(filters[trackState.filter] || filters.all);
    const chips = el('div', { class: 'track-chips', role: 'group', 'aria-label': 'Show' }, [['all', 'All'], ['In Transit', 'In transit'], ['Dispatched', 'Booked'], ['Exception', 'Exception'], ['Delivered', 'Delivered']].map(([key, label]) => el('button', {
      type: 'button', class: trackState.filter === key ? 'active' : '', 'aria-pressed': String(trackState.filter === key),
      onclick: () => { trackState.filter = key; buildTracking(container); }
    }, label)));
    const mapCard = el('div', { class: 'card track-map-card' }, [
      el('div', { class: 'track-map-head' }, [el('span', { class: 'cc-live-dot', text: 'Live' }), chips]),
      drawTrackMap(shown, map, () => buildTracking(container))
    ]);
    const selected = loads.find((load) => load.id === trackState.selected) || null;
    const top = el('div', { class: 'track-top' }, [mapCard, trackDetail(selected)]);

    const list = el('div', { class: 'card panel-card' }, [
      el('div', { class: 'mini-head' }, el('span', {}, [el('strong', { text: `Loads (${shown.length})` }), el('small', { text: 'Click a row to see it on the map' })])),
      miniTable(['Load', 'Status', 'Route', 'Truck', 'Last seen', 'Delivery'], shown.map((load) => [
        el('button', { class: 'link-button', type: 'button', onclick: () => { trackState.selected = load.id; buildTracking(container); window.scrollTo({ top: 0, behavior: 'smooth' }); } }, load.id),
        el('span', { class: `tag ${String(load.status).toLowerCase().replace(/\s+/g, '-')}`, text: load.status }),
        `${shortPlace(load.origin)} → ${shortPlace(load.destination)}`,
        load.truckPlate || '—',
        load.lastLocation ? el('span', {}, [load.lastLocation, el('small', { class: 'cell-sub', text: load.lastTrackedAt ? formatTimestamp(load.lastTrackedAt) : '' })]) : el('span', { class: 'muted', text: 'No update yet' }),
        el('span', { class: load.onTime === false ? 'warn-line' : '' , text: load.delivery || '—' })
      ]), 'No booked loads right now.')
    ]);
    const alertCard = el('div', { class: 'card panel-card' }, [
      el('div', { class: 'mini-head' }, [el('span', {}, [el('strong', { text: `Active alerts (${alerts.length})` }), el('small', { text: 'SENTINEL, checked now' })]), el('button', { class: 'view-all', type: 'button', onclick: () => navigate('inbox') }, 'Inbox & tasks')]),
      alerts.length
        ? el('ul', { class: 'risk-list' }, alerts.slice(0, 8).map((risk) => el('li', { class: `risk-${risk.severity}` }, [
          el('span', { class: 'risk-level', text: { high: 'Urgent', medium: 'Soon', low: 'Note' }[risk.severity] || risk.severity }),
          el('div', {}, [el('button', { class: 'link-button', type: 'button', onclick: () => openShipmentDetails(risk.shipmentId) }, risk.title), el('small', { class: 'muted', text: risk.advice })])
        ])))
        : el('p', { class: 'muted', text: 'All booked loads look fine.' })
    ]);
    container.replaceChildren(kpis, top, el('div', { class: 'track-bottom' }, [list, alertCard]));
  }

  // A schematic map: real coordinates on a latitude / longitude grid, fitted to the loads shown.
  function drawTrackMap(loads, map, redraw) {
    const points = [];
    loads.forEach((load) => [load.from, load.to, load.gps].forEach((p) => p && points.push(p)));
    if (!points.length) {
      return el('div', { class: 'track-map-empty' }, [
        el('strong', { text: loads.length ? 'No positions to draw yet' : 'No booked loads' }),
        el('p', { text: loads.length
          ? (map.enabled ? 'City positions are being looked up; they appear on the next refresh. Trucks appear when GPS sends positions.' : 'Trucks appear when a GPS provider sends positions. To also draw cities and routes, switch on the map on the server (GEO_PROVIDER=osm).')
          : 'Booked and moving loads will appear here.' })
      ]);
    }
    const W = 1000;
    const H = 520;
    const lats = points.map((p) => p.lat);
    const lngs = points.map((p) => p.lng);
    const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const kx = Math.cos((midLat * Math.PI) / 180);
    let minX = Math.min(...lngs) * kx; let maxX = Math.max(...lngs) * kx;
    let minY = -Math.max(...lats); let maxY = -Math.min(...lats);
    const span = Math.max(maxX - minX, (maxY - minY) * (W / H), 2);
    const cx = (minX + maxX) / 2; const cy = (minY + maxY) / 2;
    const scale = (W * 0.82) / span;
    const project = (p) => [W / 2 + (p.lng * kx - cx) * scale, H / 2 + (-p.lat - cy) * scale];

    const grid = [];
    const lngSpan = span / kx;
    const step = lngSpan > 60 ? 20 : lngSpan > 25 ? 10 : lngSpan > 10 ? 5 : 2;
    const latRange = [midLat - (H / scale), midLat + (H / scale)];
    const lngCenter = cx / kx;
    for (let lng = Math.floor((lngCenter - lngSpan) / step) * step; lng <= lngCenter + lngSpan; lng += step) {
      const [x] = project({ lat: midLat, lng });
      grid.push(svgEl('line', { x1: x, y1: 0, x2: x, y2: H, class: 'track-grid' }));
    }
    for (let lat = Math.floor(latRange[0] / step) * step; lat <= latRange[1]; lat += step) {
      const [, y] = project({ lat, lng: lngCenter });
      grid.push(svgEl('line', { x1: 0, y1: y, x2: W, y2: y, class: 'track-grid' }));
    }

    const layers = [];
    const cities = new Map();
    loads.forEach((load) => {
      const selected = load.id === trackState.selected;
      const pick = () => { trackState.selected = load.id; redraw(); };
      const tone = load.status === 'Exception' ? 'bad' : (load.onTime === false ? 'late' : 'ok');
      if (load.from && load.to) {
        const [x1, y1] = project(load.from);
        const [x2, y2] = project(load.to);
        const mx = (x1 + x2) / 2; const my = (y1 + y2) / 2;
        const lift = Math.min(120, Math.hypot(x2 - x1, y2 - y1) * 0.22);
        const d = `M${x1.toFixed(1)},${y1.toFixed(1)} Q${mx.toFixed(1)},${(my - lift).toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
        layers.push(svgEl('path', { d, class: `track-route ${tone}${selected ? ' selected' : ''}`, onclick: pick }, [svgEl('title', {}, [document.createTextNode(`${load.id} · ${load.origin} → ${load.destination}`)])]));
        [[load.from, load.origin, 'from'], [load.to, load.destination, 'to']].forEach(([p, name, kind]) => {
          const k = `${p.lat.toFixed(3)},${p.lng.toFixed(3)}`;
          if (!cities.has(k)) cities.set(k, { p, name, kind });
        });
      }
      if (load.gps) {
        const [x, y] = project(load.gps);
        layers.push(svgEl('g', { class: `track-truck ${tone}${selected ? ' selected' : ''}`, transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})`, onclick: pick, tabindex: '0', role: 'button', 'aria-label': `${load.id}, last GPS position` }, [
          svgEl('circle', { r: selected ? 16 : 12, class: 'track-truck-halo' }),
          svgEl('circle', { r: selected ? 7 : 5.5, class: 'track-truck-dot' }),
          svgEl('title', {}, [document.createTextNode(`${load.id} · ${load.lastLocation || 'GPS position'}`)])
        ]));
      }
    });
    const cityLayer = [...cities.values()].map(({ p, name, kind }) => {
      const [x, y] = project(p);
      return svgEl('g', { class: `track-city ${kind}`, transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})` }, [
        svgEl('circle', { r: 5 }),
        svgEl('text', { x: 9, y: -9 }, [document.createTextNode(shortPlace(name))])
      ]);
    });
    return el('div', { class: 'track-map' }, svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'track-svg', role: 'img', 'aria-label': `Map of ${loads.length} loads` }, [
      svgEl('g', {}, grid), svgEl('g', {}, layers.filter((n) => n.tagName === 'path')), svgEl('g', {}, cityLayer), svgEl('g', {}, layers.filter((n) => n.tagName === 'g'))
    ]));
  }

  function trackDetail(load) {
    if (!load) return el('div', { class: 'card track-detail' }, [el('p', { class: 'muted', text: 'Select a load on the map or in the list.' })]);
    const steps = [
      ['Booked', load.timeline.bookedAt],
      ['On the way', load.timeline.departedAt],
      ['Delivered', load.timeline.deliveredAt]
    ];
    const reached = load.status === 'Delivered' ? 3 : (['In Transit', 'Exception'].includes(load.status) ? 2 : 1);
    const fact = (label, value) => el('div', {}, [el('small', { text: label }), el('strong', { text: value || '—' })]);
    return el('div', { class: 'card track-detail' }, [
      el('div', { class: 'track-detail-head' }, [
        el('span', { class: 'stat-icon blue' }, icon('box', '')),
        el('span', {}, [el('strong', { text: load.id }), el('small', { text: `${load.origin} → ${load.destination}` })]),
        el('span', { class: `tag ${String(load.status).toLowerCase().replace(/\s+/g, '-')}`, text: load.status })
      ]),
      el('ol', { class: 'track-steps' }, steps.map(([label, time], index) => el('li', { class: index < reached ? 'done' : '' }, [
        el('span', { class: 'track-step-dot' }), el('strong', { text: label }), el('small', { text: time ? formatTimestamp(time) : (index === 2 ? `Planned ${load.delivery || ''}` : '') })
      ]))),
      el('div', { class: 'track-facts' }, [
        fact('Expected arrival', load.eta ? (typeof formatEta === 'function' ? formatEta(load.eta) : load.eta) : null),
        fact('Promised delivery', load.delivery),
        fact('Last place', load.lastLocation),
        fact('Last update', load.lastTrackedAt ? formatTimestamp(load.lastTrackedAt) : null),
        fact('Truck', [load.truckPlate, load.carrierName].filter(Boolean).join(' · ')),
        fact('Driver', [load.driverName, load.driverPhone].filter(Boolean).join(' · '))
      ]),
      load.risks.length ? el('ul', { class: 'track-risks' }, load.risks.map((risk) => el('li', { class: `risk-${risk.severity}`, text: risk.title }))) : el('p', { class: 'track-ok', text: load.status === 'Delivered' ? 'Delivered.' : 'No warnings for this load.' }),
      el('div', { class: 'track-detail-actions' }, [
        el('button', { class: 'btn btn-primary small', type: 'button', onclick: () => openShipmentDetails(load.id) }, 'Open load'),
        load.driverPhone ? el('a', { class: 'btn btn-ghost small', href: `tel:${String(load.driverPhone).replace(/[^+\d]/g, '')}` }, 'Call driver') : null
      ])
    ]);
  }

  /* =========================================================
     AI COMMAND CENTER
     ========================================================= */
  const KIND_LABELS = { review_intake: 'Orders read', book_carrier: 'Carriers ranked', message: 'Messages drafted', check_document: 'Documents checked', attention: 'Warnings raised' };

  async function renderCommand() {
    const container = document.getElementById('commandView');
    if (!container) return;
    if (!currentUser()) return gate(container, 'signin');
    if (!container.children.length) loading(container);
    let data;
    try {
      data = await api('/api/ai/command-center');
    } catch (error) {
      return errorState(container, error.message, renderCommand);
    }
    if (state.view !== 'command') return;

    const planAi = window.VeyraAi?.allowed() !== false;
    const agentOn = { FLOW: data.agents.ai && planAi, VAULT: data.agents.ai && planAi, RELAY: true, NEXUS: data.nexus.enabled, SCOUT: true, ROUTE: true, PULSE: true, SENTINEL: true };
    const agentsCard = el('div', { class: 'card cc-agents' }, [
      el('div', { class: 'mini-head' }, el('span', {}, [
        el('strong', { text: `AI agents · ${Object.values(agentOn).filter(Boolean).length} active` }),
        el('small', { text: 'Each prepares one kind of work' })
      ])),
      el('ul', { class: 'cc-agent-list' }, AGENTS.map((agent) => el('li', {}, [
        el('span', { class: `stat-icon ${agent.tone}` }, icon(agent.icon, '')),
        el('span', { class: 'cc-agent-text' }, [el('strong', { text: agent.name }), el('small', { text: agent.role })]),
        el('span', { class: `agent-state ${agentOn[agent.key] ? 'on' : 'off'}`, text: agentOn[agent.key] ? 'Active' : 'Off' })
      ]))),
      el('button', { class: 'btn btn-ghost small', type: 'button', onclick: () => navigate('agents') }, 'Agent details')
    ]);

    const actions = [
      ['Plan', 'target', 'Dates and return trucks (ROUTE)', () => navigate('shipments', { status: 'Sourcing' })],
      ['Price', 'chart', 'Quotes and lane prices (PULSE)', () => navigate('quotes')],
      ...(planAi ? [['Read', 'doc', 'Turn an order message into a load (FLOW)', () => window.openShipmentModal?.({})]] : []),
      ['Approve', 'check-square', 'Prepared work waiting for you', () => navigate('inbox')],
      ['Watch', 'alert', 'Loads at risk (SENTINEL)', () => navigate('inbox')],
      ['Analyze', 'bolt', 'Volume, lanes, margins', () => navigate('analytics')]
    ];
    const orbCard = el('div', { class: 'card cc-orb-card' }, [
      el('div', { class: 'cc-orb-wrap' }, [
        el('div', { class: 'cc-orb' }, [el('span', { class: 'cc-orb-mark' }), el('strong', { text: 'Veyra AI' }), el('small', { text: 'Your logistics team, with eight agents behind it' })]),
        el('div', { class: 'cc-actions' }, actions.map(([label, iconName, hint, handler]) => el('button', { class: 'cc-action', type: 'button', title: hint, onclick: handler }, [
          el('span', { class: 'cc-action-icon' }, icon(iconName, '')), el('strong', { text: label }), el('small', { text: hint })
        ])))
      ])
    ]);
    const mark = orbCard.querySelector('.cc-orb-mark');
    if (mark) {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', '0 0 100 80');
      const use = document.createElementNS(ns, 'use');
      use.setAttribute('href', '#logo-v');
      svg.append(use);
      mark.append(svg);
    }

    const live = data.live;
    const liveCard = el('div', { class: 'card cc-live' }, [
      el('div', { class: 'mini-head' }, [el('span', {}, [el('strong', { text: 'Live operations' }), el('small', { text: 'Right now' })]), el('span', { class: 'cc-live-dot', text: 'Live' })]),
      el('div', { class: 'cc-live-grid' }, [
        ['On the road', live.onRoad, 'truck', () => navigate('shipments', { status: 'In Transit' })],
        ['Waiting for a truck', live.waiting, 'box', () => navigate('shipments', { status: 'Sourcing' })],
        ['Tasks to approve', live.openTasks, 'check-square', () => navigate('inbox')],
        ['Loads at risk', live.risks, 'alert', () => navigate('inbox')]
      ].map(([label, value, iconName, handler]) => el('button', { class: 'cc-live-item', type: 'button', onclick: handler }, [
        el('span', { class: 'cc-live-icon' }, icon(iconName, '')), el('strong', { text: String(value) }), el('small', { text: label })
      ]))),
      live.urgentRisks ? el('p', { class: 'cc-live-warn', text: `${live.urgentRisks} urgent: open Inbox & tasks.` }) : el('p', { class: 'cc-live-ok', text: 'Nothing urgent.' })
    ]);

    // Switches: what the agents may do by themselves. They only ever prepare; sending and booking stay with people.
    const autoCard = el('div', { class: 'card cc-auto' }, [
      el('div', { class: 'mini-head' }, el('span', {}, [el('strong', { text: 'Automations' }), el('small', { text: data.canChange ? 'What the agents do on their own. They only prepare; people send and book.' : 'Only an administrator can change these.' })])),
      data.nexus.enabled ? null : el('p', { class: 'warn-line', text: 'NEXUS is switched off on the server (NEXUS_ENABLED=false), so none of these run.' }),
      // A plan without the AI agents does not see the switches of the automations that need AI.
      el('ul', { class: 'cc-switch-list' }, data.automations.filter((item) => planAi || !item.needsAi).map((item) => {
        const input = el('input', { type: 'checkbox', role: 'switch', 'aria-label': item.label, disabled: !data.canChange });
        input.checked = item.on;
        input.addEventListener('change', async () => {
          input.disabled = true;
          try {
            await api('/api/settings/automations', { method: 'PUT', body: JSON.stringify({ [item.key]: input.checked }) });
            toast(`${item.label}: ${input.checked ? 'on' : 'off'}.`);
          } catch (error) {
            input.checked = !input.checked;
            toast(error.message, 'error');
          }
          input.disabled = !data.canChange;
        });
        return el('li', {}, [el('span', { text: item.label }), el('label', { class: 'switch' }, [input, el('span', { class: 'switch-track', 'aria-hidden': 'true' })])]);
      }))
    ]);

    const perf = data.performance;
    const handledShare = perf.prepared ? Math.round((perf.handled / perf.prepared) * 100) : null;
    const top = Math.max(1, ...perf.daily.map((d) => d.total));
    const perfCard = el('div', { class: 'card cc-perf' }, [
      el('div', { class: 'mini-head' }, el('span', {}, [el('strong', { text: 'AI performance' }), el('small', { text: `Last ${perf.days} days` })])),
      el('div', { class: 'cc-perf-grid' }, [
        ['Work prepared', String(perf.prepared)],
        ['Handled by people', handledShare === null ? '—' : `${handledShare}%`],
        ['Time to handle', perf.minutesToHandle === null ? '—' : (perf.minutesToHandle < 90 ? `${perf.minutesToHandle} min` : `${Math.round(perf.minutesToHandle / 60)} h`)],
        [perf.aiCalls ? `AI calls answered (${perf.aiCalls})` : 'AI calls', perf.aiCalls ? `${perf.aiSuccessRate}%` : (data.agents.ai ? '0' : 'AI off')]
      ].map(([label, value]) => el('div', {}, [el('strong', { text: value }), el('small', { text: label })]))),
      perf.daily.length
        ? el('div', { class: 'cc-bars', role: 'img', 'aria-label': 'Work prepared per day' }, perf.daily.map((d) => el('span', { title: `${d.day}: ${d.total}`, style: `height:${Math.max(6, Math.round((d.total / top) * 100))}%` })))
        : el('p', { class: 'muted', text: 'No work prepared yet in this period.' }),
      el('ul', { class: 'cc-kinds' }, Object.entries(perf.byKind).map(([kind, total]) => el('li', {}, [el('span', { text: KIND_LABELS[kind] || kind }), el('strong', { text: String(total) })])))
    ]);

    const activityCard = el('div', { class: 'card cc-activity' }, [
      el('div', { class: 'mini-head' }, el('span', {}, [el('strong', { text: 'Recent AI activity' }), el('small', { text: 'Newest first' })])),
      data.activity.length
        ? el('ul', { class: 'activity-list' }, data.activity.map((item) => el('li', {}, [
          el('span', { class: `activity-dot ${item.status}` }),
          el('span', {}, [
            item.shipmentId ? el('button', { class: 'link-button', type: 'button', onclick: () => openShipmentDetails(item.shipmentId) }, item.title) : el('strong', { text: item.title }),
            el('small', { class: 'muted', text: `${{ open: 'Waiting', done: 'Done', dismissed: 'Closed' }[item.status] || item.status} · ${typeof formatTimestamp === 'function' ? formatTimestamp(item.createdAt) : item.createdAt}` })
          ])
        ])))
        : el('p', { class: 'muted', text: 'Nothing yet. New orders, bookings and late trucks will appear here.' })
    ]);

    container.replaceChildren(
      el('div', { class: 'cc-top' }, [agentsCard, orbCard, liveCard]),
      el('div', { class: 'cc-bottom' }, [autoCard, perfCard, activityCard])
    );
  }

  /* =========================================================
     AUTOMATION STUDIO: "when ... then ..." rules, drawn as a flow
     ========================================================= */
  const studioState = { tab: 'workflows', selected: null, draft: null, data: null, testLoad: '', test: null };
  const blankWorkflow = () => ({ name: 'New workflow', description: '', trigger: 'shipment.status', triggerStatus: 'Delivered', conditions: [], actions: [{ type: 'create_task', title: 'Check {id} · {customer}', note: '' }], enabled: true });
  const copyRule = (rule) => JSON.parse(JSON.stringify({
    name: rule.name, description: rule.description || '', trigger: rule.trigger, triggerStatus: rule.triggerStatus || null,
    conditions: rule.conditions || [], actions: rule.actions || [], enabled: rule.enabled !== false
  }));

  async function renderStudio(keepDraft = false) {
    const container = document.getElementById('studioView');
    if (!container) return;
    if (!currentUser()) return gate(container, 'signin');
    if (!container.children.length) loading(container);
    try {
      studioState.data = await api('/api/automation/studio');
    } catch (error) {
      return errorState(container, error.message, () => renderStudio());
    }
    if (state.view !== 'automation') return;
    const data = studioState.data;
    // A plan without the AI agents does not see the built-in automations that need AI.
    if (window.VeyraAi?.allowed() === false) data.builtIn = data.builtIn.filter((item) => !item.needsAi);
    const exists = (key) => (key?.startsWith('w:') ? data.workflows.some((w) => `w:${w.id}` === key) : key?.startsWith('b:') ? data.builtIn.some((b) => `b:${b.key}` === key) : key === 'new');
    if (!exists(studioState.selected)) {
      studioState.selected = data.workflows[0] ? `w:${data.workflows[0].id}` : `b:${data.builtIn[0].key}`;
      keepDraft = false;
    }
    if (!keepDraft) loadDraft();
    drawStudio();
  }

  function loadDraft() {
    const { data, selected } = studioState;
    studioState.test = null;
    if (selected === 'new') return;
    const rule = selected.startsWith('w:') ? data.workflows.find((w) => `w:${w.id}` === selected) : null;
    studioState.draft = rule ? copyRule(rule) : null;
  }

  function selectStudio(key, draft = null) {
    studioState.selected = key;
    studioState.tab = 'workflows';
    if (draft) {
      studioState.draft = draft;
      studioState.test = null;
    } else loadDraft();
    drawStudio();
  }

  function drawStudio() {
    const container = document.getElementById('studioView');
    const data = studioState.data;
    if (!container || !data) return;
    const stats = data.stats;
    const kpis = el('div', { class: 'stats-grid kpi-grid' }, [
      kpiCard('Active flows', String(stats.active), `${stats.custom} of your own, ${data.builtIn.length} built in`, 'bolt', 'violet'),
      kpiCard('Runs', String(stats.runs30), 'Your workflows, last 30 days', 'check-square', 'blue'),
      kpiCard('Success rate', stats.successRate === null ? '—' : `${stats.successRate}%`, stats.runs30 ? 'Runs that finished every step' : 'No runs yet', 'check-circle', 'green'),
      kpiCard('Prepared, not sent', 'Always', 'Rules prepare tasks and drafts; people send', 'eye', 'amber')
    ]);
    const tabs = el('div', { class: 'studio-bar' }, [
      el('div', { class: 'studio-tabs', role: 'tablist' }, [['workflows', 'Workflows'], ['templates', `Templates (${data.templates.length})`], ['runs', `Runs & history (${data.runs.length})`]].map(([key, label]) => el('button', {
        type: 'button', role: 'tab', class: studioState.tab === key ? 'active' : '', 'aria-selected': String(studioState.tab === key),
        onclick: () => { studioState.tab = key; drawStudio(); }
      }, label))),
      data.canChange ? el('button', { class: 'btn btn-primary small', type: 'button', onclick: () => selectStudio('new', blankWorkflow()) }, '+ Create workflow') : null
    ]);
    const warn = data.nexus.enabled ? null : el('p', { class: 'warn-line', text: 'NEXUS is switched off on the server (NEXUS_ENABLED=false), so no workflow runs.' });
    let body;
    if (studioState.tab === 'templates') body = studioTemplates(data);
    else if (studioState.tab === 'runs') body = studioRuns(data);
    else body = el('div', { class: 'studio-grid' }, [studioList(data), studioCanvas(data), studioPanel(data)]);
    container.replaceChildren(...[kpis, tabs, warn, body].filter(Boolean));
  }

  function studioList(data) {
    const item = (key, title, sub, on) => el('li', {}, el('button', {
      type: 'button', class: `studio-item${studioState.selected === key ? ' active' : ''}`, onclick: () => selectStudio(key)
    }, [el('span', { class: `studio-dot ${on ? 'on' : 'off'}` }), el('span', {}, [el('strong', { text: title }), el('small', { text: sub })])]));
    return el('div', { class: 'card studio-list' }, [
      el('div', { class: 'mini-head' }, el('span', {}, [el('strong', { text: 'Your workflows' }), el('small', { text: data.workflows.length ? 'Rules your company wrote' : 'None yet: create one or use a template' })])),
      el('ul', {}, [
        studioState.selected === 'new' ? item('new', studioState.draft?.name || 'New workflow', 'Not saved yet', true) : null,
        ...data.workflows.map((w) => item(`w:${w.id}`, w.name, `${w.triggerText} · ${w.runs30} run${w.runs30 === 1 ? '' : 's'}`, w.enabled))
      ]),
      el('div', { class: 'mini-head' }, el('span', {}, [el('strong', { text: 'Built in' }), el('small', { text: 'What the agents do by themselves' })])),
      el('ul', {}, data.builtIn.map((b) => item(`b:${b.key}`, b.name, b.trigger, b.on)))
    ]);
  }

  // The selected rule drawn top to bottom: trigger, conditions, each action, done.
  function studioCanvas(data) {
    const { selected, draft } = studioState;
    const opts = data.options;
    let title; let on; let nodes;
    if (selected.startsWith('b:')) {
      const b = data.builtIn.find((x) => `b:${x.key}` === selected);
      title = b.name; on = b.on;
      nodes = [['trigger', 'Trigger', b.trigger], ...b.steps.map((step) => ['ai', 'AI step', step]), ['action', 'Result', b.result]];
    } else {
      title = draft.name || 'Untitled'; on = draft.enabled;
      const triggerText = draft.trigger === 'shipment.status' ? `A load becomes ${draft.triggerStatus || '…'}` : opts.triggers[draft.trigger];
      nodes = [['trigger', 'Trigger', triggerText]];
      if (draft.conditions.length) nodes.push(['check', 'Only if', draft.conditions.map((c) => `${opts.fields[c.field]} contains "${c.value || '…'}"`).join(' and ')]);
      draft.actions.forEach((a) => nodes.push(['action', opts.actions[a.type]?.label || 'Action', a.type === 'create_task' ? (a.title || '…') : (opts.purposes[a.purpose] || a.purpose)]));
    }
    nodes.push(['done', 'Complete', 'Waits in Inbox & tasks for a person']);
    return el('div', { class: 'card studio-canvas' }, [
      el('div', { class: 'mini-head' }, [
        el('span', {}, [el('strong', { text: title }), el('small', { text: selected.startsWith('b:') ? 'Built-in workflow' : selected === 'new' ? 'Draft' : 'Your workflow' })]),
        el('span', { class: `agent-state ${on ? 'on' : 'off'}`, text: on ? 'Active' : 'Off' })
      ]),
      el('ol', { class: 'flow' }, nodes.map(([kind, label, text]) => el('li', { class: `flow-node ${kind}` }, [el('strong', { text: label }), el('small', { text })])))
    ]);
  }

  function studioPanel(data) {
    const { selected } = studioState;
    if (selected.startsWith('b:')) {
      const b = data.builtIn.find((x) => `b:${x.key}` === selected);
      const input = el('input', { type: 'checkbox', role: 'switch', 'aria-label': b.name, disabled: !data.canChange });
      input.checked = b.on;
      input.addEventListener('change', async () => {
        input.disabled = true;
        try {
          await api('/api/settings/automations', { method: 'PUT', body: JSON.stringify({ [b.key]: input.checked }) });
          toast(`${b.name}: ${input.checked ? 'on' : 'off'}.`);
          await renderStudio(true);
        } catch (error) {
          input.checked = !input.checked;
          input.disabled = false;
          toast(error.message, 'error');
        }
      });
      return el('div', { class: 'card studio-panel' }, [
        el('div', { class: 'mini-head' }, el('span', {}, [el('strong', { text: 'Step configuration' }), el('small', { text: 'Built-in workflows can be switched on or off' })])),
        el('div', { class: 'studio-row' }, [el('span', { text: 'Runs automatically' }), el('label', { class: 'switch' }, [input, el('span', { class: 'switch-track', 'aria-hidden': 'true' })])]),
        el('p', { class: 'muted', text: `When: ${b.trigger}. Then: ${b.steps.join(', ')}. Result: ${b.result}.` }),
        data.canChange ? null : el('p', { class: 'muted', text: 'Only an administrator can change workflows.' }),
        el('div', { class: 'studio-tip' }, [el('strong', { text: 'Veyra AI tip' }), el('small', { text: 'Need something these do not cover? Create your own workflow or start from a template.' })])
      ]);
    }
    return studioEditor(data);
  }

  function studioEditor(data) {
    const draft = studioState.draft;
    const opts = data.options;
    const ro = !data.canChange;
    const redraw = (_value, typing = false) => {
      if (!typing) return drawStudio();
      const canvas = document.querySelector('#studioView .studio-canvas');
      if (canvas) canvas.replaceWith(studioCanvas(data));
    };
    const select = (value, entries, onchange, label) => {
      const node = el('select', { 'aria-label': label, disabled: ro, onchange: (event) => onchange(event.target.value) }, entries.map(([key, text]) => el('option', { value: key, text })));
      node.value = value ?? '';
      return node;
    };
    const text = (value, max, onchange, label, placeholder = '') => el('input', {
      type: 'text', value: value || '', maxlength: max, 'aria-label': label, placeholder, disabled: ro,
      // Typing only redraws the flow, so the field keeps focus and a click on Save is not lost.
      oninput: (event) => { onchange(event.target.value, true); }
    });
    const field = (label, control) => el('label', { class: 'studio-field' }, [el('span', { text: label }), control]);

    const conditions = draft.conditions.map((c, index) => el('div', { class: 'studio-line' }, [
      select(c.field, Object.entries(opts.fields), (v) => { c.field = v; redraw(); }, 'Field'),
      text(c.value, opts.limits.value, (v, t) => { c.value = v; redraw(v, t); }, 'Contains', 'contains…'),
      ro ? null : el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove condition', onclick: () => { draft.conditions.splice(index, 1); redraw(); } }, '×')
    ]));
    const actions = draft.actions.map((a, index) => el('div', { class: 'studio-action' }, [
      el('div', { class: 'studio-line' }, [
        select(a.type, Object.entries(opts.actions).map(([k, v]) => [k, v.label]), (v) => {
          draft.actions[index] = v === 'create_task' ? { type: v, title: 'Check {id}', note: '' } : { type: v, purpose: opts.actions[v].purposes[0] };
          redraw();
        }, 'Action'),
        ro || draft.actions.length < 2 ? null : el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove action', onclick: () => { draft.actions.splice(index, 1); redraw(); } }, '×')
      ]),
      a.type === 'create_task'
        ? text(a.title, opts.limits.title, (v, t) => { a.title = v; redraw(v, t); }, 'Task title', 'Task title, e.g. Call {customer} about {id}')
        : select(a.purpose, opts.actions[a.type].purposes.map((p) => [p, opts.purposes[p]]), (v) => { a.purpose = v; redraw(); }, 'Message')
    ]));

    const enabled = el('input', { type: 'checkbox', role: 'switch', 'aria-label': 'Active', disabled: ro, onchange: (event) => { draft.enabled = event.target.checked; redraw(); } });
    enabled.checked = draft.enabled;
    const isNew = studioState.selected === 'new';
    const id = isNew ? null : Number(studioState.selected.slice(2));

    async function save(button) {
      button.disabled = true;
      try {
        const result = await api(isNew ? '/api/automation/workflows' : `/api/automation/workflows/${id}`, { method: isNew ? 'POST' : 'PUT', body: JSON.stringify(draft) });
        toast(`Saved "${result.workflow.name}".`);
        studioState.selected = `w:${result.workflow.id}`;
        await renderStudio();
      } catch (error) {
        toast(error.message, 'error');
        button.disabled = false;
      }
    }
    async function remove(button) {
      if (!window.confirm(`Delete the workflow "${draft.name}"?`)) return;
      button.disabled = true;
      try {
        await api(`/api/automation/workflows/${id}`, { method: 'DELETE' });
        toast('Workflow deleted.');
        studioState.selected = null;
        await renderStudio();
      } catch (error) {
        toast(error.message, 'error');
        button.disabled = false;
      }
    }
    async function runTest(button) {
      button.disabled = true;
      try {
        studioState.test = await api('/api/automation/test', { method: 'POST', body: JSON.stringify({ workflow: draft, shipmentId: studioState.testLoad.trim() }) });
      } catch (error) {
        studioState.test = { error: error.message };
      }
      redraw();
    }

    const test = studioState.test;
    const testResult = !test ? null : test.error ? el('p', { class: 'warn-line', text: test.error }) : el('div', { class: `studio-test ${test.matched ? 'ok' : 'no'}` }, [
      el('strong', { text: test.matched ? `${test.shipment.id} matches: this would happen` : `${test.shipment.id} does not match` }),
      el('ul', {}, [
        ...test.conditions.map((c) => el('li', { text: `${c.ok ? '✓' : '✗'} ${c.label} "${c.actual || '—'}" contains "${c.value}"` })),
        ...test.actions.map((a) => el('li', { text: `→ ${a}` }))
      ]),
      el('small', { class: 'muted', text: 'Test only: nothing was created.' })
    ]);

    return el('div', { class: 'card studio-panel' }, [
      el('div', { class: 'mini-head' }, el('span', {}, [el('strong', { text: 'Step configuration' }), el('small', { text: ro ? 'Only an administrator can change workflows' : 'Changes show on the flow right away' })])),
      field('Name', text(draft.name, opts.limits.name, (v, t) => { draft.name = v; redraw(v, t); }, 'Name')),
      el('div', { class: 'studio-row' }, [el('span', { text: 'Active' }), el('label', { class: 'switch' }, [enabled, el('span', { class: 'switch-track', 'aria-hidden': 'true' })])]),
      el('h4', { text: '1. When' }),
      select(draft.trigger, Object.entries(opts.triggers), (v) => { draft.trigger = v; draft.triggerStatus = v === 'shipment.status' ? (draft.triggerStatus || 'Delivered') : null; redraw(); }, 'Trigger'),
      draft.trigger === 'shipment.status' ? field('Status', select(draft.triggerStatus, opts.statuses.map((s) => [s, s]), (v) => { draft.triggerStatus = v; redraw(); }, 'Status')) : null,
      el('h4', { text: '2. Only if (optional)' }),
      ...conditions,
      ro || draft.conditions.length >= opts.limits.conditions ? null : el('button', { class: 'btn btn-ghost small', type: 'button', onclick: () => { draft.conditions.push({ field: 'customer', value: '' }); redraw(); } }, '+ Add condition'),
      el('h4', { text: '3. Then' }),
      ...actions,
      ro || draft.actions.length >= opts.limits.actions ? null : el('button', { class: 'btn btn-ghost small', type: 'button', onclick: () => { draft.actions.push({ type: 'create_task', title: '', note: '' }); redraw(); } }, '+ Add action'),
      el('small', { class: 'muted', text: 'In a task title, {id}, {customer}, {origin}, {destination} and {status} become the load\'s values.' }),
      el('h4', { text: 'Run test' }),
      el('div', { class: 'studio-line' }, [
        el('input', { type: 'text', placeholder: 'Load, e.g. SHP-12', 'aria-label': 'Load to test', value: studioState.testLoad, oninput: (event) => { studioState.testLoad = event.target.value; } }),
        el('button', { class: 'btn btn-ghost small', type: 'button', onclick: (event) => runTest(event.currentTarget) }, 'Run test')
      ]),
      testResult,
      ro ? null : el('div', { class: 'studio-buttons' }, [
        el('button', { class: 'btn btn-primary small', type: 'button', onclick: (event) => save(event.currentTarget) }, isNew ? 'Create workflow' : 'Save changes'),
        isNew ? el('button', { class: 'btn btn-ghost small', type: 'button', onclick: () => { studioState.selected = null; renderStudio(); } }, 'Cancel')
          : el('button', { class: 'btn btn-ghost small danger', type: 'button', onclick: (event) => remove(event.currentTarget) }, 'Delete')
      ])
    ]);
  }

  function studioTemplates(data) {
    return el('div', { class: 'studio-templates' }, data.templates.map((t) => el('div', { class: 'card studio-template' }, [
      el('span', { class: 'stat-icon violet' }, icon('bolt', '')),
      el('strong', { text: t.name }),
      el('p', { class: 'muted', text: t.description }),
      el('ul', {}, [
        el('li', { text: `When: ${t.trigger === 'shipment.status' ? `a load becomes ${t.triggerStatus}` : data.options.triggers[t.trigger].toLowerCase()}` }),
        ...t.conditions.map((c) => el('li', { text: `Only if: ${data.options.fields[c.field]} contains "${c.value}"` })),
        ...t.actions.map((a) => el('li', { text: `Then: ${a.type === 'create_task' ? a.title : `${data.options.actions[a.type].label.toLowerCase()} (${data.options.purposes[a.purpose]})`}` }))
      ]),
      data.canChange ? el('button', { class: 'btn btn-primary small', type: 'button', onclick: () => selectStudio('new', copyRule(t)) }, 'Use template') : null
    ])));
  }

  function studioRuns(data) {
    if (!data.runs.length) {
      return el('div', { class: 'card empty-state' }, [el('span', { class: 'empty-icon' }, icon('check-square')), el('h3', { text: 'No runs yet' }), el('p', { text: 'Each time one of your workflows runs, it is listed here.' })]);
    }
    return el('div', { class: 'card table-card' }, el('div', { class: 'table-scroll' }, el('table', { class: 'data-table' }, [
      el('thead', {}, el('tr', {}, ['When', 'Workflow', 'Load', 'Result', 'What happened'].map((h) => el('th', { text: h })))),
      el('tbody', {}, data.runs.map((run) => el('tr', {}, [
        el('td', { text: typeof formatTimestamp === 'function' ? formatTimestamp(run.createdAt) : run.createdAt }),
        el('td', { text: run.workflowName }),
        el('td', {}, run.shipmentId ? el('button', { class: 'link-button', type: 'button', onclick: () => openShipmentDetails(run.shipmentId) }, run.shipmentId) : '—'),
        el('td', {}, el('span', { class: `tag ${run.status === 'done' ? 'delivered' : 'exception'}`, text: run.status === 'done' ? 'Done' : 'Failed' })),
        el('td', { text: run.detail || '' })
      ])))
    ])));
  }

  /* =========================================================
     AI AGENTS: what each agent does, whether it is on, what it did
     ========================================================= */
  const AGENTS = [
    { key: 'FLOW', name: 'FLOW', role: 'Order reader', text: 'Reads an order from an email or a pasted message and fills in the load form.', needs: 'ai', icon: 'doc', tone: 'blue', action: ['Read an order', () => window.openShipmentModal?.({})] },
    { key: 'SCOUT', name: 'SCOUT', role: 'Carrier finder', text: 'Ranks your carriers for a load by trailer, past loads on the lane and reliability.', needs: null, icon: 'truck', tone: 'violet', action: ['Loads to book', () => navigate('shipments', { status: 'Sourcing' })] },
    { key: 'RELAY', name: 'RELAY', role: 'Messages', text: 'Drafts SMS / WhatsApp messages to drivers, carriers and customers from your real load data.', needs: 'messaging', icon: 'chat', tone: 'sky', action: ['Messages to approve', () => navigate('inbox')] },
    { key: 'VAULT', name: 'VAULT', role: 'Documents', text: 'Reads CMR and proof-of-delivery files and compares them with the load.', needs: 'ai', icon: 'doc', tone: 'green', action: null },
    { key: 'NEXUS', name: 'NEXUS', role: 'Coordinator', text: 'Turns events into tasks for a person. It never sends, books or changes anything by itself.', needs: 'nexus', icon: 'bolt', tone: 'violet', action: ['Inbox & tasks', () => navigate('inbox')] },
    { key: 'ROUTE', name: 'ROUTE', role: 'Schedule', text: 'Checks if the promised dates are realistic and finds trucks that unload near the pickup.', needs: null, icon: 'target', tone: 'blue', action: null },
    { key: 'PULSE', name: 'PULSE', role: 'Prices', text: 'Compares a price with what the lane usually costs and with your market prices.', needs: null, icon: 'chart', tone: 'amber', action: null },
    { key: 'SENTINEL', name: 'SENTINEL', role: 'Risk watch', text: 'Watches every open load: late pickup, late delivery, silent trucks, failed messages.', needs: null, icon: 'alert', tone: 'red', action: ['See risks', () => navigate('inbox')] }
  ];

  async function renderAgents() {
    const container = document.getElementById('agentsView');
    if (!container) return;
    if (!currentUser()) return gate(container, 'signin');
    if (!container.children.length) loading(container);
    const [usage, tasks, risks, messaging] = await Promise.all([
      can('analytics:read') ? api('/api/analytics?days=30').then((data) => data.agents || []).catch(() => []) : Promise.resolve([]),
      api('/api/tasks').then((data) => data.tasks || []).catch(() => []),
      api('/api/agents/sentinel').then((data) => data.risks || []).catch(() => []),
      api('/api/messaging/status').catch(() => ({ channels: [] }))
    ]);
    if (state.view !== 'agents') return;
    const config = window.VeyraConfig || {};
    const isOn = (needs) => {
      if (needs === 'ai' && !window.VeyraAi?.allowed()) return { on: false, off: 'Part of the Growth plan and above' };
      if (needs === 'ai') return { on: Boolean(config.ai?.enabled), off: 'Off · needs an AI key on the server' };
      if (needs === 'messaging') return { on: (messaging.channels || []).length > 0, off: 'Drafts only · connect Twilio to send' };
      if (needs === 'nexus') return { on: config.nexus?.enabled !== false, off: 'Switched off on the server' };
      return { on: true, off: '' };
    };
    const calls = (key) => usage.filter((row) => String(row.agent).toUpperCase() === key).reduce((sum, row) => sum + row.calls, 0);
    const active = AGENTS.filter((agent) => isOn(agent.needs).on).length;
    const totalCalls = usage.reduce((sum, row) => sum + row.calls, 0);

    const kpis = el('div', { class: 'stats-grid kpi-grid' }, [
      kpiCard('Agents working', `${active} of ${AGENTS.length}`, 'Rule-based agents need no key', 'sparkle', 'violet'),
      kpiCard('AI calls (30 days)', totalCalls.toLocaleString('en-US'), config.ai?.enabled ? 'Counted per company' : 'AI is off', 'bolt', 'blue'),
      kpiCard('Tasks waiting', String(tasks.length), 'Prepared for a person to approve', 'check-square', 'green'),
      kpiCard('Risks now', String(risks.length), risks.length ? 'Open loads that need a look' : 'Nothing at risk', 'alert', risks.length ? 'red' : 'green')
    ]);

    const cards = el('div', { class: 'agent-grid' }, AGENTS.map((agent) => {
      const status = isOn(agent.needs);
      const used = calls(agent.key);
      return el('article', { class: `card agent-card${status.on ? '' : ' is-off'}` }, [
        el('header', {}, [
          el('span', { class: `stat-icon ${agent.tone}` }, icon(agent.icon, '')),
          el('span', { class: 'agent-title' }, [el('strong', { text: agent.name }), el('small', { text: agent.role })]),
          el('span', { class: `agent-state ${status.on ? 'on' : 'off'}`, text: status.on ? 'Active' : 'Off' })
        ]),
        el('p', { text: agent.text }),
        status.on ? null : el('p', { class: 'warn-line', text: status.off }),
        el('footer', {}, [
          el('small', { class: 'muted', text: agent.needs === 'ai' ? `${used} AI call${used === 1 ? '' : 's'} in 30 days` : (agent.needs === null ? 'Built in · no key needed' : '') }),
          // An agent that needs AI shows no button on a plan without AI.
          agent.action && !(agent.needs === 'ai' && !window.VeyraAi?.allowed()) ? el('button', { class: 'btn btn-ghost small', type: 'button', onclick: agent.action[1] }, agent.action[0]) : null
        ])
      ]);
    }));

    const riskCard = el('div', { class: 'card panel-card' }, [
      el('div', { class: 'mini-head' }, el('span', {}, [el('strong', { text: 'SENTINEL · loads at risk' }), el('small', { text: 'Checked just now' })])),
      risks.length
        ? el('ul', { class: 'risk-list' }, risks.slice(0, 6).map((risk) => el('li', { class: `risk-${risk.severity}` }, [
          el('span', { class: 'risk-level', text: { high: 'Urgent', medium: 'Soon', low: 'Note' }[risk.severity] || risk.severity }),
          el('div', {}, [
            el('button', { class: 'link-button', type: 'button', onclick: () => openShipmentDetails(risk.shipmentId) }, risk.title),
            el('small', { class: 'muted', text: risk.advice })
          ])
        ])))
        : el('p', { class: 'muted', text: 'No open load is at risk right now.' })
    ]);
    const taskCard = el('div', { class: 'card panel-card' }, [
      el('div', { class: 'mini-head' }, el('span', {}, [el('strong', { text: 'NEXUS · prepared for you' }), el('small', { text: 'Waiting for a person' })])),
      tasks.length
        ? el('ul', { class: 'activity-list' }, tasks.slice(0, 6).map((task) => el('li', {}, [
          el('span', { class: 'activity-dot' }),
          el('span', {}, [el('strong', { text: task.title }), el('small', { class: 'muted', text: typeof formatTimestamp === 'function' ? formatTimestamp(task.createdAt) : task.createdAt })])
        ])))
        : el('p', { class: 'muted', text: 'Nothing is waiting. New orders, bookings and late trucks will appear here.' }),
      el('button', { class: 'btn btn-ghost small', type: 'button', onclick: () => navigate('inbox') }, 'Open Inbox & tasks')
    ]);
    container.replaceChildren(kpis, cards, el('div', { class: 'analytics-grid two' }, [riskCard, taskCard]));
  }

  /* =========================================================
     BILLING: open money from delivered loads
     ========================================================= */
  async function renderBilling() {
    const container = document.getElementById('billingView');
    if (!container) return;
    if (!currentUser()) return gate(container, 'signin');
    if (!can('shipments:finance')) return gate(container, 'denied');
    if (!container.children.length) loading(container);
    let finance; let billing = null;
    try {
      [finance, billing] = await Promise.all([api('/api/finance/summary'), api('/api/billing/plan').catch(() => null)]);
      // A plan change (for example after paying) shows up at once on the dashboard card and the AI controls.
      if (billing?.plan) window.VeyraAi?.setPlan(billing.plan);
    } catch (error) {
      return errorState(container, error.message, renderBilling);
    }
    if (state.view !== 'billing') return;
    const kpis = el('div', { class: 'stats-grid kpi-grid' }, [
      kpiCard('Customers owe', money(finance.receivable), `${finance.receivableLoads} delivered load${finance.receivableLoads === 1 ? '' : 's'}`, 'wallet', 'violet'),
      kpiCard('Not invoiced yet', String(finance.notInvoiced), 'Delivered, invoice not sent', 'doc', finance.notInvoiced ? 'amber' : 'green'),
      kpiCard('You owe carriers', money(finance.payable), `${finance.payableLoads} load${finance.payableLoads === 1 ? '' : 's'}`, 'truck', 'blue'),
      kpiCard('Balance', money(finance.receivable - finance.payable), 'Coming in minus going out', 'chart', finance.receivable >= finance.payable ? 'green' : 'red')
    ]);
    const rows = finance.open.map((row) => {
      const label = row.customerPaidAt ? 'Paid' : (row.invoicedAt ? 'Invoiced' : 'Not invoiced');
      const tone = row.customerPaidAt ? 'delivered' : (row.invoicedAt ? 'in-transit' : (row.daysSinceDelivery > 14 ? 'exception' : 'pending-approval'));
      return [
        el('button', { class: 'link-button', type: 'button', onclick: () => openShipmentDetails(row.id) }, row.id),
        el('span', {}, [row.customer, el('small', { class: 'cell-sub', text: row.invoiceNumber ? `Invoice ${row.invoiceNumber}` : '' })]),
        row.customerPaidAt || row.customerRate === null ? '—' : money(row.customerRate),
        el('span', { class: `tag ${tone}`, text: label }),
        row.carrierPaidAt || row.rate === null ? '—' : el('span', {}, [money(row.rate), el('small', { class: 'cell-sub', text: row.carrierName || '' })]),
        row.daysSinceDelivery === null ? '—' : `${row.daysSinceDelivery} day${row.daysSinceDelivery === 1 ? '' : 's'} ago`
      ];
    });
    const table = el('div', { class: 'card panel-card' }, [
      el('div', { class: 'mini-head' }, el('span', {}, [el('strong', { text: 'Open invoices and payments' }), el('small', { text: 'Oldest delivery first. Open a load to mark it invoiced or paid, or to print its invoice.' })])),
      miniTable(['Load', 'Customer', 'Customer owes', 'Invoice', 'Carrier is owed', 'Delivered'], rows, 'Nothing is open: every delivered load is paid on both sides.')
    ]);
    // Loads with several legs: each delivered leg is owed to its own carrier.
    const legRows = (finance.openLegs || []).map((row) => [
      el('button', { class: 'link-button', type: 'button', onclick: () => openShipmentDetails(row.shipmentId) }, row.shipmentId),
      el('span', {}, [`Leg ${row.sequence} · ${row.mode.replace('_', ' ').toLowerCase()}`, el('small', { class: 'cell-sub', text: row.customer })]),
      row.carrierName || '—',
      el('span', {}, [money(row.price), row.currency && row.currency !== finance.currency ? el('small', { class: 'cell-sub', text: row.currency }) : null]),
      row.daysSinceDelivery === null || row.daysSinceDelivery === undefined ? '—' : `${row.daysSinceDelivery} day${row.daysSinceDelivery === 1 ? '' : 's'} ago`,
      el('button', {
        class: 'btn btn-ghost small', type: 'button',
        onclick: async (event) => {
          event.target.disabled = true;
          try {
            await api(`/api/v2/legs/${row.legId}/payment`, { method: 'PUT', body: JSON.stringify({ paid: true }) });
            renderBilling();
          } catch (error) {
            event.target.disabled = false;
            toast(error.message, 'error');
          }
        }
      }, 'Mark paid')
    ]);
    const legTable = legRows.length ? el('div', { class: 'card panel-card' }, [
      el('div', { class: 'mini-head' }, el('span', {}, [el('strong', { text: 'Carriers owed per leg' }), el('small', { text: 'Loads with several legs: each delivered leg is paid to its own carrier. Oldest first.' })])),
      miniTable(['Load', 'Leg', 'Carrier', 'Owed', 'Delivered', ''], legRows, '')
    ]) : null;
    container.replaceChildren(...[billing ? planCard(billing) : null, kpis, table, legTable].filter(Boolean));
  }

  // The company's Veyra subscription: plan, trial, usage against limits, and what the plan includes.
  function planCard(billing) {
    const plan = billing.plan;
    const statusText = plan.locked
      ? (plan.status === 'trial' ? 'Trial ended' : plan.status === 'past_due' ? 'Payment overdue' : 'Cancelled')
      : plan.status === 'trial' ? `Free trial · ${plan.trialDaysLeft} day${plan.trialDaysLeft === 1 ? '' : 's'} left` : 'Active';
    const tone = plan.locked ? 'exception' : plan.status === 'trial' ? (plan.trialDaysLeft <= 3 ? 'pending-approval' : 'in-transit') : 'delivered';
    const meter = (label, used, limit) => {
      const share = Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
      return el('div', { class: `plan-meter${share >= 90 ? ' full' : ''}` }, [
        el('div', { class: 'plan-meter-head' }, [el('span', { text: label }), el('strong', { text: `${used.toLocaleString('en-US')} / ${limit.toLocaleString('en-US')}` })]),
        el('div', { class: 'plan-meter-bar', role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': String(limit), 'aria-valuenow': String(used) }, el('span', { style: `width:${share}%` }))
      ]);
    };
    const contact = billing.salesEmail ? `mailto:${billing.salesEmail}?subject=${encodeURIComponent(`Veyra plan change (${plan.name})`)}` : null;
    return el('div', { class: `card plan-card${plan.locked ? ' locked' : ''}` }, [
      el('div', { class: 'plan-card-main' }, [
        el('span', { class: 'plan-label', text: 'Your plan' }),
        el('div', { class: 'plan-name' }, [el('strong', { text: plan.name }), el('span', { class: `tag ${tone}`, text: statusText })]),
        el('p', { class: 'muted', text: `$${plan.monthly.toLocaleString('en-US')}${plan.priceFrom ? '+' : ''} / month` }),
        plan.locked ? el('p', { class: 'warn-line', text: 'Your records stay readable, but new loads and people cannot be added until the plan is active again.' }) : null,
        el('div', { class: 'plan-actions' }, [
          el('a', { class: 'btn btn-primary small', href: '/pricing', target: '_blank', rel: 'noopener' }, 'Compare plans'),
          contact ? el('a', { class: 'btn btn-ghost small', href: contact }, 'Change plan') : null
        ])
      ]),
      el('div', { class: 'plan-usage' }, [
        meter('Users', billing.usage.users, plan.users),
        meter('Shipments this month', billing.usage.shipmentsThisMonth, plan.shipments)
      ]),
      el('ul', { class: 'plan-caps' }, Object.entries(plan.capabilities).map(([, cap]) => el('li', { class: cap.on ? 'on' : 'off' }, [
        el('span', { class: 'plan-cap-dot', 'aria-hidden': 'true', text: cap.on ? '✓' : '–' }),
        el('span', { text: cap.label }),
        el('span', { class: 'visually-hidden', text: cap.on ? ' (included)' : ' (not in this plan)' })
      ]))),
      billing.paddle?.enabled && billing.paddle.canPay ? payByCard(billing) : null
    ]);
  }

  /* ---------- Paddle: pay for a plan by card ---------- */
  let paddleReady = null;
  let autoCheckoutDone = null;
  // Paddle.js is loaded only when someone is about to pay, straight from Paddle.
  function loadPaddle(info) {
    if (paddleReady) return paddleReady;
    paddleReady = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.paddle.com/paddle/v2/paddle.js';
      script.onload = () => {
        try {
          if (info.environment === 'sandbox') window.Paddle.Environment.set('sandbox');
          window.Paddle.Initialize({
            token: info.clientToken,
            eventCallback: (event) => {
              if (event?.name !== 'checkout.completed') return;
              toast('Payment received. Your plan updates in a few seconds.');
              // Paddle's webhook moves the plan; check back a few times.
              let tries = 0;
              const timer = setInterval(() => {
                tries += 1;
                if (state.view === 'billing') renderBilling();
                if (tries >= 5) clearInterval(timer);
              }, 3000);
            }
          });
          resolve(window.Paddle);
        } catch (error) {
          reject(error);
        }
      };
      script.onerror = () => {
        paddleReady = null;
        reject(new Error('Paddle checkout could not load. Check your connection and try again.'));
      };
      document.head.append(script);
    });
    return paddleReady;
  }

  function payByCard(billing) {
    const info = billing.paddle;
    const wanted = !info.subscribed && info.plans[state.params.get('pay')] ? state.params.get('pay') : null;
    let period = wanted && ['monthly', 'yearly'].includes(state.params.get('period')) ? state.params.get('period') : (info.period || 'monthly');
    const box = el('div', { class: 'plan-pay' });
    const draw = () => {
      const current = billing.plan.key;
      const switchMode = info.subscribed;
      const buttons = Object.entries(info.plans).filter(([, periods]) => periods[period]).map(([key]) => {
        const isCurrent = switchMode && key === current && period === (info.period || 'monthly');
        const { name, price, yearlyPerMonth } = info.plans[key];
        const label = isCurrent ? 'Current plan' : switchMode ? `Switch to ${name}` : `Subscribe to ${name}`;
        return el('button', {
          type: 'button',
          class: `plan-pay-option${isCurrent ? ' current' : ''}`,
          dataset: { plan: key },
          disabled: isCurrent || (switchMode && !info.canSwitch),
          onclick: (event) => choose(key, event.currentTarget)
        }, [el('strong', { text: label }), el('small', { text: period === 'yearly' ? `$${yearlyPerMonth} / month, billed yearly` : `$${price} / month` })]);
      });
      box.replaceChildren(...[
        el('div', { class: 'plan-pay-head' }, [
          el('span', {}, [el('strong', { text: switchMode ? 'Change plan' : 'Pay by card' }), el('small', { text: switchMode ? 'Paddle charges or credits the difference right away.' : 'Secure checkout by Paddle. Card details never reach Veyra.' })]),
          el('div', { class: 'studio-tabs', role: 'group', 'aria-label': 'Billing period' }, [['monthly', 'Monthly'], ['yearly', 'Yearly · save 17%']].map(([key, text]) => el('button', {
            type: 'button', class: period === key ? 'active' : '', 'aria-pressed': String(period === key), onclick: () => { period = key; draw(); }
          }, text)))
        ]),
        buttons.length ? el('div', { class: 'plan-pay-options' }, buttons) : el('p', { class: 'muted', text: 'No plan is set up for this billing period yet.' }),
        switchMode && !info.canSwitch ? el('p', { class: 'muted', text: 'To switch plans, contact us: the server has no Paddle API key yet.' }) : null,
        info.canManage ? el('button', { class: 'btn btn-ghost small', type: 'button', onclick: (event) => openPortal(event.currentTarget) }, 'Invoices, card and cancel') : null
      ].filter(Boolean));
    };
    async function choose(key, button) {
      button.disabled = true;
      try {
        if (info.subscribed) {
          if (!window.confirm(`Switch to ${info.plans[key].name} (${period})? Paddle charges or credits the difference now.`)) {
            button.disabled = false;
            return;
          }
          await api('/api/billing/change-plan', { method: 'POST', body: JSON.stringify({ plan: key, period }) });
          toast(`Switched to ${info.plans[key].name}.`);
          renderBilling();
          return;
        }
        const { checkout } = await api('/api/billing/checkout', { method: 'POST', body: JSON.stringify({ plan: key, period }) });
        const Paddle = await loadPaddle(info);
        Paddle.Checkout.open({ items: [{ priceId: checkout.priceId, quantity: 1 }], customer: { email: checkout.email }, customData: checkout.customData });
      } catch (error) {
        toast(error.message, 'error');
      }
      button.disabled = false;
    }
    async function openPortal(button) {
      button.disabled = true;
      try {
        const { url } = await api('/api/billing/portal', { method: 'POST' });
        window.open(url, '_blank', 'noopener');
      } catch (error) {
        toast(error.message, 'error');
      }
      button.disabled = false;
    }
    draw();
    // Straight from sign-up: open the checkout for the plan they chose (once per visit).
    if (wanted && info.plans[wanted][period] && autoCheckoutDone !== `${wanted}:${period}`) {
      autoCheckoutDone = `${wanted}:${period}`;
      const button = [...box.querySelectorAll('.plan-pay-option')].find((node) => node.dataset.plan === wanted);
      if (button) setTimeout(() => choose(wanted, button), 300);
    }
    return box;
  }

  /* =========================================================
     TEAM & SETTINGS: the operations console has its own page
     ========================================================= */
  function renderSettings() {
    const panel = document.getElementById('adminPanel');
    const view = document.querySelector('.view[data-view="settings"]');
    if (!view) return;
    let note = view.querySelector('.settings-gate');
    if (!note) {
      note = el('div', { class: 'settings-gate' });
      view.append(note);
    }
    if (!currentUser()) {
      panel?.classList.add('hidden');
      gate(note, 'signin');
      return;
    }
    if (!can('users:read')) {
      panel?.classList.add('hidden');
      gate(note, 'denied');
      return;
    }
    note.replaceChildren();
    if (typeof loadAdminConsole === 'function') loadAdminConsole();
  }

  /* =========================================================
     SHARED
     ========================================================= */
  async function refreshAll() {
    state.shipments.loaded = false;
    await Promise.allSettled([fetchDashboardData(), loadAdminConsole()]);
    if (state.view === 'shipments') await renderShipments();
    if (state.view === 'carriers') await renderCarriers();
    if (state.view === 'analytics') await renderAnalytics();
    if (state.view === 'inbox') await renderInbox();
    if (state.view === 'agents') await renderAgents();
    if (state.view === 'quotes') await renderQuotes();
    if (state.view === 'command') await renderCommand();
    if (state.view === 'trips') await window.VeyraTrips?.render();
    if (state.view === 'tracking') await renderTracking();
    if (state.view === 'automation') await renderStudio(true);
    if (state.view === 'billing') await renderBilling();
    loadNotifications();
  }

  function onSessionChange() {
    state.shipments = { ...state.shipments, items: [], total: 0, allCount: 0, statusCounts: {}, page: 1, loaded: false };
    state.carriers.list = [];
    state.analytics.data = null;
    window.VeyraAssistant?.onSessionChange();
    loadNotifications();
    route();
  }

  function bindGlobal() {
    window.addEventListener('hashchange', route);

    document.querySelectorAll('[data-export-csv]').forEach((button) => button.addEventListener('click', exportCsv));

    document.getElementById('addCarrierToggle')?.addEventListener('click', () => {
      state.carriers.formOpen = !state.carriers.formOpen;
      const form = document.getElementById('addCarrierForm');
      form?.classList.toggle('hidden', !state.carriers.formOpen);
      if (state.carriers.formOpen) form?.querySelector('input')?.focus();
    });

    document.getElementById('analyticsRange')?.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-days]');
      if (!button) return;
      state.analytics.days = Number(button.dataset.days);
      renderAnalytics();
    });

    const search = document.getElementById('globalSearch');
    search?.addEventListener('input', () => {
      if (state.view === 'shipments') {
        state.shipments.q = search.value;
        const local = document.querySelector('#shipmentsView .search input');
        if (local) local.value = search.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(reloadFirstPage, 300);
      } else if (state.view === 'carriers') {
        state.carriers.q = search.value;
        const container = document.getElementById('carriersView');
        if (container && state.carriers.list.length) buildCarriersLayout(container);
      }
    });
    search?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      if (state.view === 'dashboard' || state.view === 'analytics') {
        const q = search.value.trim();
        navigate('shipments', q ? { q } : {});
      }
    });

    bindDispatchModal();
    bindNotifications();
  }

  window.VeyraViews = { refresh: refreshAll, onSessionChange, toast, navigate };

  document.addEventListener('DOMContentLoaded', () => {
    bindGlobal();
    const initial = parseHash();
    route();
    if (initial.view !== 'dashboard') {
      requestAnimationFrame(() => document.getElementById('demo')?.scrollIntoView({ block: 'start' }));
    }
  });
})();
