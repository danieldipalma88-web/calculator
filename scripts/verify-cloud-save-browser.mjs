import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { bootstrapHtml } from './verify-business-configuration.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const origin = 'https://calculator.rebateportal.com.au';
const output = new URL('../outputs/cloud-save-browser/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, downloadsPath: fileURLToPath(output) });
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [], requests = [];
    let unavailable = true;
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const timeout = window.setTimeout;
      window.setTimeout = (callback, delay, ...args) => timeout(callback,
        (delay >= 3000 && delay < 3500) || (delay >= 10000 && delay < 10500) ? 30 : delay, ...args);
    });
    await page.route('**/*', route => {
      const request = route.request();
      if (request.url().startsWith('blob:')) return route.continue();
      if (request.url() === origin + '/') return route.fulfill({ contentType: 'text/html', body: bootstrapHtml({}, null, true) });
      if (request.url().includes('/api/calculator-data') && request.method() === 'PUT') {
        requests.push(request.postDataJSON());
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
    assert.equal(await retry.innerText(), 'Retry save');
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
    unavailable = true;
    await page.evaluate(() => {
      localStorage.setItem('saveRecoveryFixture', 'recover after refresh');
      window.__calculatorFlushCloudSave(20000).catch(() => {});
    });
    await page.waitForFunction(() => window.__calculatorCloudSaveState?.tone === 'error');
    const beforeReload = requests.length;
    await page.reload({ waitUntil: 'load' });
    await page.locator('#calculatorSaveRecovery').waitFor();
    assert.equal(requests.length, beforeReload, 'Reload must not replay a potentially stale financial snapshot');
    assert.match(await page.locator('#calculatorSaveRecovery pre').textContent(), /recover after refresh/);
    const proceed = page.getByRole('button', { name: 'Use saved calculator' });
    assert.equal(await proceed.isDisabled(), true, 'Retain an export before discarding pending changes');
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download recovery file' }).click();
    await (await downloadEvent).saveAs(fileURLToPath(new URL(`recovery-${width}.json`, output)));
    unavailable = false;
    page.once('dialog', dialog => dialog.accept());
    await proceed.click();
    assert.equal(await page.locator('#calculatorSaveRecovery').count(), 0);
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
    await page.close();
  }
} finally {
  await browser.close();
}
console.log('Save recovery browser: desktop/mobile retries, native Storage fences, latest edits, reload recovery without replay, recovery download, and confirmed success passed. All external requests intercepted.');
