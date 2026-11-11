// Public pricing page: plans come from /api/plans so prices live in one place (lib/plans.js).
(function () {
  const ICONS = {
    starter: 'M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zM4 7.5l8 4.5 8-4.5M12 12v9',
    growth: 'M12 3l2 5.5L19.5 10 14 12l-2 6-2-6-5.5-2L10 8.5 12 3z',
    scale: 'M4 8l8-4.5L20 8l-8 4.5L4 8zM4 12.5l8 4.5 8-4.5M4 17l8 4.5 8-4.5',
    enterprise: 'M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16M9 21v-4h6v4M9 7h1M14 7h1M9 11h1M14 11h1'
  };
  const state = { period: 'monthly', data: null };
  const container = document.getElementById('plans');

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => {
      if (value === undefined || value === null || value === false) return;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = String(value);
      else node.setAttribute(key, value);
    });
    (Array.isArray(children) ? children : [children]).forEach((child) => {
      if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    });
    return node;
  }
  function svg(path, cls) {
    const ns = 'http://www.w3.org/2000/svg';
    const node = document.createElementNS(ns, 'svg');
    node.setAttribute('viewBox', '0 0 24 24');
    node.setAttribute('aria-hidden', 'true');
    if (cls) node.setAttribute('class', cls);
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', path);
    node.append(p);
    return node;
  }
  const money = (n) => `$${Number(n).toLocaleString('en-US')}`;
  // With a sales address set, buttons open an email; without one, they lead to sign-in.
  function ctaHref(plan) {
    const email = state.data?.salesEmail;
    if (!email) return '/';
    const subject = plan.contactSales ? `Veyra ${plan.name}: talk to sales` : `Veyra ${plan.name}: start a free trial (${state.period})`;
    return `mailto:${email}?subject=${encodeURIComponent(subject)}`;
  }

  function card(plan) {
    const yearly = state.period === 'yearly';
    const price = yearly ? plan.yearlyPerMonth : plan.monthly;
    return el('article', { class: `pr-card${plan.popular ? ' popular' : ''}` }, [
      el('div', { class: 'pr-card-top' }, [
        el('span', { class: 'pr-icon' }, svg(ICONS[plan.key] || ICONS.starter)),
        plan.popular ? el('span', { class: 'pr-popular', text: 'MOST POPULAR' }) : null
      ]),
      el('h2', { text: plan.name }),
      el('p', { class: 'pr-tagline', text: plan.tagline }),
      el('p', { class: 'pr-price' }, [
        el('strong', { text: `${money(price)}${plan.priceFrom ? '+' : ''}` }),
        el('span', { text: '/ month' })
      ]),
      el('p', { class: 'pr-billed', text: yearly ? `${money(price * 12)}${plan.priceFrom ? '+' : ''} billed yearly` : 'Billed monthly' }),
      el('ul', {}, plan.features.map((feature) => el('li', {}, [svg('M5 12.5l4.5 4.5L19 7', 'pr-check'), el('span', { text: feature })]))),
      el('a', { class: `pr-btn ${plan.contactSales ? 'pr-btn-dark' : (plan.popular ? 'pr-btn-white' : 'pr-btn-light')} pr-card-btn`, href: ctaHref(plan) }, plan.contactSales ? 'Contact sales' : 'Start free trial')
    ]);
  }

  function draw() {
    if (!state.data) return;
    container.replaceChildren(...state.data.plans.map(card));
    const trial = state.data.plans.find((plan) => plan.popular) || state.data.plans[0];
    document.getElementById('navTrial').setAttribute('href', ctaHref(trial));
    document.getElementById('trialDays').textContent = String(state.data.trialDays);
  }

  document.querySelectorAll('.pr-switch button').forEach((button) => button.addEventListener('click', () => {
    state.period = button.dataset.period;
    document.querySelectorAll('.pr-switch button').forEach((other) => {
      other.classList.toggle('active', other === button);
      other.setAttribute('aria-pressed', String(other === button));
    });
    draw();
  }));

  fetch('/api/plans').then((response) => response.json()).then((data) => {
    state.data = data;
    draw();
  }).catch(() => {
    container.replaceChildren(el('p', { class: 'pr-loading', text: 'Plans could not be loaded. Please refresh the page.' }));
  });
})();
