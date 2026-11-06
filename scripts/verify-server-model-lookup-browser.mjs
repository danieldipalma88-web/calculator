import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const playwrightPath = process.env.PLAYWRIGHT_MODULE_PATH;
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
assert.ok(playwrightPath, "Set PLAYWRIGHT_MODULE_PATH to the installed Playwright module.");
assert.ok(chromiumPath, "Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to the local Chromium executable.");
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const html = await readFile(resolve(root, "index.html"), "utf8");
const fixture = JSON.parse(await readFile(resolve(root, "scripts/fixtures/gems-gap-regressions-20261106.json"), "utf8"));
const item = fixture.models.find((model) => model.brand === "Fujitsu General");
assert.ok(item, "The fixed Fujitsu GEMS fixture is present.");
const origin = "http://server-model-lookup.test";
const quoteKey = "installerMasterQuoteLogV1";
const sentinelQuote = [{ id: "offline-test", model: "SENTINEL-QUOTE", unitPriceInc: 1234, rebate: 0 }];
const writeDiagnostics = process.env.WRITE_DIAGNOSTICS !== "0";
const meta = (record = item.record) => ({
  brand: record.Brand,
  model: record.Model_No,
  "Product Type": record.Configuration1,
  "Product Class": record["Product Class"],
  Configuration2: record.Configuration2,
  "Cooling Capacity": record["C-Total Cool Rated"],
  "Heating Capacity": record["H-Total Heat Rated"],
  "Input Power": record["C-Power_Inp_Rated"],
  "Rated AEER": record["Rated AEER"],
  "Rated ACOP": record["Rated ACOP"],
  "Residential TCSPF_cold": record["Residential TCSPF_cold"] ?? record["Residential TCSPF_mixed"],
  "Residential TCSPF_mixed": record["Residential TCSPF_mixed"],
  "Residential TCSPF_hot": record["Residential TCSPF_hot"] ?? record["Residential TCSPF_mixed"],
  "Residential HSPF_cold": record["Residential HSPF_cold"],
  "Residential HSPF_mixed": record["Residential HSPF_mixed"],
  "Residential HSPF_hot": record["Residential HSPF_hot"] ?? record["Residential HSPF_mixed"],
  "Residential tcec_cold": record["Residential tcec_cold"],
  "Residential tcec_mixed": record["Residential tcec_mixed"],
  "Residential tcec_hot": record["Residential tcec_hot"],
  "Residential thec_cold": record["Residential thec_cold"],
  "Residential thec_mixed": record["Residential thec_mixed"],
  "Residential thec_hot": record["Residential thec_hot"],
});
const validPayload = () => {
  const verifiedAt = Date.now();
  return { schemaVersion: 1, brand: item.record.Brand, model: item.model, meta: meta(), verifiedAt, expiresAt: verifiedAt + 3_600_000 };
};
const mhiBrand = "Mitsubishi Heavy Industries";
const mhiFullPair = "FDCA71VNX-W / FDU71VH";
const mhiPayload = (overrides = {}) => {
  const verifiedAt = Date.now();
  const model = overrides.model || mhiFullPair;
  const brand = overrides.brand || mhiBrand;
  const modelMeta = { ...meta(), brand, model, "Product Type": "Ducted", "Product Class": "Class 10" };
  if (overrides.metaBrand) modelMeta.brand = overrides.metaBrand;
  if (overrides.metaModel) modelMeta.model = overrides.metaModel;
  return { schemaVersion: 1, brand, model, meta: modelMeta, verifiedAt, expiresAt: verifiedAt + 3_600_000 };
};
const calcResponse = (request) => {
  const building = request.buildings.building_1;
  const values = {};
  for (const [field, periods] of Object.entries(building)) {
    const [date, input] = Object.entries(periods)[0];
    values[field] = { [date]: input !== null ? input : field.includes("get_climate_zone_by_postcode") ? "mixed" : field.includes("BCA_climate_zone_by_postcode") ? "5" : 1 };
  }
  return { buildings: { building_1: values }, persons: { person1: {} } };
};

