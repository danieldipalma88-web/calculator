# NSW Rebate Calculation Backup

Standalone HTTP calculation service. This directory is licensed under
AGPL-3.0-only; see LICENSE. Its newly written JavaScript engine is informed by
the NSW Government OpenFisca source and reproduces that source's float32
arithmetic and JSON serialization. Copyright notices and the source licence
are retained. The separately deployed calculator communicates through HTTP;
it does not import or bundle this service's engine.

## Source and Scope

- Upstream: https://github.com/energy-savings-scheme/openfisca_nsw_safeguard
- Revision: ae8d778f18e0612bd38c69a2527ff9d7e12d3747 (31 August 2026, release 9.2.0).
- Family: HVAC1_PDRSAug24, same request period 2021-01-01 as the existing calculator.
- Supports one building and the documented climate/certificate variables only.
- No accounts, saved quotes, equipment prices, payout rates, contract matching,
  authentication keys, or customer contact/address records are stored here.
- Missing or unsupported calculation inputs fail closed. No default rebates.
- The primary government's published postcode sentinel remains unchanged. The
  calculator's existing explicitly enumerated postcode recovery stays outside
  this service. Unknown postcodes are not inferred.

This is an estimator, not a determination of installation eligibility or a
guarantee of claim payment. Source parity does not itself prove that future
rule changes have been incorporated. Revalidate the pinned source when the
government model/rules change; never silently update mathematical parameters.

## Reproduction

From the repository root, run `node scripts/download-nsw-fallback-reference.mjs`
to obtain the pinned audit source. The reference harness requires Python with
OpenFisca-Core 43.3.7 and its web API dependencies. Set NSW_REFERENCE_PYTHON to
that interpreter and run `node scripts/verify-nsw-calculation-fallback.mjs`.
The generated snapshot is reproducible using
`scripts/nsw-fallback-reference.py data`.

The verifier covers upstream fixtures, the recorded 28 October certificate
results, historical Electric Future screenshot references, the NSW postcode
inventory, decimal serialization, malformed inputs and differential cases.
`node scripts/verify-nsw-backup-http.mjs` checks the actual HTTP adapter and
calculator caller, including postcode recovery and source attribution.

The source, deployment files and audit tools are freely accessible in the
public danieldipalma88-web/calculator repository. GET /api/calculate and every
deployed HTTP response's Link header point to the exact deployment Git commit,
not a mutable branch. VERCEL_GIT_COMMIT_SHA must be available in production;
the service refuses calculations if that source revision is missing.
No key is needed to obtain the source.

Deploy this directory as an independent Vercel Node.js 24 project in syd1.
There are no npm dependencies, secrets, databases or scheduled AI calls.
Standard hosting usage applies. Production browser access is restricted to
the calculator origin. The public JSON math endpoint accepts no arbitrary URLs.
