/* =========================================================
   VEYRA — what the company's plan lets the screens show (AI controls)
   Loaded before script.js. Keeps the plan and hides the controls of the AI agents (the "Veyra AI" card on the dashboard,
   the order-reading panel, the AI row in Integrations, the FLOW / VAULT buttons) for plans without the AI capability.

   This only decides what is SHOWN. The server still closes every AI route to such plans (needsPlan('ai') answers 402),
   so hiding a control here is never the security boundary.

   window.VeyraPlan is null when nobody is signed in (the dashboard is then a sample and nothing is hidden). When someone
   is signed in it holds the plan's capabilities; a missing plan counts as "no AI" so nothing is promised by mistake.
   ========================================================= */
(function (root) {
  const PROMO_WITH_AI = 'Your logistics co-pilot: reads orders, ranks carriers, drafts messages and watches every load.';
  const PROMO_NO_AI = 'Your logistics co-pilot: ranks carriers, checks prices, drafts messages and watches every load.';

  // /api/me sends a list of capabilities; /api/billing/plan sends { key: { on } }.
  function normalise(raw) {
    if (!raw) return null;
    const capabilities = Array.isArray(raw.capabilities)
      ? raw.capabilities
      : Object.entries(raw.capabilities || {}).filter(([, item]) => item && item.on).map(([key]) => key);
    return { key: raw.key || null, name: raw.name || null, capabilities };
  }

  const ai = {
    normalise,
    // Remember the plan (null = signed out).
    set(raw) {
      root.VeyraPlan = normalise(raw);
    },
    // Whether this person's plan includes the AI agents (FLOW, VAULT, email reading).
    allowed() {
      return !root.VeyraPlan || root.VeyraPlan.capabilities.includes('ai');
    },
    // Show or hide the dashboard card and the other AI controls that are on the page.
    apply() {
      const doc = root.document;
      if (!doc) return;
      const allowed = ai.allowed();
      const card = doc.querySelector('.assistant-card');
      if (card) card.classList.toggle('hidden', !allowed);
      const promo = doc.getElementById('sidePromoText');
      if (promo) promo.textContent = allowed ? PROMO_WITH_AI : PROMO_NO_AI;
      const intake = doc.getElementById('aiIntake');
      if (intake) intake.classList.toggle('hidden', !(root.VeyraConfig && root.VeyraConfig.ai && root.VeyraConfig.ai.enabled && allowed));
    },
    // A plan change seen while the page is open (for example after paying) takes effect at once.
    setPlan(raw) {
      ai.set(raw);
      ai.apply();
    }
  };

  root.VeyraPlan = null;
  root.VeyraAi = ai;
})(typeof window !== 'undefined' ? window : globalThis);
