# Shared NSW Certificate Engine (Shadow Only)

This foundation is part of the standalone **AGPL-3.0-only** NSW backup service;
see [LICENSE](../LICENSE) and the [service README](../README.md). It is not an
HTTP endpoint and has no live caller. The current Next.js app and calculator
frontend **do not import or bundle this engine**. Do not move or import its
implementation into Next.js, `lib`, or the frontend.

- `calculateSharedCertificates(input)` returns either decimal `counts: { esc,
  prc }` with equipment-efficiency flags and provenance, or `unsupported` with a
  reason and no counts. `calculated` with zero counts is a distinct outcome.
- `compareCertificateShadow(input, authoritativeCounts)` compares the same
  installation's unrounded counts using `0.0002` absolute tolerance per scheme.
  It reports `match` or `mismatch` with the candidate and signed differences, or
  `unsupported`. It never replaces, returns, or mutates authoritative data and
  contains validation and calculation failures.
- The runtime entry point is `index.mjs`; `index.d.ts` defines the normalized
  contract and `index.d.mts` makes it discoverable for NodeNext imports.

Only trusted adapter inputs are appropriate. The caller must establish an exact
active Australian GEMS registration, verified equipment ratings/configuration,
and a resolved NSW installation environment, and provide a trusted evaluation
time. The engine validates schema, resource ID, checksum **format**, time
windows and consistency with the pinned rule lookup; it cannot authenticate the
publisher, verify a digest against source bytes, or establish an address or
registration's authenticity. It never reads the system clock or performs I/O.

Supported equipment is single-phase, reverse-cycle, one indoor unit: Class 8
non-ducted split under 4 kW cooling, or Class 10 ducted split under 10 kW
cooling. Both new and replacement activity are supported. The exact 552
postcodes audited in the pinned lab release are the only supported geography;
no proxy postcode, sentinel recovery, cross-border or ambiguous location is
used. No inferred classes, multi-head caps, other system types, or scheme-wide
claim determination are included. Fees, rates, DCCEEW, prices and quote data
are outside the engine.

See the [engineering and verification notes](../../../docs/shared-certificate-engine.md)
for the precise contract, known differences and gates before further use.
