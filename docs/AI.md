# AI: how VEYRA uses a language model, and the rules around it

This page is the **source of truth** for how the AI agents (FLOW, VAULT) use the outside model. How ready the AI
integration is (it is still **Test mode**: not yet tried with a real provider account and real documents) is kept in
[INTEGRATIONS.md](INTEGRATIONS.md). Security controls are summarised in [SECURITY.md](SECURITY.md).

## 0. Which provider

VEYRA can use **one** of four providers at a time, for the whole server. Choose it with `AI_PROVIDER`; if that is empty,
the first provider that has a key is used (OpenRouter first). Keys go only in the server settings (for example Railway
Variables), never in code or chat.

| Provider | `AI_PROVIDER` | Key | Model setting | Model required? |
|---|---|---|---|---|
| OpenRouter (default) | `openrouter` | `OPENROUTER_API_KEY` | `OPENROUTER_MODEL` | No (account default; the server warns) |
| OpenAI | `openai` | `OPENAI_API_KEY` | `OPENAI_MODEL` | **Yes** |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` | **Yes** |
| Google Gemini | `google` | `GEMINI_API_KEY` | `GEMINI_MODEL` | **Yes** |

- OpenAI, Anthropic and Gemini have no default model: without the model setting AI stays **off** and Integrations says why.
- Reading CMR / POD / B/L files needs a model that reads PDFs and images. How each provider receives a file: OpenAI as a
  `file` / `image_url` part, Anthropic as a `document` / `image` block, Gemini as `inlineData`, all base64.
- The Gemini key is sent in the `x-goog-api-key` header, never in the URL.
- Every rule below (consent, quota, ledger, redaction, answer check, retries) is the same for all four. The `ai_calls`
  ledger records which provider answered each call.
- **Consent is for one provider.** If the server switches to another provider, every company's sharing becomes "not
  allowed" for the new one until its administrator agrees again (Team & settings shows the old and the new provider).

## 1. One gateway for every model call

All model calls go through `ai/gateway.js`: the FLOW and VAULT screens, the automatic NEXUS work on incoming email and
documents, and any endpoint added later. The rules below are enforced there, so a new route cannot skip them.

The "Quick Shipment Draft" card on the dashboard does **not** use a model: plain code copies the latest load. It is shown
only on plans with AI agents (Growth and up), like before.

## 2. Consent: a company decides whether its data may leave

- A manual "Read with AI" on a document takes from the asking person's hourly budget too, also when the reading runs in
  the background (NEXUS). Automatic work (incoming email and documents) takes only from the company's day.
- Every model call must pass an answer check (`validate`); a call without one is refused before anything is spent.
- Setting: Team & settings → **AI data sharing** (`GET/PUT /api/settings/ai-consent`). Administrators change it; people who
  can see the team can see it.
- **Off by default** for every company, including existing companies after the upgrade (migration 0015). In development
  the demo company starts with it on.
- While off, the provider is **never** called. The person gets `403` with code `AI_CONSENT_REQUIRED` and a clear message;
  NEXUS writes the email as a task for a person instead.
- Every change is written to the activity log (`ai.consent`, who and when). The latest change is shown with the setting.

## 3. Quota: a durable budget per company and per person

| Budget | Setting | Default | Window |
|---|---|---|---|
| Per company per day (screens and NEXUS together) | `AI_DAILY_LIMIT_PER_TENANT` | 300 | UTC calendar day (resets 00:00 UTC) |
| Per person per hour | `AI_RATE_LIMIT_PER_HOUR` | 60 | UTC clock hour |

- One unit is taken **before** each provider request, in the database (`ai_quota`), with one atomic conditional update.
  The gateway retries once on a timeout or provider error; that retry is a second request and takes a **second unit**
  (no unit left = no retry), so the counters equal the requests sent.
  Parallel requests can never pass the limit; counters survive restarts and hold across several server instances.
- A request that fails still uses its unit.
- Over the limit: `429` with code `AI_QUOTA_EXCEEDED`, `details.scope` (`company_daily` or `user_hourly`), `details.limit`
  and a `Retry-After` header.
- If the counter cannot be written, nothing is sent (`503`, `AI_USAGE_UNAVAILABLE`).
- Old windows are removed after 3 days; the call ledger is kept.

## 4. Ledger and logs

- Every call has an `ai_calls` row, written **before** anything is sent: if it cannot be written, nothing is sent (`503
  AI_USAGE_UNAVAILABLE`) and the unit is given back. Completing it is tried twice; if both fail, the tokens, model and
  status go to a structured log line `ai_ledger_finish_failed` (no prompt), so the cost can still be reconciled.
- The `ai_calls` row has: company, person (if any), agent, model, status (`succeeded`, `failed`,
  `invalid_output`), input and output tokens, latency, attempts, kind of error, time. Tokens are kept even when the
  answer is not valid JSON.
- The older `agent_tasks` row (Analytics → AI agents) is still written. If writing it fails, a structured JSON log line
  `ai_audit_log_failed` is printed; the quota and ledger do not depend on it.
- Logs never contain prompts, email text, document content or secrets.

## 5. Data minimisation

**Text only.** Before sending, the gateway removes from the **text** it sends: passwords (also "parol", "пароль"), API keys, tokens, `Authorization` headers, JWTs,
common key shapes (`sk-…`, `AKIA…`, GitHub, Slack, Twilio) and the values of the server's own secret settings. Ordinary
data needed for the order (places, phone numbers, prices) is kept. FLOW sends only the order text.

**Files are NOT cleaned.** VAULT sends the uploaded document file itself (PDF or image) to the provider, unchanged:
nothing written or printed inside a PDF or a photo is removed. Whatever is on the paper (names, addresses, signatures,
stamps, any number or password on it) reaches the provider. The consent screen says this. Even for text the filter is not
a guarantee: do not upload or send anything that should not leave the company.

## 6. The model's answer

- Name the model you tested (`OPENROUTER_MODEL`, `OPENAI_MODEL`, `ANTHROPIC_MODEL` or `GEMINI_MODEL`). OpenRouter
  without a model uses the account default, which can change: the server warns at start-up and Integrations shows it.
- The answer must be one JSON object with every expected key and the right types (`ai/schema.js`). Invalid JSON, an empty
  answer, missing keys or wrong types: `502` with code `AI_INVALID_OUTPUT`; nothing is filled in. Text around a valid
  object is ignored.

## 7. Numbers, units, dates, length, signatures

- **Numbers** (`lib/numbers.js`): `18,5` = 18.5, `1 250,75` = 1250.75, `1,250.75` = 1250.75. `1,250` or `18.500` can be
  read two ways: the field is left empty and marked for a person. Nothing invalid or ambiguous is written automatically.
- **Units**: a weight without a clear unit is never assumed to be kg. FLOW leaves it empty for a person; VAULT keeps it "as
  written" (`weightUnitAssumed: true`) and the weight check is "Check by hand", never "ok".
- **Dates**: "today" for FLOW is the company's own day in its time zone (Team & settings → region). If no valid zone is set,
  **UTC** is used. A date that is not a real calendar day is left empty for a person.
- **Length**: FLOW reads at most 4000 characters (for email: subject and body together). Longer text is **not cut**: the
  screen answers `413` (`AI_INPUT_TOO_LONG`) and NEXUS leaves the email for a person.
- **Receiver signature**: checked only on a proof of delivery (POD). Signed = ok; clearly not signed = a problem to fix;
  not readable = a person checks. A CMR does not get a signature warning.

## 8. What is not proven yet

All of the above is tested with a fake provider. No real account of any of the four providers, no real model and no real messy document has
not been tried (see [INTEGRATIONS.md](INTEGRATIONS.md)). The independent security review is still open
([SECURITY.md](SECURITY.md)).
