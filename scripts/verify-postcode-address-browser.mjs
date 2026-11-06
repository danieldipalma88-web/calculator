import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const origin = "https://calculator.rebateportal.com.au";
const output = new URL("../outputs/postcode-address-browser/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
const matched = {
  placeId: "fixture-place", formattedAddress: "10 Example Street, Jerrabomberra NSW 2619, Australia",
  postcode: "2619", state: "NSW", country: "AU", locality: "Jerrabomberra",
  status: "address_matched", rebateStatus: "requires_review",
  attributions: [{ provider: "Fixture mapping provider", uri: "https://example.test/maps" }],
};
const waitFor = async (page, expression) => page.waitForFunction(expression);
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    const requests = [];
    let failure = false;
    let deferredResponse = null;
    let deferNext = false;
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", async route => {
      if (route.request().url() === origin + "/") return route.fulfill({ contentType: "text/html", body: html });
      if (route.request().url() === origin + "/api/google-address") {
        const body = route.request().postDataJSON(); requests.push(body);
        if (deferNext) {
          deferNext = false;
          await new Promise(resolve => { deferredResponse = resolve; });
        }
        if (failure) return route.fulfill({ status: 504, json: { error: "Google address search took too long. Please try again." } });
        if (body.action === "autocomplete-installation") return route.fulfill({ json: { suggestions: [{ placeId: "fixture-place", text: matched.formattedAddress }] } });
        if (body.action === "verify-installation") return route.fulfill({ json: { verification: matched } });
        throw new Error(`Unexpected address action ${body.action}`);
      }
      return route.abort();
    });
    await page.addInitScript(() => {
      window.CALCULATOR_USER = { email: "test@example.test", businessId: "fixture-business", businessName: "Fixture business", businessOperatingState: "NSW", canSeeOwnerDetails: false, rebatesEnabled: false };
    });
    await page.goto(origin, { waitUntil: "load" });
    await page.evaluate(() => {
      window.CALCULATOR_USER.rebatesEnabled = true;
      syncSharedEssPostcode("2619", "state", false);
    });
    for (const postcode of ["2611", "2618", "2619", "2678", "2898", "3691", "4375", "4377", "4380", "4383", "4385"]) {
      assert.equal(await page.evaluate(postcode => {
        syncSharedEssPostcode(postcode, "state", false);
        return ["standard", "multi", "allModels"].every(source => !$(source + "PostcodeVerification").hidden);
      }, postcode), true);
    }
    await page.evaluate(() => syncSharedEssPostcode("2000", "state", false));
    assert.equal(await page.locator("#standardPostcodeVerification").isVisible(), false);
    await page.evaluate(() => syncSharedEssPostcode("2619", "state", false));
    const quoteBefore = await page.evaluate(() => JSON.stringify({ options: quoteOptionDefs, rows: quotes, rebate: $("rebate").value, postcode: getEssPostcode() }));
    await page.locator("#standardPostcodeVerification button").click();
    assert.equal(await page.locator("#postcodeAddressModal").isVisible(), true);
    assert.match(await page.locator(".postcodeAddressPrivacy").innerText(), /sent to Google Maps/);
    assert.equal(await page.locator(".postcodeAddressPrivacy a").getAttribute("href"), "/address-lookup");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.locator(".postcodeAddressPrivacy a").evaluate(el => el === document.activeElement), true);
    await page.keyboard.press("Tab");
    assert.equal(await page.locator("#postcodeAddressInput").evaluate(el => el === document.activeElement), true);
    assert.equal(await page.locator("#postcodeAddressEmail").isDisabled(), true);
    await page.locator("#postcodeAddressInput").fill("10 Example Street");
    await page.locator("#postcodeAddressSuggestions button").waitFor();
    await page.locator("#postcodeAddressInput").press("ArrowDown");
    assert.equal(await page.locator("#postcodeAddressSuggestions button").evaluate(el => el === document.activeElement), true);
    await page.keyboard.press("Enter");
    await page.locator("#postcodeAddressReview").waitFor();
    assert.match(await page.locator("#postcodeAddressStatus").innerText(), /Rebate remains unavailable/);
    assert.equal(await page.locator("#postcodeAddressInput").getAttribute("aria-busy"), "false");
    assert.equal(await page.locator("#postcodeAddressEmail").isEnabled(), true);
    assert.equal(await page.locator("#postcodeAddressProviders a").getAttribute("href"), "https://example.test/maps");
    await page.locator("#postcodeAddressDistributor").selectOption("Essential Energy");
    const review = await page.evaluate(() => postcodeAddressReviewText());
    assert.match(review, /Essential Energy/);
    assert.match(review, /user reported, not verified/);
    assert.match(review, /No rebate has been approved/);
    assert.equal(await page.evaluate(() => JSON.stringify({ options: quoteOptionDefs, rows: quotes, rebate: $("rebate").value, postcode: getEssPostcode() })), quoteBefore);
    await page.locator("#postcodeAddressEmail").focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.locator(".postcodeAddressPrivacy a").evaluate(el => el === document.activeElement), true);
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.locator("#postcodeAddressEmail").evaluate(el => el === document.activeElement), true);
    for (const selector of [".postcodeAddressCard", "#postcodeAddressInput", "#postcodeAddressEmail", "#postcodeAddressStatus"]) {
      const box = await page.locator(selector).boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, `${selector} fits ${width}px`);
    }
    assert.equal(await page.locator(".postcodeAddressCard").evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await page.screenshot({ path: fileURLToPath(new URL(`matched-${width}.png`, output)) });
    // Editing and reopening must discard the previous result, including pending replies.
    await page.locator("#postcodeAddressInput").fill("Different address");
    assert.equal(await page.locator("#postcodeAddressEmail").isDisabled(), true);
    assert.equal(await page.locator("#postcodeAddressReview").isVisible(), false);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#postcodeAddressModal").isVisible(), false);
    assert.equal(await page.locator("#standardPostcodeVerification button").evaluate(el => el === document.activeElement), true);
    for (const source of ["multi", "allModels"]) {
      await page.evaluate(source => openPostcodeAddressModal(source), source);
      assert.equal(await page.locator("#postcodeAddressInput").inputValue(), "");
      assert.equal(await page.locator("#postcodeAddressEmail").isDisabled(), true);
      await page.keyboard.press("Escape");
    }
    await page.locator("#standardPostcodeVerification button").click();
    deferNext = true;
    await page.locator("#postcodeAddressInput").fill("Old search");
    await waitFor(page, () => $("postcodeAddressInput").getAttribute("aria-busy") === "true");
    await page.waitForTimeout(350);
    assert.ok(deferredResponse);
    await page.keyboard.press("Escape");
    await page.locator("#standardPostcodeVerification button").click();
    deferredResponse(); deferredResponse = null;
    await page.waitForTimeout(100);
    assert.equal(await page.locator("#postcodeAddressSuggestions").isVisible(), false);
    assert.equal(await page.locator("#postcodeAddressInput").inputValue(), "");
    failure = true;
    await page.locator("#postcodeAddressInput").fill("Service error");
    await waitFor(page, () => $("postcodeAddressStatus").textContent.includes("took too long"));
    assert.equal(await page.locator("#postcodeAddressInput").getAttribute("aria-busy"), "false");
    assert.equal(await page.locator("#postcodeAddressEmail").isDisabled(), true);
    failure = false;
    await page.locator("#postcodeAddressInput").fill("Try again");
    await page.locator("#postcodeAddressSuggestions button").waitFor();
    deferNext = true;
    await page.locator("#postcodeAddressSuggestions button").click();
    await page.waitForTimeout(100);
    assert.ok(deferredResponse);
    await page.locator("#postcodeAddressInput").fill("Changed while checking");
    deferredResponse(); deferredResponse = null;
    await page.waitForTimeout(100);
    assert.equal(await page.locator("#postcodeAddressReview").isVisible(), false);
    assert.equal(await page.locator("#postcodeAddressEmail").isDisabled(), true);
    await page.evaluate(() => syncSharedEssPostcode("2611", "state", false));
    assert.equal(await page.locator("#postcodeAddressModal").isVisible(), false);
    await page.evaluate(() => { window.CALCULATOR_USER.rebatesEnabled = false; updatePostcodeVerificationPrompts(); });
    assert.equal(await page.locator("#standardPostcodeVerification").isVisible(), false);
    assert.ok(requests.every(body => ["autocomplete-installation", "verify-installation"].includes(body.action)));
    assert.deepEqual(errors, []);
    console.log(`${width}px: address review, keyboard, context changes, stale responses, error recovery, and unchanged quote/rebate state passed.`);
    await page.close();
  }
} finally { await browser.close(); }
