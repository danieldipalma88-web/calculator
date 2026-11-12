import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { copyQuoteWithoutLifecycle } from '../lib/quote-family.ts';
import { mergeCalculatorData } from '../lib/quote-sync.ts';
import { visibleCalculatorData } from '../lib/quote-data-visibility.ts';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]).join('\n');
new Function(source);
const ast=ts.createSourceFile('calculator.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const extra=['htmlEscape','isMultiHeadQuoteType','groupTotals','proposalPricingHtml','watchFujitsuCashbackClock','addStandardSystemToQuoteNow'];
const selected=ast.statements.filter(node=>
  (ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>/^(MHI|FUJITSU)_CASHBACK_|^loadedMhiCashbackRow$/.test(d.name.getText(ast))))||
  (ts.isFunctionDeclaration(node)&&(/^(mhiCashback|fujitsuCashback|manufacturerCashback)/.test(node.name?.text)||extra.includes(node.name?.text)))
).map(node=>node.getText(ast)).join('\n');
const now=Date.parse('2026-11-13T12:00:00+11:00');
const context={Date,performance,window:{__mhiCashbackClock:{serverTime:now,wallTime:Date.now(),elapsedTime:performance.now()}},
  money:value=>'$'+value.toFixed(2),optionDefById:()=>null,
  savedMaterialsInc:row=>row.materialsInc,savedMiscInc:row=>row.miscInc,savedPowerOrElectricianEx:row=>row.powerCost,
  agencyProfitAfterSalesInc:()=>0,proposalSystemTitle:row=>row.type,quoteRowsMissingPriceModels:()=>[]};
vm.createContext(context);
vm.runInContext(selected+'\nglobalThis.promotions=FUJITSU_CASHBACK_PROMOTIONS;let systemType="split";let currentQuoteTotalsEditing=false;',context);
const {promotions,fujitsuCashbackSnapshot:snapshot,fujitsuCashbackQuoteOffer:offer,fujitsuCashbackDisplay:display}=context;
const brand='Fujitsu General';
const catalogue=JSON.parse(fs.readFileSync(new URL('../lib/public-rebate-catalogue.generated.json',import.meta.url),'utf8')).products;
const normalize=value=>value.toUpperCase().replace(/\s/g,'');
// Independently transcribed eligible existing models; amounts follow the official pair list, not rounded catalogue capacities.
const expected={
  split:{150:['AOTG09KMTC/ASTG09KMTC','AOTG12KMTC/ASTG12KMTC','AOTH18KMTD/ASTH18KMTD','AOTH09KNCA/ASTH09KNCA','AOTH12KNCA/ASTH12KNCA','AOTH14KNCA/ASTH14KNCA','AOTH18KNTA/ASTH18KNTA'],
    200:['AOTH22KMTD/ASTH22KMTD','AOTH24KMTD/ASTH24KMTD','AOTH22KNTA/ASTH22KNTA','AOTH24KNTA/ASTH24KNTA']},
  ducted:{300:['AOTH24KBTA/ARTH24KHTA','AOTH30KBTA/ARTH30KHTA','AOTH30KCTA/ARTH30KHTA'],
    350:['AOTH36KBTA/ARTH36KHTA','AOTH45KBTA/ARTH45KHTA','AOTH36KRTA/ARTH36KHTA','AOTH45KRTA/ARTH45KHTA','AOTH36KCTA/ARTH36KHTA','AOTH45KCTA/ARTH45KHTA'],
    400:['AOTH54KBTA/ARTH54KHTA','AOTH60KBTA/ARTH60KHTA','AOTH54KRTA/ARTH54KHTA','AOTH60KRTA/ARTH60KHTA','AOTH54KCTA/ARTH54KHTA','AOTH60KCTA/ARTH60KHTB'],
    450:['AOTH65KRTA/ARTH65KHTA','AOTH65KBTA/ARTH65KHTA'],500:['AOTH72KRTA/ARTH72KHTA','AOTH90KRTA/ARTH90KHTA']},
};
assert.deepEqual(Object.values(promotions).map(p=>Object.keys(p.models).length),[11,19]);
for(const [type,tiers] of Object.entries(expected)){
  const promotion=promotions[type];
  assert.equal(promotion.start,Date.parse(type==='split'?'2026-11-02T09:00:00+11:00':'2026-10-01T09:00:00+10:00'));
  assert.equal(promotion.end,Date.parse('2026-12-12T00:00:00+11:00'));
  assert.equal(promotion.claimEnd,Date.parse(type==='split'?'2027-01-12T00:00:00+11:00':'2027-01-30T00:00:00+11:00'));
  for(const [amount,models] of Object.entries(tiers))for(const model of models){
    const equipment={brand,model};
    assert.ok(catalogue.some(p=>p.brand===brand&&p.systemType===type&&normalize(p.model)===model),model+' exists');
    assert.equal(snapshot({brand:'Fujitsu',model},type,now).amount,Number(amount),'Ducted catalogue display alias matches');
    for(const variant of [model,model.toLowerCase(),model.split('/').join(' / '),model.replace('/','-'),model.split('/').reverse().join(' - ')]){
      assert.equal(snapshot({...equipment,model:variant},type,now).amount,Number(amount));
    }
    assert.equal(snapshot(equipment,type,promotion.start-1),undefined);
    assert.equal(snapshot(equipment,type,promotion.start).amount,Number(amount));
    assert.equal(snapshot(equipment,type,promotion.end-1).amount,Number(amount));
    assert.equal(snapshot(equipment,type,promotion.end),undefined);
  }
}
for(const model of ['AOTG18KMTC/ASTG18KMTC','AOTG22KMTC/ASTG22KMTC','AOTG24KMTC/ASTG24KMTC','AOTG09KMTC/ASTG12KMTC','ASTG09KMTC','AOTH30KMTD/ASTH30KMTD']){
  assert.equal(snapshot({brand,model},'split',now),undefined,model+' is not eligible');
}
assert.equal(snapshot({brand:'Daikin',model:'AOTG09KMTC/ASTG09KMTC'},'split',now),undefined);
assert.equal(snapshot({brand,model:'AOTG09KMTC/ASTG09KMTC'},'ducted',now),undefined);
assert.equal(snapshot({brand,model:'AOTH24KBCA3'},'multi',now),undefined);
assert.equal(snapshot({brand,model:'AOTG09KMTC/ASTG09KMTC'},'__proto__',now),undefined);
const legacy={id:'legacy',optionId:'a',type:'Split',brand,model:'AOTG09KMTC/ASTG09KMTC',finalInc:2000,rebate:400,unitInc:810,
  labour:500,materialsInc:150,powerCost:0,miscInc:0,netProfit:400,commissionInc:200,salespersonCommissionInc:100,syncUpdatedAt:now};
