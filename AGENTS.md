# Calculator Workflows

## Business-specific product price updates

Use this workflow when a request changes product prices for one business only. These are live data changes, not shared catalogue code changes.

1. Do not edit the product prices in `index.html`. That changes the shared catalogue and can affect other businesses.
2. Prepare one JSON request containing the exact database business name, `priceBasis` (`ex_gst` or `inc_gst`), and all requested models and prices.
3. Generate a guarded SQL transaction with `scripts/generate-business-price-update-sql.mjs`.
4. Review the generated ex-GST to inc-GST conversion table before execution.
5. Run the single transaction in the authenticated Supabase SQL Editor. It must abort unless the business name matches exactly once and every model matches exactly once.
6. Check the transaction's read-back result contains every requested model, the expected inc-GST value, and `locked = true`.
7. Reload the target calculator once and spot-check the updated prices. Do not switch through unrelated businesses when the SQL target and read-back checks pass.
8. Do not commit or deploy to GitHub or Vercel for a data-only price update.

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

The browser Price Manager is a fallback only when the SQL Editor is unavailable. For more than one model, do not use row-by-row browser editing unless the guarded transaction cannot be used.
