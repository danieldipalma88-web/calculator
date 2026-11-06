# Calculator save reliability

## Incident evidence

On 6 November 2026, users saw an unconfirmed-save warning when changing quote
options. Production logs showed calculator-data writes reaching the 300-second
function limit, database connection-pool timeouts, statement timeouts and waits
on the shared business-calculator row. Authentication requests also timed out.
These failures began before the address-verification release.

The available evidence does not establish the initial cause of the underlying
service degradation. The service recovered before this patch was published.
It did establish two application-level amplifiers:

- An unchanged shared business configuration was written on routine quote saves.
- A browser abandoned a request after 12 seconds and retried every 1.8 seconds,
  while server work could continue for five minutes. Input changes could also
  bypass retry delays. Unload beacons could create additional overlapping saves.

## Changes

- Unchanged business and user data skips database writes after validation,
  authorization, version and price checks. Real changes retain exact-version CAS.
- Save PUT and POST handlers share an eight-second deadline across Auth and Data
  API calls. Aborted operations cannot start more fetches. Database retries are
  disabled for this client; timeout responses are retryable and never success.
- The browser allows three automatic attempts with increasing delays and jitter.
  Typing and periodic checks do not bypass backoff. Manual retry uses the latest
  pending snapshot. A successful HTTP status alone is not save confirmation.
- Pending envelopes are retained in account/business-scoped session storage.
  An exact acknowledgement clears only that envelope. On refresh, recovery is
  offered separately from current cloud data; stale financial snapshots are not
  silently replayed. A download is required before choosing the saved version.
- Workspace switches fence old tabs. New requests carry an expected account,
  viewed profile and business; explicit legacy targets cannot silently retarget.
- Failed required cloud reads return a script-free, no-store retry page instead
  of an empty saved baseline. Browser recovery cannot discard edits based on a
  failed database read.
- Edit, copy and arrange operations retain their original request identity
  after an uncertain outcome. A rejected retry does not prove an earlier write
  failed. Only a validated response followed by the matching UI acknowledgement
  releases the mutation fence.
- Unconfirmed won-job messages describe an unknown outcome instead of claiming
  that nothing was saved; retries preserve the original won-state attempt and
  do not accidentally unlock a committed job. Existing quote, price, payment and rebate values are
  not migrated or rewritten by this release.

## Verification

The focused verifiers use actual application functions and the installed
database client, with synthetic records and intercepted network requests:

- `verify-calculator-data-save.mjs`: no-op writes, CAS, commit/lost-response
  retry, late writes, cancellation, transient errors and account/workspace guards.
- `verify-cloud-save-recovery.mjs`: bounded retries, exact acknowledgement,
  latest draft retention, storage recovery, reload and workspace isolation.
- `verify-cloud-save-baseline.mjs`: required-read failures, valid legacy
  fallback and successful empty accounts against the actual raw GET handler.
- `verify-cloud-save-browser.mjs`: real Chromium at 1280px and 390px, native
  Storage interception, recovery downloads and manual retry.
- Existing quote sync/options/library, business configuration, loading,
  performance and authentication suites; production Next.js build.

The Quote save safeguards workflow runs synthetic checks on relevant pushes,
pull requests and weekly. It contains no production credentials and cannot
modify live records. This is regression protection, not a production uptime
monitor. Existing rebate availability checks do not prove quote-save health.

## Operational limits

An interrupted response does not prove a database transaction rolled back.
External outages can still prevent saving. During an outage, keep the tab open,
retry when available, or download recovery data before leaving. Session storage
survives refresh in the same tab but is not guaranteed after the tab is closed.
Storage failures are surfaced and do not become a false Saved state.

The server improvements apply to already-open tabs through their next request.
New browser safeguards load on the next normal page load. Do not force a reload
of a partner's unconfirmed edits to roll out this release.
