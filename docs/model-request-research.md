# Model Request Research

Research is server-side and read-only. It identifies equipment using primary manufacturer sources and independently fetched Australian GEMS records. It cannot change prices, quotes, commissions, business permissions or rebate formulas, publish models, or send email itself.

## Processing

1. The approved user's existing request is saved immediately. PostgreSQL retains the original text, immutable research rounds, notes, replies and activity.
2. The research worker obtains a fenced lease and a monthly budget reservation before making a paid call. Each invocation performs at most one provider round. Complete responses and registry tool results are checkpointed before continuation.
3. A separate step invokes the existing deterministic model verifier against the current request and exact current registration. Only positive certificate results proceed to the existing catalogue publisher, at $0 equipment price. Conflicting or disabled entries are never overwritten.
4. An exact-registration-bound successful zero is a `no_rebate` outcome for the submitted installation, not a global ineligibility statement. Outages and missing data go to review, never to a no-rebate email.
5. The existing Rebate Portal outbox owns clarification, reminders, outcomes and provider idempotency. Different requesters retain separate notifications, even for the same system. Unknown email delivery is held after the provider's safe retry window.

Replies submitted through the request page create a new version. A stale research result cannot publish or enqueue a current-version notification. Explicit human-help/frustration requests retain the immediate administrator alert. Clarification remains capped at three rounds, with reminders after two and five business days and closure after ten business days. Administrator summaries remain weekly, not daily.

## Operations

- Platform Admin > Model requests displays progress, corrected equipment, evidence, outcomes and the monthly budget. Check this page for unresolved research or delivery outcomes.
- `MODEL_RESEARCH_ENABLED=true` enables the new pipeline. Keep it false during staging or maintenance. `MODEL_REQUEST_AUTOMATION_ENABLED` and the existing worker secret must also be configured.
- The dedicated key is `MODEL_RESEARCH_OPENAI_API_KEY`, a production-only Vercel Secret. Never use it outside this ledger or expose it to a browser. No key is required for offline tests.
- Continuations use a fixed calculator origin and an authenticated internal endpoint. The database owns claims, so overlapping invocations cannot make simultaneous paid calls for one job. Existing twice-daily cron passes recover queued work if a continuation could not be acknowledged. Interrupted or possibly billed work is not automatically replayed.
- To disable new processing, set `MODEL_RESEARCH_ENABLED=false` and deploy. Do not clear queues, quotes or the cost ledger. In-flight provider calls may still complete; reservations are retained until auditable settlement.
- Provider or registry outages preserve the completed research for review. Retrying a verified candidate must not discard its research and pay for it again.

## Budget

The application ceiling is A$20 per Sydney calendar month. November 2026 includes A$1.063705 already conservatively accounted in the isolated project's investigations. This seed is applied once and is never reset by deployment. Every paid request reserves its entire supported context, bounded output and bounded searches before sending. Actual usage settles at conservative rates; unknown charges remain reserved. The full-context reservation can pause processing below A$20 spent.

Rates were reviewed on 9 November 2026 against the [official model page](https://developers.openai.com/api/docs/models/gpt-6.1-sol) and [pricing](https://developers.openai.com/api/docs/pricing). Calls fail closed after 9 December 2026 until rates are revalidated. The 2.2 AUD/USD tax/FX allowance is deliberately conservative, not a live exchange rate. This is an application accounting limit, not a provider-account-wide or bank-level spending guarantee. No new hosting subscription is introduced.

## Release And Tests

Apply `supabase/model_request_research_upgrade.sql` only after independent review and isolated database tests. It is additive, does not backfill old requests into paid processing, and leaves automation disabled until configuration is deliberately enabled. Three explicitly approved already-paid artifacts may be restored through the authenticated administrator action; their source hashes and target requests are pinned, and current deterministic verification still runs before any outcome.

```text
node scripts/verify-model-research-agent.mjs
node --experimental-strip-types scripts/verify-model-research-database.mjs
node --experimental-strip-types scripts/verify-model-research-integration.mjs
node --experimental-strip-types scripts/verify-model-request-verification.mjs
node scripts/verify-model-request-workflow.mjs
node scripts/verify-model-research-admin-browser.cjs
```

Database tests use isolated PGlite, not production credentials. They exercise PostgreSQL semantics but serialize statements; final review and staging must also check real multi-session locking. Browser fixtures contain fictional records. Keep checkpoints, request transcripts and private keys out of public artifacts and logs.

For the native contention gate, set `POSTGRES_BIN_DIR` to a trusted PostgreSQL 17 binary directory and run `node scripts/verify-model-research-postgres.mjs`. The runner creates a disposable cluster on a random loopback port, applies the exact migrations, observes distinct sessions and real lock waits, and checks claim/budget/outcome exclusion, concurrent request edits and unknown-charge recovery. It reads no env file, opens no production connection and registers no system service. Its `finally` block stops the cluster and preserves the report, including cleanup failures.
