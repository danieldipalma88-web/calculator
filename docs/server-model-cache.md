# Server-side calculation metadata

The quote calculator resolves model ratings through `GET /api/gems-model-metadata`
instead of querying GEMS and the NSW metadata service from each browser.
This public endpoint exposes public registration ratings only. It has no access
to saved quotes, equipment prices, business settings or payment data.

## Matching and freshness

- Exact, brand-scoped registered systems and existing documented package aliases.
- Reversed indoor/outdoor pairs and punctuation are accepted; a component alone
  cannot stand in for a complete system.
- Both GEMS feeds must load completely. Conflicting active records, missing
  ratings and rejected registrations remain unavailable.
- The shared Next.js inventory cache revalidates after five minutes. Every
  response also enforces a one-hour hard maximum age, including failed background
  revalidation. Expiring registrations can shorten that interval.
- Only verified inventories are cached. Concurrent reads share work; transport
  failures have a short cooldown. The server deadline is eight seconds, including
  response bodies. Browser waiting is bounded to ten seconds.
- A cancelled comparison cannot cancel a lookup shared by the selected system.
- Existing curated fallback metadata remains available on genuine misses or
  service outages. It is not newly certified by this cache and does not bypass
  conflicting, incomplete, rejected or malformed lookup responses.

## Verification

Run on Node 24 with project dependencies installed:

```powershell
node --experimental-transform-types scripts/verify-gems-calculation-metadata.mjs
node --experimental-transform-types scripts/verify-server-model-lookup-parity.mjs
node scripts/verify-best-value-recommendations.mjs
```

The weekly NSW safeguard workflow runs the first two checks using fixtures.
The parity check compares the existing mapping with the server mapping over
five registered systems, four postcodes and both installation types. It uses
the actual backup calculation engine while injecting a primary outage.

Browser transport/UI checks are in `scripts/verify-server-model-lookup-browser.mjs`.
Set `PLAYWRIGHT_MODULE_PATH` and `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to installed
local runtimes. All browser requests are intercepted and no live records are
written. These checks do not substitute for certificate-accuracy tests.

## Release boundary

No certificate formulas, catalogue entries, equipment prices, saved quote records
or business settings are changed. Server-side won-job/estimator calculations keep
their existing metadata resolver. The new route replaces the quote browser's
lookup path, not every resolver in the repository.

Already-open pages adopt the new code through the existing safe update notice.
There is no forced reload, sign-out or discard of unsaved work.

This reduces upstream and browser failures; it does not promise zero outages.
A cold cache during a registry outage still reports unavailable. Long outages
past the freshness boundary require fresh verified data, not stale estimates.