const tests = [];
const testFailures = [];
const summary = { runtime: process.version, fixture: { brand: item.brand, model: item.model, registrationId: item.record["Registration Number"] }, scope: "synthetic transport/UI only; no financial-accuracy claim", tests };
const browser = await chromium.launch({ executablePath: chromiumPath });
let currentTest = null;

async function pageFor(scenario) {
  const startedAt = performance.now();
  const selectedBrand = scenario.brand || item.brand;
  const selectedModel = scenario.model || item.model;
  const selectedSystemType = scenario.systemType || "split";
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const requests = [];
  const externalCalls = [];
  let metadataBehavior = scenario.metadataBehavior || "ok";
  let holdMetadata = null;
  let releaseHeldMetadata = null;
  if (scenario.holdMetadata) holdMetadata = new Promise((resolve) => { releaseHeldMetadata = resolve; });

  await page.addInitScript(({ quoteKey, sentinelQuote }) => {
    localStorage.setItem(quoteKey, JSON.stringify(sentinelQuote));
    window.CALCULATOR_USER = { businessOperatingState: "NSW", canSeeOwnerDetails: false, rebatesEnabled: false };
  }, { quoteKey, sentinelQuote });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Expose-Headers": "X-NSW-Calculation-Source",
    };
    const fulfill = (options) => route.fulfill({ ...options, headers: { ...cors, ...(options.headers || {}) } });
    const requestBody = request.postData() || "";
    const purpose = /HVAC1_PDRSAug24_(?:ESC_calculation|electricity_savings|peak_demand_reduction_capacity|PRC_calculation)/.test(requestBody) ? "certificate" : requestBody.includes("HVAC1_PDRSAug24_PDRS__postcode") ? "postcode" : "other";
    requests.push({ url: url.href, method: request.method(), purpose });
    if (url.origin !== origin) externalCalls.push(url.hostname);
    if (url.origin !== origin && request.method() === "OPTIONS") return fulfill({ status: 204, body: "" });
    if (url.origin === origin && url.pathname === "/") return fulfill({ status: 200, contentType: "text/html", body: html });
    if (url.origin === origin && url.pathname === "/api/gems-model-metadata") {
      if (scenario.holdMetadata) {
        await holdMetadata;
        metadataBehavior = "ok";
      }
      if (metadataBehavior === "hang") return new Promise(() => {});
      if (metadataBehavior === "503") return fulfill({ status: 503, json: { code: "GEMS_UNAVAILABLE", error: "fixture unavailable" } });
      if (metadataBehavior === "notfound") return fulfill({ status: 404, json: { code: "GEMS_MODEL_NOT_FOUND" } });
      if (metadataBehavior === "conflict") return fulfill({ status: 409, json: { code: "GEMS_MODEL_CONFLICT" } });
      if (metadataBehavior === "incomplete") return fulfill({ status: 422, json: { code: "GEMS_MODEL_INCOMPLETE" } });
      if (metadataBehavior === "rejected") return fulfill({ status: 422, json: { code: "GEMS_MODEL_REJECTED" } });
      if (metadataBehavior === "unreadable422") return fulfill({ status: 422, body: "unparseable fixture body" });
      if (metadataBehavior === "toshibaOutdoorOnly") {
        const payload = mhiPayload({ brand: "Toshiba", model: "RAS-07E2AVG-A" });
        return fulfill({ status: 200, json: payload });
      }
      if (["mhiPair", "mhiWrongBrand", "mhiWrongComponent", "mhiWrongModel", "mhiBadIdentity", "mhiBadSchema", "mhiRejected"].includes(metadataBehavior)) {
        const payload = metadataBehavior === "mhiWrongBrand"
          ? mhiPayload({ brand: "Mitsubishi Electric" })
          : metadataBehavior === "mhiWrongComponent"
            ? mhiPayload({ model: "FDCA71VNX-W / FDU71VH-OTHER" })
            : metadataBehavior === "mhiWrongModel"
              ? mhiPayload({ model: "NEIGHBOUR-MODEL" })
              : metadataBehavior === "mhiBadIdentity"
                ? mhiPayload({ metaBrand: "Other Brand" })
                : mhiPayload();
        if (metadataBehavior === "mhiBadSchema") payload.schemaVersion = 99;
        if (metadataBehavior === "mhiRejected") return fulfill({ status: 422, json: { code: "GEMS_MODEL_REJECTED" } });
        return fulfill({ status: 200, json: payload });
      }
      const payload = validPayload();
      if (metadataBehavior === "wrongmodel") payload.model = "NEIGHBOUR-MODEL";
      if (metadataBehavior === "identityConflict") payload.meta.model = "NEIGHBOUR-MODEL";
      if (metadataBehavior === "badBrand") { payload.brand = "Mitsubishi Electric"; payload.meta.brand = "Mitsubishi Electric"; }
      if (metadataBehavior === "badIdentity") payload.meta.brand = "Other Brand";
      if (metadataBehavior === "badSchema") payload.schemaVersion = 99;
      return fulfill({ status: 200, json: payload });
    }
    if (url.origin === origin && url.pathname === "/api/gems-model-search") return fulfill({ json: { brands: [item.brand], models: [] } });
    if (url.origin === origin && url.pathname === "/api/rebate-service-status") return fulfill({ json: { available: false, code: "unavailable" } });
    if (url.origin === origin && url.pathname === "/api/calculator-guidance") return fulfill({ status: 200, json: {} });
    if (url.hostname === "of-sfg-rac-prd.energy.nsw.gov.au" && url.pathname === "/calculate") return route.abort("failed");
    if (url.hostname === "rebate-portal-nsw-backup.vercel.app" && url.pathname === "/api/calculate") {
      if (scenario.backupBlocked) return fulfill({ status: 503, body: "fixture backup blocked" });
      return fulfill({ status: 200, headers: { "X-NSW-Calculation-Source": "OpenFisca-ae8d778-HVAC1_PDRSAug24" }, json: calcResponse(JSON.parse(request.postData() || "{}")) });
    }
    return route.abort();
  });
  await page.goto(origin, { waitUntil: "load" });
  await page.evaluate(({ brand, model, selectedType }) => {
    window.CALCULATOR_USER.rebatesEnabled = true;
    product = () => ({ brand, model, capacity: "2.5kW", capacityNum: 2.5, unitPriceInc: 777, rebate: 0, series: "fixed browser fixture" });
    systemType = selectedType;
    installType = "new";
    $("essPostcode").value = "2213";
    $("essClimateZone").value = "auto";
    $("essEscRate").value = "23";
    $("essPrcRate").value = "2.6";
    $("unitPriceInc").value = "777.00";
  }, { brand: selectedBrand, model: selectedModel, selectedType: selectedSystemType });
  await page.evaluate(({ quoteKey, sentinelQuote }) => localStorage.setItem(quoteKey, JSON.stringify(sentinelQuote)), { quoteKey, sentinelQuote });
  const baseline = await page.evaluate((key) => ({ price: $("unitPriceInc")?.value, quoteStorage: localStorage.getItem(key) }), quoteKey);
  return {
    page,
    requests,
    externalCalls,
    baseline,
    get metadataRequests() { return requests.filter((request) => new URL(request.url).pathname === "/api/gems-model-metadata").length; },
    elapsedMs: () => Math.round(performance.now() - startedAt),
    requestCounts: () => ({
      metadata: requests.filter((request) => new URL(request.url).pathname === "/api/gems-model-metadata").length,
      primaryPostcode: requests.filter((request) => new URL(request.url).hostname === "of-sfg-rac-prd.energy.nsw.gov.au" && request.method === "POST" && request.purpose === "postcode").length,
      primaryCertificate: requests.filter((request) => new URL(request.url).hostname === "of-sfg-rac-prd.energy.nsw.gov.au" && request.method === "POST" && request.purpose === "certificate").length,
      backupPostcode: requests.filter((request) => new URL(request.url).hostname === "rebate-portal-nsw-backup.vercel.app" && request.method === "POST" && request.purpose === "postcode").length,
      backupCertificate: requests.filter((request) => new URL(request.url).hostname === "rebate-portal-nsw-backup.vercel.app" && request.method === "POST" && request.purpose === "certificate").length,
      browserRegistryOrEstimator: externalCalls.filter((host) => ["data.gov.au", "estimator-sfg-rac-prd.energy.nsw.gov.au"].includes(host)).length,
    }),
    releaseHeldMetadata: () => releaseHeldMetadata?.(),
    setMetadataBehavior: (value) => { metadataBehavior = value; },
    async startLookup() {
      return page.evaluate(async ({ brand, model }) => refreshLiveRebateForCurrentProduct(), { brand: item.brand, model: item.model });
    },
    async state() {
      return page.evaluate((quoteKey) => ({
        retryVisible: $("retryLiveRebate")?.hidden === false,
        message: $("certRebateMeta")?.textContent || "",
        savedGemsFallback: $("rebateCalcMeta")?.textContent.includes("Saved GEMS fallback + NSW formula") || false,
        detail: $("rebateServiceDetail")?.textContent || "",
        spinner: liveRebateLoading || $("liveRebatePanel")?.getAttribute("aria-busy") === "true",
        source: essRuntime.lastCalculationSource || "",
        price: $("unitPriceInc")?.value,
        quoteStorage: localStorage.getItem(quoteKey),
        saveBusy: !!window.__calculatorSaveInFlight,
      }), quoteKey);
    },
    async payloadValidation() {
      return page.evaluate(({ payload, expectedBrand, expectedModel }) => ({
        brandMatch: new Set(rebateLookupBrandCandidates(expectedBrand).map(normalizeLookup)).has(normalizeLookup(payload.brand)),
        modelMatch: new Set(rebateLookupModelSearchCandidates(expectedModel).map(normalizeLookup)).has(normalizeLookup(payload.model)),
        metaBrandMatch: normalizeLookup(payload.meta.brand) === normalizeLookup(payload.brand),
        metaModelMatch: normalizeLookup(payload.meta.model) === normalizeLookup(payload.model),
        usable: isUsableModelMeta(payload.meta),
        verifiedAtValid: Number.isFinite(payload.verifiedAt) && payload.verifiedAt <= Date.now() + 60000,
        expiresAtValid: Number.isFinite(payload.expiresAt) && payload.expiresAt > Date.now() && payload.expiresAt > payload.verifiedAt && payload.expiresAt - payload.verifiedAt <= 3600000,
      }), { payload: validPayload(), expectedBrand: item.brand, expectedModel: item.model });
    },
    async close() { await page.close(); },
  };
}

