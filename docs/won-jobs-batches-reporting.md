# Won Jobs batches and sales reporting

## Batch records

- A payment request, agency payment receipt, or commission payout batch records the entire selection (1 to 50 quotes), including already-recorded statuses. These are admin status actions, not transfers or proof of payment.
- Earlier per-quote timestamps cannot identify historical selections. Admins can save a named manual group from known quotes, including recovered backups, without changing any payment status.
- Reopening a batch filters Won Quotes to its original identities and selects the available quotes. Unavailable identities stay in history and are not replaced with similar jobs. Report, backup, and history-page navigation clears transient selections.
- Recovered backups are payment read-only. Mixed payment selections containing a recovered quote are rejected before any payment change. Existing single-quote payment and reset endpoints also reject recovered backups.

## Payment safeguards and limits

- Stable job IDs use the calculator owner ID (or legacy email), salesperson email, option ID and won timestamp. A separate review fingerprint binds the source, owner, salesperson, win, payment state, and quote values shown for the action. The server compares it before creating a payment batch and again on the final snapshot read before the existing compare-and-swap. An unrelated update to the same owner's snapshot does not by itself invalidate the review.
- No payment write starts until the authorized admin's batch intent is stored. Duplicate submission tokens never replay writes. Definitive failures do not prevent other jobs from being processed; a lost payment acknowledgement or outcome-write failure stops the remaining work. Reconcile any unconfirmed statuses against the current quotes before trying again. The intent and each outcome are durable, but the existing snapshot write and its outcome append are separate database operations.
- Recording a different payment status preserves existing times and actors, including legacy snapshot fields. An explicit reset keeps a fence against older flags in saved copies, including after a new status is recorded.
- History is an admin-authored log. Authorized admins can append outcomes to their own batch records under RLS; it is not independent evidence of a transfer. Read the current quote for its current recorded status.

## Weekly report

The report uses current canonical Won Quotes, grouped by salesperson email, and excludes recovered backups. A unique resolved Daniel Parisotto is the default; otherwise select a salesperson. Business memberships are not used to assign or split sales. Last week is the last completed Monday-to-Sunday week; last month is the previous calendar month. Custom ranges are inclusive through today, with a maximum of 366 days.

The report uses Australia/Sydney won dates. Invalid dates are excluded and counted. Empty weeks appear as zero; missing saved amounts are marked incomplete, not treated as zero. Each row compares the same weekdays in the prior week, which may extend outside the selected range. Salesperson commission earned uses the saved payable amount regardless of payout status; it is distinct from the selection's unpaid commission. Customer revenue and agency amounts include GST, installer profit excludes GST, and salesperson commission includes GST where applicable.

## Setup and verification

- The additive schema is [won_job_batches_upgrade.sql](../supabase/won_job_batches_upgrade.sql). It creates one table, its index, policies, and validation trigger; it does not change existing calculator data or access policies. No database column is needed for the review fingerprint.
- Apply only after independent review. The app fails closed on new bulk payment actions and manual saves if batch storage is unavailable.
- Run `node scripts/verify-won-reporting.mjs` and `node scripts/verify-won-reporting-integration.mjs` plus the existing Won Quote payment, commission, and durability verifiers.
- `WonSalesReport` accepts `WonReportJob[]`, a salesperson directory, Sydney today, backup/unavailable flags and an optional query. `WonBatchHistory` accepts deterministic `WonBatch[]`, current job IDs, an optional active batch, and pagination flags. Both render without database calls. In a browser fixture, the group button dispatches `admin:reopen-won-batch` with the exact IDs; the page runtime performs the selection.
