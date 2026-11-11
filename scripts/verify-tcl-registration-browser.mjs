import assert from 'node:assert/strict';
import { createRequire, register } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import engine from '../services/nsw-rebate-backup/api/calculate.mjs';

register('./monitor-nsw-postcodes-loader.mjs', import.meta.url);
const { createGemsCalculationMetadata } = await import('../lib/gems-calculation-metadata.ts');
const { GEMS_VERIFIED_INVENTORY_SOURCE } = await import('../lib/gems-model-search.ts');
const root = resolve(import.meta.dirname, '..');
const html = await readFile(resolve(root, 'index.html'), 'utf8');
const fixture = JSON.parse(await readFile(resolve(root, 'scripts/fixtures/tcl-registration-estimates-20261112.json'), 'utf8'));
const records = fixture.records.map(({ resource, record }) => ({ ...record, [GEMS_VERIFIED_INVENTORY_SOURCE]: resource }));
const lookup = createGemsCalculationMetadata({ fetchInventory: async () => records });
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH);
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
const origin = 'http://tcl-registration.test';
const errors = [];
let primaryOutages = 0;
let metadataRequests = 0;
let behavior = 'ok';
const outputs = [];

try {
  for (const model of ['TAC-10CHSD/VEIH', 'TAC-13CHSD/VEIH']) {
    const page = await browser.newPage({ viewport: { width: 1365, height: 1000 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.CALCULATOR_USER = { businessId: 'isolated-test', businessOperatingState: 'NSW', role: 'admin', rebatesEnabled: false };
    });
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Expose-Headers': 'X-NSW-Calculation-Source' };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (url.origin === origin && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
      if (url.origin === origin && url.pathname === '/api/gems-model-metadata') {
        metadataRequests++;
        if (behavior === 'unavailable') return route.fulfill({ status: 503, json: { code: 'GEMS_UNAVAILABLE' } });
        try {
          const payload = await lookup(url.searchParams.get('brand'), url.searchParams.get('model'), {
            registrationEstimate: url.searchParams.get('registrationEstimate') === 'lower-total-v1',
          });
          if (behavior === 'missing') payload.registrationEstimate.candidates.pop();
          if (behavior === 'expired') payload.expiresAt = Date.now() - 1;
          return route.fulfill({ json: payload });
        } catch (error) { return route.fulfill({ status: error.status || 503, json: { code: error.code, error: error.message } }); }
      }
      if (url.hostname === 'of-sfg-rac-prd.energy.nsw.gov.au') { primaryOutages++; return route.abort('failed'); }
      if (url.hostname === 'rebate-portal-nsw-backup.vercel.app' && url.pathname === '/api/calculate') {
        const response = await engine.fetch(new Request(url, { method: request.method(), headers: { 'Content-Type': 'application/json' }, body: request.postData() }));
        return route.fulfill({ status: response.status, headers: { ...cors, ...Object.fromEntries(response.headers) }, body: await response.text() });
      }
      if (url.origin === origin && url.pathname === '/api/gems-model-search') return route.fulfill({ json: { brands: ['TCL'], models: [] } });
      if (url.origin === origin && url.pathname === '/api/calculator-guidance') return route.fulfill({ json: {} });
      return route.abort();
    });
    await page.goto(origin);
    const base = await page.evaluate(model => {
      window.CALCULATOR_USER.rebatesEnabled = true;
      systemType = 'split'; installType = 'new';
      $('essPostcode').value = '2756'; $('essClimateZone').value = 'auto';
      certValues.locked = false;
      $('essEscRate').value = '23.40'; $('essPrcRate').value = '2.35';
      const index = data().findIndex(p => p.brand === 'TCL' && p.model === model);
      if (index < 0) throw new Error('Missing catalogue product ' + model);
      populateBrands({ skipProductChange: true }); $('brand').value = 'TCL';
      populateProducts({ skipProductChange: true }); $('product').value = String(index);
      clearCertificateRuntime(); onProductChange({ skipAsyncRefresh: true });
      $('customer').value = 'Isolated TCL test'; ensureOptionDefs();
      quoteOptionDefs.find(row => row.id === currentAddOptionId()).name = 'Isolated TCL test';
      return { final: num('finalInc'), unitPrice: num('unitPriceInc') };
    }, model);
    assert.equal(await page.evaluate(() => refreshLiveRebateForCurrentProduct()), true);
    const result = await page.evaluate(() => ({ final: num('finalInc'), rebate: num('rebate'), estimate: currentRegistrationEstimate(), state: currentState() }));
    const values = result.estimate.registrationResults.map(row => row.esc * 23.4 + row.prc * 2.35);
    assert.equal(result.rebate, Number(Math.min(...values).toFixed(2)), 'Lower intact registration pair wins');
    assert.equal(result.final, Number(Math.max(0, base.final - result.rebate * 1.1).toFixed(2)), 'Rebate reduces new suggested customer price with existing GST basis');
    assert.equal(result.state.unitPriceInc, base.unitPrice.toFixed(2));
    assert.equal(result.state.rebateRegistrationEstimate.selectedRegistration, result.estimate.registration);
    assert.equal(await page.evaluate(() => $('rebate').readOnly), true, 'Estimate field is not manually editable');
    await page.evaluate(() => { $('rebate').value='9999'; render(); });
    assert.equal(await page.evaluate(() => num('rebate')), result.rebate, 'Rendering derives rebate from the verified result');
    await page.evaluate(() => refreshLiveRebateForCurrentProduct());
    assert.equal(await page.evaluate(() => num('finalInc')), result.final, 'Refresh must not subtract twice');
    await page.locator('button[onclick="addToQuote()"]:visible').first().click();
    const saved = await page.evaluate(() => JSON.stringify(quotes));
    const quote = JSON.parse(saved)[0];
    assert.equal(quote.model, model);
    assert.equal(quote.finalInc, result.final);
    assert.equal(quote.rebate, result.rebate);
    assert.equal(quote.state.rebateRegistrationEstimate.policy, 'lower-total-v1');

    const rateChange = await page.evaluate(() => {
      $('essEscRate').value = '60'; $('essPrcRate').value = '0.50';
      $('essEscRate').dispatchEvent(new Event('input', { bubbles: true }));
      return { rebate: num('rebate'), final: num('finalInc'), selected: currentRegistrationEstimate() };
    });
    const rateMinimum = Math.min(...rateChange.selected.registrationResults.map(row => row.esc * 60 + row.prc * 0.5));
    assert.equal(rateChange.rebate, Number(rateMinimum.toFixed(2)));
    assert.equal(await page.evaluate(() => JSON.stringify(quotes)), saved, 'Rate changes do not modify saved quotes');
    await page.evaluate(() => { finalPriceLocked = true; $('finalInc').value = '1234.56'; });
    await page.evaluate(() => refreshLiveRebateForCurrentProduct());
    assert.equal(await page.evaluate(() => num('finalInc')), 1234.56, 'Manual customer price remains locked');
    await page.evaluate(() => loadQuote(0));
    await page.waitForFunction(() => !liveRebateLoading);
    assert.equal(await page.evaluate(() => num('finalInc')), quote.finalInc, 'Loading saved quote preserves customer price');
    assert.equal(await page.evaluate(() => JSON.stringify(quotes)), saved);
    if (model === 'TAC-10CHSD/VEIH') {
      await page.evaluate(async () => {
        loadQuote(0);
        $('product').value=String(data().findIndex(p=>p.brand==='TCL'&&p.model==='TAC-13CHSD/VEIH'));
        onProductChange({skipAsyncRefresh:true});
        await refreshLiveRebateForCurrentProduct();
        createNewOptionNow('Different TCL model',true);
      });
      const changed = await page.evaluate(() => ({locked:finalPriceLocked,price:num('finalInc'),model:product().model,estimate:currentRegistrationEstimate()}));
      assert.equal(changed.locked,false,'Changing the product releases only the loaded snapshot lock');
      assert.equal(changed.model,'TAC-13CHSD/VEIH');
      assert.notEqual(changed.price,quote.finalInc);
      assert.equal(await page.evaluate(()=>JSON.stringify(quotes)),saved);
      await page.evaluate(async () => {
        $('product').value=String(data().findIndex(p=>p.brand==='TCL'&&p.model==='TAC-10CHSD/VEIH'));
        onProductChange({skipAsyncRefresh:true});await refreshLiveRebateForCurrentProduct();
      });
    }
    await page.evaluate(() => createNewOptionNow('New TCL destination', true));
    assert.equal(await page.evaluate(() => finalPriceLocked), false, 'A loaded snapshot lock is not inherited by a new quote');
    assert.equal(await page.evaluate(() => num('finalInc')), rateChange.final);
    assert.equal(await page.evaluate(() => JSON.stringify(quotes)), saved);

    // An All Models search hit with complete single-row metadata must still resolve both registrations.
    const beforeAll = metadataRequests;
    const all = await page.evaluate(async model => {
      essCache.gemsByLookup = {};
      allModelsSelected = { brand: 'TCL', model, productType: 'Non Ducted', completeEnergyData: true, metadata: {} };
      allModelsMode = 'single'; allModelsInstallType = 'new'; $('allModelsPostcode').value = '2756';
      await calculateAllModelsRebate();
      return $('allModelsRebateTotal').textContent;
    }, model);
    assert.ok(metadataRequests > beforeAll);
    assert.equal(Number(all.replace(/[^0-9.]/g, '')), Number(rateMinimum.toFixed(2)));

    const stale = await page.evaluate(() => {
      essRuntime.registrationExpiresAt = Date.now() - 1;
      addStandardSystemToQuoteNow();
      return { ready: standardRegistrationRebateReady(), quotes: JSON.stringify(quotes) };
    });
    assert.equal(stale.ready, false); assert.equal(stale.quotes, saved);
    for (behavior of ['missing', 'expired', 'unavailable']) {
      await page.evaluate(() => { essCache.gemsByLookup = {}; });
      await page.evaluate(() => refreshLiveRebateForCurrentProduct());
      assert.equal(await page.evaluate(() => standardRegistrationRebateReady()), false, behavior);
      await page.evaluate(() => addStandardSystemToQuoteNow());
      assert.equal(await page.evaluate(() => JSON.stringify(quotes)), saved, 'Failed estimate must not add a zero-rebate quote');
      const exports = await page.evaluate(() => {
        let attempts=0;const original=window.open;window.open=()=>{attempts++;return null;};
        $('proposalSource').value='current';generateProposalPdf();const current=attempts;
        $('proposalSource').value='quote';generateProposalPdf();window.open=original;
        return {current,saved:attempts-current};
      });
      assert.deepEqual(exports, {current:0,saved:1}, 'Unavailable current-system export is blocked; saved quote exports are unchanged');
    }
    behavior = 'ok';
    await page.evaluate(() => { essCache.gemsByLookup = {}; finalPriceLocked = false; });
    await page.evaluate(() => refreshLiveRebateForCurrentProduct());
    assert.equal(await page.evaluate(() => standardRegistrationRebateReady()), true);
    await page.evaluate(() => { $('essPostcode').value = '2213'; });
    assert.equal(await page.evaluate(() => standardRegistrationRebateReady()), false, 'Input-only context change invalidates old estimate');
    await page.evaluate(() => refreshLiveRebateForCurrentProduct());
    assert.equal(await page.evaluate(() => standardRegistrationRebateReady()), true);
    await page.evaluate(() => { installType = 'replacement'; });
    assert.equal(await page.evaluate(() => standardRegistrationRebateReady()), false);
    await page.evaluate(() => refreshLiveRebateForCurrentProduct());
    assert.equal(await page.evaluate(() => standardRegistrationRebateReady()), true);
    assert.equal(await page.evaluate(() => JSON.stringify(quotes)), saved);
    const synthetic = await page.evaluate(() => {
      const ids=tclRegistrationEstimateIds(product().brand,product().model);
      $('essPostcode').value='2311';installType='replacement';
      $('essEscRate').value='1';$('essPrcRate').value='1';finalPriceLocked=false;loadedTclQuotePrice=null;
      essRuntime.registrationContext=registrationEstimateContext();
      essRuntime.registrationResults=[{registration:ids[0],esc:2,prc:100},{registration:ids[1],esc:10,prc:10}];
      applyAuthoritativeDcceewContractData({rate:30,postcodes:[],productKeys:[]});
      render();const before={rebate:num('rebate'),final:num('finalInc'),registration:currentRegistrationEstimate().registration};
      applyAuthoritativeDcceewContractData({rate:30,postcodes:[2311],productKeys:[dcceewProductKey(product().brand,product().model)]});
      addStandardSystemToQuoteNow();const contracted=quotes[0];
      essRuntime.registrationResults=ids.map(registration=>({registration,esc:0,prc:0}));
      render();addStandardSystemToQuoteNow();const zero=quotes[0];
      return {ids,before,contracted,zero,zeroStored:savedQuoteStoredRebate(zero),zeroRecomputed:recomputeSavedQuote(JSON.parse(JSON.stringify(zero))).rebate};
    });
    assert.equal(synthetic.before.registration, synthetic.ids[1]);
    assert.equal(synthetic.before.rebate, 20);
    assert.equal(synthetic.contracted.rebate, 160);
    assert.equal(synthetic.contracted.state.rebateRegistrationEstimate.selectedRegistration, synthetic.ids[0]);
    assert.equal(synthetic.contracted.state.rebateRegistrationEstimate.escRate, 30);
    assert.equal(synthetic.contracted.finalInc, Number((synthetic.before.final - 140*1.1).toFixed(2)));
    assert.equal(synthetic.zero.rebate, 0);
    assert.equal(synthetic.zeroStored, 0);
    assert.equal(synthetic.zeroRecomputed, 0, 'Verified zero is never replaced with the catalogue rebate');
    await page.evaluate(() => { applyAuthoritativeDcceewContractData({rate:30,postcodes:[],productKeys:[]},true); });
    await page.evaluate(() => refreshLiveRebateForCurrentProduct());
    await mkdir(resolve(root, 'outputs/tcl-registration'), { recursive: true });
    await page.locator('#brand').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(root, `outputs/tcl-registration/${model.slice(0, 8)}-desktop.png`) });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: resolve(root, `outputs/tcl-registration/${model.slice(0, 8)}-mobile.png`) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    outputs.push({ model, rebate2756New: result.rebate, finalInc: result.final, registrations: result.estimate.registrationResults.map(row => row.registration) });
    await page.close();
  }
  assert.ok(primaryOutages > 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ outputs, metadataRequests, primaryOutages, checks: 'Both sizes: real engine, new/replacement, lower pair, new quote deduction once, rate changes, locked/loaded prices, saved quotes, provenance, All Models, context/expiry/failure guards, mobile/desktop. No live network or data writes.' }, null, 2));
} finally { await browser.close(); }
