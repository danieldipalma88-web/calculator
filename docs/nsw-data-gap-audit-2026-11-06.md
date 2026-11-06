# NSW rebate data-gap audit

Checked 6 November 2026. This report distinguishes missing lookup data from a confirmed zero rebate or an eligibility decision.

## Model results

| Brand | Exact catalogue model | Result |
| --- | --- | --- |
| Braemar | TCHV03T1S / TSHV03T1S | Exact GEMS AAC8855 verified; separator queries repaired. |
| Mitsubishi Electric | SUZ-M25VAD2-A / SEZ-M25DA3 | Exact GEMS AAC9409 verified; audit now matches the full pair returned by component queries. |
| Mitsubishi Electric | SUZ-M35VAD2-A / SEZ-M35DA3 | Exact GEMS AAC9435 verified; same pair-query correction. |
| Hisense | AUD-85UXHT-SET (AUD-85UX4RTH1 / AUW-85U4RK1) | Exact component pair AUW-85U4RK1/AUD-85UX4RTH1 verified; explicit lookup alias removes the package wrapper. |
| Fujitsu General | AOTH24KBTA/ARTH24KHTA | Exact registration verified under the FUJITSU brand; audit brand normalization corrected. |
| Mitsubishi Electric | MUZ-AP80VGD2-A2 / MSZ-AP80VGKD2-A2 | Exact current approved/available Australian GEMS ratings still unverified. No suffix substitution. |
| Samsung | AR30DXFZCWKXSA / AR30DXFZCWKNSA | Exact current approved/available Australian GEMS ratings still unverified. |
| Mitsubishi Electric | PUZ-ZM250YKA-A.TH / PEA-M250LAA.TH | Exact .TH registration still unverified. No substitution of the unsuffixed model. |
| Samsung | AC120TXAPNG/SA / AC120TNHPKG/SA | Exact pair still unverified. AC120TXAPKG/SA / AC120TNHDKG/SA is a different registered pair and was not substituted. |
| Mitsubishi Heavy Industries | FDCA71VNX-W / FDU71VH | Complete current exact registration still unverified. Existing historical fallback is not evidence of current GEMS coverage. |

Five exact registration fixtures, including original rating strings and source URLs, are in `scripts/fixtures/gems-gap-regressions-20261106.json`. Both new and replacement calculations are compared between the browser and server. The same weekly sample changed from 42 passing / 20 untested cases to 50 passing / 12 untested, with no calculation mismatches or infrastructure failures in the final run. The five unresolved original models remain failures of coverage, not successful tests and not confirmed ineligible equipment.

The stricter full-system identity check also exposed one additional entry: **Hisense HAWJ9KR / HS01025**. Current GEMS AAC6350 and the [official Hisense brochure](https://dtc-aus-api.hisense.com/medias/Hisense-Air-Con-Split-Systems-Brochure.pdf) verify HAWJ9KR as a complete set (HAWJ9KR-I / HAWJ9KR-O), but no manufacturer evidence links HS01025 to it. Its two test cases are now correctly untested instead of passing on a partial component match. No unverified alias has been added.

Sources: [GEMS labelled dataset](https://data.gov.au/data/dataset/energy-rating-for-household-appliances/resource/0973a476-eb0c-45e6-9a18-054f74307843), [GEMS non-labelled dataset](https://data.gov.au/data/dataset/energy-rating-for-household-appliances/resource/d4e17a35-9002-4a0c-ac1c-003ece0de135).

## Postcodes

The exact 11 are **2611, 2618, 2619, 2678, 2898, 3691, 4375, 4377, 4380, 4383, 4385**. The pinned government engine returns a zero/missing network factor for these inputs and rejects them; that is not proof of no rebate.

| Postcodes | Required resolution |
| --- | --- |
| 2611, 2618, 3691, 4375, 4377, 4380, 4383, 4385 | Shared state-border postcodes. Verify the actual NSW installation address, distributor and BCA climate zone. A nearby-postcode replacement is unsafe. |
| 2619 | Jerrabomberra: confirmed NSW locality, Cold ESS climate and BCA 7. The missing network factor still requires a verified connection/site recovery path. |
| 2678 | Charles Sturt University / mail-centre postcode. Verify the physical installation building and connection; do not calculate from a locked-bag address. |
| 2898 | Lord Howe Island has its own electricity network; no generic PDRS network factor is published. Separate ESS eligibility review is needed, not a combined default rate. |

No climate, network or eligibility values were invented. The UI explains the missing location verification instead of presenting an unexplained failure. These 11 remain monitored and are not silently removed from the postcode sweep.

The final complete sweep exercised all 622 geographic postcodes: 1,224 calculation cases passed, 22 cases failed for these 11 known location-data gaps, zero infrastructure failures and zero untested cases. Location messages mentioning an electricity network are classified as individual data failures, never as a general network outage that stops the rest of the sweep. This does not establish coverage for mail-only postcodes or every model/site combination.

Sources: [official pinned engine](https://github.com/energy-savings-scheme/openfisca_nsw_safeguard/tree/ae8d778f18e0612bd38c69a2527ff9d7e12d3747), [ESS Rule September 2026, A24/A27](https://www.energysustainabilityschemes.nsw.gov.au/sites/default/files/cm9_documents/Energy-Savings-Scheme-%28Amendment-No.-2%29-Rule-2026.PDF), [PDRS Rule October 2026, A3/A5](https://www.energysustainabilityschemes.nsw.gov.au/sites/default/files/documents/2026-10/Peak-Demand-Reduction-Scheme-Rule-of-2022-12-October-2026.pdf), [ABCB climate map](https://www.abcb.gov.au/abcb-climate-map), [Lord Howe electricity network](https://www.lhib.nsw.gov.au/infrastructure/electricity).

## Safeguards

- Automatic verified backup remains independent of the failed government TLS certificate; certificate validation is never disabled.
- A 15-minute GitHub schedule checks known certificate results on both services, backup browser access, live registered-model search and certificate renewal risk. GitHub scheduling can be delayed; automatic request failover does not wait for a scheduled check.
- A single GitHub incident is assigned to the repository owner on degradation/outage, updated only on a state change and closed after verified recovery. Email delivery follows the owner's GitHub notification settings; this is not a separate email service.
- Weekly all-postcode and rotating-model checks retain unresolved cases. Fixed regression tests cover the five verified pairs and all 11 actionable postcode errors.
- Public standard GitHub runners avoid private-repository Actions charges and no AI tokens are used. Existing hosting/network usage limits still apply. No monitor can guarantee that an external service will never fail.
- No equipment prices, business agreements, saved quotes or payout rates are changed by this release.
