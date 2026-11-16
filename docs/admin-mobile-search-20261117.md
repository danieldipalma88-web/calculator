# Platform Admin mobile search

## Diagnosis

Read-only inspection of production found 169 user cards, 26,520 business-assignment
checkboxes and 119,927 DOM elements across the admin page. Every closed assignment
menu built the entire business catalogue. Focusing the directory search also
engaged the edit-order lock, recreating context values and rerendering every
activity label and removal control. Each search character repeated that work.
Date/time and sort operations constructed expensive Intl objects repeatedly.

A local production-React fixture with 169 synthetic users and 156 businesses
reproduced the problem without real account or calculator requests:

| Check | Original | Fixed |
| --- | ---: | ---: |
| Fixture DOM elements | 82,845 | 3,415 |
| Initially mounted assignment checkboxes | 26,364 | 0 |
| Account-control renders on search focus | 338 | 0 |
| Account-control renders when typing Daniel | 2,028 | 0 |

The original 390px Chromium run with 4x CPU throttling took 10.49 seconds to focus
and type Daniel. Fixed runs were approximately 0.3-2.5 seconds under the same
throttling, varying with host load. These are synthetic browser measurements, not
a guarantee for every phone. Raw runs and screenshots are in outputs/admin-search.

## Isolation and preservation

- Runtime changes are limited to the directory, activity label, business picker
  and admin-directory formatting helpers.
- No API, authentication, account data, calculator, catalogue, quote, pricing,
  commission or rebate formula changes; no database migration.
- Unopened pickers submit selected hidden inputs in the original catalogue order,
  preserving the primary-business convention. First opening replaces these with
  the original checkbox controls, which remain mounted thereafter.
- User rows stay mounted across search, sort and activity filters, preserving
  uncontrolled form edits and business-selection state.
- Search focus does not engage the account-edit lock. Open/editing records still
  retain their order during activity refreshes. WebKit's parent-summary focus
  during a nested activity-button tap is excluded without disabling keyboard use.
- Rapid filtering with an expanded card reproduced a stale edit-snapshot race.
  Snapshots now carry their search/sort/activity criteria and cannot mask a newer
  explicit search. Repeated rapid filter/search cycles cover that regression.
- A picker opened before hydration populates on mount without requiring a second
  click. Stable contexts and reused Intl formatters avoid unnecessary work.

## Verification

`node scripts/verify-admin-search-browser.cjs` uses the actual production
components with synthetic data and a local-only server. It tests mobile and
desktop search, clear, sorting, activity filters, polling, edit-order freeze and
release, touch/keyboard use, retained drafts, exact FormData order, delayed
hydration, empty selections, persistence, layout and absence of mutation requests.
Set PLAYWRIGHT_BROWSER=webkit for the Safari-engine run. The browser suite is also
available as verify:admin-search-browser. The DOM-size and zero-extra-render
assertions guard against reintroducing the measured slowdown.

Related admin, user-removal, authentication, quote-sync and won-payment suites
passed. The Next production build and manufacturer route-package checks passed.

Two unrelated legacy performance-suite fixtures cannot currently run to completion:
verify-calculator-performance.mjs omits getDcceewContractMatch from its VM globals;
verify-rebate-settings-refresh.mjs omits Headers. Those scripts and their calculator
subjects are unchanged from the previously deployed f84a96f release. They were
not modified as part of this isolated admin fix.
