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
