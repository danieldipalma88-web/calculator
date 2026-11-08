import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import handler from "../services/nsw-rebate-backup/api/calculate.mjs";
import { referenceRequest } from "./nsw-backup-probe.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const origin = "https://calculator.rebateportal.com.au";
const backup = "https://rebate-portal-nsw-backup.vercel.app/api/calculate";
const liveBackup = process.argv.includes("--live-backup");
const screenshots = process.argv.includes("--screenshots");
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
const get = (field) => referenceRequest.buildings.building_1[`HVAC1_PDRSAug24_${field}`]["2021-01-01"];
const record = {
  Brand: "FUJITSU GENERAL", Model_No: "AOTG09KMTC/ASTG09KMTC", SubmitStatus: "Approved", "Availability Status": "Available",
  Configuration1: "Non Ducted", Configuration2: "Single Split System", "Product Class": "Class 8", Sold_in: "Australia",
  "C-Total Cool Rated": get("cooling_capacity_input"), "H-Total Heat Rated": get("heating_capacity_input"), "C-Power_Inp_Rated": get("input_power"),
  "Rated AEER": get("rated_AEER_input"), "Rated ACOP": get("rated_ACOP_input"), "Residential TCSPF_mixed": get("TCSPF_mixed"),
  "Residential HSPF_mixed": get("HSPF_mixed"), "Residential HSPF_cold": get("HSPF_cold"),
  "Residential tcec_hot": 452, "Residential tcec_mixed": 155, "Residential tcec_cold": 97,
  "Residential thec_hot": 51, "Residential thec_mixed": 351, "Residential thec_cold": 920,
};
// Synthetic ratings are only for exercising multi-head result rendering locally.
const multiRecord = {
  ...record, Brand: "Rinnai", Model_No: "MON2H05B1LA", Configuration2: "Multi Split System", "Product Class": "Class 19",
  "C-Total Cool Rated": 5.4, "H-Total Heat Rated": 6.5, "C-Power_Inp_Rated": 1.12,
};
if (screenshots) await mkdir(new URL("../outputs/nsw-backup-browser/", import.meta.url), { recursive: true });
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    let backupCalls = 0;
    let backupUnavailable = false;
    const expectSource = async (selector, present) => {
      const source = page.locator(selector);
      if (present) {
        assert.match(await source.innerText(), /Verified NSW backup/);
        assert.equal(await source.isVisible(), true);
        const box = await source.boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, `${selector} fits at ${width}px`);
      } else {
        assert.doesNotMatch(await source.textContent(), /Verified NSW backup/);
      }
    };
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (request.url() === origin + "/") return route.fulfill({ contentType: "text/html", body: html });
      if (new URL(request.url()).hostname === "data.gov.au") return route.fulfill({ json: { success: true, result: { records: [record, multiRecord] } } });
      if (request.url() === backup) {
        backupCalls++;
        if (backupUnavailable) return route.abort();
        if (liveBackup) return route.continue();
        const response = await handler.fetch(new Request(backup, { method: request.method(), headers: request.headers(), body: request.method() === "POST" ? request.postData() : undefined }));
        return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
      }
      return route.abort();
    });
    await page.addInitScript(() => { window.CALCULATOR_USER = { businessOperatingState: "NSW", canSeeOwnerDetails: false, rebatesEnabled: false }; });
    await page.goto(origin, { waitUntil: "load" });
    const result = await page.evaluate(async () => {
      $("brand").value = "Fujitsu General";
      populateProducts({ skipProductChange: true });
      $("product").value = String(data().findIndex((p) => p.model === "AOTG09KMTC/ASTG09KMTC"));
      installType = "new";
      $("essPostcode").value = "2145";
      $("essClimateZone").value = "auto";
      $("essEscRate").value = "23";
      $("essPrcRate").value = "2.6";
      window.CALCULATOR_USER.rebatesEnabled = true;
      const success = await refreshLiveRebateForCurrentProduct();
      return { success, esc: essRuntime.lastEsc, prc: essRuntime.lastPrc, amount: $("rebate").value };
    });
    assert.equal(result.success, true);
    assert.ok(Math.abs(result.esc - 8.61131174) < 1e-9);
    assert.equal(result.prc, 86.646231);
    assert.equal(result.amount, "423.34");
    assert.ok(backupCalls >= 2);
    assert.notEqual(await page.locator("#liveRebatePanel").getAttribute("aria-busy"), "true");
    assert.equal(await page.locator("#rebateCalcMeta").isVisible(), false);
    await expectSource("#certRebateMeta", true);
    const callsBeforeRateEdit = backupCalls;
    await page.evaluate(() => {
      certValues.locked = false;
      $("essEscRate").value = "24";
      $("essEscRate").dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.equal(await page.locator("#rebate").inputValue(), "431.95");
    assert.equal(backupCalls, callsBeforeRateEdit, "Rate-only redraw does not fetch new certificates.");
    await expectSource("#certRebateMeta", true);
    if (screenshots) {
      await page.locator("#liveRebatePanel").scrollIntoViewIfNeeded();
      await page.screenshot({ path: new URL(`../outputs/nsw-backup-browser/fujitsu-${width}.png`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") });
    }

    backupUnavailable = true;
    assert.equal(await page.evaluate(async () => (await refreshLiveRebateForCurrentProduct()) === true), false);
    assert.equal(await page.locator("#certRebateValue").innerText(), "Unavailable");
    assert.equal(await page.evaluate(() => essRuntime.lastCalculationSource), "");
    await expectSource("#certRebateMeta", false);
    backupUnavailable = false;

    if (!liveBackup) {
      await page.evaluate(async (record) => {
        allModelsBrandsLoaded = true;
        setAllModelsSection();
        allModelsSearchRows = [{ brand: record.Brand, model: record.Model_No, productType: "Non Ducted", completeEnergyData: true, metadata: modelMetaFromGemsRecord(record) }];
        selectAllModelsResult(0);
        await calculateAllModelsRebate();
      }, record);
      await expectSource("#allModelsRebateSummary", true);
      backupUnavailable = true;
      await page.evaluate(() => calculateAllModelsRebate());
      await expectSource("#allModelsRebateSummary", false);
      assert.match(await page.locator("#allModelsRebateSummary").innerText(), /could not be completed/);
      backupUnavailable = false;

      await page.evaluate(async (multiRecord) => {
        const outdoor = MULTI_SPLIT_OUTDOORS.find((row) => row.model === multiRecord.Model_No);
        const indoorIndex = ALL_MODELS_MULTI_INDOORS.findIndex((row) => row.model === "HINRPX25M");
        allModelsMultiBrandsLoaded = true;
        allModelsMultiOutdoors = [{ ...outdoor, completeEnergyData: true, metadata: modelMetaFromGemsRecord(multiRecord) }];
        $("allModelsMultiOutdoor").replaceChildren(new Option(outdoor.model, "0"));
        allModelsMultiIndoorSelections = [{ indoorIndex, qty: 2 }];
        setAllModelsMode("multi");
        await calculateAllModelsRebate();
      }, multiRecord);
      await expectSource("#allModelsRebateSummary", true);
      backupUnavailable = true;
      await page.evaluate(() => calculateAllModelsRebate());
      await expectSource("#allModelsRebateSummary", false);
      assert.match(await page.locator("#allModelsRebateSummary").innerText(), /could not be completed/);
      backupUnavailable = false;

      await page.evaluate(async (model) => {
        setMultiSplitSection();
        const outdoorIndex = MULTI_SPLIT_OUTDOORS.findIndex((row) => row.model === model);
        const indoorIndex = ALL_MODELS_MULTI_INDOORS.findIndex((row) => row.model === "HINRPX25M");
        $("multiSplitOutdoor").replaceChildren(new Option(model, String(outdoorIndex)));
        multiSplitIndoorSelections = [{ indoorIndex, qty: 2 }];
        renderMultiSplitTrial();
        await calculateMultiSplitTrialRebate();
      }, multiRecord.Model_No);
      await expectSource("#multiSplitCalculationSource", true);
      assert.equal(await page.locator("#multiSplitTechnicalDetails").getAttribute("open"), null, "Attribution does not require expanding technical details.");
      backupUnavailable = true;
      await page.evaluate(() => calculateMultiSplitTrialRebate());
      await expectSource("#multiSplitCalculationSource", false);
      assert.match(await page.locator("#multiSplitStatus").innerText(), /Rebate unavailable\. This is not a confirmed \$0 rebate/);
    }
    assert.deepEqual(errors, []);
    console.log(`${width}px: ${liveBackup ? "standard" : "all four calculator paths"} show verified backup attribution; rate redraw preserves it, failures clear it`);
    await page.close();
  }
} finally { await browser.close(); }
