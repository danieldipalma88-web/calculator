import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
// Australian manufacturer circular-flow range, verified 2026-11-12:
// https://www.generalairstage.com.au/commercial-products/airstage-vrf-indoor/cassette/circular-flow
const expected = [
  ["AUXK018GLEH", 5.6, 6.3], ["AUXK024GLEH", 7.1, 8],
  ["AUXK030GLEH", 9, 10], ["AUXK034GLEH", 10, 11.2],
  ["AUXK036GLEH", 11.2, 12.5], ["AUXK045GLEH", 12.5, 14],
  ["AUXK054GLEH", 14, 16],
];
const functionSource = (name) => {
  const source = html.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(source, `${name} exists`);
  return source;
};
const catalogueSource = html.slice(html.indexOf("function multiOutdoor("), html.indexOf("function normaliseBrandName("));
const context = {
  brandsEquivalent: (a, b) => a === b,
  normalizeLookup: (value) => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, ""),
  toNumber: Number,
};
vm.runInNewContext(`${catalogueSource}
  ${["multiSplitCompatibleIndoorIndexes", "allModelsMultiAvailableIndoorIndexes", "allModelsMultiIndoorSearchText", "allModelsMultiMatchingIndoorIndexes", "multiSplitCertificateInputs"].map(functionSource).join("\n")}
  globalThis.rows=ALL_MODELS_MULTI_INDOORS;
`, context);
const outdoor = { brand: "Fujitsu General", model: "AJY144LELBH", capacityNum: 45 };
for (const [model, cooling, heating] of expected) {
  const matches = context.rows.map((row, index) => ({ row, index })).filter(({ row }) => row.model === model);
  assert.equal(matches.length, 1, `${model} occurs exactly once`);
  const { row, index } = matches[0];
  assert.equal(row.brand, outdoor.brand);
  assert.equal(row.family, "fujitsu-airstage-vrf");
  assert.equal(row.capacityNum, cooling);
  assert.equal(row.ratedCoolingCapacity, cooling);
  assert.equal(row.ratedHeatingCapacity, heating);
  assert.equal(row.unitPriceInc, 0, "Unknown prices stay unset, not estimated");
  assert.ok(context.multiSplitCompatibleIndoorIndexes(outdoor).includes(index));
  assert.deepEqual(Array.from(context.allModelsMultiMatchingIndoorIndexes(outdoor, model)), [index]);
  assert.equal(context.allModelsMultiMatchingIndoorIndexes({ brand: "Daikin" }, model).length, 0);
  assert.equal(context.multiSplitCompatibleIndoorIndexes({ brand: "Daikin" }).includes(index), false);
}
assert.equal(context.rows.some((row) => row.model === "AUXK054LEH"), false, "Do not publish the unverified typo as a model");
// These pre-existing positions are persisted in older saved multi-head selections.
assert.equal(createHash("sha256").update(JSON.stringify(context.rows.slice(0, 259))).digest("hex"),
  "b40e711d48d7b84483411c95836b23fbf9dd4d9e5441fd47ccd1085b5c6609be",
  "The existing 259 heads, their capacities, prices and indexes remain unchanged");
const head = context.rows.find((row) => row.model === "AUXK054GLEH");
// Synthetic input power exercises the unchanged capacity helper, not an eligibility assertion.
const meta = { "Cooling Capacity": 45, "Heating Capacity": 45, "Input Power": 15 };
const two = context.multiSplitCertificateInputs(meta, [{ row: head, qty: 2 }]);
assert.equal(two.coolingCapacity, 28);
assert.equal(two.heatingCapacity, 32);
assert.ok(Math.abs(two.inputPower - 15 * 28 / 45) < 1e-10);
const four = context.multiSplitCertificateInputs(meta, [{ row: head, qty: 4 }]);
assert.equal(four.indoorCooling, 56);
assert.equal(four.indoorHeating, 64);
assert.equal(four.coolingCapacity, 45);
assert.equal(four.heatingCapacity, 45);
assert.equal(four.inputPower, 15);
assert.throws(() => context.multiSplitCertificateInputs(meta, [{ row: { model: "UNVERIFIED" }, qty: 1 }]), /Manufacturer-rated/);
console.log("Fujitsu AUXK: seven verified heads, both selectors, brand isolation, stable saved indexes and capacity limits passed.");

