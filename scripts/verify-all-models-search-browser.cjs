const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(process.env.ALL_MODELS_SEARCH_HTML||path.join(root,'index.html'),'utf8');
const screenshotDir=path.join(root,'outputs','all-models-search-20261029');
const pairModels=[
  {brand:'Daikin',model:'RXM35AVMA / FTXM35AVMA',capacityKw:3.5,family:'Alira X',productType:'Non Ducted Unitary System'},
  {brand:'Daikin',model:'RXM35AVMA',capacityKw:3.5,family:'Alira X',productType:'Non Ducted Unitary System'},
  {brand:'Daikin',model:'FTXM35AVMA',capacityKw:3.5,family:'Alira X',productType:'Non Ducted Unitary System'},
];
const json=(body,status=200)=>({status,contentType:'application/json',body:JSON.stringify(body)});
const tick=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
  try{
    fs.mkdirSync(screenshotDir,{recursive:true});
    for(const width of [1280,390]){
      const page=await browser.newPage({viewport:{width,height:900}});
      const errors=[];page.on('pageerror',error=>errors.push(error.message));
      const pending=new Map();
      await page.route('**/*',async route=>{
        const url=new URL(route.request().url());
        if(url.pathname==='/') return route.fulfill({contentType:'text/html',body:html});
        if(url.pathname==='/api/gems-model-search'){
          const q=url.searchParams.get('q')||'';
          if(url.searchParams.get('mode')==='brands') return route.fulfill(json({brands:['Daikin']}));
          if(q==='MALFORMED') return route.fulfill(json({models:{}}));
          return new Promise(resolve=>pending.set(q,async body=>{
            try{await route.fulfill(json(body));}catch{}
            resolve();
          }));
        }
        return route.abort();
      });
      await page.addInitScript(()=>{window.CALCULATOR_USER={role:'admin',businessId:'search-test',businessName:'Example Air',businessOperatingState:'NSW'};});
      await page.goto('http://127.0.0.1:43823/',{waitUntil:'domcontentloaded'});
      await page.locator('#allModelsTab').click();
      await page.locator('#allModelsBrand').selectOption({label:'Daikin'});
      const input=page.locator('#allModelsSearch');
      const results=page.locator('#allModelsSearchResults');
      const spinner=page.locator('#allModelsSearchSpinner');
      const option=()=>results.locator('[role="option"]');
      const fulfill=async(q,body)=>{assert.equal(pending.has(q),true,`${q} request is pending`);await pending.get(q)(body);};

      await input.fill('RXM35AVMA');
      assert.match(await results.innerText(),/Searching the GEMS register/,'valid query visibly replaces results during debounce');
      assert.equal(await spinner.isVisible(),true,'debounce period exposes busy state');
      await tick(300);
      await fulfill('RXM35AVMA',{models:pairModels});
      await page.waitForFunction(()=>document.querySelector('#allModelsSearchResults')?.innerText.includes('RXM35AVMA / FTXM35AVMA'));
      await option().filter({hasText:'RXM35AVMA / FTXM35AVMA'}).click();
      assert.match(await page.locator('#allModelsSelectedModel').innerText(),/RXM35AVMA \/ FTXM35AVMA/,'exact matched pair can be selected');
      assert.equal(await results.evaluate(el=>el.classList.contains('open')),false,'selection closes dropdown');
      await page.screenshot({path:path.join(screenshotDir,`all-models-search-${width}.png`),animations:'disabled'});

      await input.fill('OLDQUERY');await tick(300);
      assert.equal(pending.has('OLDQUERY'),true);
      await input.fill('NEWQUERY');
      assert.equal(await option().count(),0,'old options clear synchronously on input');
      assert.match(await results.innerText(),/Searching the GEMS register/,'debounce visibly presents current query state');
      assert.equal(await spinner.isVisible(),true,'spinner remains on for current debounced query');
      await fulfill('OLDQUERY',{models:[{brand:'Daikin',model:'STALE-OLD-QUERY'}]});
      await tick(20);
      assert.doesNotMatch(await results.innerText(),/STALE-OLD-QUERY/,'prior response during debounce cannot paint');
      assert.equal(await spinner.isVisible(),true,'stale response cannot clear current spinner');
      await tick(280);
      await fulfill('NEWQUERY',{models:pairModels});
      await page.waitForFunction(()=>document.querySelector('#allModelsSearchResults')?.innerText.includes('RXM35AVMA / FTXM35AVMA'));
      await input.fill('ZXQ');
      assert.equal(await option().count(),0,'old rows cannot remain available to Enter');
      assert.match(await results.innerText(),/Searching the GEMS register/);
      await input.press('Enter');
      assert.match(await page.locator('#allModelsSelectedModel').innerText(),/Select a registered model/,'Enter cannot select old rows during debounce');

      await input.fill('');
      assert.equal(await spinner.isVisible(),false,'blank query resets spinner immediately');
      assert.equal(await results.evaluate(el=>el.classList.contains('open')),false,'blank query closes suggestions');
      await tick(300);
      assert.equal(pending.has('ZXQ'),false,'blank query cancels debounce');

      await input.fill('BRANDCHANGE');await tick(300);
      assert.equal(pending.has('BRANDCHANGE'),true);
      await page.locator('#allModelsBrand').selectOption('');
      assert.equal(await spinner.isVisible(),false,'brand change resets spinner and aborts search');
      await fulfill('BRANDCHANGE',{models:[{brand:'Daikin',model:'LATE-BRAND'}]});
      await tick(20);
      assert.doesNotMatch(await results.innerText(),/LATE-BRAND/);
      await input.fill('AVMA');
      assert.match(await results.innerText(),/Select a brand first/,'missing brand is reported without starting search');
      assert.equal(await spinner.isVisible(),false,'missing brand never shows search busy state');

      await page.locator('#allModelsBrand').selectOption({label:'Daikin'});
      await input.fill('SELECTME');await tick(300);
      await fulfill('SELECTME',{models:[{brand:'Daikin',model:'SELECTME-PAIR'}]});
      await page.waitForFunction(()=>document.querySelector('#allModelsSearchResults')?.innerText.includes('SELECTME-PAIR'));
      await option().filter({hasText:'SELECTME-PAIR'}).click();
      assert.match(await page.locator('#allModelsSelectedModel').innerText(),/SELECTME-PAIR/);
      await tick(300);
      assert.equal(await results.evaluate(el=>el.classList.contains('open')),false,'selection cannot be undone by a late timer or reopen results');

      await input.fill('MALFORMED');await tick(300);
      await page.waitForFunction(()=>document.querySelector('#allModelsSearchResults')?.innerText.includes('invalid response'));
      assert.match(await results.innerText(),/Search unavailable.*invalid response/i,'malformed payload is an error, not empty results');
      assert.doesNotMatch(await results.innerText(),/No matching available/);
      assert.deepEqual(errors,[]);
      console.log(`All Models search browser ${width}: pair selection, debounce visuals, stale-response/input races, cancellation, spinner, selection timer, malformed payload passed.`);
      await page.close();
    }
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
