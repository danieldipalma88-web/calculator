# NSW Postcode Rebate Safeguard

The safeguard checks postcode resolution and real rebate calculations without
changing quotes, certificate prices, business settings, or product prices.

The baseline inventory comes from ABS NSW Postal Areas plus ABS-listed
cross-border areas. It is checked against the current NSW Spatial Services
suburb boundary service, independently of the rebate service's successful
lookups. On 8 September 2026 both sources identified the same 622 geographic
postcodes. These are installation locations; mail-only postcodes such as PO-box
codes are not a list of installation sites. The live inventory refresh includes
new government-listed codes without silently dropping baseline coverage.

## Running It

```sh
node scripts/verify-postcode-monitor.mjs
node scripts/monitor-nsw-postcodes.mjs --output=postcode-report.json --summary=postcode-report.md
```

Use Node.js 24. No npm install or production credentials are needed.

For a focused check:

```sh
node scripts/monitor-nsw-postcodes.mjs --postcodes=2550,2549,2000 --output=postcode-report.json --summary=postcode-report.md
```

A focused run is not evidence that the full postcode inventory passed. A failed
or incomplete sweep exits unsuccessfully and reports what was not checked.

Every geographic postcode is checked with a known eligible split system for
both new installation and replacement, comparing the browser's calculation
helpers with the server calculation using the same current GEMS product data.
Ducted new/replacement controls also exercise the 2550 recovery path. This is
postcode coverage monitoring, not an audit of every model or multi-head
combination, nor a guarantee that every product is rebate-eligible.

## Automatic Checks

`.github/workflows/nsw-postcode-safeguard.yml` runs every Monday at 06:17 AEST
(07:17 AEDT), after relevant changes on `main`, and on manual dispatch. Pull
requests run the offline checks. GitHub may delay scheduled runs during busy
periods; this is periodic monitoring, not a continuous availability guarantee.

Read each run's summary in the repository's **Actions** tab. Detailed JSON is
included in its log. Failed runs identify postcodes/scenarios needing attention;
they must not be treated as a reason to insert invented rebate values or to
silently remove postcodes from the inventory.

To receive failure notifications, enable GitHub Actions email or web notifications
in the GitHub account's notification settings and select failed workflows only.
GitHub sends scheduled-run notifications to the account that last changed the
schedule. This workflow does not send customer email or require email credentials.

## Cost And Access

The calculator repository is public. Standard GitHub-hosted runners are free for
public repositories. The workflow uses a standard Ubuntu runner and read-only
repository access, no AI, no paid monitoring service, no production credentials,
and no billable report-artifact uploads. It calls the existing public NSW/GEMS
services from the runner rather than making thousands of requests to Vercel.
The job is disabled automatically if the repository becomes private, to avoid
consuming paid private-repository minutes.

GitHub disables scheduled workflows in public repositories after 60 days without
repository activity. If the repository becomes inactive, re-enable this workflow
from Actions before relying on its schedule. No keepalive commits are generated.

Sources:

- [GitHub Actions billing](https://docs.github.com/en/actions/concepts/billing-and-usage)
- [Scheduled workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [Workflow notifications](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs)