const before=JSON.stringify(legacy);
assert.equal(offer(legacy),null);
assert.equal(context.manufacturerCashbackQuoteBlock([legacy],{},2000),'');
assert.equal(offer({...legacy,wonAt:'2026-11-12'}),null,'No backfill even on recent won quotes');
const row={...legacy,manufacturerCashback:snapshot(legacy,'split',now)};
const active=offer(row);
assert.match(display([active],true,now).lines.join('\n'),/Potential GENERAL Airstage manufacturer reward \$150.00/);
assert.doesNotMatch(display([active],true,now).lines.join('\n'),/Estimated cost|1850/);
assert.equal(context.fujitsuCashbackBlock([null]),'');
assert.equal(offer({...row,model:'AOTG12KMTC/ASTG09KMTC'}),null);
for(const change of [{amount:500},{recordedAt:promotions.split.start-1},{promotionId:promotions.ducted.id}]){
  assert.equal(offer({...row,manufacturerCashback:{...row.manufacturerCashback,...change}}),null);
}
const ended=display([active],true,promotions.split.end);
assert.match(ended.lines.join('\n'),/Recorded.*offer ended for new purchases/);
assert.equal(ended.links.length,2);
assert.equal(display([{...active,recorded:false}],true,promotions.split.end).lines.length,0);
assert.match(display([active],true,promotions.split.claimEnd).lines.join('\n'),/Claims closed on 11 January 2027/);
assert.equal(display([active],true,promotions.split.claimEnd).links.length,1);
const ducted={...row,type:'Ducted',model:'AOTH90KRTA/ARTH90KHTA'};
ducted.manufacturerCashback=snapshot(ducted,'ducted',now);
const mixed=display([active,offer(ducted)],true,promotions.split.claimEnd);
assert.equal(mixed.links.filter(link=>link.label.includes('claim information')).length,1,'Ducted claims remain open after split deadline');
assert.match(mixed.lines.join('\n'),/\$500.00/);

