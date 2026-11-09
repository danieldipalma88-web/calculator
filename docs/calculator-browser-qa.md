# Calculator browser QA

Run with Node 24 and the repository's installed dependencies.

- `npm run qa:calculator` starts a loopback-only calculator. Open the printed URL in the Codex browser to explore manually. The server resets on exit.
- `npm run verify:calculator-qa` starts its own disposable servers and runs the repeatable browser suite. Install Playwright 1.62.1 and the corresponding browser binaries, or set `PLAYWRIGHT_MODULE_PATH` and `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` for a bundled Chromium runtime.
- When only bundled Node is on PATH, run `node scripts/qa-calculator-server.mjs` or `node scripts/verify-calculator-qa.mjs` directly.
- `QA_BROWSER=webkit` selects the installed WebKit browser. This is not a test on an actual Apple device.
- Replay a run with its `QA_SEED`, `QA_STEPS`, and browser. `QA_WIDTHS` takes comma-separated widths; `QA_SCENARIO` can limit the run to `quote`, `rebate`, `access`, or `multi-outage`, or a comma-separated list.
- Reports go to `outputs/calculator-qa/<browser>/report.json`, with a screenshot and Playwright trace for each failure. Set `QA_OUTPUT_DIR` to keep a run separate.

## Isolation and coverage

The test server runs the actual calculator HTML, raw bootstrap, and calculator-data handlers. A restricted, in-memory Data API fixture backs the real Supabase query client. Test sessions and catalogue responses are fixtures; real authentication, Postgres/RLS, hosting, and live rebate availability are not covered. It does not use production credentials, send email, or contact external rebate services. The browser runner also blocks non-loopback requests. Test data and report artifacts are fictional.

The quote journey uses UI clicks and desktop drag/drop, including a large compressed history, repeated moves, undo, retries, a conflicting change from a separate tab, removal, and reloading. It checks exact persisted fields and option totals. The rebate journey uses controlled rates, the locally executed backup engine, a historical split reference, a pinned ducted reference, synthetic multi-head ratings, and outages. These are not live market-rate or eligibility checks. Access checks cover the two fixture accounts, not a production permissions audit.

## Exploratory probes

Run with `QA_PROBE=1` and optionally `QA_SCENARIO=pending-rebate` or `QA_SCENARIO=multi-outage`. Set a separate `QA_OUTPUT_DIR` to retain both reports.

The multi-head outage regression is now in the default suite. With two HINRPX25M heads on MON2H05B1LA at postcode 2550, it asserts that failed and pending calculations block every add control. It also checks that an obsolete response cannot re-enable quoting, a successful zero remains valid, manual rebate edits survive late responses, and saved quote values and prices do not change.

On mobile, the floating actions hide when the current quote workspace is in view. The quote journey places a move handle at the old overlap position and verifies it can receive pointer input without manually centring the card.

The GitHub Actions workflow uses the same suite for relevant pull requests and pushes to `main`, with shorter event runs and longer weekly runs. It takes effect only after it is merged and enabled in the repository. It uses no AI calls or production credentials.

## Response transport safeguards

`npm run verify:transfer-next` builds and starts an isolated production Next.js app with pass-through middleware and synthetic HTML/JSON responses larger than 5 MB. It tests compression negotiation, exact UTF-8 content, private no-store headers and HEAD requests. The fixture has no calculator credentials and is deleted afterwards.

`node scripts/verify-large-save-roundtrip-browser.mjs` tests large quote histories in Chromium, or WebKit with `QA_BROWSER=webkit`, at desktop and mobile widths. It simulates the observed hosting fault by removing any origin encoding header and applying Brotli at the edge. The route must supply raw UTF-8; manually gzipping first would leave binary bytes after browser decoding. It also tests compressed uploads, reloads and outage recovery without changing the saved fixture prices or rebates. Both browser engines run this check in the weekly browser workflow; the production Next.js fixture runs in quote-save safeguards.

Local Next.js alone did not reproduce the hosting header replacement. After a response-transport release, also check the authenticated deployed `/calculator/raw` and `/api/calculator-data` responses: browser-decoded bodies must be HTML and JSON, not gzip bytes (`1f 8b`). Use read-only checks and report metadata only, never private account content. Verify a large history on the actual host before claiming the hosting-size limit is covered.
