/* =========================================================
   Terms of Service, Privacy Policy and Refund Policy pages.
   The texts are a starting point written for a B2B logistics SaaS sold through Paddle;
   the owner must have them reviewed by a lawyer for their country before selling.
   Company details come from the server settings (LEGAL_*), so nothing is hard-coded.
   ========================================================= */

// Raise when the Terms or Privacy Policy change in substance; sign-up records which version was accepted.
const TERMS_VERSION = '2026-11-20';
const UPDATED = 'November 20, 2026';

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function details() {
  const env = (name, fallback) => String(process.env[name] || '').trim() || fallback;
  return {
    entity: env('LEGAL_ENTITY', '[Your company legal name]'),
    address: env('LEGAL_ADDRESS', '[Registered address]'),
    country: env('LEGAL_COUNTRY', '[Country whose law applies]'),
    email: env('LEGAL_EMAIL', env('SALES_EMAIL', '[contact email]')),
    refundDays: Math.min(Math.max(Number.parseInt(process.env.REFUND_DAYS, 10) || 14, 0), 60)
  };
}

// Each section: [heading, [paragraphs]]. Paragraphs are plain text (escaped on output).
function terms(d) {
  return [
    ['1. Who we are', [
      `Veyra ("Veyra", "we", "us") is a logistics software service provided by ${d.entity}, ${d.address}. Contact: ${d.email}.`,
      'These Terms apply to every company ("Customer") and every person using Veyra on its behalf ("User"). By creating an account or using Veyra, the Customer accepts these Terms. Veyra is for businesses only, not for consumers.'
    ]],
    ['2. The service', [
      'Veyra helps logistics companies manage shipments, carriers, quotes, tracking, documents and related messages. Features available to a Customer depend on its plan, shown on the pricing page.',
      'Veyra\'s AI agents prepare work (drafts, suggestions, readings of documents). They may be wrong. Every outward action, such as sending a message, booking a truck or issuing an invoice, is decided by a person, and the Customer remains responsible for checking the result.'
    ]],
    ['3. Accounts', [
      'The Customer is responsible for its Users, for keeping passwords secret, and for everything done under its account. Tell us at once if an account may have been misused.',
      'The Customer must give true information and must have the right to put the data it enters into Veyra, including data about its own customers, carriers and drivers.'
    ]],
    ['4. Plans, trial, payment', [
      'New companies may start with a free trial. When it ends, the plan continues only after payment. Prices are shown on the pricing page in US dollars, excluding taxes.',
      'Our order process is conducted by our online reseller Paddle.com. Paddle.com is the Merchant of Record for all our orders. Paddle provides all customer service inquiries and handles returns.',
      'Subscriptions renew automatically each month or year until cancelled. A cancellation takes effect at the end of the paid period. If a payment fails, we may limit the account to read-only until it is paid.'
    ]],
    ['5. Acceptable use', [
      'Do not use Veyra to break the law, send spam or unsolicited messages, upload malicious code, try to reach other companies\' data, overload or probe the service, or resell it without our written agreement.',
      'We may suspend an account that breaks these rules or puts the service or other customers at risk, and we will tell the Customer why when we can.'
    ]],
    ['6. Customer data', [
      'The Customer owns the data it puts into Veyra. We process it only to provide the service, as described in the Privacy Policy, and act as the Customer\'s processor for personal data in it.',
      'An administrator can download the company\'s data at any time (Team & settings → Company data). After an account is closed we delete the Customer\'s data within 90 days, except backups, which expire on their own schedule, and records we must keep by law.'
    ]],
    ['7. Third-party services', [
      'Some features use services the Customer connects or that we use on its behalf, such as messaging (Twilio), email providers, AI providers, maps and GPS providers. Their own terms apply to them, and we are not responsible for their availability.'
    ]],
    ['8. Availability and changes', [
      'We work to keep Veyra available and secure but do not promise uninterrupted service. We may change or improve features; if a change materially reduces a paid plan, we will give notice and the Customer may cancel.'
    ]],
    ['9. Liability', [
      'To the extent the law allows, Veyra is provided "as is", and we are not liable for indirect or consequential losses, lost profits or lost data. Our total liability in any 12 months is limited to the fees the Customer paid for Veyra in those 12 months.',
      'Nothing in these Terms limits liability that cannot be limited by law.'
    ]],
    ['10. Ending the agreement', [
      'The Customer may stop using Veyra and cancel at any time. We may end the agreement with 30 days\' notice, or at once for a serious breach of these Terms.'
    ]],
    ['11. Changes to these Terms', [
      'We may update these Terms. We will tell administrators about material changes before they take effect. Continued use after that means the new Terms apply.'
    ]],
    ['12. Law', [
      `These Terms are governed by the law of ${d.country}. Disputes go to the competent courts there, unless mandatory law says otherwise.`
    ]]
  ];
}