context.loadedRow=legacy;
vm.runInContext('loadedMhiCashbackRow=loadedRow;',context);
assert.equal(context.fujitsuCashbackCurrentOffer('split',{p:legacy}),null,'Loading old quote never inserts a reward');
assert.equal(context.manufacturerCashbackCurrentQuoteFields(legacy).manufacturerCashback,undefined);
context.loadedRow={...legacy,type:'Ducted',brand:'Fujitsu',model:'AOTH24KBTA-ARTH24KHTA'};
vm.runInContext('loadedMhiCashbackRow=loadedRow;systemType="ducted";',context);
const legacyDucted={brand:'Fujitsu General',model:'ARTH24KHTA / AOTH24KBTA'};
assert.equal(context.fujitsuCashbackCurrentOffer('ducted',{p:legacyDucted}),null,'Legacy pair delimiters/order/brand aliases never backfill an offer');
assert.equal(context.manufacturerCashbackCurrentQuoteFields(legacyDucted).manufacturerCashback,undefined);
vm.runInContext('systemType="split";',context);
context.loadedRow=row;
vm.runInContext('loadedMhiCashbackRow=loadedRow;',context);
assert.equal(context.fujitsuCashbackCurrentOffer('split',{p:row}).amount,150);
vm.runInContext('loadedMhiCashbackRow=null;',context);
assert.equal(context.fujitsuCashbackCurrentOffer('split',{p:legacy}).recorded,false);
assert.equal(context.manufacturerCashbackCurrentQuoteFields(legacy).manufacturerCashback.amount,150,'Unsaved current-system proposal has conditional information');
const provisional=offer({...legacy,...context.manufacturerCashbackCurrentQuoteFields(legacy)});
assert.equal(provisional.recorded,false);
assert.equal(display([provisional],true,promotions.split.end).lines.length,0,'Unsaved proposal cannot retain historical offer after purchase cutoff');

const rowsKey='installerMasterQuoteLogV1';
const merged=mergeCalculatorData({[rowsKey]:JSON.stringify([legacy])},{[rowsKey]:JSON.stringify([legacy,{...row,id:'new'}])});
const reopened=JSON.parse(visibleCalculatorData(merged,true,true)[rowsKey]);
assert.deepEqual(reopened.find(r=>r.id==='legacy'),legacy);
assert.equal(reopened.find(r=>r.id==='new').manufacturerCashback.amount,150);
const salespersonRows=JSON.parse(visibleCalculatorData(merged,false,true)[rowsKey]);
assert.equal(salespersonRows.find(r=>r.id==='new').manufacturerCashback.amount,150);
assert.equal(salespersonRows.find(r=>r.id==='new').commissionInc,undefined,'Existing financial visibility rules are preserved');
assert.deepEqual(copyQuoteWithoutLifecycle(row).manufacturerCashback,row.manufacturerCashback);
assert.equal(JSON.stringify(legacy),before);
const proposal=context.proposalPricingHtml([{def:{name:'Taylor'},number:1,rows:[row]}],'20 December 2026');
assert.match(proposal,/Amount due<\/span><strong>\$2000.00/);
assert.match(proposal,/manufacturer reward \$150.00/);
assert.doesNotMatch(proposal,/\$1850.00|Estimated cost/);

const calc={p:legacy,unitInc:810,rebate:400,finalInc:2000,labour:500,materialsInc:150,service:0,miscEx:0,addons:0,
  labourTreatment:'Expense',installAddons:{labour:0,materialsInc:0},netProfit:400,commissionInc:200,salespersonCommissionInc:100};
Object.assign(context,{currentAddOptionId:()=> 'a',assertOptionEditable:()=>true,releaseLoadedTclPriceForDestination(){},requireStandardRegistrationRebate:()=>true,
  standardQuotePriceReadiness:()=>({ok:true}),calculate:()=>calc,currentState:()=>({systemType:'split',model:legacy.model,brand}),
  optionNameById:()=> 'Taylor',salespersonGstRegistered:()=>true,installType:'new',installAddonDisplayLabels:()=>[],num:()=>0,
  quotes:[],persistQuotes(){},renderQuotes(){},showQuoteActionNotice(){}});
context.addStandardSystemToQuoteNow();
assert.equal(context.quotes[0].manufacturerCashback.amount,150);
for(const key of ['unitInc','rebate','finalInc','netProfit','commissionInc','salespersonCommissionInc'])assert.equal(context.quotes[0][key],calc[key],key+' unchanged');

const block={dataset:{fujitsuCashback:JSON.stringify([[active],true])}};
const previewBlock={dataset:{fujitsuCashback:JSON.stringify([[provisional],true])}};
const listeners={};let callback;
const view={document:{querySelectorAll:()=>[block,previewBlock],addEventListener:(event,fn)=>listeners[event]=fn},
  addEventListener:(event,fn)=>listeners[event]=fn,setTimeout:fn=>{callback=fn;return 1;},clearTimeout(){}};
