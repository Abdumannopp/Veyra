// Self sign-up: choose a plan, create the company, then go to Billing to pay by card.
(function () {
  const form = document.getElementById('signupForm');
  const planSelect = form.elements.plan;
  const periodSelect = form.elements.period;
  const error = document.getElementById('suError');
  const summary = document.getElementById('suPlan');
  const note = document.getElementById('suNote');
  const params = new URLSearchParams(window.location.search);
  let data = null;

  const money = (n) => `$${Number(n).toLocaleString('en-US')}`;
  const chosen = () => data.plans.find((plan) => plan.key === planSelect.value);

  function describe() {
    const plan = chosen();
    if (!plan) return;
    const yearly = periodSelect.value === 'yearly';
    const price = yearly ? `${money(plan.yearlyPerMonth)} / month, ${money(plan.yearlyPerMonth * 12)} billed yearly` : `${money(plan.monthly)} / month`;
    summary.textContent = `${plan.name}: ${price}. ${plan.features.slice(0, 2).join(', ')}.`;
    note.textContent = data.cardPayment
      ? `Next step: pay by card in Paddle's secure checkout. Your ${data.trialDays}-day free trial starts now, so you can work right away.`
      : `Your ${data.trialDays}-day free trial starts now. No card needed.`;
  }

  fetch('/api/plans').then((response) => response.json()).then((result) => {
    data = result;
    if (!data.signup) {
      form.replaceChildren();
      const text = document.createElement('p');
      text.className = 'su-sub';
      text.textContent = data.salesEmail ? `Sign-up is not open yet. Write to ${data.salesEmail} and we will set up your account.` : 'Sign-up is not open yet. Please contact us to get an account.';
      form.append(text);
      return;
    }
    // Enterprise is arranged with sales, so it is not offered here.
    data.plans.filter((plan) => !plan.contactSales).forEach((plan) => {
      const option = document.createElement('option');
      option.value = plan.key;
      option.textContent = `${plan.name} · ${money(plan.monthly)} / month`;
      planSelect.append(option);
    });
    const wanted = params.get('plan');
    planSelect.value = [...planSelect.options].some((option) => option.value === wanted) ? wanted : 'growth';
    periodSelect.value = params.get('period') === 'yearly' ? 'yearly' : 'monthly';
    describe();
  }).catch(() => {
    error.textContent = 'Plans could not be loaded. Please refresh the page.';
  });

  planSelect.addEventListener('change', describe);
  periodSelect.addEventListener('change', describe);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!data?.signup) return;
    error.textContent = '';
    if (!form.reportValidity()) return;
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    submit.textContent = 'Creating your account…';
    try {
      const response = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          companyName: form.elements.companyName.value.trim(),
          name: form.elements.name.value.trim(),
          email: form.elements.email.value.trim(),
          password: form.elements.password.value,
          plan: planSelect.value
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || 'Sign-up failed. Please try again.');
      try {
        localStorage.setItem('veyraUser', JSON.stringify(result.user));
      } catch (_) { /* the app asks the server who is signed in anyway */ }
      // Straight to Billing; with card payment on, the checkout for the chosen plan opens by itself.
      const query = new URLSearchParams({ pay: planSelect.value, period: periodSelect.value });
      window.location.assign(`/#/billing?${result.cardPayment ? query.toString() : 'welcome=1'}`);
    } catch (problem) {
      error.textContent = problem.message;
      submit.disabled = false;
      submit.textContent = 'Create account';
    }
  });
})();