function privacy(d) {
  return [
    ['1. Who is responsible', [
      `${d.entity}, ${d.address}, runs Veyra. For data a Customer enters about its own business contacts (customers, carriers, drivers), the Customer is the controller and we are its processor. For account and billing data of Users, we are the controller. Contact: ${d.email}.`
    ]],
    ['2. What we collect', [
      'Account data: name, work email, role, company name, and a hashed password (we never store passwords in readable form).',
      'Business data the Customer enters or connects: shipments, carriers, quotes, documents, messages, phone numbers, truck positions from GPS providers, and emails from a connected mailbox.',
      'Technical data: sign-in times, IP addresses in security logs, and an activity log of important changes. We use only the cookies needed to keep you signed in; no advertising or tracking cookies.',
      'Payment data is handled by Paddle, our Merchant of Record. We do not receive or store card numbers.'
    ]],
    ['3. Why we use it', [
      'To provide and secure the service, to bill subscriptions, to answer support requests, and to meet legal obligations. Our legal bases are the contract with the Customer, our legitimate interest in running a secure service, and legal obligations.',
      'We do not sell personal data and do not use Customer data to train AI models.'
    ]],
    ['4. Who processes it with us', [
      'Hosting (our cloud provider), Paddle (payments), and, only when the Customer turns them on, the AI provider Google (Gemini API), Twilio (SMS/WhatsApp), email providers (Google, Microsoft or the Customer\'s mail server), map and traffic services (OpenStreetMap, TomTom) and GPS providers. Each receives only what its feature needs.',
      'Some of these providers are outside the European Economic Area. Where required, transfers rely on standard contractual clauses or similar safeguards.'
    ]],
    ['5. How long we keep it', [
      'While the account is active. After it closes, we delete Customer data within 90 days; daily backups expire after the number of days set on the server (7 by default). Billing records are kept as long as tax law requires.'
    ]],
    ['6. Security', [
      'Data is separated per company, connections use HTTPS, provider keys are stored encrypted, passwords are hashed, sign-in attempts are limited, and administrators can see an activity log.'
    ]],
    ['7. Your rights', [
      'Depending on where you are (for example under the GDPR or UK GDPR), you may ask to access, correct, delete, restrict or move your personal data, and you may object to processing. Company administrators can download the company\'s data in Team & settings.',
      `To make a request, write to ${d.email}. If your data was entered by a Customer (for example you are a driver), we will pass the request to that Customer. You may also complain to your data protection authority.`
    ]],
    ['8. Changes', [
      'We will post any change here with a new date, and tell administrators about material changes.'
    ]]
  ];
}

function refunds(d) {
  return [
    ['Refunds', [
      'Paddle.com is the Merchant of Record for all Veyra orders and handles refunds.',
      d.refundDays > 0
        ? `If Veyra does not work for your company, you can ask for a full refund within ${d.refundDays} days of your first payment for a plan. Write to ${d.email} or reply to your Paddle receipt.`
        : `Payments are not refundable, except where the law requires. Write to ${d.email} if you think a charge is wrong.`,
      'Renewals are not refunded, but you can cancel at any time and keep access until the end of the period you paid for.',
      'If we charged you by mistake, or the service was unavailable for a long time because of us, contact us and we will put it right.'
    ]],
    ['Cancelling', [
      'Administrators cancel from Billing → "Invoices, card and cancel" (Paddle\'s billing portal), or by writing to us. Your data stays available to download until the account is closed.'
    ]]
  ];
}

const PAGES = {
  terms: { title: 'Terms of Service', build: terms },
  privacy: { title: 'Privacy Policy', build: privacy },
  refunds: { title: 'Refund Policy', build: refunds }
};

function renderPage(key) {
  const page = PAGES[key];
  const d = details();
  const sections = page.build(d).map(([heading, paragraphs]) => `<h2>${escape(heading)}</h2>\n${paragraphs.map((text) => `<p>${escape(text)}</p>`).join('\n')}`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escape(page.title)} | Veyra</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" />
  <link rel="stylesheet" href="/pricing.css" />
</head>
<body>
  <header class="pr-nav">
    <a class="pr-logo" href="/pricing" aria-label="Veyra pricing"><img src="/brand/veyra-logo.svg" alt="Veyra" width="120" height="32" /></a>
    <nav class="pr-actions"><a class="pr-btn pr-btn-light" href="/pricing">Plans</a><a class="pr-btn pr-btn-light" href="/">Log in</a></nav>
  </header>
  <main class="legal">
    <h1>${escape(page.title)}</h1>
    <p class="legal-updated">Last updated: ${escape(UPDATED)}</p>
${sections}
  </main>
  ${footer()}
</body>
</html>`;
}

function footer() {
  return '<footer class="pr-footer">© 2026 Veyra · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · <a href="/refunds">Refunds</a></footer>';
}

module.exports = { TERMS_VERSION, PAGES, renderPage, details };
