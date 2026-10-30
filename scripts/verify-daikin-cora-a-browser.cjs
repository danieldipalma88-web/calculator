const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = path.resolve(__dirname, '..');
const models = ['20', '25', '35', '46', '50', '60', '71'].map(size => `RXV${size}AVMA / FTXV${size}AVMA`);

(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 950 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => new URL(route.request().url()).pathname === '/'
        ? route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'index.html'), 'utf8') })
        : route.abort());
      await page.addInitScript(() => {
        window.CALCULATOR_USER = { role: 'admin', businessId: 'test', businessName: 'Example Air', businessOperatingState: 'NSW' };
      });
      await page.goto('http://127.0.0.1:43823/', { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => {
        refreshLiveRebateForCurrentProduct = async () => {};
        refreshBestValueIndicator = () => {};
        setSystem('split'); $('brand').value = 'Daikin'; populateProducts();
      });
      for (const business of ['Example Air', 'Andos Air']) {
        await page.evaluate(name => {
          window.CALCULATOR_USER.businessName = name;
          setSystem('split'); $('brand').value = 'Daikin'; populateProducts();
        }, business);
        assert.equal(await page.locator('#product option').filter({ hasText: 'Cora - A Series' }).count(), 7);
        for (const model of models) {
          const index = await page.evaluate(value => data().findIndex(row => row.model === value), model);
          assert.ok(index >= 0, `${business}: ${model} is selectable`);
          await page.locator('#product').selectOption(String(index));
          const price = model.includes('RXV25AVMA') ? 850 : model.includes('RXV50AVMA') ? 1420 : 0;
          assert.equal(await page.locator('#unitPriceInc').inputValue(), price.toFixed(2));
          assert.equal(await page.locator('#wifiMeta').innerText(), 'Wi-Fi optional adaptor');
          assert.equal(await page.locator('#warrantyMeta').innerText(), '5 yrs parts & labour');
          assert.equal(await page.evaluate(() => standardQuotePriceReadiness().ok), price > 0, 'Only priced systems are ready to quote');
        }
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      if (process.env.CORASCREENSHOT_DIR) {
        fs.mkdirSync(process.env.CORASCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.CORASCREENSHOT_DIR, `cora-a-${width}.png`), animations: 'disabled' });
      }
      await page.evaluate(() => {
        window.CALCULATOR_USER.role = 'salesperson';
        setSystem('split'); $('brand').value = 'Daikin'; populateProducts();
      });
      assert.equal(await page.locator('#product option').filter({ hasText: 'Cora - A Series' }).count(), 2, 'Only the two priced models are visible to salespeople');
      await page.evaluate(() => {
        window.CALCULATOR_USER.role = 'admin';
        window.CALCULATOR_USER.businessOperatingState = 'QLD';
        setSystem('split'); $('brand').value = 'Daikin'; populateProducts();
      });
      assert.equal(await page.locator('#product option').filter({ hasText: 'Cora - A Series' }).count(), 0, 'NSW-only models are hidden in QLD');
      assert.deepEqual(errors, []);
      console.log(`Cora A ${width}px: seven models, default/Andos views, optional Wi-Fi, warranty, zero-price guard, salesperson and QLD visibility passed.`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
