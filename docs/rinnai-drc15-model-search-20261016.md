# Rinnai DRCi 15 model search correction

## Root Cause

The All Models API fetched GEMS rows with the case-sensitive filter
`Brand = Rinnai`. The requested `DONSR15B1/DINLR15B1` is registered as
`RINNAI`, while the newer LA/SA and TA/SA pairs use `Rinnai`.

On 16 October 2026, the exact-case Rinnai inventory contained 83 rows.
A case-insensitive approved/available inventory contained 115 rows, including
the exact requested pair. Both configured GEMS resources were checked.

The correction uses the existing CKAN SQL API for brand inventories with
`LOWER(Brand) = LOWER(requested brand)`. Approval, availability, Australian
market filtering, query normalization, result limits and cache lifetimes remain
in place. Metadata searches and certificate formulas are unchanged. Brand
choices are deduplicated without regard to capitalization.

## Catalogue Entry

- Brand: Rinnai
- Series: DRCi R32, nominal 15 kW
- Outdoor: DONSR15B1
- Indoor: DINLR15B1
- Rated cooling: 14.0 kW
- Rated heating: 14.5 kW
- Power: single phase, 220-240 V, 50 Hz
- System: ducted reverse-cycle inverter, R32
- Warranty display: 7 years limited, subject to Rinnai terms
- Wi-Fi: enabled wired programmable controller included
- Price: $0 including GST; no price was supplied
- Scope: shared default NSW ducted catalogue and generated estimator catalogue

The distinct `DONSR15B1TA/DINLR15B1SA` entry and its $2,968.81 price are
unchanged. Zero-price quote guards and salesperson visibility rules remain.

## Sources

- GEMS resource: https://data.gov.au/data/api/3/action/datastore_search?resource_id=0973a476-eb0c-45e6-9a18-054f74307843&q=DONSR15B1%2FDINLR15B1
- Rinnai technical brochure: https://www.rinnai.com.au/wp-content/uploads/RA85.07.24-Ducted-Cooling-Brochure-WEB-1.pdf
- Rinnai operation manual: https://www.rinnai.com.au/wp-content/uploads/B065531-DRCi-Lo-Med-Hi-OM-Issue-C_NOV-2023.pdf
- Rinnai warranty update: https://www.rinnai.com.au/trade/news/rinnai-air-conditioning-new-7-year-warranty
- NSW estimator metadata: POST https://estimator-sfg-rac-prd.energy.nsw.gov.au/commercial_hvac/metadata with brand Rinnai and model DONSR15B1-DINLR15B1

The official NSW metadata identifies Class 11 ducted equipment and agrees with
the GEMS rated capacities. The supplied manufacturer documentation covers this
older exact pair, not the newer suffix variants.

## Verification

`verify:all-models` includes regression tests for mixed-case registrations,
full and partial model searches, deduplication, distinct suffix variants,
Australian/approved/available filtering, SQL escaping, unavailable-service
responses, catalogue support and preservation of existing prices.

`scripts/verify-rinnai-drc15-live.mjs` checks the live case-insensitive GEMS
inventory, official NSW metadata and browser/server certificate agreement for
new and replacement installations at postcodes 2000 and 2179.

For postcode 2000, replacement, both implementations returned:

- ESC: 52.918546420000006 (displayed 52.92)
- PERC: 237.2199232 (displayed 237.22)
- At the screenshot comparison rates of $24.70/ESC and $3.10/PERC: $2,042.47

These match the supplied Electric Future screenshot. Actual business payouts
still use each account's current rates; the comparison rates are test inputs,
not changes to live spot prices or business agreements.
