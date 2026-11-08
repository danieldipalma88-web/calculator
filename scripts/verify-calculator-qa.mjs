import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startCalculatorQa, qaModels, qaRates } from "./qa-calculator-server.mjs";

const { chromium, webkit } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
const engine = process.env.QA_BROWSER || "chromium";
assert.ok(["chromium", "webkit"].includes(engine), "QA_BROWSER must be chromium or webkit");
const browser = await (engine === "webkit" ? webkit : chromium).launch({
  executablePath: engine === "chromium" ? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH : undefined,
});
const output = resolve(process.env.QA_OUTPUT_DIR || "outputs/calculator-qa", engine);
const seed = Number(process.env.QA_SEED || "46323");
const steps = Number(process.env.QA_STEPS || "12");
assert.ok(Number.isSafeInteger(seed) && Number.isSafeInteger(steps) && steps >= 1 && steps <= 150);
const report = { browser: engine, seed, steps, passed: [], failures: [] };
const widths = (process.env.QA_WIDTHS || "1440,390").split(",").map(Number);
const inputPostcode = async (page, id, code) => {
  const field = page.locator(id);
  await field.fill("");
  await field.pressSequentially(code);
  await field.press("Tab");
};
async function waitFor(read, description, ms = 10000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await read()) return;
    await delay(50);
  }
  throw new Error("Timed out: " + description);
}
const textIs = (page, selector, value, state = "visible") => page.locator(selector).filter({ hasText: value }).waitFor({ state });
async function clickCentred(locator) {
  await locator.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
  await locator.click();
}
const quoteBody = (page) => page.locator("#currentOptionBody");
const rowCard = (page, id) => quoteBody(page).locator(`[data-row-id="${id}"]`);
const option = (page, id) => quoteBody(page).locator(`section[data-option-id="${id}"]`);
const financials = (row) => Object.fromEntries([
  "model", "postcode", "install", "unitInc", "rebate", "finalInc", "labour", "materialsInc", "netProfit", "salespersonCommissionInc", "commissionInc",
].map((key) => [key, row[key]]));
const amounts = (page) => Promise.all(["#escCertCount", "#prcCertCount", "#certRebateValue"].map((id) => page.locator(id).textContent()));
async function openPage(qa, width, role = "admin") {
  const context = await browser.newContext({ viewport: { width, height: width > 500 ? 1550 : 860 }, hasTouch: width < 500, serviceWorkers: "block" });
  await context.route("**/*", (route) => new URL(route.request().url()).origin === qa.origin ? route.continue() : route.abort());
  if (role === "sales") await context.addCookies([{ name: "qa-role", value: role, url: qa.origin }]);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  return { page, context, errors };
}
async function loadPage(page, qa) {
  await page.goto(qa.origin);
  await page.getByRole("heading", { name: "Master Quote Calculator" }).waitFor();
}
async function addStandard(page, qa, { name, destination, rebate, role = "admin" } = {}) {
  const before = qa.snapshot(role).rows.map((row) => row.id);
  await page.locator('#standardCalculatorSection button[onclick="addToQuote()"]').click();
  if (name) {
    await page.locator("#quoteNameModalInput").fill(name);
    await page.locator("#quoteNameModalSubmit").click();
  }
  await waitFor(() => qa.snapshot(role).rows.length === before.length + 1, "system durably added");
  const row = qa.snapshot(role).rows.find(({ id }) => !before.includes(id));
  if (destination) assert.equal(row.optionId, destination, "System saved to the selected alternative");
  if (rebate !== undefined) assert.equal(row.rebate, rebate, "The selected rebate reached the saved quote");
  return row;
}
async function createOption(page, qa, name) {
  const before = qa.snapshot().options.length;
  await quoteBody(page).getByRole("button", { name: "+ Add option", exact: true }).click();
  await page.locator("#quoteNameModalInput").fill(name);
  await page.locator("#quoteNameModalSubmit").click();
  if (qa.faults.delaySaveMs) {
    await page.locator("#quoteChoiceProgress[open]").waitFor();
    assert.equal(qa.snapshot().options.length, before, "Delayed save does not claim success early");
  }
  await textIs(page, "#quoteChoicesStatus", "Option saved.");
  const stored = qa.snapshot().options.find((item) => item.quoteOptionName === name);
  assert.ok(stored, "An option shown as saved exists on the server");
  return stored.id;
}
async function chooseMove(page, id, target) {
  await rowCard(page, id).locator(".quoteDragHandle").click();
  await page.locator("#quoteChoiceMoveTarget").selectOption(target);
  await page.locator("#quoteChoiceMoveDialog").getByRole("button", { name: "Move system", exact: true }).click();
}
async function confirmMove(page, qa, row, target) {
  await option(page, target).locator(`[data-row-id="${row.id}"]`).waitFor();
  await page.locator("#quoteChoiceProgress[open]").waitFor({ state: "hidden" });
  const stored = qa.snapshot().rows.find(({ id }) => id === row.id);
  assert.equal(stored.optionId, target);
  assert.deepEqual(financials(stored), financials(row), "Moving a system must not reprice it");
  assert.equal(await rowCard(page, row.id).count(), 1, "System appears in just one option");
}
function assertTotals(qa, ids) {
  const rows = qa.snapshot().rows;
  assert.equal(new Set(rows.map(({ id }) => id)).size, rows.length, "No duplicated systems");
  assert.ok(rows.every(({ optionId }) => ids.includes(optionId)), "No orphaned systems");
  return Object.fromEntries(ids.map((id) => [id, rows.filter(({ optionId }) => optionId === id)
    .reduce((total, { finalInc }) => total + Math.round(finalInc * 100), 0) / 100]));
}
const money = (n) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(n);

