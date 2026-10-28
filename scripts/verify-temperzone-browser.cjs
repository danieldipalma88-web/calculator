const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const root=path.resolve(__dirname,'..');
const models=JSON.parse(fs.readFileSync(path.join(root,'scripts/fixtures/temperzone-templite-gems.json'),'utf8')).models;
(async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    for(const width of [1440,390,320]){
      const page=await browser.newPage({viewport:{width,height:900}});
      const errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.route('**/*',route=>new URL(route.request().url()).pathname==='/'
        ?route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(root,'index.html'),'utf8')})
        :route.abort());
      await page.addInitScript(()=>{window.CALCULATOR_USER={role:'admin',businessId:'test',businessName:'Example Air',businessOperatingState:'NSW'};});
      await page.goto('http://127.0.0.1:43823/',{waitUntil:'domcontentloaded'});
      // Isolate catalogue rendering; live calculations are checked separately against public services.
      await page.evaluate(()=>{
        refreshLiveRebateForCurrentProduct=async()=>{};
        refreshBestValueIndicator=()=>{};
        setSystem('ducted');$('brand').value='Temperzone';populateProducts();
      });
      assert.equal(await page.locator('#product option').count(),5);
      for(const registered of models){
        const index=await page.evaluate(model=>data().findIndex(row=>row.model===model),registered.model);
        await page.locator('#product').selectOption(String(index));
        assert.equal(await page.locator('#unitPriceInc').inputValue(),'0.00');
        assert.equal(await page.locator('#wifiMeta').innerText(),'Wi-Fi unconfirmed');
        assert.equal(await page.locator('#warrantyMeta').innerText(),'5 yrs parts & labour (conditions apply)');
        assert.equal(await page.locator('#originMeta').innerText(),'New Zealand');
        const readiness=await page.evaluate(()=>standardQuotePriceReadiness());
        assert.equal(readiness.ok,false,'Missing equipment price cannot be quoted');
      }
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'No mobile horizontal overflow');
      if(process.env.TEMPERZONE_SCREENSHOTS){
        fs.mkdirSync(process.env.TEMPERZONE_SCREENSHOTS,{recursive:true});
        await page.screenshot({path:path.join(process.env.TEMPERZONE_SCREENSHOTS,'temperzone-'+width+'.png'),animations:'disabled'});
      }
      await page.evaluate(()=>{
        window.CALCULATOR_USER.businessName='Andos Air';
        setSystem('ducted');$('brand').value='Temperzone';populateProducts();
      });
      assert.equal(await page.locator('#product option').count(),5,'Partner catalogue also includes five units');
      await page.evaluate(()=>{
        window.CALCULATOR_USER.businessName='Example Air';
        window.CALCULATOR_USER.role='salesperson';setSystem('ducted');
      });
      assert.equal(await page.locator('#brand option').filter({hasText:'Temperzone'}).count(),0,'Unpriced models remain hidden for salesperson accounts');
      assert.deepEqual(errors,[]);
      console.log('Temperzone browser '+width+': product list, support info, price guard and partner/salesperson views passed.');
      await page.close();
    }
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
