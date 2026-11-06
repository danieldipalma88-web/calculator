# Shared Certificate Engine: Shadow Foundation

The only runtime addition is in the standalone AGPL service's
[`shared-engine`](../services/nsw-rebate-backup/shared-engine/README.md)
directory. No endpoint, deployment configuration, quote caller, UI result,
business rate, fee, DCCEEW contract logic, product price or saved record is
changed. The current Next.js app does not import the engine.

## Input and Result

Use `CertificateInput` from the service-local `index.mjs` declaration. Supply
one equipment/installation case: exact brand, model and registration number;
verified single-phase configuration and ratings; the NSW postcode and its
verified ESS/BCA zones; new or replacement activity; and explicit `asOf`.
Cooling/heating capacities and cooling input are in kW; annual energy for all
three ESS climates is in kWh. Verified seasonal or annual zero values invoke
the existing fallbacks. Missing fields or invented zeros are not acceptable.

GEMS provenance carries the pinned resource ID, a source-snapshot SHA-256 and
timestamps. Environment provenance carries the lab coverage revision and
timestamps. Pass canonical UTC instants with milliseconds. Each snapshot must
satisfy `observedAt <= asOf < validUntil` with a lifetime of at most seven days,
and `asOf` must precede `registrationValidUntil`. The trusted source adapter
must normalize that exclusive registration cutoff from verified registry
semantics; the core does not interpret date-only GEMS expiry. The fixture
adapter conservatively uses the start of the recorded UTC expiry date for
historical replay. Output `provenance.validUntil` is the earliest cutoff. The
seven-day window is a shadow safety policy, not evidence that data remained
current during the window. Do not advance observations on cached source data.

The caller owns verification of source bytes, source authenticity, exact
equipment/registration identity, location and trusted time. A syntactically
valid digest, asserted active status or asserted timestamp is not proof of
any of these. The result explicitly reports `publisherAuthenticated: false`.
Do not accept this contract directly from user-supplied JSON. Do not interpret
an `unsupported` result as zero, or interpret equipment-efficiency flags as a
determination of installation or scheme eligibility.

## Calculation Decisions

- `calculateNswFallback` supplies pinned postcode lookups and raw savings at
  OpenFisca revision `ae8d778f18e0612bd38c69a2527ff9d7e12d3747` and source
  period `2021-01-01`. The period is a rule-interface pin, not `asOf`.
- Class 8/10 thresholds come from the existing parameter snapshot and match
  `lib/nsw-hvac-rebate.ts` and `index.html` for the supported equipment. The
  quote path tests cooling for both schemes and heating for ESC; a positive
  seasonal rating takes precedence, otherwise the corresponding rated metric
  is used. Quote thresholds compare registered decimals; OpenFisca's internal
  float32 checks can differ at a threshold (e.g. Class 10 ACOP `3.8`). This is
  a quote shadow comparison, not a reproduction of official whole certificates.
- Quote counts are raw electricity savings times the regional factor times
  `1.06`, and raw peak reduction capacity times the loss factor times `10`,
  subject to their efficiency gates. There are no applicable multi-split caps
  for these inputs. Do not use the floored official `ESC_calculation` or
  `PRC_calculation` fields. An eligible negative raw count is unsupported:
  the lab clamps it to zero, while the quote decimal path can preserve it.
  Resolve that policy independently before admitting those cases.
- The compressed postcode inventory is exactly the 552 covered postcodes in
  lab release `atlas-20261106t113910611z-3756476b802a`. All 70 lab exclusions
  and all out-of-inventory postcodes fail closed. In particular `2163` differs
  between the pinned BCA lookup (zone 6) and the calculator override (zone 5);
  there is no override here. No adjacent postcode is inferred. Coverage is
  evidence for this rule pin, not a live map or permission to refresh data.

## Offline Verification

With Node 24, run from the calculator checkout:

```powershell
node --test scripts/verify-shared-certificate-engine.mjs
node scripts/verify-nsw-hvac-rebate-rules.mjs
node scripts/verify-nsw-backup-http.mjs
```

The shared verifier reads the pinned sibling `rebate-engine-lab` checkout by
default; set `CERTIFICATE_ENGINE_LAB` to its path for other layouts. It checks
artifact hashes and uses the original fixture timestamp, not today's time.
It compares all 5 models x 552 postcodes x 2 activities against both the
independent Python atlas and the recorded offline frontend/backup results.
The maximum accepted absolute difference is `0.0002` certificates for each
scheme. The verifier blocks fetch, WebSocket and imports outside the audited
engine dependency graph. No lab data is copied except for the compressed
coverage inventory. To verify the pinned atlas is reproducible, run
`node scripts/build-atlas.mjs --check` from the lab with its local Python
environment. Neither check refreshes snapshots.

## Future Adapters and Release Gates

- Calculator: construct the case only after exact server-side GEMS and NSW
  environment verification. Compare with the unrounded authoritative counts
  for the same model, activity and environment. Keep the current calculator
  result authoritative; never wait for or replace it with shadow output.
- Estimator: use the same trusted normalized input and apply payout rates
  outside the service. Unsupported is unavailable, not a rebate promise.
- Won jobs: compare only a separately authorized, server-verified replay of
  each installation with explicit rule/data and evaluation time. Never
  recalculate locked quotes, change jobs or persist candidate counts by default.

Before any rollout: coordinator final review and production build; independent
qualified financial and AGPL boundary review; authoritative rule, registry,
address and trusted-time validation with authenticated publishing and expiry
ownership; independently reviewed parity beyond the five models and at rule
edges; agreement on negative counts and excluded location resolution; and an
explicitly approved shadow rollout with privacy-safe diagnostics, time bounds
and a kill switch. Broader classes, multi-head and use of candidate counts
require separate approval and evidence. No live shadow has been wired here.