context.window.__mhiCashbackClock={serverTime:promotions.split.end-100,wallTime:Date.now(),elapsedTime:performance.now()};
context.watchFujitsuCashbackClock(view);
assert.match(block.innerHTML,/Potential/);
context.window.__mhiCashbackClock={serverTime:promotions.split.end,wallTime:Date.now(),elapsedTime:performance.now()};
callback();
assert.match(block.innerHTML,/offer ended for new purchases/);
listeners.beforeprint();
assert.equal(previewBlock.hidden,true,'An unsaved proposal open across cutoff disappears before printing');
assert.equal(previewBlock.innerHTML,'');
context.window.__mhiCashbackClock={serverTime:promotions.split.claimEnd,wallTime:Date.now(),elapsedTime:performance.now()};
listeners.beforeprint();
assert.match(block.innerHTML,/Claims closed/);
assert.doesNotMatch(block.innerHTML,/claim information/);
console.log('Fujitsu: 30 exact pairs, date boundaries, separate reward, saved-quote preservation, new snapshots, copy/persistence/proposal and open-tab expiry passed.');

if(process.argv.includes('--browser')){
  const require=createRequire(import.meta.url);
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
  const origin='https://calculator.test';
  const output=new URL('../outputs/fujitsu-cashback/',import.meta.url);
  fs.mkdirSync(output,{recursive:true});
  try{
    for(const width of [1280,390]){
      const page=await browser.newPage({viewport:{width,height:1000}});
      const errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.route('**/*',route=>route.request().url()===origin+'/'?route.fulfill({contentType:'text/html',body:html}):route.abort());
      await page.addInitScript(time=>{
        window.CALCULATOR_USER={businessOperatingState:'NSW',businessId:'cashback-test',businessName:'Test Air',canSeeOwnerDetails:true,rebatesEnabled:false};
        window.__mhiCashbackClock={serverTime:time,wallTime:Date.now(),elapsedTime:performance.now()};
      },now);
      await page.goto(origin);
      await page.locator('#brand').selectOption('Fujitsu General');
      const summary=page.locator('#standardMhiCashback');
      assert.match(await summary.innerText(),/Potential GENERAL Airstage manufacturer reward \$150.00/);
      const baseline=await page.evaluate(()=>({calculation:calculate(),state:currentState()}));
      const after=await page.evaluate(()=>{fujitsuCashbackDisplay([fujitsuCashbackCurrentOffer(systemType,calculate())]);return {calculation:calculate(),state:currentState()};});
      assert.deepEqual(after,baseline,'Reward presentation does not change the calculation or state');
      const bounds=await summary.boundingBox();
      assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=width+1,'Reward fits viewport');
      await summary.scrollIntoViewIfNeeded();
      await page.screenshot({path:fileURLToPath(new URL(`split-${width}.png`,output))});
      const results=await page.evaluate(()=>{
        createNewOptionNow('Cashback test',true);
        const old={id:'old-fixture',type:'Split',brand:'Fujitsu General',model:'AOTG09KMTC/ASTG09KMTC',unitInc:810,finalInc:2000,rebate:400,optionId:currentAddOptionId(),state:{businessId:'cashback-test'}};
        quotes.push(old);persistQuotes();renderQuotes();
        const prior=JSON.stringify(old);
        addStandardSystemToQuoteNow();
        const added=quotes.find(row=>row.id!==old.id);
        const copied=buildCurrentQuoteInfo({name:'Cashback test'},[added]);
        const proposal=proposalPricingHtml([{def:{name:'Cashback test'},number:1,rows:[added]}]);
        return {unchanged:JSON.stringify(old)===prior,added,copied,proposal,oldDisplay:manufacturerCashbackQuoteBlock([old],{},old.finalInc)};
      });
      assert.equal(results.unchanged,true);assert.equal(results.oldDisplay,'');
      assert.equal(results.added.manufacturerCashback.amount,150);
      assert.match(results.copied,/manufacturer reward \$150.00/);
      assert.doesNotMatch(results.proposal,/Estimated cost after/);
      await page.reload();
      const persisted=await page.evaluate(()=>quotes.find(row=>row.id!=='old-fixture'));
      assert.equal(persisted.manufacturerCashback.amount,150);
      assert.equal(persisted.finalInc,results.added.finalInc);
      await page.locator('#ductedTab').click();
      await page.locator('#brand').selectOption('Fujitsu');
      await page.waitForFunction(()=>document.querySelector('#standardMhiCashback').textContent.includes('manufacturer reward $300.00'));
      assert.match(await summary.innerText(),/manufacturer reward \$300.00/);
      await summary.scrollIntoViewIfNeeded();
      await page.screenshot({path:fileURLToPath(new URL(`ducted-${width}.png`,output))});
      assert.deepEqual(errors,[]);
      await page.close();
      console.log(`${width}px: split/ducted reward, separate totals, old quote preservation, new quote save/reload, copy and proposal passed.`);
    }
  }finally{await browser.close();}
}
