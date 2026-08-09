# Calculator Agent Guide

## Purpose

This repository powers the live air-conditioning quote calculator at
`https://calculator.rebateportal.com.au`.

Treat calculator accuracy, business separation, saved quote durability, and
mobile usability as core requirements. Do not make unrelated refactors.

## System Boundaries

- `index.html` contains the shared calculator UI, shared catalogue, and core
  calculation logic.
- The Next.js app provides authentication, API routes, server-side validation,
  admin pages, and Supabase integration.
- Supabase holds live business, user, saved quote, payment, and business-level
  configuration data.
- Vercel deploys code pushed to `main`.
- A data-only change normally does not require a GitHub commit or Vercel
  deployment.

## Decide the Change Type First

Before editing, classify the request:

1. **Shared code or shared catalogue**
   - Affects all applicable businesses.
   - Requires code changes, focused tests, a production build, commit, push,
     and live deployment verification.

2. **One-business product price update**
   - Must not edit the shared catalogue in `index.html`.
   - Use a business-specific price override in Supabase.
   - No deploy is required.

3. **Business-wide install defaults**
   - Includes labour, materials, power/electrician, default pricing
     agreements, and business-specific settings.
   - Update only the selected business's shared configuration.
   - Never modify another business as part of a lookup or verification.

4. **Saved quotes, won jobs, payments, or users**
   - These are live operational records.
   - Preserve existing data and enforce server-side validation where relevant.

## Business Separation

- Never assume a change for one business should affect another.
- Confirm the exact business name and target scope before updating data.
- Do not edit shared catalogue pricing when the request names one business.
- Do not change a business's models, prices, default costs, rebates, or
  commission settings while working on another business.
- Verify the target workspace after a business-specific update.

## Business-Specific Product Price Updates

Use this workflow for one-business model price changes:

1. Prepare one JSON request with the exact business name, price basis
   (`ex_gst` or `inc_gst`), models, and prices.
2. Generate guarded SQL with
   `scripts/generate-business-price-update-sql.mjs`.
3. Review the GST conversion table before execution.
4. Run the transaction in the authenticated Supabase SQL Editor.
5. The transaction must abort unless the business and every model match exactly
   once.
6. Confirm the read-back result has every requested model, expected inc-GST
   price, and `locked = true`.
7. Reload only the target business and spot-check the result.
8. Do not commit or deploy for this data-only update.

Example request:

```json
{
  "businessName": "Example Air",
  "priceBasis": "ex_gst",
  "prices": [
    { "model": "OUTDOOR-25 / INDOOR-25", "price": 700 }
  ]
}
```

Generate the SQL using the bundled Node runtime when `node` is not on `PATH`:

```powershell
& "C:\Users\danie\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" scripts\generate-business-price-update-sql.mjs request.json update.sql
```

Use the browser Price Manager only for a small fallback update when guarded SQL
is unavailable. For many models, do not use row-by-row browser editing.

## GST and Cost Rules

- Unit prices and materials are displayed and stored as **including GST**.
- Labour and power/electrician costs are **excluding GST**.
- Clearly state the basis before changing or reporting a value.
- When adjusting quote totals, preserve the correct calculation fields for
  split systems, ducted systems, and multi-head split systems.
- Power must show as a dollar value or `$0.00`; never show `N/A`.
- A current-quote total adjustment applies only to the systems in that quote,
  never to default pricing or other quotes.

## NSW Rebate Rules

- NSW ESS/PDRS rebates apply only to NSW businesses and eligible products.
- Queensland businesses must not show or calculate NSW rebates.
- If a rebate cannot be calculated or verified, return **zero**. Never fall
  back to a default rebate.
- Preserve decimal certificate values. Do not round certificate counts down.
- Do not change eligibility, GEMS data, postcode/climate-zone handling, or
  formula logic without an authoritative source and comparison testing.
- For an Electric Future comparison, test the exact brand, model, postcode,
  install type, certificate price, and date/rule context.
- When investigating a discrepancy, report findings before changing the live
  calculator unless the user explicitly asks for the fix.

## Multi-Head Split Systems

- Capacity for rebate calculation is based on:
  - outdoor capacity when connected indoor capacity is greater than outdoor
    capacity;
  - combined indoor capacity when it is lower than outdoor capacity.
- Keep indoor-head limits, equipment pricing, rebates, and saved quote state
  consistent.
- Do not add cooling-only models when the request excludes them.
- Test new, replacement, capacity, and no-rebate cases before releasing
  multi-head changes.

## Saved Quotes and Won Jobs

- Never silently replace or discard systems already saved in a quote.
- Maintain durable quote synchronisation and deletion tombstones.
- A won job must be server-side validated with:
  - a Google-selected installation address; and
  - a proposed installation date.
- Do not allow missing address/date records to be marked won.
- Won quotes are locked. Unlocking must return the quote to the user's normal
  calculator and remove it from the Won Quotes list.
- Permanent deletion must require a clear irreversible warning.
- Payment requested, paid in, and paid out are separate states. Do not treat
  one as another.

## Permissions and Visibility

- Salespeople must not see hidden commission percentages or agency profit.
- Platform admins and authorised business owners may see agency profit after
  salesperson commission, including GST.
- Admin preview must be clearly distinguished from the user's normal view.
- When opening another person's calculator, start in their normal view and
  provide an explicit admin-preview option.
- Locked users must not be able to access or modify calculator data.

## Authentication and External Services

- Support Google sign-in and email-code sign-in for approved users.
- Do not regress Google OAuth redirects, custom-domain redirects, or Safari
  sign-in behaviour.
- Test authentication changes on mobile Safari as well as desktop.
- Google address lookup must use the approved server-side integration; do not
  expose credentials in client code.
- Treat Google Maps, Places, Supabase, Vercel, and GitHub configuration as
  production infrastructure. Change only what the task requires.

## UI and Mobile Standards

- Test meaningful UI changes on desktop and mobile portrait layouts.
- Prevent horizontal page dragging and clipped controls on mobile.
- Keep controls aligned, compact, and readable. Avoid uneven card layouts.
- Use the product language consistently: call customer groupings **Quotes**,
  not Options.
- Preserve clear loading feedback for every slow save, unlock, payment, export,
  or admin action.
- A loading state must always clear on success or failure. Never leave the
  user on a permanent spinner.
- Do not hide essential actions behind unnecessary expansion or scrolling.

## Testing and Release

For a code change:

1. Inspect the relevant existing code and tests before editing.
2. Add or update a focused regression check for the changed behaviour.
3. Run the relevant verifier scripts, for example:
   - `verify:rebates`
   - `verify:quote-sync`
   - `verify:loading`
   - `verify:power-circuit`
   - `verify:admin`
   - `verify:auth`
   - `verify:price-updates`
4. Run the production build using the bundled Node runtime if `node` is not on
   `PATH`.
5. Review `git diff --check` and keep the change narrowly scoped.
6. Commit with a clear message, push `main`, and allow Vercel to deploy.
7. Confirm the production calculator responds, then verify the changed flow
   where practical.
8. Do not commit generated `next-env.d.ts` churn caused only by a build.

## Working Style

- Read before editing.
- Prefer the existing architecture and patterns over new abstractions.
- Use structured data and guarded transactions instead of manual bulk edits.
- Give concise progress updates during longer work.
- Do not claim a change is complete until it is saved, verified, and deployed
  when deployment is required.
- Preserve unrelated user changes and never use destructive Git commands.
