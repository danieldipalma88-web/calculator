# Calculator read efficiency and health warnings

## Scope

This release reduces reads only. It does not change quote-saving logic, backup
triggers, stored quotes, prices, rebate calculations, authentication policy or
session lifetime. There is no database migration or restart.

- Calculator startup and full calculator-data GET read a profile by email once.
  Only a successful missing self-profile permits the legacy user-ID fallback.
  Database errors never become empty profiles, and viewing another user never
  falls back to the current user's document.
- Admin loads full Won Jobs profiles and batch history on demand. Other admin
  sections do not scan quote documents. Existing Won Jobs links remain usable;
  recovered backup reads remain explicit opt-in.

## External health warnings

`.github/workflows/calculator-origin-health.yml` runs every ten minutes on the
public production repository's main branch, or manually through Actions. GitHub
schedules are best effort and may be delayed; this is not automatic failover.

Each check makes only two read-only requests to the configured Supabase project:

1. Authentication health, validating the expected GoTrue response.
2. A database REST HEAD request with a zero-row limit, validating Content-Range.

No sign-in codes are sent. No accounts, quote bodies or prices are retrieved.
No service-role credentials are required. Requests have a twelve-second
deadline. A failure or response taking at least three seconds is checked once
more after five seconds. There is no unbounded retry loop.

Confirmed slowness or failure opens one GitHub incident assigned to the repository
owner. State changes update it; unchanged failures do not add repeated comments.
A clean subsequent check closes the incident. A recovered retry is recorded in
the run but does not close an existing incident. Missing or invalid monitor
output is treated as unknown health, never as recovery.

Alerts use GitHub notifications. Email delivery depends on the owner's GitHub
notification settings. Inspect the Actions run summary for timings and the open
issue titled `Calculator sign-in or database needs attention` for incidents.
Only fixed service names, timings and HTTP status codes are published.

These probes check reachability, not an authenticated quote-save transaction.
They do not measure backup growth, memory or disk I/O. Those require separate
private infrastructure metrics; do not claim that a healthy check proves every
application operation is healthy or that outages cannot recur.

## Verification

Run `node scripts/verify-calculator-origin.mjs` and
`node scripts/verify-calculator-origin-incident.mjs` for synthetic slow responses,
outages, malformed success responses, bounded retry, deduplication, recovery and
privacy checks. These tests do not contact production or create real incidents.

Run `node scripts/monitor-calculator-origin.mjs` with network access for a small
read-only live health check. A restricted local network can fail this check even
when production is healthy; verify from an allowed network before diagnosing
an outage. The scheduled GitHub runner checks independently of this workstation.

Do not respond to an alert with an automatic restart, restore, backup deletion
or blanket sign-out. Confirm the failing dependency and use bounded diagnostics.