if (process.argv.includes("--browser")) {
  const require = createRequire(import.meta.url);
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
  const origin = "https://calculator.test";
  const output = new URL("../outputs/fujitsu-vrf-indoors/", import.meta.url);
  await mkdir(output, { recursive: true });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/*", (route) => route.request().url() === origin + "/"
        ? route.fulfill({ contentType: "text/html", body: html }) : route.abort());
      await page.addInitScript(() => {
        window.CALCULATOR_USER = { businessOperatingState: "NSW", canSeeOwnerDetails: false, rebatesEnabled: false };
      });
      await page.goto(origin);
      await page.evaluate(() => {
        // Local display fixture only; never adds or changes a live outdoor registration.
        const index = MULTI_SPLIT_OUTDOORS.push(multiOutdoor("Fujitsu General", "Airstage J-IVL", 45, "AJY144LELBH", 0, 40)) - 1;
        multiSplitBrandOptions = ["Fujitsu General"];
        setMultiSplitSection();
        $("multiSplitBrand").replaceChildren(new Option("Fujitsu General", "Fujitsu General"));
        $("multiSplitOutdoor").replaceChildren(new Option("AJY144LELBH", String(index)));
        multiSplitIndoorSelections = [{ indoorIndex: ALL_MODELS_MULTI_INDOORS.findIndex((row) => row.model === "AUXK054GLEH"), qty: 4 }];
        renderMultiSplitTrial();
      });
      const select = page.getByRole("combobox", { name: "Indoor head 1 model", exact: true });
      for (const [model, cooling, heating] of expected) {
        const value = await select.locator("option").filter({ hasText: model }).getAttribute("value");
        assert.ok(value, `${model} available at ${width}px`);
        await select.selectOption(value);
        assert.match(await page.locator("#multiSplitIndoorRows").innerText(), new RegExp(`${cooling.toFixed(1)}kW`));
        assert.match(await page.locator("#multiSplitIndoorRows").innerText(), new RegExp(`${heating.toFixed(1)}kW`));
      }
      assert.equal(await page.getByRole("spinbutton", { name: "AUXK054GLEH price including GST", exact: true }).inputValue(), "");
      const bounds = await select.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
      await page.locator("#multiSplitIndoorRows").scrollIntoViewIfNeeded();
      await page.screenshot({ path: fileURLToPath(new URL(`quote-${width}.png`, output)) });
      await page.evaluate(() => {
        allModelsBrandsLoaded = true;
        allModelsMultiBrandsLoaded = true;
        allModelsMultiOutdoors = [{ brand: "Fujitsu General", model: "AJY144LELBH", capacity: "45.0kW", capacityNum: 45, maxHeads: 40 }];
        $("allModelsMultiOutdoor").replaceChildren(new Option("AJY144LELBH", "0"));
        allModelsMultiIndoorSelections = [{ indoorIndex: ALL_MODELS_MULTI_INDOORS.findIndex((row) => row.model === "AUXK054GLEH"), qty: 4 }];
        setAllModelsSection();
        setAllModelsMode("multi");
      });
      const search = page.locator("#allModelsMultiHeadSearch0");
      await search.fill("AUXK054GLEH");
      assert.match(await page.locator("#allModelsMultiRows").innerText(), /AUXK054GLEH/);
      await page.locator("#allModelsMultiRows").scrollIntoViewIfNeeded();
      await page.screenshot({ path: fileURLToPath(new URL(`lookup-${width}.png`, output)) });
      assert.deepEqual(errors, []);
      console.log(`${width}px: all seven heads selectable; capacity facts and unset price correct; rebate lookup search works.`);
      await page.close();
    }
  } finally { await browser.close(); }
}
