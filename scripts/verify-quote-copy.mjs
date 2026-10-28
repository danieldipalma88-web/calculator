import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
const ast = ts.createSourceFile('calculator.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = new Map(ast.statements.filter(ts.isFunctionDeclaration).map(n => [n.name.text, n.getText(ast)]));
const product = {brand:'Example',model:'OUT-25 / IN-25',wifiStatus:'optional',wifiLabel:'Wi-Fi optional adaptor',warrantyLabel:'5 yrs parts & labour'};
const row = {type:'Split',brand:'Example',series:'Comfort',size:'2.5kW',model:product.model,install:'New',finalInc:2100.55,unitInc:1000,rebate:500,
  commissionInc:123.45,salespersonCommissionInc:67.89,netProfit:333.77,labour:555.66,materialsInc:777.88,notes:'SECRET_INTERNAL_NOTE',
  state:{businessId:'test-business',systemType:'split',model:product.model,brand:'Example',installAddons:['addonPipe'],installAddonQuantities:{addonPipe:2}}};
const context = {
  console, setTimeout, clearTimeout, navigator:{},
  productListFor:()=>[product], SPLIT_PRODUCTS:[product], DUCTED_PRODUCTS:[], ANDOS_SPLIT_PRODUCTS:[], ANDOS_DUCTED_PRODUCTS:[],
  INSTALL_ADDONS:[{id:'addonPipe',type:'quantity',label:'Extra 5m pipe run'}],
  normaliseBrandName:v=>v, normaliseModelName:v=>v,
  activeBusinessName:()=> 'Example Air', calculatorUserContext:()=>({businessId:'test-business'}),
  money:n=>'$'+n.toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2}),
  groupTotals:rows=>({customer:rows.reduce((n,r)=>n+Number(r.finalInc),0)}),
};
const names = ['normalizeLookup','finiteMoneyNumber','quoteNeedsCustomerName','hasPositiveUnitPrice','uniquePriceModels','isMultiHeadQuoteType','quoteRowMissingPriceModels','quoteRowsMissingPriceModels','quoteStateDisablesRebates','installAddonDisplayLabel','quoteInfoText','quoteInfoSupport','quoteInfoProduct','quoteInfoExtras','currentQuoteInfoError','quoteInfoBusiness','buildCurrentQuoteInfo','updateCopyQuoteInfoButton','fallbackCopyQuoteInfo','copyCurrentQuoteInfo'];
vm.createContext(context);
vm.runInContext('let currentQuoteTotalsEditing=false; let quoteInfoCopyBusy=false; let quoteInfoFeedbackTimer=null;\n'+names.map(n=>{assert.ok(functions.has(n),n);return functions.get(n);}).join('\n'),context);