async function quoteJourney(page, qa, width) {
  await loadPage(page, qa);
  await inputPostcode(page, "#essPostcode", "2170");
  assert.equal(Number(await page.locator("#essEscRate").inputValue()), qaRates.esc);
  assert.equal(Number(await page.locator("#essPrcRate").inputValue()), qaRates.prc);
  const expected = Number((8.61131174 * qaRates.esc + 86.646231 * qaRates.prc).toFixed(2));
  await textIs(page, "#certRebateValue", money(expected));
  assert.deepEqual(await amounts(page), ["8.611", "86.646", "$423.34"]);
  const original = await addStandard(page, qa, { name: "QA Quote Journey", rebate: expected });
  assert.equal(original.postcode ?? original.state.postcode, "2170");
  assert.ok(qa.events.some((event) => event.type === "save" && event.encoding?.endsWith("+gzip")), "Large history used real compressed save transport");
  assert.equal(JSON.parse(qa.snapshot().raw.installerSavedQuoteSetsV1)[0].quotes[0].notes.length, 1400000);
  qa.faults.delaySaveMs = 650;
  const alt = await createOption(page, qa, "QA Alternative");
  qa.faults.delaySaveMs = 0;
  const third = await createOption(page, qa, "QA Mix");
  const ids = [original.optionId, alt, third];
  await option(page, alt).locator(".quoteChoiceSelect").click();
  await page.locator("#replacementBtn").click();
  await waitFor(async () => (await page.locator("#certRebateMeta").innerText()).includes("replacement"), "replacement rebate is ready");
  const second = await addStandard(page, qa, { destination: alt });
  assert.notEqual(second.rebate, original.rebate, "New/replacement use different rebates");
  assert.equal(qa.snapshot().rows.length, 2);
  if(width < 500) {
    const handle = rowCard(page, second.id).locator(".quoteDragHandle");
    await handle.evaluate((element) => {
      const box = element.getBoundingClientRect();
      window.scrollBy({ top: box.top - (innerHeight - 42), behavior: "instant" });
    });
    await page.locator("#standardFloatingActionBar").waitFor({ state: "hidden" });
    await waitFor(() => handle.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    }), "The bottom-positioned move handle is not covered by the floating actions");
    await page.screenshot({ path: resolve(output, "mobile-quote-controls.png") });
  }

  if (width > 500) {
    const target = option(page, third).locator(".quoteChoiceList");
    await rowCard(page, second.id).locator(".quoteDragHandle").dragTo(target);
    await confirmMove(page, qa, second, third);
  } else {
    await chooseMove(page, second.id, third);
    await confirmMove(page, qa, second, third);
  }
  await quoteBody(page).getByRole("button", { name: "Undo move", exact: true }).click();
  await confirmMove(page, qa, second, alt);

  // Start the same reproducible sequence on each browser and viewport.
  let random = seed >>> 0;
  const next = (count) => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % count; };
  for (let i = 0; i < steps; i++) {
    const row = [original, second][next(5) % 2];
    const current = qa.snapshot().rows.find(({ id }) => id === row.id).optionId;
    const choices = ids.filter((id) => id !== current);
    const target = choices[next(7) % choices.length];
    await chooseMove(page, row.id, target);
    await confirmMove(page, qa, row, target);
  }

  for (const [fault, code] of [["saveUnavailable", 503], ["signedOut", 401]]) {
    const before = qa.snapshot().rows;
    const eventStart = qa.events.length;
    const current = before.find(({ id }) => id === second.id).optionId;
    const target = ids.find((id) => id !== current);
    qa.faults[fault] = true;
    await chooseMove(page, second.id, target);
    const retry = quoteBody(page).getByRole("button", { name: "Retry save", exact: true });
    await retry.waitFor({ timeout: 23000 });
    assert.deepEqual(qa.snapshot().rows, before, "Unconfirmed move did not alter stored quote rows");
    assert.equal(await page.locator("#quoteChoiceProgress[open]").count(), 0, "Save error clears the progress dialog");
    assert.ok(qa.events.slice(eventStart).some((event) => event.type === "save" && event.status === code && event.writes === 0));
    qa.faults[fault] = false;
    await retry.click();
    await confirmMove(page, qa, second, target);
  }

  qa.faults.dropNextArrangeAck = true;
  const target = ids.find((id) => id !== qa.snapshot().rows.find(({ id }) => id === original.id).optionId);
  await chooseMove(page, original.id, target);
  await quoteBody(page).getByRole("button", { name: "Retry save", exact: true }).click();
  await confirmMove(page, qa, original, target);
  const lost = qa.events.find((event) => event.committed);
  assert.ok(lost?.saveId && lost.writes === 1, "The test lost the acknowledgement after one write");
  const replays = qa.events.filter((event) => event.saveId === lost.saveId && event.status === 200);
  assert.equal(replays.length, 1, "Retry reused the same mutation ID");
  assert.equal(replays[0].writes, 0, "Receipt replay did not write the move again");

  const stale = await openPage(qa, width);
  try {
    await loadPage(stale.page, qa);
    await textIs(stale.page, "#currentOptionTitle", "QA Quote Journey");
    await stale.page.waitForFunction(() => window.__calculatorCanRefresh?.() === true, null, { timeout: 20000 });
    const eventStart = qa.events.length;
    const destination = ids.find((id) => id !== target);
    await chooseMove(page, original.id, destination);
    await confirmMove(page, qa, original, destination);
    const staleDestination = ids.find((id) => id !== target && id !== destination);
    const loadLatest = stale.page.getByRole("button", { name: "Load latest options", exact: true });
    if (!await loadLatest.isVisible()) {
      try { await chooseMove(stale.page, original.id, staleDestination); }
      catch (error) {
        // Background snapshot validation may reject this tab before the move dialog opens.
        if (!await loadLatest.isVisible()) throw error;
      }
    }
    await loadLatest.waitFor();
    assert.equal(qa.snapshot().rows.find(({ id }) => id === original.id).optionId, destination, "Stale tab could not overwrite the newer move");
    await loadLatest.click();
    await confirmMove(stale.page, qa, original, destination);
    assert.ok(qa.events.slice(eventStart).some((event) => event.type === "save" && event.status === 409 && event.writes === 0));
    assert.deepEqual(stale.errors, []);
    await stale.context.tracing.stop();
  } catch (error) {
    await stale.context.tracing.stop({ path: resolve(output, "stale-tab-" + width + ".zip") }).catch(() => {});
    throw error;
  } finally { await stale.context.close(); }

  const remove = rowCard(page, second.id).locator(".quoteChoiceRemove");
  await remove.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
  page.once("dialog", (dialog) => dialog.dismiss());
  await remove.click();
  assert.equal(qa.snapshot().rows.length, 2);
  page.once("dialog", (dialog) => dialog.accept());
  await remove.click();
  await waitFor(() => qa.snapshot().rows.length === 1, "one system removed");
  await textIs(page, "#quoteChoicesStatus", "System removed.");
  const totals = assertTotals(qa, ids);
  await page.waitForFunction(() => window.__calculatorCanRefresh?.() === true, null, { timeout: 20000 });
  await page.reload();
  await textIs(page, "#currentOptionTitle", "QA Quote Journey");
  for (const [id, total] of Object.entries(totals)) await textIs(page, `section[data-option-id="${id}"] .quoteChoiceTotal strong`, money(total));
  assert.equal(await rowCard(page, second.id).count(), 0, "Deleted system does not return after reload");
  assert.deepEqual(financials(qa.snapshot().rows[0]), financials(original));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Quote view fits the screen");
  if(width < 500) {
    await page.locator("#splitTab").scrollIntoViewIfNeeded();
    await page.locator("#standardFloatingActionBar").waitFor({ state: "visible" });
  }
}

