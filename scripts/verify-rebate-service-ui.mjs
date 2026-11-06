import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const origin = "http://127.0.0.1:43823";
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
});

try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const requests = [];
    let releaseDiagnostic;
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (request.url() === origin + "/") {
        await route.fulfill({ contentType: "text/html", body: html });
      } else if (request.url() === origin + "/api/rebate-service-status") {
        requests.push(request.method());
        await new Promise((resolve) => {
          releaseDiagnostic = async () => {
            try {
              await route.fulfill({ json: {
                available: false,
                code: "certificate_error",
                checkedAt: "2026-11-06T00:00:00.000Z",
              } });
            } finally {
              resolve();
            }
          };
        });
      } else {
        await route.abort();
      }
    });
    await page.addInitScript(() => {
      window.CALCULATOR_USER = { businessOperatingState: "NSW", canSeeOwnerDetails: false, rebatesEnabled: false };
    });
    await page.goto(origin, { waitUntil: "load" });
    await page.evaluate(() => {
      window.CALCULATOR_USER.rebatesEnabled = true;
      render();
      const diagnose = showLiveRebateServiceDetail;
      showLiveRebateServiceDetail = (id) => window.rebateDiagnostic = diagnose(id);
      window.comparisonRefreshes = 0;
      refreshBestValueIndicator = () => { window.comparisonRefreshes++; };
      window.rebateAttempts = [];
      estimateLiveEssRebate = (brand, model) => {
        window.rebateAttempts.push({ brand, model });
        return new Promise((resolve, reject) => { window.finishRebateAttempt = { resolve, reject }; });
      };
    });
    const retry = page.getByRole("button", { name: "Retry rebate" });
    const detail = page.locator("#rebateServiceDetail");
    const amount = page.locator("#certRebateValue");
    const meta = page.locator("#certRebateMeta");
    const busy = () => page.locator("#liveRebatePanel").getAttribute("aria-busy");
    const numeric = () => page.locator("#rebate").inputValue();
    const start = () => page.evaluate(() => {
      window.pendingRebate = refreshLiveRebateForCurrentProduct();
    });
    const reject = (message) => page.evaluate(async (message) => {
      window.finishRebateAttempt.reject(new Error(message));
      await window.pendingRebate;
    }, message);
    const waitForDiagnostic = async () => {
      const deadline = Date.now() + 5000;
      while (!releaseDiagnostic && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(releaseDiagnostic, "Expected a rebate health request");
      const release = releaseDiagnostic;
      releaseDiagnostic = null;
      return async () => {
        await release();
        await page.evaluate(() => window.rebateDiagnostic);
      };
    };

    assert.equal(await retry.isVisible(), false);
    await page.evaluate(() => { $("rebate").value = "125.00"; });
    await start();
    assert.equal(await numeric(), "0.00");
    await reject("Enter a valid 4-digit postcode");
    assert.equal(requests.length, 0);
    assert.equal(await numeric(), "0.00");
    assert.equal(await amount.innerText(), "Unavailable");
    assert.equal(await meta.innerText(), "Rebate unavailable. This is not a confirmed $0 rebate.");
    assert.equal(await meta.isVisible(), true);
    assert.equal(await detail.innerText(), "Enter a valid 4-digit postcode");
    assert.equal(await retry.isVisible(), true);
    assert.equal(await page.locator("#rebateCalcMeta").isVisible(), false);
    assert.equal(await amount.evaluate((el) => el.scrollWidth <= el.clientWidth), true);

    await start();
    await reject("Failed to fetch");
    const completeDiagnostic = await waitForDiagnostic();
    assert.equal(await busy(), "false");
    assert.equal(await retry.isVisible(), true);
    assert.equal(await detail.innerText(), "");
    await completeDiagnostic();
    assert.match(await detail.innerText(), /security certificate issue/);

    await start();
    await reject("Failed to fetch");
    const completeStaleDiagnostic = await waitForDiagnostic();
    await page.evaluate(() => {
      const selector = $("product");
      if (selector.options.length < 2) throw new Error("Expected two test products");
      selector.selectedIndex = 1;
      window.pendingRebate = refreshLiveRebateForCurrentProduct();
    });
    await reject("Incomplete model energy rating data: missing product class");
    const inputDetail = "The selected model is missing required energy rating data.";
    assert.equal(await detail.innerText(), inputDetail);
    await completeStaleDiagnostic();
    assert.equal(await detail.innerText(), inputDetail);

    await retry.click();
    assert.equal(await busy(), "true");
    assert.equal(await retry.isVisible(), false);
    assert.equal(await numeric(), "0.00");
    assert.equal(await page.evaluate(() => {
      const [first, selected, retried] = window.rebateAttempts.slice(-3);
      return first.model !== selected.model && selected.model === retried.model;
    }), true);
    await page.evaluate(() => window.finishRebateAttempt.resolve({
      esc: 0, prc: 0, escRate: 24, prcRate: 2.7, escValue: 0, prcValue: 0, rebate: 0,
    }));
    await page.waitForFunction(() => window.comparisonRefreshes === 1);
    assert.equal(await amount.innerText(), "$0.00");
    assert.equal(await detail.innerText(), "");
    assert.equal(await retry.isVisible(), false);
    assert.equal(await busy(), "false");
    assert.deepEqual([...requests], ["GET", "GET"]);

    await start();
    await reject("HTTP 400 - upstream internals");
    assert.equal(await detail.innerText(), "");
    assert.equal(await retry.isVisible(), true);
    await page.evaluate(() => {
      window.CALCULATOR_USER.rebatesEnabled = false;
      applyRebateSchemeUi();
    });
    assert.equal(await retry.isVisible(), false);
    assert.deepEqual([...requests], ["GET", "GET"]);
    await page.close();
  }
} finally {
  await browser.close();
}

console.log("main rebate outage UI checks passed at desktop and mobile widths");
