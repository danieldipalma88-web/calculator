# Business Won Jobs

## Scope

Business owners get a separate Business Won Jobs report for the business selected
in their calculator. My Won Jobs retains the original personal view and actions.
The report opens in a separate tab; it never loads another salesperson's quotes
into the editor. Search, date filters, salesperson filtering and 25-job pages run
locally after the report loads.

Only retained current/saved jobs whose complete set of system rows identifies the
selected business can be included. Ambiguous business attribution is not inferred
from current memberships. Deleted-account data and database backup-only records
are not resurrected. Missing saved monetary values remain "Not recorded".

## Safety Boundary

- Existing quote JSON, prices, rebate calculations and payment controls are not
  written or recalculated by this feature.
- No additional index, trigger, column, foreign key or policy is added to
  `user_calculator_data`. Normal quote saves do not maintain this cache.
- A private directory stores only profile identity/version and source-discovery
  keys. It does not store customer quote payloads or new authoritative money.
- Every HTTP request checks current approval, lock status, role and business
  membership before using the 30-second in-process report cache.
- The database RPC independently verifies authorization and projects only allowed
  fields. Full salesperson profiles and other-business rows never reach the page.
- There is no cron, calculator-startup request or persistent polling. An opened
  report may prepare its directory in bounded batches, then stops. A closed page
  aborts its own preparation; it cannot cancel another caller's shared read.

## Read-Side Directory

The RPC compares small profile metadata with the private directory. At most ten
changed profiles are parsed per call, under a nonwaiting cache-only advisory lock.
Freshness includes the row's `xmin` version, timestamp and email, so legacy writes
that do not advance `updated_at` still invalidate the derived directory.
It never locks source quote rows. Incomplete preparation returns no report data;
the page retries at most twenty times within a thirty-second total deadline.

Once prepared, business/source keys locate relevant retained profiles, including
former salespeople and admin-owned copies. Exact business matching, deletion and
unlock suppression, and canonical deduplication happen before display. Versions
are rechecked before returning a complete report.

The report rejects more than 1,000 jobs, 200 systems per job, 5,000 total systems
or 2 MiB of projected JSON rather than silently returning incomplete totals.
These are output bounds, not a claim that intermediate database work is free.

## Rejected Design

Do not replace the directory with an expression index on the quote JSON.
The initial isolated 6.99 MiB profile benchmark measured median updates of
30.28 ms without that index and 125.69 ms with it, even for an unrelated field.
That design was rejected and never applied to production.

## Validation

Run the focused scripts from the repository root:

```powershell
node scripts/verify-business-won-jobs.cjs
node scripts/verify-business-won-jobs-database.mjs
node scripts/verify-business-won-jobs-browser.cjs
node scripts/verify-won-quote-durability.mjs
node scripts/verify-calculator-data-save.mjs
node scripts/verify-quote-sync-safety.mjs
```

The database verifier uses an isolated PGlite database and fictional records.
The final design passed 146 database checks. In seven authenticated updates of a
7.33 MB fictional profile, baseline median latency was 21.86 ms and latency with
the directory installed was 23.02 ms; normal saves invoked zero directory parsers.
An explicit large-profile refresh took 117.07 ms median and a warm report 6.67 ms.
These local timings are not production guarantees. PGlite does not validate
multi-session advisory-lock contention; explicit report preparation still uses
bounded database resources.
`PGLITE_MODULE` can point to an already installed `dist/index.js`; tests never
download dependencies or connect to production. Browser tests need a local build,
Playwright and Chromium/WebKit installations. `PLAYWRIGHT_MODULE`,
`PLAYWRIGHT_BROWSERS_PATH` and `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` support local
runtime locations. All browser requests outside localhost are blocked.

The old multi-head-only isolation verifier pins its own earlier release and is
not the scope gate for this change. The business verifier instead compares with
`598b29a`, preserving all existing calculator functions except the two authorized
Won Jobs entry/count functions, plus all calculator markup and styles.

## Release

Independent review, database tests, browser tests and a production build must pass
on the final candidate before release. Apply `supabase/business_won_jobs_read.sql`
and `supabase/business_won_jobs_index.sql` together before publishing the UI.
The index belongs only to the new private directory. The RPC fails closed if that
index is absent or invalid.

Verify the selected business and permissions using the live read-only report.
Check that the original quote-table indexes, triggers and policies are unchanged.
No backup restore, account reset, compute upgrade or saved-quote migration is needed.
To roll back the user-facing change, roll back the application release; existing
quote storage is independent of this cache. Future discovery-helper changes must
invalidate the derived directory using its own lock, never rewrite quote JSON.
