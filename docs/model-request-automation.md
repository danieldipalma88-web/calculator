# Missing Model Automation

New requests are saved before work starts. A database trigger creates a durable job;
Next.js `after()` runs it without blocking the form response. Two Vercel Cron
entries twelve hours apart each check up to three pending verifications and
twelve contact emails, keeping ordinary retries within the provider's 24-hour
idempotency window.
Failed verification retries at most three times, then moves to review. Historical
requests are not bulk backfilled or emailed; an administrator can retry an individual job.

## Publication Rules

- Approved, unlocked requester, with access to the selected NSW business.
- Exact brand and complete two-part GEMS model pair; reverse order accepted. A
  single code is resolved only when it exactly matches one component of a single
  active Australian registration. No fuzzy suffix substitutions.
- One active Australian registration with matching single-system configuration,
  phase, capacity and complete energy ratings. No guessed suffixes or package codes.
- Positive certificate calculation bound to that exact registration and the
  submitted postcode/new-or-replacement scenario, using existing NSW formulas.
- Multiple distinct pairs, missing model codes and missing installation details
  prompt a clarification. Conflicting registration evidence, unsupported systems
  and multi-head requests remain in review. No AI eligibility decisions or automatic DCCEEW approval.
- Added equipment starts at $0. Warranty and Wi-Fi are unconfirmed. Existing
  catalogue entries/prices and saved quotes are never overwritten.
- Verified additions are merged into all NSW catalogue variants and the public
  estimator. They load on the next calculator navigation/refresh, without sign-out.
  Existing open calculators are not forcibly reloaded.
- Unpriced models remain hidden from salespeople. Users who can select them can
  calculate rebates and enter a price, but cannot quote until the price is positive.

## Review

Platform Admin -> Model requests (`/admin/model-requests`) searches and filters the
full request history before pagination. Review reasons and registry/certificate
evidence are retained. Retry re-verifies; Close stops processing. Neither bypasses
verification. An administrator may disable automated additions. This does not
remove systems from saved quotes; disabled models cannot be loaded into a new
calculator selection. A static catalogue entry, if one also exists, is unchanged.

## Email Delivery

Clarification and reminder emails link to a signed-in, requester-only response
page. Replies should be submitted there; the app does not read personal email.
Once the clarification is accepted by the provider, reminders are scheduled after
two and five Sydney weekdays; after ten, the request closes without deleting it.
Updated details reopen the job for verification. The explicit human-help option
and clear phrases indicating frustration pause reminders and queue one admin
alert for that clarification round. The activity log records state and delivery
changes. Routine admin notices are replaced by one deduplicated Monday Sydney
summary (Tuesday or Wednesday if Monday is missed). Provider acceptance is
tracked separately from inbox delivery.

Requester confirmations use the existing Resend setup, exclusively from
`notifications@mail.rebateportal.com.au`, with replies to the monitored
`danieldipalma88@gmail.com`. No personal sender fallback. Publication and email
progress are separate: an email failure never repeats model publication.

The worker checks the active published record before authorizing a send. Disabling
is rejected while an active send lease exists. Provider retries use a fixed
request UUID idempotency key and unchanged payload. An uncertain delivery older
than 23 hours is held for reconciliation, not automatically resent. Review the
provider logs before manually resending to avoid duplicates. Email status `sent`
means accepted by Resend, not proof of inbox delivery.

## Deployment

Apply `supabase/model_request_automation_upgrade.sql` and then
`supabase/model_request_followup_upgrade.sql` through migrations before the
corresponding app release, after independent review. Set these production-only Vercel values:

- `MODEL_REQUEST_WORKER_SECRET`: dedicated random 256-bit-or-greater secret.
- `CRON_SECRET`: separate random secret for the scheduled HTTP endpoint.
- `MODEL_REQUEST_AUTOMATION_ENABLED=true`.
- Existing `RESEND_API_KEY` and `MODEL_REQUEST_FROM_EMAIL`.

Store only SHA-256(worker secret) in `model_automation_private.settings` using
secure provisioning; never commit or print secrets. No service-role key is used.
Public RPC wrappers run as invoker; narrowly scoped private functions validate the
worker secret or the current approved admin. Preview environments cannot process
production jobs because the worker secrets/enable flag are production-only.

To pause processing, disable the flag and redeploy. Saved requests and catalogue
entries remain intact. Do not drop the tables as a rollback: old and new callers
can both keep saving requests. The trigger validates ownership, business access,
server-controlled fields and a five-per-15-minute quota even for direct API inserts.

## Checks

- `node --experimental-strip-types scripts/verify-model-request-verification.mjs`
- `node scripts/verify-model-request-workflow.mjs`
- `node scripts/verify-model-request-database.mjs` (isolated PGlite 0.5.14; set
  `PGLITE_MODULE` to its `dist/index.js`, or use the ignored test dependency path).
- `node scripts/verify-model-request-browser.cjs` with the existing Playwright
  module/executable environment variables.

Database tests run real SQL/RLS/grants on an isolated, single-connection Postgres
engine. They test interleaved state transitions, not simultaneous network clients.
No test sends real email or inserts synthetic production requests.
