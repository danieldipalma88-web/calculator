# NSW Rebate Service Health

## Incident: 6 November 2026

The selected Fujitsu AOTG09KMTC/ASTG09KMTC rebate for a new install in
postcode 2145 failed with "Failed to fetch". This was reproduced in the
authenticated calculator. A separate HTTPS request to the configured NSW
calculation API failed TLS validation with `CERT_HAS_EXPIRED`.

The official NSW residential estimator still publishes the same API:

- https://www.energy.nsw.gov.au/residential-ac-estimator
- https://auesfgracessstgprd.blob.core.windows.net/estimator-v5/dist/latest/dynamic-loader.js
- https://auesfgracessstgprd.blob.core.windows.net/estimator-v5/dist/latest/files/residential_ac_estimator.js
- https://of-sfg-rac-prd.energy.nsw.gov.au/calculate

No supported replacement was verified. Restoring this dependency requires
the operator to repair its certificate. Do not disable TLS verification,
change the calculation date, or use guessed/default rebates.

## Safeguards

- `GET /api/rebate-service-status` makes a fixed, non-customer postcode probe.
  It accepts no target URL or payload from the caller and returns only a
  sanitized status. Only signed-in, approved, unlocked calculator users can call
  it. Responses are private and not stored by shared caches. Upstream probes
  are deduplicated and cached in memory for 30 seconds per server instance.
- The standard split/ducted calculator displays an unavailable result and
  Retry rebate action on failure. It retains the numeric zero guard internally.
  A service diagnostic is optional and cannot overwrite a newer calculation.
- `NSW rebate service health` runs hourly at minute 43 on public repositories
  only, plus manual runs and changes to its files. It tests the real NSW API
  and validates its TLS certificate, warning within seven days of expiry.
  This uses GitHub Actions, not recurring AI requests.
- Failed runs use GitHub's normal workflow notifications, subject to the
  repository user's notification preferences. No email is sent by the script.
  Scheduling and notifications are not an immediate-response guarantee.
- The comprehensive weekly postcode and model safeguards remain separate.

Run the focused tests with Node 24:

```text
node --experimental-strip-types scripts/verify-rebate-service-status.mjs
node --experimental-strip-types scripts/verify-rebate-dependencies.mjs
node scripts/verify-rebate-service-ui.mjs
```

During an outage, a failing dependency-monitor result is expected and must not
be presented as a successful live rebate test. After operator repair, verify a
real calculation and the certificate check before calling service restored.
