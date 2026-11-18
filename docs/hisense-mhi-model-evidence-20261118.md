# Hisense X5 and MHI Avanti/Ciara model evidence

The approved scope below uses the public [GEMS Energy Rating Registration Database](https://www.energyrating.gov.au/program-tools/energy-rating-registration-database) registrations supplied from `Registry.search` for 18 November 2026. All ten registrations were reported active on that date. Capacities are rated cooling kW; component codes are listed outdoor first. Registration and manufacturer identity do not establish NSW rebate eligibility or amounts.

| Brand / series | Canonical registered model | Outdoor unit | Indoor unit | Cooling kW | GEMS |
| --- | --- | --- | --- | ---: | --- |
| Hisense X5 | `HAWH9KR` | `HAWH9KR-O` | `HAWH9KR-I` | 2.5 | `AAC9478` |
| Hisense X5 | `HAWH12KR` | `HAWH12KR-O` | `HAWH12KR-I` | 3.7 | `AAC9479` |
| Hisense X5 | `HAWH18KR` | `HAWH18KR-O` | `HAWH18KR-I` | 5.1 | `AAC9279` |
| Hisense X5 | `HAWH24KR` | `HAWH24KR-O` | `HAWH24KR-I` | 7.2 | `AAC9240` |
| Hisense X5 | `HAWH28KR` | `HAWH28KR-O` | `HAWH28KR-I` | 8.0 | `AAC9249` |
| MHI Avanti | `DXC06ZSA-W / DXK06ZSA-W` | `DXC06ZSA-W` | `DXK06ZSA-W` | 2.0 | `AAC8734` |
| MHI Avanti | `DXC09ZSA-W / DXK09ZSA-W` | `DXC09ZSA-W` | `DXK09ZSA-W` | 2.5 | `AAC8732` |
| MHI Avanti | `DXC12ZSA-W / DXK12ZSA-W` | `DXC12ZSA-W` | `DXK12ZSA-W` | 3.5 | `AAC8733` |
| MHI Avanti | `DXC18ZSA-W / DXK18ZSA-W` | `DXC18ZSA-W` | `DXK18ZSA-W` | 5.0 | `AAC8735` |
| MHI Ciara | `DXC24ZTLA-WJ / DXK24ZTLA-WFJ` | `DXC24ZTLA-WJ` | `DXK24ZTLA-WFJ` | 7.1 | `AAC8851` |

## Manufacturer Cross-Checks

- **Hisense X5:** The official [X5 brochure, Wall Mounted Systems table](https://dtc-aus-api.hisense.com/medias/Hisense-Air-Con-Split-Systems-Brochure.pdf?context=bWFzdGVyfE1hbnVhbHwyMzk2OTMzOHxhcHBsaWNhdGlvbi9wZGZ8YUdFNEwyZzROQzg0T0RrNU5UWXdNREV6T0RVMEwwaHBjMlZ1YzJVZ1FXbHlJRU52YmlCVGNHeHBkQ0JUZVhOMFpXMXpJRUp5YjJOb2RYSmxMbkJrWmd8ZTdlNzdmNjMyZGRhMWY3MTU5NTBmNmExZTFkNmQzMDg2M2QyMDJhZDg4ODE3Mjk0NWZhY2U1ZGM0YzE3ZmExMg) gives the five set codes, cooling capacities, and exact indoor and outdoor unit codes. The [Hisense cyber-security page](https://hisense.com.au/cyber-security) also lists the component pairs. The set code is the canonical identity; `-I` and `-O` are aliases, not standalone catalogue systems.
- **MHI Avanti:** The [MHIAA October 2024 trade list, W Range, p. 6](https://www.mhiaa.com.au/document/trade-price-list-october-2024-web/) confirms all four exact pairs and capacities. MHIAA's [model table](https://www.mhiaa.com.au/partner-portal/powerplus-rewards/eligible-products/) identifies these combinations as Avanti. Do not substitute `-WF1` indoor variants or use trade list figures as calculator prices.
- **MHI Ciara:** The [MHIAA June 2025 Ciara model update, specification table](https://www.mhiaa.com.au/document/ciara-series-mja-model-update-june-2025-web/#page=2) confirms the 7.1 kW `-WJ` outdoor and `-WFJ` indoor pair. The non-J pair and other Ciara capacities are outside this approved scope.

## Catalogue Baseline

In `d94c8bd:index.html`, `HAWH18KR` is already at default split index `194` with both price fields and static rebate at zero. None of these exact approved identities were present in the static Andos split list. `HAWH9KR` is also supplied as a verified runtime addition. Append any missing static rows after the previous rows with `lateCatalogueEntry`, so the NSW merge retains the verified `HAWH9KR` at its existing position and does not shift prior business, verified, or late rows. No new shared pricing or static rebates are approved.

## Change and Validation Scope

- Missing approved models are appended to NSW standard and Andos catalogues. Existing Hisense entries are deduplicated. Physical Hisense component codes are searchable aliases; canonical rebate lookup identities remain unchanged.
- Split/ducted unit selectors and multi-head outdoor/indoor selectors now have local type-to-search. Native option values and existing change handlers remain authoritative. Typing, clearing, cancelling or finding no matches does not select a model or save a quote.
- The catalogue regression deep-compares original rows, indices and prices against `d94c8bd`, including business additions and a verified Hisense fixture. New static prices and rebates are zero.
- Browser coverage includes desktop/mobile Chromium and WebKit, partial codes, component aliases, keyboard selection, cancellation, loading/failure lists, same-brand option refresh, indoor-row recreation and focus, and responsive overflow. Quote/rebate/access/multi-head outage workflows are exercised separately using fictional local data.
- Financial, quote-sync, business-configuration, rebate, catalogue, cashback and existing model-request browser regressions passed. The production build and generated public catalogue freshness checks passed.
- Independent review found stale cached native options after identical list replacement and lost focus after indoor-row recreation. Both were fixed and covered by regression tests before release.
- Known pre-existing test limitation: `verify-loading-states.mjs` asserts an obsolete live-rebate hard-timeout string and fails identically at the unchanged baseline. Actual startup and simulated-outage browser checks pass. No unrelated timeout behavior was changed.
- No database migration, price update, quote write or authentication change is part of this release. The previous production commit is `d94c8bd`.
