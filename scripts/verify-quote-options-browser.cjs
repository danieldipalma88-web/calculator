const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const root=path.resolve(__dirname,'..');
const output=process.env.QUOTE_OPTIONS_SCREENSHOTS;
(async()=>{
  const {applyQuoteArrange}=await import(pathToFileURL(path.join(root,'lib/quote-arrange.ts')));
  const raw=fs.readFileSync(path.join(root,'app/calculator/raw/route.ts'),'utf8');
  const wrapper=raw.slice(raw.indexOf('  window.__calculatorQuoteRequest ='),raw.indexOf('  function scheduleSync(force)'));
  const browser=await chromium.launch({headless:true});
  try{
    for(const width of process.env.QUOTE_OPTIONS_WIDTHS?process.env.QUOTE_OPTIONS_WIDTHS.split(',').map(Number):[1440,390,320]){
      const page=await browser.newPage({viewport:{width,height:width===1440?1050:844},hasTouch:width!==1440});
      let data={},loseResponse=false;
      let responseGate=Promise.resolve(),releaseResponse;
      const holdResponse=()=>{responseGate=new Promise(resolve=>{releaseResponse=()=>{responseGate=Promise.resolve();resolve();};});};
      const requests=[],errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.route('**/*',async route=>{
        const url=new URL(route.request().url());
        if(url.pathname==='/') return route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(root,'index.html'),'utf8')});
        if(url.pathname==='/vendor/sortable-1.15.6.min.js') return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(root,'public/vendor/sortable-1.15.6.min.js'),'utf8')});
        if(url.pathname==='/api/calculator-data'){
          const request=route.request().postDataJSON();requests.push(request);
          const result=applyQuoteArrange(data,request.quoteArrange,true);
          if(result.data)data=result.data;
          await responseGate;
          if(loseResponse){loseResponse=false;return route.fulfill({status:503,json:{error:'Test response lost after save'}});}
          const {data:ignored,...response}=result;
          return route.fulfill({status:result.status||200,json:response});
        }
        return route.abort();
      });
      await page.addInitScript(()=>{window.CALCULATOR_USER={role:'admin',businessId:'test',businessName:'Example Air',businessOperatingState:'NSW',canSeeAgencyProfit:true};});
      await page.goto('http://127.0.0.1:43822/',{waitUntil:'domcontentloaded'});
      await page.evaluate(()=>{
        ensureSecondaryStartup();
        const products=SPLIT_PRODUCTS.filter(p=>p.brand==='Daikin'&&p.series==='Cora').slice(0,2);
        quoteOptionDefs=[{id:'customer-a',name:'Taylor Smith',syncUpdatedAt:10},{id:'other',name:'Unrelated customer',syncUpdatedAt:10}];
        quotes=products.map((p,i)=>({id:'system-'+i,optionId:'customer-a',optionName:'Taylor Smith',brand:p.brand,model:p.model,series:p.series,size:p.capacity,type:'Split',install:'Replacement',finalInc:2200+i*1000,unitInc:1100,labour:500,materialsInc:200,miscInc:0,powerCost:0,rebate:500,netProfit:600,commissionInc:100,salespersonCommissionInc:50,commissionType:'none',labourTreatment:'Expense',timestamp:10,syncUpdatedAt:10,state:{systemType:'split',businessId:'test',businessName:'Example Air',postcode:'2000',model:p.model,brand:p.brand,commissionType:'none'}}));
        quotes.push({...structuredClone(quotes[0]),id:'unrelated-row',optionId:'other',optionName:'Historic unchanged spelling',customNote:'Preserve'});
        renderOptionSelectors();syncAddOptionSelects('customer-a');renderCurrentOptionPanel();
        quotes.at(-1).optionName='Historic unchanged spelling';
      });
      data=await page.evaluate(()=>({installerMasterQuoteLogV1:JSON.stringify(quotes),installerQuoteOptionDefsV1:JSON.stringify(quoteOptionDefs)}));
      const original=structuredClone(data);
      await page.addScriptTag({content:"var calculatorSyncUrl='/api/calculator-data',businessConfigurationRevision=null,quoteArrangeAttempt=null;window.__calculatorFlushCloudSave=async()=>({ok:true});function setCloudSaveStatus(){}function scheduleSync(){}\n"+wrapper});
      await page.locator('#currentOptionTitle').evaluate(el=>el.scrollIntoView({block:'start',behavior:'instant'}));
      assert.equal(await page.locator('.quoteChoice').count(),1);
      const profit=page.locator('section[data-option-id="customer-a"] .quoteChoiceProfit');
      assert.equal(await profit.isVisible(),true,'Profit is visible without expansion');
      assert.deepEqual(await profit.locator('dt').allTextContents(),['Installer profit ex GST','Salesperson commission payable','Agency profit inc GST']);
      assert.deepEqual(await profit.locator('dd').allTextContents(),['$1,200.00','$100.00','$0.00']);
      assert.equal(await page.locator('[data-row-id="system-0"] .quoteChoiceRemove').isVisible(),true,'Remove is a direct action');
      page.once('dialog',dialog=>dialog.dismiss());
      await page.locator('[data-row-id="system-0"] .quoteChoiceRemove').click();
      assert.equal(requests.length,0,'Cancelling remove does not save or delete');
      assert.equal(await page.locator('[data-row-id="system-0"]').count(),1);
      const costSummary=page.locator('[data-row-id="system-0"] .quoteChoiceCostSummary');
      assert.equal(await costSummary.isVisible(),true);
      assert.deepEqual(await costSummary.locator('dt').allTextContents(),['Equipment inc GST','Labour ex GST','Materials inc GST','Saved rebate','Electrical ex GST','Misc inc GST']);
      assert.deepEqual(await costSummary.locator('dd').allTextContents(),['$1,100.00','$500.00','$200.00','$500.00','$0.00','$0.00']);
      assert.equal(await page.locator('[data-row-id="system-0"] > details').getAttribute('open'),null,'Basic costs do not require expansion');
      await page.evaluate(()=>{window.__calculatorFlushCloudSave=()=>new Promise(resolve=>{window.releaseTestFlush=resolve;});});
      holdResponse();
      await page.locator('#currentOptionBody').getByRole('button',{name:'+ Add option',exact:true}).click();
      await page.locator('#quoteNameModalInput').fill('Rinnai alternative');
      await page.locator('#quoteNameModalSubmit').click();
      await page.locator('#quoteChoiceProgress[open]').waitFor();
      assert.equal(await page.locator('#quoteChoiceProgressTitle').innerText(),'Creating option...');
      assert.equal(await page.locator('#quoteChoiceProgressStage').innerText(),'Saving current changes...');
      assert.equal(requests.length,0,'Option request waits for durable quote save');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#quoteChoiceProgress').isVisible(),true,'Escape cannot hide an in-flight save');
      await page.evaluate(()=>{window.releaseTestFlush({ok:true});window.__calculatorFlushCloudSave=async()=>({ok:true});});
      await page.waitForFunction(()=>$('quoteChoiceProgressStage').textContent==='Confirming the option changes...');
      assert.equal(await page.locator('.quoteChoice').count(),1,'New option is not displayed as saved prematurely');
      const progressBox=await page.locator('#quoteChoiceProgress').boundingBox();
      assert.ok(progressBox.x>=0&&progressBox.y>=0&&progressBox.x+progressBox.width<=width+1,'Progress dialog fits the viewport');
      if(width===1440)await page.locator('#quoteChoiceProgressSlow').getByText('This is taking a little longer. Still waiting for save confirmation.',{exact:true}).waitFor();
      if(output){fs.mkdirSync(output,{recursive:true});await page.screenshot({path:path.join(output,'quote-options-saving-'+width+'.png'),animations:'disabled'});}
      releaseResponse();
      await page.waitForFunction(()=>!quoteArrangeBusy&&!quoteArrangePending);
      assert.equal(await page.locator('#quoteChoiceProgress').isVisible(),false);
      assert.equal(await page.evaluate(()=>document.activeElement?.id),'quoteChoicesStatus','Successful name dialog save restores visible focus');
      assert.equal(await page.evaluate(()=>quoteChoiceProgressTimer),null,'Slow-save timer is cleared');
      assert.equal(await page.locator('.quoteChoice').count(),2);
      const second=await page.evaluate(()=>quoteOptionDefs.find(def=>def.quoteOptionName==='Rinnai alternative').id);
      assert.equal(await page.locator('#addOptionSelect').inputValue(),second);
      assert.match(await page.locator('#mainOptionName').innerText(),/Taylor Smith.*Rinnai alternative/);
      assert.match(await page.locator('#addOptionSelect option:checked').innerText(),/Taylor Smith.*Rinnai alternative/);
      assert.equal(await page.locator('#copyQuoteInfoBtn').innerText(),'Copy quote info');
      assert.equal(await page.locator('#copyQuoteInfoBtn').isEnabled(),true,'An empty selected alternative does not block copying populated options');
      const beforeSelect=requests.length;
      await page.locator('[data-row-id="system-0"] > details').evaluate(el=>{el.open=true;window.testStableCard=el;});
      const firstDestination=page.locator('section[data-option-id="customer-a"] .quoteChoiceSelect');
      await firstDestination.click();
      assert.equal(await firstDestination.getAttribute('aria-pressed'),'true');
      assert.match(await firstDestination.innerText(),/Adding here/);
      assert.equal(await page.evaluate(()=>currentAddOptionId()),'customer-a');
      assert.equal(await page.evaluate(()=>window.testStableCard.isConnected&&window.testStableCard.open),true,'Selecting destination preserves expanded system details');
      assert.equal(await firstDestination.evaluate(el=>el===document.activeElement),true,'Destination keeps keyboard focus');
      for(const id of ['addOptionSelect','multiAddOptionSelect']) assert.equal(await page.locator('#'+id).inputValue(),'customer-a','Destination shared with '+id);
      const secondDestination=page.locator('section[data-option-id="'+second+'"] .quoteChoiceSelect');
      await secondDestination.focus();await page.keyboard.press('Enter');
      assert.equal(await secondDestination.getAttribute('aria-pressed'),'true','Keyboard selects destination');
      assert.equal(await page.evaluate(()=>currentAddOptionId()),second);
      assert.equal(requests.length,beforeSelect,'Switching destination never waits for a network save');
      await page.locator('[data-row-id="system-0"] > details').evaluate(el=>{el.open=false;});
      assert.match(await page.locator('#addOptionSelect').evaluate(el=>el.closest('.quoteSearchPicker').querySelector('.quoteSearchInput').value),/Taylor Smith.*Rinnai alternative/,'Visible custom picker names the destination option');
      const picker=page.locator('.quoteSearchPicker').filter({has:page.locator('#addOptionSelect')});
      await picker.locator('.quoteSearchInput').fill('Rinnai');
      assert.equal(await picker.locator('.quoteSearchOption').count(),1,'Search can narrow by option name');
      assert.match(await picker.locator('.quoteSearchOption').innerText(),/Rinnai alternative/);
      await picker.locator('.quoteSearchInput').press('Escape');
      // Move through the explicit control: keyboard/touch fallback uses the same transaction as drag.
      await page.locator('[data-row-id="system-1"] .quoteChoiceActions summary').click();
      await page.locator('[data-row-id="system-1"] .quoteChoiceActions').getByRole('button',{name:'Move to option',exact:true}).click();
      await page.locator('#quoteChoiceMoveTarget').selectOption(second);
      await page.locator('#quoteChoiceMoveDialog').getByRole('button',{name:'Move system',exact:true}).click();
      await page.waitForFunction(()=>!quoteArrangeBusy&&!quoteArrangePending);
      assert.equal(await page.evaluate(()=>quotes.find(row=>row.id==='system-1').optionId),second);
      assert.match(await page.locator('[data-option-id="customer-a"] > .quoteChoiceHeader .quoteChoiceTotal').innerText(),/2,200/);
      assert.match(await page.locator('section[data-option-id="'+second+'"] .quoteChoiceTotal').innerText(),/3,200/);
      const moved=JSON.parse(data.installerMasterQuoteLogV1).find(row=>row.id==='system-1');
      const initial=JSON.parse(original.installerMasterQuoteLogV1).find(row=>row.id==='system-1');
      for(const key of ['finalInc','unitInc','rebate','state','salespersonCommissionInc','commissionInc'])assert.deepEqual(moved[key],initial[key],key+' preserved during move');
      await page.evaluate(()=>{window.originalTestCopy=copyQuoteChoiceText;copyQuoteChoiceText=async text=>{window.testCopiedText=text;};});
      await page.locator('#copyQuoteInfoBtn').click();
      const allOptionsText=await page.evaluate(()=>window.testCopiedText);
      assert.match(allOptionsText,/short friendly email with a subject line, and a concise text message/);
      assert.match(allOptionsText,/Option: Option 1/);assert.match(allOptionsText,/Option: Rinnai alternative/);
      assert.match(allOptionsText,/\$2,200\.00/);assert.match(allOptionsText,/\$3,200\.00/);
      assert.doesNotMatch(allOptionsText,/\$5,400\.00/,'Alternatives are not added into a combined price');
      assert.match(allOptionsText,/Wi-Fi:/);assert.match(allOptionsText,/Warranty:/);
      assert.doesNotMatch(allOptionsText,/Installer profit ex GST:|Salesperson commission payable:|Equipment inc GST:/);
      await page.locator('section[data-option-id="customer-a"]').getByRole('button',{name:'Copy option info',exact:true}).click();
      const singleOptionText=await page.evaluate(()=>window.testCopiedText);
      assert.match(singleOptionText,/Option: Option 1/);assert.doesNotMatch(singleOptionText,/Rinnai alternative|\$3,200\.00/);
      assert.match(singleOptionText,/friendly customer email/);assert.match(singleOptionText,/concise text message/);
      assert.match(singleOptionText,/Wi-Fi:/);assert.match(singleOptionText,/Warranty:/);
      await page.evaluate(()=>{copyQuoteChoiceText=window.originalTestCopy;});
      await page.getByRole('button',{name:'Undo move',exact:true}).click();
      await page.waitForFunction(()=>!quoteArrangeBusy&&!quoteArrangePending);
      assert.equal(await page.evaluate(()=>quotes.find(row=>row.id==='system-1').optionId),'customer-a');
      // A confirmed server move remains retryable if applying it to local storage fails.
      await page.evaluate(id=>{
        const original=Storage.prototype.setItem;
        window.restoreTestStorage=()=>{Storage.prototype.setItem=original;};
        let fail=true;
        Storage.prototype.setItem=function(key,value){
          if(key===QUOTE_STORAGE_KEY&&fail){fail=false;throw new Error('Test local quote storage unavailable');}
          return original.call(this,key,value);
        };
        moveQuoteChoiceRow('system-1',id,'',false);
      },second);
      await page.getByRole('button',{name:'Retry save',exact:true}).waitFor();
      assert.equal(JSON.parse(data.installerMasterQuoteLogV1).find(row=>row.id==='system-1').optionId,second,'Server move committed before local write failure');
      assert.equal(await page.evaluate(()=>quotes.find(row=>row.id==='system-1').optionId),'customer-a','Local original remains available after failed application');
      await page.evaluate(()=>{
        window.restoreTestStorage();localStorage.setItem('draft','unsent edit while result is pending');
        window.__calculatorFlushCloudSave=async()=>{throw new Error('Retry must not preflush stale layout');};
      });
      await page.getByRole('button',{name:'Retry save',exact:true}).click();
      await page.waitForFunction(()=>!quoteArrangeBusy&&!quoteArrangePending);
      assert.equal(requests.at(-1).quoteArrange.saveId,requests.at(-2).quoteArrange.saveId,'Local patch retry checks the same server receipt');
      assert.equal(await page.evaluate(()=>quoteArrangeAttempt),null,'Successful local application acknowledges the arrangement');
      await page.evaluate(()=>{window.__calculatorFlushCloudSave=async()=>({ok:true});});
      await page.getByRole('button',{name:'Undo move',exact:true}).click();
      await page.waitForFunction(()=>!quoteArrangeBusy&&!quoteArrangePending);
      // Failure before the mutation must release the modal and retain the exact retry request.
      const requestsBeforeFlushFailure=requests.length;
      await page.evaluate(id=>{
        window.__calculatorFlushCloudSave=async()=>{throw new Error('Test pending changes could not be saved');};
        quoteChoiceAction('renameOption',quoteLibraryArg(id));
      },second);
      await page.locator('#quoteNameModalSubmit').click();
      await page.getByRole('button',{name:'Retry save',exact:true}).waitFor();
      assert.equal(await page.locator('#quoteChoiceProgress').isVisible(),false);
      assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'Retry save','Failed name dialog save focuses its recovery action');
      assert.equal(requests.length,requestsBeforeFlushFailure);
      await page.evaluate(()=>{window.__calculatorFlushCloudSave=async()=>({ok:true});});
      await page.getByRole('button',{name:'Retry save',exact:true}).click();
      await page.waitForFunction(()=>!quoteArrangeBusy&&!quoteArrangePending);
      // Lost response retry must create only one option and keep the same idempotency key.
      loseResponse=true;
      await page.evaluate(()=>quoteChoiceAction('duplicateOption',quoteLibraryArg('customer-a')));
      await page.getByRole('button',{name:'Retry save',exact:true}).waitFor();
      assert.equal(await page.locator('#quoteChoiceProgress').isVisible(),false,'Lost response must release progress and expose retry');
      const countAfterSave=JSON.parse(data.installerQuoteOptionDefsV1).length;
      await page.getByRole('button',{name:'Retry save',exact:true}).click();
      await page.waitForFunction(()=>!quoteArrangeBusy&&!quoteArrangePending);
      assert.equal(JSON.parse(data.installerQuoteOptionDefsV1).length,countAfterSave);
      assert.equal(requests.at(-1).quoteArrange.saveId,requests.at(-2).quoteArrange.saveId);
      // Copy retains original and moves only a new ID.
      await page.evaluate(id=>moveQuoteChoiceRow('system-0',id,'',true),second);
      await page.waitForFunction(()=>!quoteArrangeBusy&&!quoteArrangePending);
      assert.equal(await page.evaluate(()=>quotes.find(row=>row.id==='system-0').optionId),'customer-a');
      assert.equal(await page.evaluate(id=>quoteChoiceRows(id).length,second),1);
      // A stale snapshot cannot overwrite a concurrent edit; load the fresh family explicitly.
      const concurrent=JSON.parse(data.installerMasterQuoteLogV1);
      concurrent.find(row=>row.id==='system-0').finalInc=2250;
      concurrent.find(row=>row.id==='system-0').syncUpdatedAt=Date.now()+500;
      data.installerMasterQuoteLogV1=JSON.stringify(concurrent);
      await page.evaluate(id=>moveQuoteChoiceRow('system-0',id,'',false),second);
      await page.getByRole('button',{name:'Load latest options',exact:true}).waitFor();
      assert.equal(await page.evaluate(()=>quotes.find(row=>row.id==='system-0').finalInc),2200);
      await page.getByRole('button',{name:'Load latest options',exact:true}).click();
      assert.equal(await page.evaluate(()=>quotes.find(row=>row.id==='system-0').finalInc),2250);
      assert.equal(await page.evaluate(()=>savedQuoteSets[0].quotes.find(row=>row.id==='system-0').finalInc),2200,'Conflict recovery keeps the prior local version in backups');
      const after=await page.evaluate(()=>({row:quotes.find(row=>row.id==='unrelated-row'),defs:quoteOptionDefs,copy:buildAllQuoteChoicesInfo(quoteFamilyDefs('customer-a'))}));
      assert.deepEqual(after.row,JSON.parse(original.installerMasterQuoteLogV1).find(row=>row.id==='unrelated-row'),'Unrelated row remains exact');
      assert.match(after.copy,/Never add the options together/);assert.match(after.copy,/Wi-Fi:/);assert.match(after.copy,/Warranty:/);assert.doesNotMatch(after.copy,/Salesperson commission payable:/);
      await page.evaluate(()=>{openDrawer();$('quoteLibrarySearch').value='Taylor';filterQuoteLibrary();});
      assert.equal(await page.locator('.quoteLibraryRow').count(),1,'One customer result, not separate alternative quotes');
      assert.match(await page.locator('.quoteLibraryRow').innerText(),/3 options/);
      await page.locator('.quoteLibraryRow').click();
      assert.equal(await page.locator('.quoteChoiceTabs button[aria-pressed]').count(),3);
      await page.getByRole('button',{name:'View / arrange options',exact:true}).click();
      await page.locator('#drawer').evaluate(el=>Promise.all(el.getAnimations().map(animation=>animation.finished)));
      await page.locator('#currentOptionTitle').evaluate(el=>el.scrollIntoView({block:'start',behavior:'instant'}));
      await page.waitForFunction(()=>!!window.Sortable&&quoteChoiceSortables.length===3);
      const overflow=await page.evaluate(()=>({page:document.documentElement.scrollWidth,viewport:innerWidth,body:$('currentOptionBody').scrollWidth,client:$('currentOptionBody').clientWidth}));
      assert.ok(overflow.page<=overflow.viewport+1,JSON.stringify(overflow));assert.ok(overflow.body<=overflow.client+1,JSON.stringify(overflow));
      if(output){
        fs.mkdirSync(output,{recursive:true});
        await page.screenshot({path:path.join(output,'quote-options-'+width+'.png'),animations:'disabled'});
        await page.locator('[data-row-id="system-0"]').screenshot({path:path.join(output,'quote-system-costs-'+width+'.png'),animations:'disabled'});
      }
      if(width===1440){
        await page.setViewportSize({width:1024,height:1050});
        await page.locator('#currentOptionTitle').evaluate(el=>el.scrollIntoView({block:'start',behavior:'instant'}));
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'Compact desktop has no horizontal overflow');
        if(output)await page.screenshot({path:path.join(output,'quote-options-1024.png'),animations:'disabled'});
        await page.setViewportSize({width,height:1050});
      }
      // Drive the actual library with pointer/touch input, not a synthetic callback.
      holdResponse();
      await page.locator('[data-row-id="system-0"]').evaluate(el=>el.scrollIntoView({block:'start',behavior:'instant'}));
      const handle=await page.locator('[data-row-id="system-0"] .quoteDragHandle').boundingBox();
      const below=await page.locator('[data-row-id="system-1"]').boundingBox();
      const from={x:handle.x+handle.width/2,y:handle.y+handle.height/2};
      const to={x:from.x,y:below.y+below.height/2+10};
      if(width===1440){
        await page.mouse.move(from.x,from.y);await page.mouse.down();
        await page.mouse.move(from.x+10,from.y+10,{steps:3});
        await page.mouse.move(to.x,to.y,{steps:20});await page.mouse.up();
      }else{
        const cdp=await page.context().newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[from]});
        await page.waitForTimeout(180); // Deliberate hold meets the mobile drag-handle threshold.
        for(let step=1;step<=15;step++){
          await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:from.x+(to.x-from.x)*step/15,y:from.y+(to.y-from.y)*step/15}]});
          await page.waitForTimeout(20);
        }
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();
      }
      await page.locator('#quoteChoiceProgress[open]').waitFor({timeout:5000}).catch(async error=>{
        console.error('Drag diagnostic',JSON.stringify({width,from,to,handle,below,state:await page.evaluate(()=>({busy:quoteArrangeBusy,message:quoteArrangeMessage,rows:quoteChoiceRows('customer-a').map(row=>row.id),scrollY,viewport:innerHeight,dragging:document.body.classList.contains('quoteChoicesDragging')}))}));
        if(output)await page.screenshot({path:path.join(output,'quote-options-drag-failure-'+width+'.png')});
        throw error;
      });
      assert.equal(await page.locator('#quoteChoiceProgressTitle').innerText(),'Saving system order...');
      releaseResponse();
      await page.waitForFunction(()=>quoteChoiceRows('customer-a')[0].id==='system-1'&&!quoteArrangeBusy);
      assert.equal(JSON.parse(data.installerMasterQuoteLogV1).find(row=>row.id==='system-1').quotePosition,0,'Actual drag reordered and persisted');
      await page.getByRole('button',{name:'Undo move',exact:true}).click();
      await page.waitForFunction(()=>quoteChoiceRows('customer-a')[0].id==='system-0'&&!quoteArrangeBusy);
      if(width===1440){
        holdResponse();
        await page.setViewportSize({width,height:1800});
        await page.locator('[data-row-id="system-0"]').evaluate(el=>el.scrollIntoView({block:'center',behavior:'instant'}));
        const source=await page.locator('[data-row-id="system-0"] .quoteDragHandle').boundingBox();
        const destination=await page.locator('.quoteChoiceList[data-option-id="'+second+'"]').boundingBox();
        await page.locator('[data-row-id="system-0"] .quoteDragHandle').dragTo(page.locator('.quoteChoiceList[data-option-id="'+second+'"]'),{sourcePosition:{x:18,y:20},targetPosition:{x:destination.width/2,y:destination.height/2}});
        await page.locator('#quoteChoiceProgress[open]').waitFor({timeout:5000}).catch(async error=>{
          console.error('Cross-option drag diagnostic',JSON.stringify({source,destination,state:await page.evaluate(id=>({busy:quoteArrangeBusy,pending:!!quoteArrangePending,attempt:quoteArrangeAttempt,message:quoteArrangeMessage,scrollY,dragging:document.body.classList.contains('quoteChoicesDragging'),source:document.querySelector('[data-row-id="system-0"]')?.closest('.quoteChoiceList')?.dataset.optionId,target:document.querySelector('.quoteChoiceList[data-option-id="'+id+'"]')?.getBoundingClientRect().toJSON(),dialogs:[...document.querySelectorAll('dialog[open]')].map(el=>el.id)}),second)}));
          if(output)await page.screenshot({path:path.join(output,'quote-options-cross-drag-diagnostic.png')});
          throw error;
        });
        assert.equal(await page.locator('#quoteChoiceProgressTitle').innerText(),'Moving system...');
        releaseResponse();
        await page.waitForFunction(id=>quotes.find(row=>row.id==='system-0').optionId===id&&!quoteArrangeBusy,second);
        assert.equal(JSON.parse(data.installerMasterQuoteLogV1).find(row=>row.id==='system-0').optionId,second,'Cross-option drag persisted');
        await page.getByRole('button',{name:'Undo move',exact:true}).click();
        await page.waitForFunction(()=>quotes.find(row=>row.id==='system-0').optionId==='customer-a'&&!quoteArrangeBusy);
      }
      // A direct removal uses the existing durable mutation, with explicit confirmation.
      const beforeCopyIds=await page.evaluate(()=>quotes.map(row=>row.id));
      await page.evaluate(id=>moveQuoteChoiceRow('system-0',id,'',true),second);
      await page.waitForFunction(()=>!quoteArrangeBusy&&!quoteArrangePending);
      const removeId=await page.evaluate(ids=>quotes.find(row=>!ids.includes(row.id)).id,beforeCopyIds);
      page.once('dialog',dialog=>dialog.accept());
      await page.locator('[data-row-id="'+removeId+'"] .quoteChoiceRemove').click();
      await page.waitForFunction(()=>!quoteArrangeBusy&&!quoteArrangePending);
      assert.equal(await page.evaluate(id=>quotes.some(row=>row.id===id),removeId),false);
      assert.equal(JSON.parse(data.installerMasterQuoteLogV1).some(row=>row.id===removeId),false,'Remove is durably saved');
      assert.equal(await page.locator('[data-row-id="system-0"]').count(),1,'Other systems remain');
      // The UI uses the same role controls as existing quote detail views.
      await page.evaluate(()=>{
        window.CALCULATOR_USER.canSeeProfitDetails=false;window.CALCULATOR_USER.canSeeAgencyProfit=false;
        window.CALCULATOR_USER.canSeeSalespersonCommission=true;renderCurrentOptionPanel();
      });
      assert.doesNotMatch(await page.locator('#currentOptionBody').textContent(),/Agency commission|Agency profit/);
      assert.match(await page.locator('#currentOptionBody').textContent(),/Salesperson commission payable/);
      assert.deepEqual(await page.locator('section[data-option-id="customer-a"] .quoteChoiceProfit dt').allTextContents(),['Installer profit ex GST','Salesperson commission payable']);
      await page.evaluate(()=>{window.CALCULATOR_USER.canSeeSalespersonCommission=false;renderCurrentOptionPanel();});
      assert.equal(await page.locator('.quoteChoiceProfit').count(),0,'Hidden financials do not appear in the new headline');
      await page.evaluate(()=>{window.CALCULATOR_USER.canSeeSalespersonCommission=true;renderCurrentOptionPanel();});
      await page.evaluate(()=>{syncAddOptionSelects('customer-a');beginCurrentQuoteTotalsEdit();});
      await page.locator('#currentOptionCustomerTotal').fill('7777');
      await page.evaluate(()=>window.dispatchEvent(new CustomEvent('calculator-quote-conflict',{detail:{currentFamily:{...quoteChoiceSnapshot('customer-a'),removedRowIds:[],removedOptionIds:[],selectedOptionId:'customer-a'}}})));
      assert.equal(await page.locator('#currentOptionCustomerTotal').inputValue(),'7777','A conflict must not redraw or discard in-progress pricing inputs');
      page.once('dialog',dialog=>dialog.dismiss());
      await page.locator('.currentOptionEditActions').getByRole('button',{name:'Cancel',exact:true}).click();
      assert.equal(await page.evaluate(()=>currentQuoteTotalsEditing),true,'Declining cancellation preserves the draft');
      page.once('dialog',dialog=>dialog.accept());
      await page.locator('.currentOptionEditActions').getByRole('button',{name:'Cancel',exact:true}).click();
      assert.equal(await page.evaluate(()=>currentQuoteTotalsEditing),false);
      await page.getByRole('button',{name:'Load latest options',exact:true}).click();
      await page.waitForFunction(()=>!quoteArrangeBusy);
      await page.evaluate(()=>{quotes.find(row=>row.id==='system-0').unitInc=0;renderCurrentOptionPanel();});
      assert.equal(await page.locator('[data-row-id="system-0"] .quoteChoiceCostSummary dd').first().innerText(),'Price needed');
      assert.equal(await page.locator('section[data-option-id="customer-a"] .quoteChoiceProfit').count(),0,'Missing price does not show a misleading profit');
      assert.match(await page.locator('section[data-option-id="customer-a"] .quoteChoiceProfitNotice').innerText(),/Enter equipment prices/);
      assert.equal(await page.locator('#copyQuoteInfoBtn').isEnabled(),false,'Invalid option blocks all-option copying');
      assert.equal(await page.locator('section[data-option-id="'+second+'"]').getByRole('button',{name:'Copy option info',exact:true}).isEnabled(),true,'Another complete option can still be copied on its own');
      assert.equal(await page.locator('section[data-option-id="customer-a"]').getByRole('button',{name:'Accept this option',exact:true}).isEnabled(),false,'Missing equipment price cannot be accepted');
      await page.evaluate(id=>{
        quotes.find(row=>row.id==='system-0').unitInc=1100;
        optionDefById(id).wonAt='2026-10-27T00:00:00Z';
        quotes.filter(row=>row.optionId===id).forEach(row=>row.wonAt='2026-10-27T00:00:00Z');
        renderCurrentOptionPanel();
      },second);
      assert.equal(await page.locator('#currentOptionBody').getByRole('button',{name:'Accept this option',exact:true}).count(),0);
      assert.equal(await page.locator('.quoteChoiceActions').count(),0,'Accepted quote locks all competing options');
      assert.equal(await page.locator('.quoteChoiceRemove').count(),0,'Accepted family has no remove buttons');
      assert.equal(await page.locator('.quoteChoiceSelect').count(),0,'Accepted family cannot be selected for adding');
      const acceptedSummary=await page.evaluate(id=>{
        const family=quoteLibraryGroups().find(group=>group.familyOptions?.some(option=>option.def.id===id));
        return {displayTotal:family.total,acceptedTotal:groupTotals(quoteChoiceRows(id)).customer,allTotal:groupTotals(family.rows).customer};
      },second);
      assert.equal(acceptedSummary.displayTotal,acceptedSummary.acceptedTotal);
      assert.notEqual(acceptedSummary.displayTotal,acceptedSummary.allTotal,'Unchosen alternatives never become the sold total');
      await page.evaluate(()=>{
        const latest=quoteChoiceSnapshot('customer-a');
        quotes.push({...structuredClone(quotes[0]),id:'unsaved-conflict'});
        window.testConflictResolved=false;
        window.__calculatorResolveQuoteConflict=()=>{window.testConflictResolved=true;};
        window.dispatchEvent(new CustomEvent('calculator-quote-conflict',{detail:{code:'QUOTE_OPTION_CONFLICT',currentFamily:{...latest,removedRowIds:['unsaved-conflict'],removedOptionIds:[],selectedOptionId:'customer-a'}}}));
      });
      await page.getByRole('button',{name:'Load latest options',exact:true}).click();
      assert.equal(await page.evaluate(()=>window.testConflictResolved),true,'Explicit recovery resumes paused autosave');
      assert.equal(await page.evaluate(()=>quotes.some(row=>row.id==='unsaved-conflict')),false);
      assert.equal(await page.evaluate(()=>savedQuoteSets[0].quotes.some(row=>row.id==='unsaved-conflict')),true,'Rejected new local rows remain recoverable in backups');
      const firstAdd=await page.evaluate(async()=>{
        const originalRename=renameOption,originalAdd=addStandardSystemToQuoteNow;
        const events=[];
        try{
          renameOption=async(id,name)=>{events.push('saving-name');await Promise.resolve();optionDefById(id).name=name;events.push('name-saved');};
          addStandardSystemToQuoteNow=()=>events.push('system-added');
          quoteNameModalContext={mode:'first-add',targetId:'customer-a',addKind:'standard',selectIt:true};
          $('quoteNameModalInput').value='New customer';
          await confirmQuoteNameModal();
          return events;
        }finally{renameOption=originalRename;addStandardSystemToQuoteNow=originalAdd;}
      });
      assert.deepEqual(firstAdd,['saving-name','name-saved','system-added'],'First system waits for the family customer name to save');
      assert.deepEqual(errors,[],'No page errors');
      console.log('Quote options browser '+width+': passed');
      await page.close();
    }
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
