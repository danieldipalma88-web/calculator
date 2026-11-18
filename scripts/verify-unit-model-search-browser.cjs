const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const output = path.join(root, 'outputs', 'unit-model-search');
const engine = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const outdoorModels = [
  { brand: 'Actron Air', model: 'MRC-050DS-2', capacityKw: 5.3, family: 'Non Ducted', phase: 'Single' },
  { brand: 'Actron Air', model: 'MRC-071AS-3', capacityKw: 7.1, family: 'Both', phase: 'Single' },
];

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await ({ chromium, webkit })[engine].launch({ headless: true,
    ...(engine === 'chromium' && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 950 }, hasTouch: width === 390 });
      const errors = [], writes = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        if (!['GET', 'HEAD'].includes(req.method()) && !['/calculate', '/api/calculate'].includes(url.pathname)) writes.push(url.pathname);
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
        if (url.pathname === '/api/gems-model-search') {
          const mode = url.searchParams.get('mode');
          const body = mode === 'multi-brands' ? { brands: ['Actron Air'] } : mode === 'multi-outdoors' ? { models: outdoorModels } : { models: [], brands: [] };
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
        }
        return route.abort();
      });
      await page.addInitScript(() => { window.CALCULATOR_USER = { role: 'admin', businessId: 'model-search-qa', businessName: 'Fictional QA Air', businessOperatingState: 'NSW' }; });
      await page.goto('http://127.0.0.1:43823/', { waitUntil: 'domcontentloaded' });
      await page.locator('#brand').selectOption('Mitsubishi Heavy Industries');
      const input = page.locator('#productSearchInput');
      await input.waitFor();
      const before = await page.evaluate(() => ({ value: $('product').value, price: $('unitPriceInc').value, quotes: JSON.stringify(quotes) }));
      await input.fill('dxk12zsa w');
      const list = page.locator('#productSearchList');
      assert.equal(await list.locator('[role=option]').count(), 1, 'Search exact supplied Avanti suffix');
      assert.deepEqual(await page.evaluate(() => ({ value: $('product').value, price: $('unitPriceInc').value, quotes: JSON.stringify(quotes) })), before, 'Typing must not change product, price or quote');
      await input.press('Enter');
      assert.equal(await page.evaluate(() => product().model), 'DXC12ZSA-W / DXK12ZSA-W');
      assert.equal(await list.isVisible(), false);
      await input.fill('does-not-exist');
      assert.equal(await list.locator('[role=option]').count(), 0);
      await input.press('Enter');
      assert.equal(await page.evaluate(() => product().model), 'DXC12ZSA-W / DXK12ZSA-W', 'No-match Enter does not change selection');
      await input.press('Escape');
      assert.match(await input.inputValue(), /DXK12ZSA-W/);
      await input.click();
      await input.fill('ciara');
      await list.locator('[role=option]').click();
      assert.equal(await page.evaluate(() => product().model), 'DXC24ZTLA-WJ / DXK24ZTLA-WFJ');
      await page.locator('#brand').selectOption('Hisense');
      await input.fill('hawh9kr-i');
      assert.equal(await list.locator('[role=option]').count(), 1, 'Physical Hisense indoor alias finds registered set');
      await input.press('Enter');
      assert.equal(await page.evaluate(() => product().model), 'HAWH9KR');
      assert.equal(await page.locator('#unitPriceInc').inputValue(), '0.00');
      await page.evaluate(() => populateProducts());
      await input.fill('HAWH28KR-O');
      await input.press('Enter');
      assert.equal(await page.evaluate(() => product().model), 'HAWH28KR', 'Identical option replacement must refresh cached option nodes');
      await input.fill('HAWH9KR');
      await input.press('Enter');
      await input.fill('HAWH28KR-O');
      await input.press('Tab');
      assert.equal(await page.evaluate(() => product().model), 'HAWH9KR', 'Tab cancels unchosen search');
      await page.evaluate(() => { $('product').value = String(data().findIndex(p => p.model === 'HAWH18KR')); onProductChange({ skipAsyncRefresh: true }); });
      assert.match(await input.inputValue(), /HAWH18KR/, 'Programmatic saved-product restoration updates display');
      await input.fill('HAWH9KR');
      await page.locator('#brand').selectOption('Daikin');
      assert.equal(await list.isVisible(), false, 'Brand change closes stale results');
      assert.doesNotMatch(await input.inputValue(), /HAWH/);
      await page.locator('#ductedTab').click();
      const ducted = await page.evaluate(() => product().model);
      await input.fill(ducted.split('/')[0].trim());
      assert.ok(await list.locator('[role=option]').count() > 0, 'Ducted equipment code is searchable');
      await input.press('Escape');
      await page.locator('#multiSplitTab').click();
      const outdoorInput = page.locator('#multiSplitOutdoorSearchInput');
      await page.waitForFunction(() => document.querySelector('#multiSplitOutdoorSearchInput')?.value.includes('MRC-050DS-2'));
      const originalOutdoor = await page.locator('#multiSplitOutdoor').inputValue();
      await outdoorInput.fill('mrc071as3');
      assert.equal(await page.locator('#multiSplitOutdoorSearchList [role=option]').count(), 1);
      assert.equal(await page.locator('#multiSplitOutdoor').inputValue(), originalOutdoor);
      await page.screenshot({ path: path.join(output, `${engine}-${width}.png`), animations: 'disabled' });
      await outdoorInput.press('Enter');
      assert.equal(await page.evaluate(() => selectedMultiSplitOutdoor().model), 'MRC-071AS-3');
      const headInput = page.locator('#multiSplitIndoorModel0SearchInput');
      const headModel = await page.evaluate(() => ALL_MODELS_MULTI_INDOORS[multiSplitIndoorSelections[0].indoorIndex].model);
      await headInput.fill(headModel);
      assert.ok(await page.locator('#multiSplitIndoorModel0SearchList [role=option]').count() > 0);
      await headInput.press('Enter');
      const differentHead = await page.evaluate(() => ALL_MODELS_MULTI_INDOORS[Number($('multiSplitIndoorModel0').options[1].value)].model);
      assert.notEqual(differentHead, headModel);
      await headInput.fill(differentHead);
      await page.locator('#multiSplitIndoorModel0SearchList [role=option]').filter({ hasText: differentHead }).click();
      assert.equal(await page.evaluate(() => document.activeElement.id), 'multiSplitIndoorModel0SearchInput', 'Rebuilt head picker retains keyboard focus');
      assert.equal(await page.locator('#multiSplitIndoorModel0SearchList').isVisible(), false);
      await headInput.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.className), 'modelSearchToggle', 'Tab continues in the restored picker');
      await outdoorInput.fill('not-found');
      await outdoorInput.press('Escape');
      await outdoorInput.click();
      await outdoorInput.fill('');
      await outdoorInput.press('ArrowUp');
      await outdoorInput.press('Enter');
      assert.equal(await page.evaluate(() => selectedMultiSplitOutdoor().model), 'MRC-050DS-2');
      await page.evaluate(() => { $('multiSplitOutdoor').disabled = true; $('multiSplitOutdoor').innerHTML = '<option value="">Loading registered outdoor models...</option>'; });
      await page.waitForFunction(() => document.querySelector('#multiSplitOutdoorSearchInput').disabled);
      assert.match(await outdoorInput.inputValue(), /Loading/);
      await page.evaluate(() => { $('multiSplitOutdoor').disabled = false; $('multiSplitOutdoor').innerHTML = '<option value="">Outdoor models unavailable</option>'; });
      await page.waitForFunction(() => document.querySelector('#multiSplitOutdoorSearchInput').value.includes('unavailable'));
      await outdoorInput.click();
      assert.equal(await page.locator('#multiSplitOutdoorSearchList [role=option]').count(), 0, 'Failure cannot expose stale choices');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'No mobile horizontal overflow');
      assert.equal(await page.evaluate(() => quotes.length), 0, 'Search tests created no quote');
      assert.deepEqual(writes, [], 'No network mutations');
      assert.deepEqual(errors, []);
      console.log(`${engine} ${width}: code/alias/series search, no-change typing, keyboard, selection, loading/failure, restored values, no writes and layout passed.`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
