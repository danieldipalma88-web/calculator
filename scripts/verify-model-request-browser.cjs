const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const ts=require('typescript');
const React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const root=path.resolve(__dirname,'..');
const out=path.join(root,'outputs/model-request-automation');
fs.mkdirSync(out,{recursive:true});
const addition={catalogueAdditionId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',type:'split',systemType:'split',brand:'Daikin',model:'FIXTURE-OUT25 / FIXTURE-IN25',series:'Verification fixture',capacityNum:2.5,size:2.5,capacity:'2.5kW',phase:'Single',unitPriceInc:0,priceIncGst:0,rebate:0,nswOnly:true,wifiStatus:'unknown',wifiLabel:'Wi-Fi unconfirmed',warrantyLabel:'Warranty unconfirmed',originLabel:'Not confirmed'};
function renderComponent(file,hooks=React,props={}){
  const code=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const exports={};
  vm.runInThisContext(`(function(exports,require){${code}\n})`)(exports,id=>id==='react'?hooks:id.endsWith('.css')?new Proxy({},{get:(_,name)=>name==='__esModule'?false:String(name)}):require(id));
  return renderToStaticMarkup(React.createElement(exports.default,props));
}
function adminMarkup(){
  const fixture={requests:[{id:'fixture',requester_name:'Installer Example',requester_email:'installer@example.invalid',business_name:'Example Air Conditioning',system_type:'ducted',brand:'Daikin',model:'EXAMPLE-OUT140 / EXAMPLE-IN140',capacity:'14kW',phase:'three',notes:'Please check this indoor/outdoor combination.',postcode:'2145',install_type:'replacement',created_at:'2026-11-03T00:00:00Z',status:'reviewing',job:{state:'review',reason:'Multiple active Australian GEMS registrations match this pair',attempts:1,evidence:{registry:{model:'EXAMPLE-OUT140 / EXAMPLE-IN140'}},product:null,email_state:'pending',email_error:''}}],products:[],hasMore:false};
  let hook=0;
  const hooks={...React,useState:initial=>{hook++;return [hook===1?fixture:hook===2?false:initial,()=>{}]},useRef:value=>({current:value}),useEffect:()=>{},useCallback:fn=>fn};
  return renderComponent('app/admin/model-requests/request-list.tsx',hooks);
}
(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
  try {
    for(const width of [1440,390]) {
      const page=await browser.newPage({viewport:{width,height:950}});const errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      await page.route('**/*',route=>new URL(route.request().url()).pathname==='/'?route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(root,'index.html'),'utf8')}):route.abort());
      await page.addInitScript(p=>{window.CALCULATOR_USER={role:'admin',businessId:'test',businessName:'Example Air',businessOperatingState:'NSW'};window.__verifiedCatalogueAdditions=[p]},addition);
      await page.goto('http://127.0.0.1:43823/',{waitUntil:'domcontentloaded'});
      await page.evaluate(()=>{refreshLiveRebateForCurrentProduct=async()=>{};refreshBestValueIndicator=()=>{};setSystem('split');$('brand').value='Daikin';populateProducts();});
      const index=await page.evaluate(()=>data().findIndex(p=>p.catalogueAdditionId));
      assert.ok(index>=0);
      await page.locator('#product').selectOption(String(index));
      assert.equal(await page.locator('#unitPriceInc').inputValue(),'0.00');
      assert.equal(await page.locator('#wifiMeta').innerText(),'Wi-Fi unconfirmed');
      assert.equal(await page.locator('#warrantyMeta').innerText(),'Warranty unconfirmed');
      assert.equal(await page.evaluate(()=>standardQuotePriceReadiness().ok),false);
      assert.equal(await page.evaluate(i=>managedProductKey('split',i),index),'split|verified_'+addition.catalogueAdditionId);
      await page.locator('#unitPriceInc').fill('900');await page.locator('#unitPriceInc').dispatchEvent('input');
      assert.equal(await page.evaluate(()=>standardQuotePriceReadiness().ok),true);
      await page.evaluate(()=>{openModelRequestModal('standard');$('modelRequestModel').value='OUT / IN';});
      assert.equal(await page.locator('#modelRequestPostcode').count(),1);
      assert.equal(await page.locator('#modelRequestInstall').inputValue(),'new');
      await page.screenshot({path:path.join(out,`request-form-${width}.png`)});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
      await page.evaluate(()=>{closeModelRequestModal();window.CALCULATOR_USER.role='salesperson';setSystem('split');$('brand').value='Daikin';populateProducts();});
      assert.equal(await page.locator('#product option').filter({hasText:'Verification fixture'}).count(),0);
      assert.deepEqual(errors,[]);
      const admin=await browser.newPage({viewport:{width,height:950}});
      const css=fs.readFileSync(path.join(root,'app/globals.css'),'utf8')+'\n'+fs.readFileSync(path.join(root,'app/admin/model-requests/model-requests.module.css'),'utf8');
      await admin.setContent(`<html><head><style>${css}</style></head><body><main class="admin-shell"><section class="admin-card"><header class="admin-head"><div><p class="kicker">Quote Calculator</p><h1>Model requests</h1></div><a href="#">Platform Admin</a></header>${adminMarkup()}</section></main></body></html>`);
      assert.equal(await admin.getByRole('heading',{name:'Daikin EXAMPLE-OUT140 / EXAMPLE-IN140'}).count(),1);
      assert.equal(await admin.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
      await admin.screenshot({path:path.join(out,`admin-review-${width}.png`)});
      const responseCss=fs.readFileSync(path.join(root,'app/model-requests/model-requests.module.css'),'utf8');
      const responseMarkup=renderComponent('app/model-requests/request-response.tsx',React,{id:addition.catalogueAdditionId,request:{
        ...addition,system_type:'split',postcode:'2263',install_type:'replacement',round:2,state:'closed',
        question:'Please choose the indoor and outdoor codes printed on your equipment.',
        candidates:[addition.model],next_at:null,
      }});
      await admin.setContent(`<html><head><style>${responseCss}</style></head><body><main class="shell"><section class="panel">${responseMarkup}</section></main></body></html>`);
      assert.equal(await admin.getByRole('button',{name:'Reopen request'}).count(),1);
      assert.equal(await admin.getByLabel('Suggested model').count(),1);
      assert.equal(await admin.getByRole('checkbox',{name:/person review/}).count(),1);
      assert.equal(await admin.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
      await admin.screenshot({path:path.join(out,`request-response-${width}.png`)});
      await page.close();await admin.close();
      console.log(`Model request browser ${width}px: no-price guard, unconfirmed support, stable keys, editable quote price, salesperson visibility, request form and admin review layout passed.`);
    }
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