function check(name, details = {}) {
  tests.push({ name, result: "passed", elapsedMs: currentTest.elapsedMs(), requestCounts: currentTest.requestCounts(), ...details });
}

try {
  // Healthy server metadata with public lookups blocked and primary TLS failing.
  {
    const test = await pageFor({ name: "healthy" });
    currentTest = test;
    await test.startLookup();
    const state = await test.state();
    assert.equal(test.metadataRequests, 1);
    assert.ok(test.requests.some((request) => request.url.includes("rebate-portal-nsw-backup.vercel.app/api/calculate")), JSON.stringify({ message: state.message.replace(/\$\s*[\d,.]+/g, "[amount omitted]"), detail: state.detail, source: state.source }));
    assert.equal(state.source, "Verified NSW backup (ae8d778)", JSON.stringify({ validation: await test.payloadValidation(), message: state.message.replace(/\$\s*[\d,.]+/g, "[amount omitted]"), detail: state.detail }));
    assert.equal(state.retryVisible, false);
    assert.equal(state.spinner, false);
    assert.equal(state.price, test.baseline.price);
    assert.equal(state.quoteStorage, test.baseline.quoteStorage);
    assert.deepEqual(test.externalCalls.filter((host) => ["data.gov.au", "estimator-sfg-rac-prd.energy.nsw.gov.au"].includes(host)), []);
    check("server metadata success + primary TLS failure + verified backup", { outcome: "success", metadataRequests: 1, primary: "failed as injected", backup: "verified source shown", systemPriceUnchanged: true, savedQuoteUnchanged: true, browserRegistryFanout: 0 });
    await test.close();
  }

  // Server outage must not trigger browser-side registry/estimator fanout; retry recovers.
  {
    const test = await pageFor({ metadataBehavior: "503" });
    currentTest = test;
    await test.startLookup();
    let state = await test.state();
    assert.equal(state.retryVisible, true);
    assert.match(state.message, /not a confirmed \$0 rebate/i);
    assert.match(state.detail, /temporarily unavailable/i);
    assert.equal(state.spinner, false);
    assert.equal(test.metadataRequests, 1);
    assert.deepEqual(test.externalCalls.filter((host) => ["data.gov.au", "estimator-sfg-rac-prd.energy.nsw.gov.au"].includes(host)), []);
    assert.doesNotMatch(state.detail, /security certificate issue/i);
    assert.equal(state.price, test.baseline.price);
    assert.equal(state.quoteStorage, test.baseline.quoteStorage);
    test.setMetadataBehavior("ok");
    await test.page.evaluate(() => { refreshBestValueIndicator = async () => {}; });
    await test.page.evaluate(() => $("retryLiveRebate").click());
    await test.page.waitForFunction(() => $("retryLiveRebate")?.hidden === true && !liveRebateLoading, null, { timeout: 5000 });
    state = await test.state();
    assert.equal(test.metadataRequests, 2);
    assert.equal(state.retryVisible, false);
    assert.match(state.message, /Verified NSW backup/);
    assert.equal(state.price, test.baseline.price);
    assert.equal(state.quoteStorage, test.baseline.quoteStorage);
    check("metadata 503, no browser registry fanout, retry recovery", { outcome: "fail-closed then recovered", metadataRequests: 2, browserRegistryFanout: 0, loadingCleared: true, unrelatedCertificateDiagnosis: false, systemPriceUnchanged: true, savedQuoteUnchanged: true });
    await test.close();
  }

  // Server-declared and payload identity/rating failures all remain unavailable.
  for (const [behavior, expected] of [["notfound", /could not be found/i], ["conflict", /conflicting registered model data/i], ["incomplete", /missing required energy rating/i], ["wrongmodel", /could not be verified/i], ["identityConflict", /could not be verified/i], ["badSchema", /could not be verified/i]]) {
    const test = await pageFor({ metadataBehavior: behavior });
    currentTest = test;
    await test.startLookup();
    const state = await test.state();
    assert.equal(state.retryVisible, true, behavior);
    assert.match(state.message, /not a confirmed \$0 rebate/i, behavior);
    assert.match(state.detail, expected, behavior);
    assert.equal(state.spinner, false, behavior);
    assert.doesNotMatch(state.detail, /security certificate issue/i, behavior);
    assert.equal(test.metadataRequests, 1, behavior);
    assert.equal(state.price, test.baseline.price, behavior);
    assert.equal(state.quoteStorage, test.baseline.quoteStorage, behavior);
    assert.equal(test.requests.some((request) => request.purpose === "certificate"), false, behavior);
    check(`metadata validation ${behavior}`, { outcome: "unavailable", metadataRequests: 1, calculationRequests: 0, systemPriceUnchanged: true, savedQuoteUnchanged: true });
    await test.close();
  }

  // A curated exact MHI fallback remains available on a typed registry 404; an unlisted model does not.
  {
    const mhiBrand = "Mitsubishi Heavy Industries";
    const mhiModel = "FDCA71VNX-W / FDU71VH";
    const test = await pageFor({ brand: mhiBrand, model: mhiModel, metadataBehavior: "notfound" });
    currentTest = test;
    await test.startLookup();
    const state = await test.state();
    assert.equal(test.metadataRequests, 1);
    assert.equal(state.retryVisible, false);
    assert.equal(state.spinner, false);
    assert.equal(state.savedGemsFallback, true);
    assert.match(state.message, /Verified NSW backup/);
    assert.equal(state.price, test.baseline.price);
    assert.equal(state.quoteStorage, test.baseline.quoteStorage);
    check("MHI curated local metadata fallback on server 404", { outcome: "saved fallback used", metadataRequests: 1, systemPriceUnchanged: true, savedQuoteUnchanged: true });
    await test.close();
  }

  // Existing MHI local metadata must not mask a malformed success or authoritative rejection.
  for (const behavior of ["mhiWrongModel", "mhiBadIdentity", "mhiBadSchema", "mhiRejected"]) {
    const test = await pageFor({ brand: mhiBrand, model: mhiFullPair, systemType: "ducted", metadataBehavior: behavior });
    currentTest = test;
    await test.startLookup();
    const state = await test.state();
    assert.equal(test.metadataRequests, 1, behavior);
    assert.equal(state.retryVisible, true, behavior);
    assert.equal(state.spinner, false, behavior);
    assert.equal(state.savedGemsFallback, false, behavior);
    assert.match(state.message, /not a confirmed \$0 rebate/i, behavior);
    assert.match(state.detail, /could not be verified/i, behavior);
    assert.equal(test.requests.some((request) => request.purpose === "certificate"), false, behavior);
    assert.equal(state.price, test.baseline.price, behavior);
    assert.equal(state.quoteStorage, test.baseline.quoteStorage, behavior);
    check(`MHI local metadata does not mask ${behavior}`, { outcome: "unavailable without local fallback", metadataRequests: 1, certificateCalculationRequests: 0, systemPriceUnchanged: true, savedQuoteUnchanged: true });
    await test.close();
  }

  // The package alias may resolve to its registered full pair only under the same catalogue brand.
  {
    const packageModel = "FDU71AVNXWVH";
    const test = await pageFor({ brand: mhiBrand, model: packageModel, systemType: "ducted", metadataBehavior: "mhiPair" });
    currentTest = test;
    await test.startLookup();
    const state = await test.state();
    const metadataUrl = new URL(test.requests.find((request) => new URL(request.url).pathname === "/api/gems-model-metadata").url);
    try {
      assert.equal(metadataUrl.searchParams.get("model"), packageModel);
      assert.equal(state.retryVisible, false);
      assert.equal(state.spinner, false);
      assert.equal(state.source, "Verified NSW backup (ae8d778)");
      assert.equal(state.price, test.baseline.price);
      assert.equal(state.quoteStorage, test.baseline.quoteStorage);
      check("MHI package alias accepts the exact registered full pair", { outcome: "accepted", requestModel: packageModel, responseModel: mhiFullPair, metadataRequests: 1, systemPriceUnchanged: true, savedQuoteUnchanged: true });
    } catch (error) {
      testFailures.push({ name: "MHI package alias accepts the exact registered full pair", message: error.message, retryVisible: state.retryVisible, detail: state.detail });
      tests.push({ name: "MHI package alias accepts the exact registered full pair", result: "failed", elapsedMs: test.elapsedMs(), requestCounts: test.requestCounts(), detail: state.detail });
    }
    await test.close();
  }
  for (const behavior of ["mhiWrongBrand", "mhiWrongComponent"]) {
    const test = await pageFor({ brand: mhiBrand, model: "FDU71AVNXWVH", systemType: "ducted", metadataBehavior: behavior });
    currentTest = test;
    await test.startLookup();
    const state = await test.state();
    assert.equal(test.metadataRequests, 1, behavior);
    assert.equal(state.retryVisible, true, behavior);
    assert.equal(state.savedGemsFallback, false, behavior);
    assert.match(state.message, /not a confirmed \$0 rebate/i, behavior);
    assert.match(state.detail, /could not be verified/i, behavior);
    assert.equal(test.requests.some((request) => request.purpose === "certificate"), false, behavior);
    assert.equal(state.price, test.baseline.price, behavior);
    assert.equal(state.quoteStorage, test.baseline.quoteStorage, behavior);
    check(`MHI package alias rejects ${behavior}`, { outcome: "unavailable", metadataRequests: 1, certificateCalculationRequests: 0, systemPriceUnchanged: true, savedQuoteUnchanged: true });
    await test.close();
  }

  {
    const test = await pageFor({ brand: mhiBrand, model: "FDU71AVNXWV", systemType: "ducted", metadataBehavior: "mhiPair" });
    currentTest = test;
    await test.startLookup();
    const state = await test.state();
    assert.equal(test.metadataRequests, 1);
    assert.equal(state.retryVisible, true);
    assert.equal(state.savedGemsFallback, false);
    assert.match(state.message, /not a confirmed \$0 rebate/i);
    assert.match(state.detail, /could not be verified/i);
    assert.equal(test.requests.some((request) => request.purpose === "certificate"), false);
    assert.equal(state.price, test.baseline.price);
    assert.equal(state.quoteStorage, test.baseline.quoteStorage);
    check("MHI package alias missing trailing H is rejected", { outcome: "unavailable", metadataRequests: 1, certificateCalculationRequests: 0, systemPriceUnchanged: true, savedQuoteUnchanged: true });
    await test.close();
  }

  // A paired Toshiba request must not accept a component-only registry row as a system.
  {
    const pair = "RAS-07E2AVG-A/RAS-07E2KVG-A";
    const test = await pageFor({ brand: "Toshiba", model: pair, systemType: "split", metadataBehavior: "toshibaOutdoorOnly" });
    currentTest = test;
    await test.startLookup();
    const state = await test.state();
    assert.equal(test.metadataRequests, 1);
    assert.equal(state.retryVisible, true);
    assert.equal(state.savedGemsFallback, false);
    assert.match(state.message, /not a confirmed \$0 rebate/i);
    assert.match(state.detail, /could not be verified/i);
    assert.equal(test.requests.some((request) => request.purpose === "certificate"), false);
    assert.equal(state.price, test.baseline.price);
    assert.equal(state.quoteStorage, test.baseline.quoteStorage);
    check("Toshiba paired request rejects outdoor-only 200 response", { outcome: "unavailable", requestedModel: pair, responseModel: "RAS-07E2AVG-A", certificateCalculationRequests: 0, systemPriceUnchanged: true, savedQuoteUnchanged: true });
    await test.close();
  }

  // An unreadable 422 is a typed invalid response, not a missing-record fallback.
  {
    const test = await pageFor({ brand: mhiBrand, model: mhiFullPair, systemType: "ducted", metadataBehavior: "unreadable422" });
    currentTest = test;
    await test.startLookup();
    const state = await test.state();
    assert.equal(test.metadataRequests, 1);
    assert.equal(state.retryVisible, true);
    assert.equal(state.savedGemsFallback, false);
    assert.match(state.message, /not a confirmed \$0 rebate/i);
    assert.match(state.detail, /could not be verified/i);
    assert.equal(test.requests.some((request) => request.purpose === "certificate"), false);
    assert.equal(state.price, test.baseline.price);
    assert.equal(state.quoteStorage, test.baseline.quoteStorage);
    check("unreadable 422 does not activate local fallback", { outcome: "unavailable without local fallback", metadataRequests: 1, certificateCalculationRequests: 0, systemPriceUnchanged: true, savedQuoteUnchanged: true });
    await test.close();
  }
  {
    const test = await pageFor({ brand: "Mitsubishi Heavy Industries", model: "FDCA71VNX-W / UNLISTED-FDU71VH", metadataBehavior: "notfound" });
    currentTest = test;
    await test.startLookup();
    const state = await test.state();
    assert.equal(test.metadataRequests, 1);
    assert.equal(state.retryVisible, true);
    assert.equal(state.spinner, false);
    assert.equal(state.savedGemsFallback, false);
    assert.match(state.message, /not a confirmed \$0 rebate/i);
    assert.match(state.detail, /could not be found/i);
    assert.equal(test.requests.some((request) => request.purpose === "certificate"), false);
    assert.equal(state.price, test.baseline.price);
    assert.equal(state.quoteStorage, test.baseline.quoteStorage);
    check("unlisted MHI model rejected on server 404", { outcome: "unavailable", metadataRequests: 1, certificateCalculationRequests: 0, systemPriceUnchanged: true, savedQuoteUnchanged: true });
    await test.close();
  }

  // Shorten only the app's 10 s model-metadata deadline; the route never resolves.
  {
    const test = await pageFor({ metadataBehavior: "hang" });
    currentTest = test;
    await Promise.race([test.page.evaluate(async () => {
      const native = window.setTimeout.bind(window);
      window.setTimeout = (fn, ms, ...args) => native(fn, ms === 10_000 ? 30 : ms, ...args);
      await refreshLiveRebateForCurrentProduct();
    }), new Promise((_, reject) => setTimeout(() => reject(new Error("Bounded hang test exceeded 2 s")), 2000))]);
    const state = await test.state();
    assert.equal(test.metadataRequests, 1);
    assert.equal(state.retryVisible, true);
    assert.equal(state.spinner, false);
    assert.match(state.message, /not a confirmed \$0 rebate/i);
    assert.match(state.detail, /temporarily unavailable/i);
    assert.equal(state.price, test.baseline.price);
    assert.equal(state.quoteStorage, test.baseline.quoteStorage);
    check("hung server metadata bounded timeout", { outcome: "timed out and failed closed", spinnerCleared: true, metadataRequests: 1, systemPriceUnchanged: true, savedQuoteUnchanged: true });
    await test.close();
  }

  // A cancelled comparison subscriber must not abort the selected-unit shared request.
  {
    const test = await pageFor({ holdMetadata: true });
    currentTest = test;
    const started = await test.page.evaluate(async () => {
      const context = { systemType: "split", installType: "new" };
      const climate = Promise.resolve({ postcode: "2213", climateZone: "mixed", bcaZone: "BCA_Climate_Zone_5" });
      const selected = estimateLiveEssRebate(product().brand, product().model, context, climate);
      window.__selectedLookupPromise = selected;
      const controller = new AbortController();
      const comparison = estimateLiveEssRebate(product().brand, product().model, context, climate, controller.signal);
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.abort(new Error("comparison cancelled"));
      let comparisonResult = "pending";
      try { await comparison; comparisonResult = "unexpected success"; }
      catch { comparisonResult = "cancelled"; }
      return { comparisonResult, selectedPending: true };
    });
    assert.equal(started.comparisonResult, "cancelled");
    await test.page.waitForFunction(() => window.__selectedLookupPromise !== undefined, null, { timeout: 1000 });
    assert.equal(test.metadataRequests, 1);
    test.releaseHeldMetadata();
    await test.page.evaluate(async () => { await window.__selectedLookupPromise; });
    assert.equal(test.metadataRequests, 1);
    check("comparison cancellation preserves selected shared lookup", { outcome: "comparison cancelled; selected lookup completed", sharedMetadataRequests: 1, underlyingRequestAborted: false });
    await test.close();
  }

  // The browser cache is valid before expiry and refetches after its bounded TTL.
  {
    const test = await pageFor({ metadataBehavior: "ok" });
    currentTest = test;
    await test.page.evaluate(async () => {
      await estimateLiveEssRebate(product().brand, product().model, { systemType: "split", installType: "new" });
      window.__originalDateNow = Date.now;
    });
    assert.equal(test.metadataRequests, 1);
    await test.page.evaluate(async () => {
      await estimateLiveEssRebate(product().brand, product().model, { systemType: "split", installType: "new" });
      Date.now = () => window.__originalDateNow() + 301_000;
      try { await estimateLiveEssRebate(product().brand, product().model, { systemType: "split", installType: "new" }); }
      finally { Date.now = window.__originalDateNow; }
    });
    assert.equal(test.metadataRequests, 2);
    const state = await test.state();
    assert.equal(state.price, test.baseline.price);
    assert.equal(state.quoteStorage, test.baseline.quoteStorage);
    check("metadata cache hit then expiry/refetch", { outcome: "one initial fetch; cache hit; second fetch after 301 s", metadataRequests: 2, systemPriceUnchanged: true, savedQuoteUnchanged: true });
    await test.close();
  }

  const output = resolve(root, "outputs/diagnostics/server-model-lookup-browser.json");
  summary.result = testFailures.length ? "failed" : "passed";
  if (testFailures.length) summary.failures = testFailures;
  if (writeDiagnostics) {
    await mkdir(resolve(root, "outputs/diagnostics"), { recursive: true });
    await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }
  if (testFailures.length) {
    console.error(JSON.stringify({ passed: tests.filter((test) => test.result === "passed").length, failed: testFailures }, null, 2));
    throw new Error(testFailures.map((failure) => `${failure.name}: ${failure.message}`).join("\n"));
  }
  console.log(`Server model lookup browser checks passed (${tests.length} checks).${writeDiagnostics ? ` Evidence: ${output}` : ""}`);
} catch (error) {
  summary.result = "failed";
  summary.failure = { name: error?.name || "Error", message: error?.message || String(error), stack: String(error?.stack || "").split("\n").slice(0, 5).join("\n") };
  if (writeDiagnostics) {
    const output = resolve(root, "outputs/diagnostics/server-model-lookup-browser.json");
    await mkdir(resolve(root, "outputs/diagnostics"), { recursive: true });
    await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }
  throw error;
} finally {
  await browser.close();
}