async function setupMulti(page) {
  await page.locator("#multiSplitTab").click();
  await page.locator("#multiSplitBrand").selectOption("Rinnai");
  const outdoor = page.locator("#multiSplitOutdoor option").filter({ hasText: qaModels.multi }).first();
  await outdoor.waitFor({ state: "attached" });
  await page.locator("#multiSplitOutdoor").selectOption(await outdoor.getAttribute("value"));
  await inputPostcode(page, "#multiSplitPostcode", "2550");
  await clickCentred(page.locator("#multiSplitNewBtn"));
  const head = page.getByRole("combobox", { name: "Indoor head 1 model" });
  if (!await head.count()) await page.locator("#multiSplitAddHeadBtn").click();
  const indoor = head.locator("option").filter({ hasText: "HINRPX25M" }).first();
  await head.selectOption(await indoor.getAttribute("value"));
  await clickCentred(page.getByRole("button", { name: "Increase indoor head 1 quantity" }));
}

async function rebateJourney(page, qa) {
  await loadPage(page, qa);
  await textIs(page, "#certRebateMeta", "Verified NSW backup");
  await page.locator("#ductedTab").click();
  await page.locator("#brand").selectOption("Fujitsu");
  await page.locator("#product").selectOption({ label: "7.1kW - Single" });
  await page.locator("#replacementBtn").click();
  await inputPostcode(page, "#essPostcode", "2145");
  await textIs(page, "#selectedModel", qaModels.ducted);
  await textIs(page, "#escCertCount", "26.817", "attached");
  await textIs(page, "#prcCertCount", "224.011", "attached");
  assert.equal((await amounts(page))[2], money(Number((26.81684672 * qaRates.esc + 224.0110425 * qaRates.prc).toFixed(2))));

  await setupMulti(page);
  await clickCentred(page.locator("#multiSplitQuickRebateBtn"));
  await textIs(page, "#multiSplitCalculationSource", "Verified NSW backup");
  assert.ok(Number((await page.locator("#multiSplitRebateValue").innerText()).replace(/[$,]/g, "")) > 0);

  qa.faults.backupDown = true;
  await page.locator("#splitTab").click();
  await inputPostcode(page, "#essPostcode", "2213");
  await textIs(page, "#certRebateValue", "Unavailable");
  assert.notEqual(await page.locator("#liveRebatePanel").getAttribute("aria-busy"), "true", "Outage cannot leave a stuck rebate spinner");
  assert.equal(Number(await page.locator("#rebate").inputValue()), 0, "No stale rebate in costs when both services fail");
  qa.faults.backupDown = false;
  await page.locator("#retryLiveRebate").click();
  await textIs(page, "#certRebateMeta", "Verified NSW backup");
  assert.ok(qa.events.some((event) => event.type === "rebate" && event.service === "backup" && event.unavailable));
}