const before=JSON.stringify(row);
assert.equal(context.currentQuoteInfoError([row]),'');
const text=context.buildCurrentQuoteInfo({name:'Taylor'},[row]);
assert.match(text,/Customer: Taylor/);
assert.match(text,/Business: Example Air/);
assert.match(text,/Final customer price including GST: \$2,100.55/);
assert.match(text,/Wi-Fi: Wi-Fi optional adaptor \(not confirmed as included/);
assert.match(text,/Warranty: 5 yrs parts & labour/);
assert.match(text,/Selected extras: Extra 5m pipe run x 2/);
assert.match(text,/quoted rebate is already reflected/);
for(const secret of ['123.45','67.89','333.77','555.66','777.88','SECRET_INTERNAL_NOTE','test-business']) assert.ok(!text.includes(secret),`Excluded ${secret}`);
assert.equal(JSON.stringify(row),before,'Copy must not change saved quote data');
assert.equal(context.quoteInfoProduct({...row,model:'MISSING',state:{brand:'Example',model:'MISSING',productIndex:0}}),null,'Never guess from stale product index');
assert.equal(context.quoteInfoProduct({...row,brand:'Different',state:{brand:'Different',model:product.model}}),null,'Never match another brand');
assert.equal(context.quoteInfoSupport({wifiStatus:'included',wifiLabel:'Built-in Wi-Fi',warrantyLabel:'5 yrs standard / 7 yrs registered'}).warranty,'5 yrs standard / 7 yrs registered');
assert.equal(context.quoteInfoSupport({wifiStatus:'none',wifiLabel:'No Wi-Fi'}).wifi,'No Wi-Fi');
assert.equal(context.quoteInfoSupport({wifiStatus:'unknown',wifiLabel:'Wi-Fi not listed'}).wifi,'Unconfirmed');
assert.equal(context.quoteInfoSupport(null).warranty,'Unconfirmed');
const multiple=context.buildCurrentQuoteInfo({name:'Quote 1'},[row,{...row,finalInc:999.45,install:'Replacement'}]);
assert.match(multiple,/\$3,100.00/);
assert.match(multiple,/System 2:/);
assert.match(multiple,/Installation: Replacement/);
assert.doesNotMatch(multiple,/Customer: Quote 1/);
const noRebate=context.buildCurrentQuoteInfo({name:'Taylor'},[{...row,state:{...row.state,rebatesEnabled:false}}]);
assert.doesNotMatch(noRebate,/quoted rebate is already reflected/);
for(const finalInc of [NaN,Infinity,-1,null,'',undefined]) assert.match(context.currentQuoteInfoError([{...row,finalInc}]),/customer total/);
assert.match(context.currentQuoteInfoError([{...row,unitInc:0}]),/equipment prices/);
assert.match(context.currentQuoteInfoError([]),/Add a system/);
assert.equal(context.currentQuoteInfoError([{...row,state:{...row.state,businessId:'legacy'}}]),'','Already-authorised selected rows are not owned by the pricing selector');
assert.equal(context.quoteInfoBusiness([row]),'Example Air');
const historic={...row,state:{...row.state,businessId:'historic',businessName:'Historic Air'}};
assert.equal(context.quoteInfoBusiness([historic]),'Historic Air','Preserve an unambiguous saved business instead of relabelling it');
for(const rows of [[row,historic],[{...row,state:{}}],[{...historic,state:{...historic.state,businessName:''}}],[historic,{...historic,state:{...historic.state,businessName:'Different Air'}}]]){
  assert.match(context.quoteInfoBusiness(rows),/^Unconfirmed/,'Mixed, missing or conflicting business details must not be guessed');
  const prompt=context.buildCurrentQuoteInfo({name:'Taylor'},rows);
  assert.doesNotMatch(prompt,/Business: Example Air|Business: Historic Air|Business: Different Air/);
}
vm.runInContext('currentQuoteTotalsEditing=true',context);
assert.match(context.currentQuoteInfoError([row]),/Save or cancel/);
vm.runInContext('currentQuoteTotalsEditing=false',context);
const multi={...row,type:'Multi-head Split',model:'OUT + 3 heads',unitInc:3000,state:{businessId:'test-business',systemType:'multi_split',outdoorModel:'OUT-MULTI',outdoorUnitPriceInc:2000,indoorHeads:[{brand:'Example',model:'HEAD-25',capacity:'2.5kW',qty:2,unitPriceInc:500},{brand:'Example',model:'HEAD-35',capacity:'3.5kW',qty:1,unitPriceInc:0}]}};
assert.match(context.currentQuoteInfoError([multi]),/equipment prices/);
multi.state.indoorHeads[1].unitPriceInc=700;
assert.equal(context.currentQuoteInfoError([multi]),'');
const multiText=context.buildCurrentQuoteInfo({name:'Taylor'},[multi]);
assert.match(multiText,/Outdoor model: OUT-MULTI/);
assert.match(multiText,/Indoor head: 2 x Example - HEAD-25 - 2.5kW/);
assert.match(multiText,/Outdoor warranty: Unconfirmed/);
assert.match(multiText,/Wi-Fi: Unconfirmed/);
assert.match(context.buildCurrentQuoteInfo({name:'Taylor'},[{...row,type:'Ducted',state:{systemType:'ducted',airtouch:'yes',zones:4,sensors:2}}]),/AirTouch controller; 4 zones; 2 sensors/);
const staleDuctedControls={airtouch:'yes',zones:4,sensors:2};
for(const systemType of ['split','multi_split']){
  assert.deepEqual([...context.quoteInfoExtras({...row,state:{...staleDuctedControls,systemType}})],[], 'Hidden ducted controls must not become split or multi-head inclusions');
}

let copied='';
const button={disabled:false,textContent:'',title:''};
const status={textContent:''};
context.$=id=>id==='copyQuoteInfoBtn'?button:status;
context.currentOptionSelection=()=>({def:{name:'Taylor'},rows:[row]});
context.navigator.clipboard={writeText:async value=>{copied=value;}};
await context.copyCurrentQuoteInfo();
assert.equal(copied,text);
assert.equal(button.textContent,'Copied');
assert.equal(button.disabled,false);
assert.match(status.textContent,/Ready to paste/);
context.navigator.clipboard.writeText=async()=>{throw new Error('denied');};
let removed=0,restored=0;
context.document={activeElement:{focus:()=>restored++},body:{appendChild:()=>{}},createElement:()=>({setAttribute:()=>{},style:{},focus:()=>{},select:()=>{},setSelectionRange:()=>{},remove:()=>removed++}),execCommand:()=>true};
await context.copyCurrentQuoteInfo();
assert.equal(button.textContent,'Copied','Fallback succeeds');
context.document.execCommand=()=>false;
await context.copyCurrentQuoteInfo();
assert.match(status.textContent,/Could not copy/);
assert.equal(button.disabled,false,'Failure must allow retry');
assert.equal(removed,2);assert.equal(restored,2);
context.navigator.clipboard.writeText=()=>new Promise(()=>{});
await context.copyCurrentQuoteInfo();
assert.match(status.textContent,/Could not copy/);
assert.equal(button.disabled,false,'Hung clipboard must clear loading');
vm.runInContext('clearTimeout(quoteInfoFeedbackTimer)',context);
assert.match(functions.get('renderCurrentOptionPanel'),/updateCopyQuoteChoicesButton\(\)/);
assert.match(html,/id="copyQuoteInfoBtn"[^>]+onclick="copyAllQuoteChoices\(\)"/);
assert.doesNotMatch(functions.get('copyCurrentQuoteInfo'),/persist|fetch\(|sendEmail|calculate\(/);
console.log('Quote copy: privacy, selected totals, exact metadata, multi-heads, unknowns, missing prices and clipboard failures passed.');
