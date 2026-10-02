import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const [page, styles, migration, backfill, schema, rangeControl, component] = await Promise.all([
  readFile(new URL("../app/admin/users/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  readFile(new URL("../supabase/platform_certificate_value_history.sql", import.meta.url), "utf8"),
  readFile(new URL("../supabase/backfill_certificate_value_history_2026.sql", import.meta.url), "utf8"),
  readFile(new URL("../supabase/schema.sql", import.meta.url), "utf8"),
  readFile(new URL("../app/admin/users/certificate-history-range.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/admin/users/certificate-history.tsx", import.meta.url), "utf8"),
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
assert.match(page, /async function saveAuthoritativePlatformCertificateValues/);
assert.match(page, /async function listPlatformCertificateValueHistory/);
assert.match(component, /The fixed DCCEEW \$30 contract rate is separate/);
assert.match(styles, /\.certificate-current-trends/);
assert.match(styles, /\.certificate-chart-grid/);
assert.match(styles, /\.certificate-history-table-wrap/);
assert.match(component, /Show price history/);
assert.match(component, /Hide price history/);
assert.match(component, /Australia\/Sydney/);
assert.match(component, /role="group"/);
assert.match(component, /aria-live="polite"/);
assert.match(component, /Insufficient history to show a trend/);
assert.match(component, /onKeyDown/);
assert.doesNotMatch(component, /router\.push|fetch\(/);
for (const label of ["Last 4 weeks", "Last 3 months", "Last 6 months", "Last year", "All time"]) {
  assert.ok(rangeControl.includes(label), `Missing range option ${label}`);
}
assert.doesNotMatch(rangeControl, /router\.push|useRouter|useSearchParams/);

const authoritativeWrite = page.indexOf("async function saveAuthoritativePlatformCertificateValues");
const historyRead = page.indexOf("async function listPlatformCertificateValueHistory");
assert.ok(authoritativeWrite > 0 && historyRead > 0, "Current values and history must remain separate paths.");

const helperTests = `
import assert from 'node:assert/strict';
import { certificateHistoryCutoff, certificateHistoryChartPoints, filterCertificateHistory, sortCertificateHistory } from ${JSON.stringify(new URL("../lib/certificate-history.ts", import.meta.url).href)};
const rows = [
  { id: 2, effectiveWeek: '2026-06-01', observedAt: '2026-06-01T00:00:00Z', escSpotPrice: 31, prcSpotPrice: 20, source: 'manual', observedByEmail: '' },
  { id: 1, effectiveWeek: '2026-01-01', observedAt: '2026-01-01T00:00:00Z', escSpotPrice: 30, prcSpotPrice: 19, source: 'manual', observedByEmail: '' },
  { id: 3, effectiveWeek: '2026-09-01', observedAt: '2026-09-01T00:00:00Z', escSpotPrice: 33, prcSpotPrice: 21, source: 'manual', observedByEmail: '' },
];
assert.equal(certificateHistoryCutoff('4w', new Date('2026-10-01T01:00:00Z')), '2026-09-03');
assert.equal(certificateHistoryCutoff('3m', new Date('2026-10-01T01:00:00Z')), '2026-07-01');
assert.deepEqual(filterCertificateHistory(rows, 'all'), rows);
assert.deepEqual(filterCertificateHistory(rows, '6m', new Date('2026-10-01T01:00:00Z')).map(r => r.id), [2,3]);
assert.deepEqual(sortCertificateHistory(rows).map(r => r.id), [1,2,3]);
assert.equal(certificateHistoryChartPoints(rows.slice(0,1), 'escSpotPrice', 640, 230).length, 0);
const points = certificateHistoryChartPoints(sortCertificateHistory(rows), 'escSpotPrice', 640, 230);
assert.ok(points[0].x < points[1].x && points[1].x < points[2].x);
assert.equal(points[0].x, 56);
`;
const helperResult = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", helperTests], {
  encoding: "utf8",
});
assert.equal(helperResult.status, 0, helperResult.stderr || helperResult.stdout || "Helper tests failed");

console.log("Certificate spot-price history verification passed.");