async function pendingRebateProbe(page, qa) {
  await loadPage(page, qa);
  await textIs(page, "#certRebateMeta", "Verified NSW backup");
  await addStandard(page, qa, { name: "QA Pending Rebate" });
  qa.faults.delayRebateMs = 1800;
  await inputPostcode(page, "#essPostcode", "2170");
  await page.locator('#liveRebatePanel[aria-busy="true"]').waitFor();
  await page.locator('#standardCalculatorSection button[onclick="addToQuote()"]').click();
  await textIs(page, "#certRebateValue", "$423.34");
  await waitFor(async () => !(await page.locator("#cloudSaveStatus").innerText()).includes("Saving"), "quote save settles");
  const saved = qa.snapshot().rows.find((row) => (row.postcode ?? row.state?.postcode) === "2170");
  if (saved) assert.equal(saved.rebate, 423.34, "Adding a system during calculation saved a provisional rebate");
  else assert.equal(qa.snapshot().rows.length, 1, "Pending calculation blocked the add");
}

async function multiOutageProbe(page, qa) {
  await loadPage(page, qa);
  await setupMulti(page);
  for (const [id, price] of [["#multiSplitOutdoorPriceInput", "1100"], ["#multiSplitIndoorRows .multiSplitPriceInput", "350"]]) {
    await page.locator(id).fill(price);
    await page.locator(id).press("Tab");
    await page.locator("#multiSplitPriceUseOnce").click();
  }
  await clickCentred(page.locator("#multiSplitQuickRebateBtn"));
  await textIs(page, "#multiSplitCalculationSource", "Verified NSW backup");
  const pricesBefore = qa.snapshot().raw.installerManagedPricesV1;
  const selectedPrices = await page.locator("#multiSplitOutdoorPriceInput").inputValue();
  qa.faults.delayRebateMs = 900;
  const pending = page.waitForResponse((response) => response.url().endsWith("/qa/nsw-backup"));
  await clickCentred(page.locator("#multiSplitQuickRebateBtn"));
  await textIs(page, "#multiSplitRebateFreshness", "Calculating rebate");
  assert.equal(await page.locator("#multiSplitAddToQuoteBtn").isDisabled(), true, "A recalculation blocks the main add control");
  assert.equal(await page.locator("#standardFloatingActionBar .floatingAdd").isDisabled(), true, "A recalculation blocks the floating add control");
  await page.evaluate(() => addToQuote());
  assert.equal(await page.locator("#quoteNameModal.open").count(), 0, "The handler also refuses an unconfirmed rebate");
  // A changed head invalidates any response already in flight.
  await clickCentred(page.getByRole("button", { name: "Decrease indoor head 1 quantity" }));
  await pending;
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  assert.equal(await page.locator("#multiSplitAddToQuoteBtn").isDisabled(), true, "An obsolete response cannot restore quote readiness");
  await clickCentred(page.getByRole("button", { name: "Increase indoor head 1 quantity" }));
  qa.faults.delayRebateMs = 0;
  qa.faults.backupDown = true;
  await clickCentred(page.locator("#multiSplitQuickRebateBtn"));
  await textIs(page, "#multiSplitRebateFreshness", "Calculation needs attention");
  assert.equal(await page.locator("#multiSplitRebateValue").textContent(), "Unavailable");
  assert.equal(await page.locator("#multiSplitAddToQuoteBtn").isDisabled(), true);
  assert.equal(await page.locator("#standardFloatingActionBar .floatingAdd").isDisabled(), true);
  await page.evaluate(() => addToQuote());
  assert.equal(await page.locator("#quoteNameModal.open").count(), 0);
  assert.equal(qa.snapshot().rows.length, 0, "Multi-head calculation failed but the system was saved as a $0 rebate");
  assert.equal(qa.snapshot().raw.installerManagedPricesV1, pricesBefore, "Outages do not change saved equipment prices");
  assert.equal(await page.locator("#multiSplitOutdoorPriceInput").inputValue(), selectedPrices);
  qa.faults.backupDown = false;
  qa.faults.zeroCertificates = true;
  await clickCentred(page.locator("#multiSplitQuickRebateBtn"));
  await textIs(page, "#multiSplitRebateFreshness", "Rebate up to date");
  assert.equal(await page.locator("#multiSplitRebateValue").textContent(), "$0.00", "A successful zero is still a valid result");
  assert.equal(await page.locator("#multiSplitAddToQuoteBtn").isEnabled(), true);
  if (page.viewportSize().width < 500) {
    await page.locator("#multiSplitTab").scrollIntoViewIfNeeded();
    await page.locator("#standardFloatingActionBar").waitFor({ state: "visible" });
    await page.locator("#standardFloatingActionBar .floatingAdd").click();
  } else await page.locator("#multiSplitAddToQuoteBtn").click();
  await page.locator("#quoteNameModalInput").fill("QA Verified Zero");
  await page.locator("#quoteNameModalSubmit").click();
  await waitFor(() => qa.snapshot().rows.length === 1, "verified zero can be saved");
  assert.equal(qa.snapshot().rows[0].rebate, 0);
  assert.equal(qa.snapshot().rows[0].unitInc, 1800);
  qa.faults.zeroCertificates = false;
  qa.faults.delayRebateMs = 900;
  const late = page.waitForResponse((response) => response.url().endsWith("/qa/nsw-backup"));
  await clickCentred(page.locator("#multiSplitQuickRebateBtn"));
  await page.locator(".multiSplitFinancialDetails > summary").click();
  await page.locator("#multiRebate").fill("123.45");
  await page.locator("#multiRebate").press("Tab");
  await late;
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  assert.equal(await page.locator("#multiRebate").inputValue(), "123.45", "A late calculation must not overwrite an explicit manual rebate");
  assert.equal(qa.snapshot().rows[0].rebate, 0, "Editing calculator inputs must not reprice a saved quote");
  await page.screenshot({ path: resolve(output, "multi-outage-recovered-" + page.viewportSize().width + ".png") });
}

