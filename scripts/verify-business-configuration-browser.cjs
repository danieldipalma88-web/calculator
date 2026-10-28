const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');

(async () => {
  const fixture = await import(pathToFileURL(path.join(__dirname, 'verify-business-configuration.mjs')));
  const {fixtureConfiguration, bootstrapHtml, key, businessA, businessB, root} = fixture;
  const configuration = fixtureConfiguration();
  const browser = await chromium.launch({headless: true});
  try {
    if (process.argv.includes('--indexes')) {
      const config = process.env.BUSINESS_CONFIGURATION_FILE
        ? JSON.parse(fs.readFileSync(process.env.BUSINESS_CONFIGURATION_FILE, 'utf8')) : configuration;
      assert.ok(fixture.validate(JSON.stringify(config), config.businessId), 'Index fixture configuration must be valid');
      const page = await browser.newPage();
      await page.route('**/*', route => new URL(route.request().url()).pathname === '/'
        ? route.fulfill({contentType:'text/html',body:bootstrapHtml({[key]:JSON.stringify(config)},config.businessId)}) : route.abort());
      await page.goto('http://127.0.0.1:43829/',{waitUntil:'domcontentloaded'});
      await page.waitForFunction(() => window.__calculatorReady === true);
      const rows = await page.evaluate(() => allManagedProducts().map(({type,index,key,p}) => ({
        type,index,key,brand:p.brand,series:p.series||'',model:p.model,phase:p.phase||'Single',capacityNum:cap(p),
        businessPrivate:businessConfigurationCache.products.includes(p),
      })));
      console.log(JSON.stringify(rows,null,2));
      await page.close();
      return;
    }
    for (const width of [1440, 390, 320]) {
      const page = await browser.newPage({viewport: {width, height: 900}});
      let businessId = businessA;
      let cloud = {[key]: JSON.stringify(configuration)};
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/') return route.fulfill({contentType: 'text/html', body: bootstrapHtml(cloud, businessId, true)});
        if (url.pathname === '/vendor/sortable-1.15.6.min.js') return route.fulfill({contentType: 'application/javascript', body: fs.readFileSync(path.join(root, 'public/vendor/sortable-1.15.6.min.js'), 'utf8')});
        if (url.pathname === '/api/calculator-data') return route.fulfill({json: route.request().method() === 'GET' ? {data: {}} : {ok: true}});
        return route.abort();
      });
      await page.goto('http://127.0.0.1:43829/', {waitUntil: 'domcontentloaded'});
      await page.waitForFunction(() => window.__calculatorReady === true);
      await page.evaluate(() => { refreshLiveRebateForCurrentProduct = async () => {}; refreshBestValueIndicator = () => {}; });
      const catalog = await page.evaluate(() => ({
        extras: allManagedProducts().filter(item => item.p.model.startsWith('PRIVATE-')).map(item => ({key: item.key, model: item.p.model, price: item.p.unitPriceInc})),
        legacy: allManagedProducts().find(item => !item.p.model.startsWith('PRIVATE-')),
      }));
      assert.equal(catalog.extras.length, 17);
      assert.ok(catalog.extras.every(item => item.price === 0));
      // Existing index-key price storage, including model-based migration from another index.
      const privateItem = catalog.extras[0];
      const existingPrice = 876.54;
      cloud.installerManagedPricesV1 = JSON.stringify({
        'split|99999': {model: privateItem.model, unitPriceInc: 1234.56, locked: true},
        [catalog.legacy.key]: {model: catalog.legacy.p.model, unitPriceInc: existingPrice, locked: true},
      });
      cloud.installerMasterQuoteLogV1 = '[{"id":"saved-fixture","type":"Split","model":"Stored historical model","unitInc":432.1,"state":{"businessOperatingState":"QLD"}}]';
      await page.reload({waitUntil: 'domcontentloaded'});
      await page.waitForFunction(() => window.__calculatorReady === true);
      await page.evaluate(() => { refreshLiveRebateForCurrentProduct = async () => {}; refreshBestValueIndicator = () => {}; });
      assert.equal(await page.evaluate(model => allManagedProducts().find(item => item.p.model === model).p.unitPriceInc, privateItem.model), 1234.56);
      assert.equal(await page.evaluate(key => priceLocks[key].unitPriceInc, catalog.legacy.key), existingPrice);
      assert.equal(await page.evaluate(model => managedKeyForProduct('split', productListFor('split').find(p => p.model === model)), privateItem.model), privateItem.key);
      const boundaries = await page.evaluate(() => ({
        split: [7,7.1,8].map(c => defaultCostRuleFor('split','new',c).labour),
        ducted: [16,17,18].map(c => defaultCostRuleFor('ducted','replacement',c).labour),
        nominal: (() => {
          setSystem('ducted');setInstall('replacement');
          const p = data().find(p => p.defaultCostCapacityNum);
          $('brand').value = p.brand;populateProducts();$('product').value = String(data().indexOf(p));onProductChange({skipAsyncRefresh:true});
          return {rated: cap(p), cost: defaultCostCapacity(p), labour: $('labour').value, label: p.capacity};
        })(),
      }));
      assert.deepEqual(boundaries.split, [202,202,303]);assert.deepEqual(boundaries.ducted,[404,1500,606]);
      assert.deepEqual(boundaries.nominal,{rated:17,cost:18,labour:'606.00',label:'18.0kW nominal (17.0kW rated)'});
      await page.evaluate(() => {openPriceDrawer();});
      await page.locator('#priceDrawer .priceDefaultCosts summary').click();
      assert.equal(await page.locator('#defaultCostRows tr').count(), 14);
      const ruleId = configuration.defaultCostRules[0].id;
      const labourInput = page.locator(`[data-cost-rule="${ruleId}"] [data-field="labour"]`);
      await labourInput.fill('765.43');
      assert.equal(await page.evaluate(() => defaultCostRuleFor('split','new',3.5).labour),765.43);
      cloud.installerDefaultCostRulesV1 = await page.evaluate(() => localStorage.getItem('installerDefaultCostRulesV1'));
      await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(() => window.__calculatorReady === true);
      assert.equal(await page.evaluate(() => defaultCostRuleFor('split','new',3.5).labour),765.43);
      assert.equal(await page.evaluate(() => defaultCostRuleFor('split','new',8).labour),303);
      await page.evaluate(() => {refreshLiveRebateForCurrentProduct=async()=>{};refreshBestValueIndicator=()=>{};window.confirm=()=>true;resetDefaultCostRules();openPriceDrawer();});
      await page.locator('#priceDrawer .priceDefaultCosts summary').click();
      assert.equal(await page.evaluate(() => defaultCostRuleFor('split','new',3.5).labour),101);
      assert.equal(await page.locator('#defaultCostRows tr').count(),14);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),true,'No horizontal page overflow');
      if (process.env.BUSINESS_CONFIGURATION_SCREENSHOTS) {
        fs.mkdirSync(process.env.BUSINESS_CONFIGURATION_SCREENSHOTS,{recursive:true});
        await page.screenshot({path:path.join(process.env.BUSINESS_CONFIGURATION_SCREENSHOTS,`business-configuration-${width}.png`),animations:'disabled'});
      }
      // Same-profile absent configuration must clear an old local copy, not revive it.
      cloud = {};
      await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(() => window.__calculatorReady === true);
      assert.equal(await page.evaluate(() => activeBusinessConfiguration()),null);
      assert.equal(await page.evaluate(() => allManagedProducts().filter(item=>item.p.model.startsWith('PRIVATE-')).length),0);
      assert.equal(await page.evaluate(() => defaultCostRuleFor('split','new',7.1).labour),500);
      businessId=businessB;cloud={[key]:JSON.stringify(configuration)};
      await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(() => window.__calculatorReady === true);
      assert.equal(await page.evaluate(() => activeBusinessConfiguration()),null,'Wrong-business config rejected in the actual bootstrap');
      assert.equal(await page.evaluate(() => allManagedProducts().filter(item=>item.p.model.startsWith('PRIVATE-')).length),0);
      assert.deepEqual(errors,[]);
      console.log(`Business configuration browser ${width}: actual raw bootstrap, 17 private rows, legacy/private prices, custom rules, rated/nominal capacity, UI edits/reset/reload, absent/wrong-business isolation and layout passed.`);
      await page.close();
    }
    for (const legacyBridge of [true, false]) for (const configuredBefore of [false, true]) {
      const context = await browser.newContext();
      try {
        const priceKey = 'installerManagedPricesV1', quoteKey = 'installerMasterQuoteLogV1';
        const model = 'AOTG09KMTC/ASTG09KMTC';
        const prices = value => JSON.stringify({'split|0':{model,unitPriceInc:value,locked:true}});
        const initialData = {[priceKey]:prices(880)};
        if (configuredBefore) initialData[key] = JSON.stringify({...configuration,revision:'fixture-r1'});
        const imported = {business_id:businessA,data:{[key]:JSON.stringify(configuration),[priceKey]:prices(968)},updated_at:'2030-01-01T00:00:00.124789+00:00'};
        const endpoint = fixture.createSnapshotEndpoint({initialBusiness:{business_id:businessA,data:initialData,updated_at:'2030-01-01T00:00:00.123456+00:00'}});
        const requests = [], errors = [];
        let beaconResolve;
        const beaconSaved = new Promise(resolve => {beaconResolve=resolve;});
        await context.route('**/*',async route => {
          const request = route.request(), url = new URL(request.url());
          if (url.pathname === '/old') return route.fulfill({contentType:'text/html',body:bootstrapHtml(initialData,businessA,true,legacyBridge)});
          if (url.pathname === '/new') return route.fulfill({contentType:'text/html',body:bootstrapHtml(imported.data,businessA)});
          if (url.pathname === '/vendor/sortable-1.15.6.min.js') return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(root,'public/vendor/sortable-1.15.6.min.js'),'utf8')});
          if (url.pathname === '/api/calculator-data') {
            if (request.method() === 'GET') return route.fulfill({json:{data:{}}});
            const body = request.postDataJSON();
            const result = await endpoint.request(body,request.method());
            requests.push({method:request.method(),body,result});
            await route.fulfill({status:result.status,json:result.body});
            if (request.method() === 'POST') beaconResolve();
            return;
          }
          return route.abort();
        });
        const oldPage = await context.newPage();oldPage.on('pageerror',error=>errors.push(error.message));
        await oldPage.goto('http://127.0.0.1:43829/old',{waitUntil:'domcontentloaded'});
        await oldPage.waitForFunction(()=>window.__calculatorReady===true);
        assert.equal(await oldPage.evaluate(()=>priceLocks['split|0'].unitPriceInc),880);
        endpoint.state.business=structuredClone(imported);
        const newPage = await context.newPage();newPage.on('pageerror',error=>errors.push(error.message));
        await newPage.goto('http://127.0.0.1:43829/new',{waitUntil:'domcontentloaded'});
        await newPage.waitForFunction(()=>window.__calculatorReady===true);
        assert.equal(await oldPage.evaluate(key=>JSON.parse(localStorage.getItem(key)).revision,key),configuration.revision,'Actual tabs share the NEW configuration through localStorage');
        assert.equal(await oldPage.evaluate(()=>priceLocks['split|0'].unitPriceInc),880,'Old page still has old prices in memory');
        await oldPage.evaluate(async quoteKey=>{
          persistManagedPrices();
          localStorage.setItem(quoteKey,JSON.stringify([{id:'two-tab-quote',type:'Split',model:'Fixture quote',unitInc:880,syncUpdatedAt:1}]));
          await window.__calculatorFlushCloudSave(5000);
        },quoteKey);
        const oldSnapshot = requests.filter(row=>row.method==='PUT' && row.body.data?.[quoteKey]?.includes('two-tab-quote')).at(-1);
        assert.ok(oldSnapshot);assert.equal(oldSnapshot.result.status,200);
        const expectedRevision = configuredBefore?'fixture-r1':null;
        if (legacyBridge) {
          assert.equal(Object.hasOwn(oldSnapshot.body,'businessConfigurationRevision'),false,'Existing bridges do NOT send the new top-level field');
          assert.equal(JSON.parse(oldSnapshot.body.data[key]).revision,configuration.revision,'Legacy bridge can echo the NEW config, but must remain blocked');
        } else {
          assert.equal(oldSnapshot.body.businessConfigurationRevision,expectedRevision,'Autosave provenance is frozen at page bootstrap');
          assert.equal(oldSnapshot.body.data[key] ? JSON.parse(oldSnapshot.body.data[key]).revision : null,expectedRevision);
        }
        assert.equal(JSON.parse(endpoint.state.business.data[priceKey])['split|0'].unitPriceInc,968,'Old-tab autosave cannot revert 968 to 880');
        assert.equal(JSON.parse(endpoint.state.user.data[quoteKey])[0].id,'two-tab-quote','Old-tab quote still saves');
        // The new page must not attach its valid revision to the old page's stale storage prices.
        await newPage.evaluate(async()=>{await window.__calculatorFlushCloudSave(5000);});
        assert.equal(JSON.parse(endpoint.state.business.data[priceKey])['split|0'].unitPriceInc,968,'Current-page autosave uses its own prices, not stale shared storage');
        await newPage.evaluate(async()=>{priceLocks['split|0'].unitPriceInc=990;persistManagedPrices();await window.__calculatorFlushCloudSave(5000);});
        assert.equal(JSON.parse(endpoint.state.business.data[priceKey])['split|0'].unitPriceInc,990,'Current-page Price Manager edits remain accepted');
        await oldPage.evaluate(()=>{persistManagedPrices();window.dispatchEvent(new Event('beforeunload'));});
        await beaconSaved;
        const beacon = requests.filter(row=>row.method==='POST').at(-1);
        assert.equal(beacon.result.status,200);
        assert.equal(beacon.body.businessConfigurationRevision,legacyBridge?undefined:expectedRevision);
        assert.equal(JSON.parse(endpoint.state.business.data[priceKey])['split|0'].unitPriceInc,990,'Actual sendBeacon cannot revert current prices');
        await newPage.evaluate(async()=>{
          try {await window.__calculatorQuoteRequest('quoteCopy',{fixtureOnly:true});} catch(error) {if(error.status!==422) throw error;}
        });
        const quoteOnly = requests.find(row=>row.body.quoteCopy);
        assert.ok(quoteOnly);assert.equal(quoteOnly.body.businessConfigurationRevision,configuration.revision);
        assert.equal(quoteOnly.result.status,422,'Quote-only invalid fixture reaches existing validation, not snapshot/provenance rejection');
        assert.deepEqual(errors,[]);
        console.log(`Two-tab ${legacyBridge?'pre-provenance':'frozen-bootstrap'} ${configuredBefore?'old revision':'unconfigured'}: new LS config + old memory, real PUT/autosave, POST/sendBeacon, quote-only request, quote durability and current edits passed.`);
      } finally {await context.close();}
    }
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode=1;});
