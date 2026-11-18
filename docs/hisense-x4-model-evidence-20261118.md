# Hisense X4 catalogue addition

Approved scope: the five complete Australian X4 reverse-cycle split systems supplied by the user. No shared equipment prices, saved quote updates, formula changes, or database migration are included.

## Verified identities

The public GEMS resource `d4e17a35-9002-4a0c-ac1c-003ece0de135` was queried through the existing read-only `Registry.search('HAWK')` on 18 November 2026. It returned exactly these five records, all Approved, Available, sold in Australia and New Zealand, Non Ducted, Single Split System, Single phase, and active. These system codes are the canonical rebate identities.

| Canonical system | Outdoor component | Indoor component | Cooling kW | Registration | Expiry |
| --- | --- | --- | ---: | --- | --- |
| HAWK25KR | HAWK25KR-O | HAWK25KR-I | 2.5 | AAC10386 | 2031-08-12 |
| HAWK35KR | HAWK35KR-O | HAWK35KR-I | 3.5 | AAC10383 | 2031-08-11 |
| HAWK50KR | HAWK50KR-O | HAWK50KR-I | 5.4 | AAC10393 | 2031-08-13 |
| HAWK71KR | HAWK71KR-O | HAWK71KR-I | 7.1 | AAC10382 | 2031-08-11 |
| HAWK80KR | HAWK80KR-O | HAWK80KR-I | 8.0 | AAC10387 | 2031-08-12 |

Registry source: [Australian GEMS air-conditioner data](https://data.gov.au/data/dataset/5b70b4e7-4171-4c60-b2e9-6461bc213ac0/resource/d4e17a35-9002-4a0c-ac1c-003ece0de135).

## Manufacturer cross-checks

- [Hisense's compliance page](https://hisense.com.au/cyber-security) lists all five exact indoor/outdoor pairs. The outdoor suffix is the letter O, not zero.
- [Hisense's residential catalogue](https://hisense.com.au/category/residential-airconditioning/) lists the X4 system code HAWK25KR and the five capacities 2.5, 3.5, 5.4, 7.1 and 8.0 kW, with ConnectLife controls.
- The official [residential range page](https://hisense.com.au/air-conditioning/residential), indexed during this verification, advertises a limited-time seven-year air-conditioning warranty. The support label retains the existing cautious wording `7 yrs promo (conditions apply)` rather than claiming unconditional seven-year coverage.
- The product detail page and a retailer-hosted brochure were not retrievable. Neither is used as identity evidence. No retailer prices are imported.

## Preservation and verification

- Append the five models after the previously published X5/MHI entries, with `lateCatalogueEntry` and `nswOnly`, in both standard and Andos catalogues.
- Store complete registered system codes; expose physical component codes as searchable aliases, including in the generated public estimator catalogue.
- Extend the catalogue regression baseline to production commit `65f79fc`, preserving every previous model, index and price. Include an already-verified X4 row priced at $731 to prove that shared additions do not overwrite business/runtime pricing or create duplicates.
- Extend desktop/mobile Chromium and WebKit picker tests to select all five X4 indoor aliases and find all five outdoor aliases, without writing quotes or prices.
- Independent review identified a duplicate risk for an existing priced component-pair row. The late-addition check now recognises only these five exact complete X4 pairs using the same punctuation-insensitive keys as rebate aliases, preserving the old model string, index and price key. Reverse aliases let that retained pair resolve to its registered set. Both component orders and slash, hyphen, comma and space separators are tested in both business and verified additions, for both catalogues.
- Run catalogue, quote/price guards, rebate regressions, and a production build before independent review and release. Government eligibility and calculation formulas remain unchanged.

## Live cache regression discovered during release verification

The newly published catalogue was searchable but live metadata GETs for HAWK25KR and HAWK50KR returned `GEMS_MODEL_NOT_FOUND`. Fresh uncached calls to the exact same metadata loader resolved all five correctly. The framework inventory cache used a constant key even though its candidates are classified using catalogue package/component aliases. A previous release's `single` identities could therefore be reused while the new release expected `package` identities.

The cache namespace now includes the generated catalogue's `sourceVersion`, so catalogue changes cannot reuse incompatible classified candidates. Five-minute revalidation, one-hour hard expiry, conflict/eligibility checks, formulas, and response shapes stay unchanged. Regression coverage includes all five X4 canonical/pair lookups, rejection of a lone indoor component, and a persisted old-cache/new-release test that leaves the old cache untouched.

Final candidate verification: the metadata suite, 60 model/postcode/install parity cases, all six TCL registration-estimate tests, 25 browser metadata/outage checks, and the Next.js production build passed.
