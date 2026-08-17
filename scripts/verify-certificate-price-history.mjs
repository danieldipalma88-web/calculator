import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [page, styles, migration, backfill, schema, rangeControl] = await Promise.all([
  readFile(new URL("../app/admin/users/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  readFile(new URL("../supabase/platform_certificate_value_history.sql", import.meta.url), "utf8"),
  readFile(new URL("../supabase/backfill_certificate_value_history_2026.sql", import.meta.url), "utf8"),
  readFile(new URL("../supabase/schema.sql", import.meta.url), "utf8"),
  readFile(new URL("../app/admin/users/certificate-history-range.tsx", import.meta.url), "utf8"),
]);

assert.match(migration, /create table if not exists public\.platform_certificate_value_history/i);
assert.match(migration, /after insert or update of esc_spot_price, prc_spot_price, source, updated_at/i);
assert.match(migration, /on conflict \(effective_week, esc_spot_price, prc_spot_price, source\) do nothing/i);
assert.match(migration, /using \(\(select public\.is_approved_admin\(\)\)\)/i);
assert.match(migration, /grant select, insert on public\.platform_certificate_value_history to authenticated/i);
assert.doesNotMatch(migration, /grant[^;]*(update|delete)[^;]*platform_certificate_value_history/i);
assert.equal((backfill.match(/::timestamptz/g) || []).length, 12, "Expected 12 verified weekly email observations.");
assert.match(backfill, /on conflict \(effective_week, esc_spot_price, prc_spot_price, source\) do nothing/i);

assert.match(schema, /create table if not exists public\.platform_certificate_value_history/i);
assert.match(page, /\.from\("platform_certificate_value_history"\)/);
assert.match(page, /View price history/);
assert.match(page, /The fixed DCCEEW \$30 contract rate is separate/);
assert.match(page, /metric="escSpotPrice"/);
assert.match(page, /metric="prcSpotPrice"/);
assert.match(page, /certificateHistoryRangeLabel/);
assert.match(rangeControl, /Last 4 weeks/);
assert.match(rangeControl, /Last 3 months/);
assert.match(rangeControl, /Last 6 months/);
assert.match(rangeControl, /Last year/);
assert.match(rangeControl, /All time/);
assert.match(styles, /\.certificate-current-trends/);
assert.match(styles, /\.certificate-chart-grid/);
assert.match(styles, /\.certificate-history-table-wrap/);

const authoritativeWrite = page.indexOf("async function saveAuthoritativePlatformCertificateValues");
const historyRead = page.indexOf("async function listPlatformCertificateValueHistory");
assert.ok(authoritativeWrite > 0 && historyRead > 0, "Current values and history must remain separate paths.");

console.log("Certificate spot-price history verification passed.");