async function accessJourney(page, qa, width) {
  await loadPage(page, qa);
  await textIs(page, "#certRebateMeta", "Verified NSW backup");
  await addStandard(page, qa, { name: "QA Admin Private Quote" });
  const admin = qa.snapshot().rows;
  const sales = await openPage(qa, width, "sales");
  try {
    await sales.page.goto(qa.origin + "/?as=admin%40example.test");
    await textIs(sales.page, "#certRebateMeta", "Verified NSW backup");
    assert.doesNotMatch(await sales.page.locator("#currentOptionTitle").innerText(), /QA Admin Private Quote/);
    await addStandard(sales.page, qa, { name: "QA Sales Quote", role: "sales" });
    assert.doesNotMatch(await quoteBody(sales.page).innerText(), /Agency profit inc GST/);
    assert.match(await quoteBody(sales.page).innerText(), /Salesperson commission payable/);
    assert.deepEqual(qa.snapshot().rows, admin, "Salesperson's quote save cannot change the admin's quote");
    assert.deepEqual(sales.errors, []);
    await sales.context.tracing.stop();
  } finally { await sales.context.close(); }
}

await mkdir(output, { recursive: true });
try {
  for (const width of widths) {
    const scenarios = process.env.QA_PROBE === "1" ? [["pending-rebate", pendingRebateProbe], ["multi-outage", multiOutageProbe]]
      : [["quote", quoteJourney], ["rebate", rebateJourney], ["access", accessJourney], ["multi-outage", multiOutageProbe]];
    for (const [scenario, run] of scenarios.filter(([name]) => !process.env.QA_SCENARIO || process.env.QA_SCENARIO.split(",").includes(name))) {
      const key = `${scenario}-${width}`;
      const qa = await startCalculatorQa({ largeHistory: scenario === "quote" });
      let tab;
      try {
        tab = await openPage(qa, width);
        await run(tab.page, qa, width);
        assert.deepEqual(tab.errors, [], "No uncaught page errors");
        report.passed.push({ key, saves: qa.events.filter((e) => e.type === "save").length });
        console.log("PASS " + key);
        await tab.context.tracing.stop();
      } catch (error) {
        const evidence = { key, error: error.message, stack: error.stack, browserErrors: tab?.errors, events: qa.events.slice(-30),
          savedSystems: qa.snapshot().rows.map((row) => ({ id: row.id, optionId: row.optionId, ...financials(row) })) };
        if (tab) {
          evidence.state = await tab.page.evaluate(() => Object.fromEntries(
            ["selectedModel", "certRebateMeta", "certRebateValue", "escCertCount", "prcCertCount", "multiSplitRebateFreshness", "multiSplitStatus", "quoteChoicesStatus"].map((id) => [id, document.getElementById(id)?.textContent])
          )).catch(() => null);
          await tab.page.screenshot({ path: resolve(output, key + ".png"), timeout: 3000 }).catch(() => {});
          await tab.context.tracing.stop({ path: resolve(output, key + ".zip") }).catch(() => {});
        }
        report.failures.push(evidence);
        console.error("FAIL " + key + ": " + error.message, evidence.state ?? "");
      } finally {
        await tab?.context.close();
        await qa.close();
      }
    }
  }
} finally {
  await browser.close();
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
}
if (!report.passed.length && !report.failures.length) throw new Error("No QA scenarios selected");
if (report.failures.length) process.exitCode = 1;
