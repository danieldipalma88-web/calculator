import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { bootstrapHtml } from './verify-business-configuration.mjs';

const require = createRequire(import.meta.url);
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const engineName = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? 'webkit' : 'chromium';
const origin = 'https://calculator.rebateportal.com.au';
const output = new URL('../outputs/cloud-save-browser/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await (engineName === 'webkit' ? webkit : chromium).launch({
  executablePath: engineName === 'chromium' ? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined : undefined,
  downloadsPath: fileURLToPath(output),
});
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const errors = [], requests = [], wireSizes = [];
    let unavailable = true;
    let cloud = {};
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const timeout = window.setTimeout;
      window.setTimeout = (callback, delay, ...args) => timeout(callback,
        (delay >= 3000 && delay < 3500) || (delay >= 10000 && delay < 10500) ? 30 : delay, ...args);
    });
    await page.route('**/*', route => {
      const request = route.request();
      if (request.url().startsWith('blob:')) return route.continue();
      if (request.url() === origin + '/') return route.fulfill({ contentType: 'text/html', body: bootstrapHtml(cloud, null, true) });
      if (request.url().includes('/api/calculator-data') && request.method() === 'PUT') {
        const wire = request.postDataBuffer();
        const compressed = request.headers()['content-type'] === 'application/vnd.rebate-portal.calculator-save+gzip';
        requests.push(compressed ? JSON.parse(gunzipSync(wire)) : request.postDataJSON());
        wireSizes.push({ bytes: wire.length, compressed });
        return route.fulfill(unavailable
          ? { status: 503, json: { error: 'Temporary save outage', code: 'CALCULATOR_SAVE_TIMEOUT' } }
          : { status: 200, json: { ok: true } });
      }
      return route.abort();
    });
    await page.goto(origin, { waitUntil: 'load' });
    assert.equal(await page.evaluate(() => localStorage.getItem('setItem')), null, 'Storage guards must be methods, not accidentally persisted strings');
    await page.evaluate(() => {
      localStorage.setItem('saveRecoveryFixture', 'unsaved first edit');
      window.__calculatorFlushCloudSave(20000).catch(() => {});
    });
    await page.waitForFunction(() => window.__calculatorCloudSaveState?.tone === 'error');
    assert.equal(requests.length, 3, 'The browser stops after three failed attempts');
    const retry = page.locator('#cloudSaveStatus button').filter({ hasText: 'Retry save' });
    await retry.waitFor({ state: 'visible' });
    assert.equal(await retry.textContent(), 'Retry save');
    for (const selector of ['#cloudSaveStatus', '#cloudSaveStatus button:first-of-type', '#cloudSaveStatus button:last-of-type']) {
      const box = await page.locator(selector).boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, `${selector} fits ${width}px`);
    }
    assert.equal(await page.locator('#cloudSaveStatus').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await page.screenshot({ path: fileURLToPath(new URL(`paused-${width}.png`, output)) });
    await page.evaluate(() => localStorage.setItem('saveRecoveryFixture', 'newest edit retained'));
    unavailable = false;
    await retry.click();
    await page.waitForFunction(() => window.__calculatorCloudSaveState?.tone === 'saved');
    assert.equal(requests.at(-1).data.saveRecoveryFixture, 'newest edit retained');
    assert.equal(await retry.count(), 0, 'Retry action disappears after confirmed recovery');
    // WebKit's Playwright interception does not expose binary Blob request bodies.
    if (engineName === 'chromium') {
      await page.evaluate(async () => {
        localStorage.setItem('installerSavedQuoteSetsV1', JSON.stringify([{ id: 'synthetic-backup', name: 'Large test history',
          quotes: [{ id: 'synthetic-row', model: 'TEST-OUT/TEST-IN', unitPriceInc: 962.98, notes: '"'.repeat(1400000) }] }]));
        await window.__calculatorFlushCloudSave(20000);
      });
      assert.ok(Buffer.byteLength(JSON.stringify(requests.at(-1))) > 5_200_000, 'Reproduce a save above the host limit');
      assert.ok(wireSizes.at(-1).compressed && wireSizes.at(-1).bytes < 4_400_000);
      const savedBackup = JSON.parse(requests.at(-1).data.installerSavedQuoteSetsV1)[0];
      assert.equal(savedBackup.quotes[0].notes.length, 1400000);
      assert.equal(savedBackup.quotes[0].unitPriceInc, 962.98);
      await page.screenshot({ path: fileURLToPath(new URL(`large-saved-${width}.png`, output)) });
      await page.evaluate(async () => {
        localStorage.removeItem('installerSavedQuoteSetsV1');
        await window.__calculatorFlushCloudSave(20000);
      });
    }
    unavailable = true;
    const option = { id: 'recovery-quote', name: 'Sample customer' };
    const savedRow = { id: 'recovery-row', optionId: option.id, optionName: option.name, model: 'SAVED-MODEL', finalInc: 1800, timestamp: Date.now() };
    cloud = { installerMasterQuoteLogV1: JSON.stringify([savedRow]), installerQuoteOptionDefsV1: JSON.stringify([option]) };
    await page.evaluate(() => {
      localStorage.setItem('saveRecoveryFixture', 'recover after refresh');
      localStorage.setItem('installerMasterQuoteLogV1', JSON.stringify([
        { id: 'recovery-row', optionId: 'recovery-quote', optionName: 'Sample customer', model: 'DRAFT-MODEL', finalInc: 2100, netProfit: 85123, timestamp: Date.now() },
      ]));
      window.__calculatorFlushCloudSave(20000).catch(() => {});
    });
    await page.waitForFunction(() => window.__calculatorCloudSaveState?.tone === 'error');
    const beforeReload = requests.length;
    await page.reload({ waitUntil: 'load' });
    const notice = page.locator('#currentQuoteRecovery');
    await notice.waitFor();
    assert.equal(await page.locator('dialog:modal').count(), 0, 'The recovered draft must never take over the calculator');
    assert.equal(requests.length, beforeReload, 'Reload must not replay a potentially stale financial snapshot');
    await notice.locator('summary').click();
    await notice.getByText('Saved when opened').waitFor();
    assert.match(await notice.innerText(), /SAVED-MODEL.*\$1800\.00/);
    assert.match(await notice.innerText(), /DRAFT-MODEL.*\$2100\.00/);
    assert.doesNotMatch(await notice.innerText(), /85123/, 'Review does not disclose stored profit values');
    await page.screenshot({ path: fileURLToPath(new URL(`recovery-${engineName}-${width}.png`, output)) });
    const downloadEvent = page.waitForEvent('download');
    await notice.getByRole('button', { name: 'Download comparison' }).click();
    const comparisonPath = fileURLToPath(new URL(`recovery-${engineName}-${width}.json`, output));
    await (await downloadEvent).saveAs(comparisonPath);
    assert.doesNotMatch(await readFile(comparisonPath, 'utf8'), /85123|netProfit/);
    unavailable = false;
    await notice.locator('summary').click();
    const sibling = await context.newPage();
    await sibling.route(origin + '/storage-fixture', route => route.fulfill({ contentType: 'text/html', body: '<p>Storage fixture</p>' }));
    await sibling.goto(origin + '/storage-fixture');
    await sibling.evaluate(() => {
      localStorage.setItem('installerMasterQuoteLogV1', '[{"id":"other-tab","model":"OTHER-TAB-UNCONFIRMED"}]');
      localStorage.setItem('saveRecoveryFixture', 'other-tab-local');
    });
    await page.evaluate(() => window.__calculatorFlushCloudSave(20000));
    assert.equal(requests.length, beforeReload, 'The recovered tab does not upload another tab\'s unconfirmed storage');
    await sibling.close();
    const freshTab = await context.newPage();
    await freshTab.route('**/*', route => route.request().url() === origin + '/'
      ? route.fulfill({ contentType: 'text/html', body: bootstrapHtml({}, null, true) })
      : route.abort());
    await freshTab.goto(origin, { waitUntil: 'load' });
    assert.equal(await freshTab.locator('#currentQuoteRecovery').isVisible(), false, 'A fresh tab does not inherit the recovery notice');
    assert.equal(await freshTab.evaluate(() => localStorage.getItem('saveRecoveryFixture')), null, 'A fresh tab starts from the saved baseline, not another tab\'s storage');
    await freshTab.evaluate(() => window.__calculatorFlushCloudSave(20000));
    await freshTab.close();
    await page.evaluate(async () => {
      createNewOptionNow('Fresh unrelated quote', true);
      await window.__calculatorFlushCloudSave(20000);
    });
    assert.equal(requests.length, beforeReload + 1);
    assert.match(requests.at(-1).data.installerQuoteOptionDefsV1, /Fresh unrelated quote/);
    assert.equal(requests.at(-1).data.installerMasterQuoteLogV1, cloud.installerMasterQuoteLogV1, 'Fresh work does not re-send older or startup-normalized quotes');
    assert.equal(requests.at(-1).data.saveRecoveryFixture, undefined, 'Fresh work does not include values from another tab');
    assert.equal(await page.evaluate(() => {
      const records = Object.keys(sessionStorage).filter(key => key.startsWith('__calculatorPendingSaveV1:'));
      return records.length === 1 && sessionStorage.getItem(records[0]).includes('DRAFT-MODEL');
    }), true);
    await page.evaluate(() => { openDrawer(); openLibraryQuote('recovery-quote'); });
    const libraryRecovery = page.locator('#quoteLibraryRecovery');
    await libraryRecovery.locator('summary').click();
    await libraryRecovery.getByText('Recovered draft', { exact: true }).waitFor();
    assert.match(await libraryRecovery.innerText(), /SAVED-MODEL/);
    assert.match(await libraryRecovery.innerText(), /DRAFT-MODEL/);
    await page.evaluate(() => closeDrawer());
    await page.evaluate(() => {
      localStorage.setItem('__calculatorProfileEmail', 'another@example.test|another-business');
      window.dispatchEvent(new StorageEvent('storage', { key: '__calculatorProfileEmail' }));
    });
    await page.getByRole('heading', { name: 'Workspace changed in another tab' }).waitFor();
    const writesBefore = requests.length;
    const otherDraft = await page.evaluate(async () => {
      localStorage.setItem('saveRecoveryFixture', 'must not overwrite another workspace');
      try { await window.__calculatorFlushCloudSave(); } catch {}
      return localStorage.getItem('saveRecoveryFixture');
    });
    assert.notEqual(otherDraft, 'must not overwrite another workspace');
    assert.equal(requests.length, writesBefore, 'No cross-workspace save');
    assert.deepEqual(errors, []);
    await context.close();
  }
} finally {
  await browser.close();
}
console.log(engineName + ' save recovery: desktop/mobile retries, workspace fences, non-blocking comparison, optional download and fresh quote save passed. All external requests intercepted.');
