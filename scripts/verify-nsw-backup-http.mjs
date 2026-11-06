import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import handler from "../services/nsw-rebate-backup/api/calculate.mjs";
import { createFrontendCalculator } from "./monitor-nsw-postcodes-helpers.mjs";
register("./monitor-nsw-postcodes-loader.mjs", import.meta.url);
const { calculateCurrentNswRebate } = await import("../lib/nsw-hvac-rebate.ts");
const { mapGemsModelSearchItem } = await import("../lib/gems-model-search.ts");
const primary = "https://of-sfg-rac-prd.energy.nsw.gov.au/calculate";
const backup = "https://rebate-portal-nsw-backup.vercel.app/api/calculate";
const origin = "https://calculator.rebateportal.com.au";
const originalRevision = process.env.VERCEL_GIT_COMMIT_SHA;
const originalVercel = process.env.VERCEL;
process.env.VERCEL_GIT_COMMIT_SHA = "a".repeat(40);
const json = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const temperzone = (await json("./fixtures/temperzone-templite-gems.json")).models;
const history = (await json("./fixtures/nsw-certificate-reference-20261028.json")).results;
const fujitsu = {
  Brand: "FUJITSU GENERAL", Model_No: "AOTG09KMTC/ASTG09KMTC", SubmitStatus: "Approved",
  "Availability Status": "Available", Sold_in: "Australia", Configuration1: "Non Ducted", Configuration2: "Single Split System",
  "Registration Number": "AAC8714", ExpDate: "2030-03-31", "Product Class": "Class 8",
  "Cooling Capacity": 2.5, "Heating Capacity": 3.2, "Input Power": 0.53, "Rated AEER": 4.701, "Rated ACOP": 4.8352,
  "Residential TCSPF_mixed": 6.755, "Residential HSPF_mixed": 4.975, "Residential HSPF_cold": 4.548,
  "Residential tcec_hot": 452, "Residential tcec_mixed": 155, "Residential tcec_cold": 97,
  "Residential thec_hot": 51, "Residential thec_mixed": 351, "Residential thec_cold": 920,
};
let registry = temperzone;
let primaryRequests = 0;
let backupRequests = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  if (String(url) === primary) { primaryRequests++; throw new TypeError("fetch failed: CERT_HAS_EXPIRED"); }
  if (String(url) === backup) { backupRequests++; return handler.fetch(new Request(backup, options)); }
  if (new URL(url).hostname === "data.gov.au") return Response.json({ success: true, result: { records: registry } });
  throw new Error(`Unexpected network access: ${url}`);
};
try {
  const frontend = await createFrontendCalculator({ fetch: globalThis.fetch });
  for (const row of history) {
    const record = temperzone.find((item) => item.model === row.model);
    const input = { brand: record.brand, model: row.model, postcode: row.postcode, installType: row.installType, systemType: "ducted", escRate: 1, prcRate: 1 };
    const server = await calculateCurrentNswRebate(input);
    const browser = await frontend.calculate({ ...input, metadata: mapGemsModelSearchItem(record).metadata, airConditionerType: "ducted_single_split_system" });
    for (const actual of [server, browser]) {
      assert.equal(actual.esc, row.esc, `${row.model}/${row.postcode}/${row.installType} ESC`);
      assert.equal(actual.prc, row.prc, `${row.model}/${row.postcode}/${row.installType} PRC`);
      assert.equal(actual.calculationSource, "Verified NSW backup (ae8d778)");
    }
    assert.equal(server.rebate, row.rebate);
  }
  registry = [fujitsu];
  for (const postcode of ["2145", "2170", "2550", "2163"]) {
    const input = { brand: "FUJITSU GENERAL", model: fujitsu.Model_No, postcode, installType: "new", systemType: "split", escRate: 23, prcRate: 2.6 };
    const server = await calculateCurrentNswRebate(input);
    const browser = await frontend.calculate({ ...input, metadata: mapGemsModelSearchItem(fujitsu).metadata, airConditionerType: "non_ducted_single_split_system" });
    assert.equal(server.esc, browser.esc);
    assert.equal(server.prc, browser.prc);
    assert.equal(server.calculationSource, "Verified NSW backup (ae8d778)");
    assert.equal(browser.calculationSource, "Verified NSW backup (ae8d778)");
    assert.ok(server.esc > 0 && server.prc > 0, `Positive verified counts for ${postcode}`);
    if (postcode === "2170") {
      assert.ok(Math.abs(server.esc - 8.61131174) < 1e-12);
      assert.equal(server.prc, 86.646231);
    }
    console.log(`Fujitsu new ${postcode}: ${server.esc} ESC, ${server.prc} PRC, $${server.rebate}`);
  }
  assert.equal(primaryRequests, 2, "One failed primary check per browser/server circuit, not every model.");
  assert.ok(backupRequests > 40);
  const metadata = await handler.fetch(new Request(backup));
  assert.equal(metadata.status, 200);
  assert.equal((await metadata.json()).license, "AGPL-3.0-only");
  assert.ok(metadata.headers.get("Link").includes("services/nsw-rebate-backup"));
  assert.ok(metadata.headers.get("Link").includes(`/tree/${"a".repeat(40)}/`));
  process.env.VERCEL = "1";
  delete process.env.VERCEL_GIT_COMMIT_SHA;
  assert.equal((await handler.fetch(new Request(backup))).status, 503, "Production requires immutable source revision");
  process.env.VERCEL_GIT_COMMIT_SHA = "a".repeat(40);
  const preflight = await handler.fetch(new Request(backup, { method: "OPTIONS", headers: { Origin: origin } }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), origin);
  assert.equal((await handler.fetch(new Request(backup, { headers: { Origin: "https://unapproved.example" } }))).status, 403);
  assert.equal((await handler.fetch(new Request(backup, { method: "DELETE" }))).status, 405);
  assert.equal((await handler.fetch(new Request(backup, { method: "POST", body: "{}" }))).status, 415);
  const request = (body) => new Request(backup, { method: "POST", body, headers: { "Content-Type": "application/json", Origin: origin } });
  assert.equal((await handler.fetch(request(" ".repeat(16385)))).status, 413);
  assert.equal((await handler.fetch(request("{bad-json"))).status, 422);
  assert.equal((await handler.fetch(request('{"rebate":1000}'))).status, 422);
  console.log("HTTP integration: 20 historical browser/server matches; failing Fujitsu case; 2550 recovery; CORS, limits, source offer and rejection checks passed.");
} finally {
  globalThis.fetch = originalFetch;
  if (originalRevision === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
  else process.env.VERCEL_GIT_COMMIT_SHA = originalRevision;
  if (originalVercel === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = originalVercel;
}
