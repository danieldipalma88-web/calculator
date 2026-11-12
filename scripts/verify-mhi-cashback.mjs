import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { copyQuoteWithoutLifecycle } from '../lib/quote-family.ts';
import { mergeCalculatorData } from '../lib/quote-sync.ts';
import { visibleCalculatorData } from '../lib/quote-data-visibility.ts';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]).join('\n');
new Function(source);
const ast=ts.createSourceFile('calculator.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const functions=['isMultiHeadQuoteType','htmlEscape','refreshMhiCashbackBlocks','watchMhiCashbackClock',
  'addMultiSplitToQuoteNow','groupTotals','proposalPricingHtml'];
const cashbackSource=ast.statements.filter(node=>
  (ts.isVariableStatement(node)&&node.declarationList.declarations.some(declaration=>/^(MHI|FUJITSU)_CASHBACK_/.test(declaration.name.getText(ast))))||
  (ts.isFunctionDeclaration(node)&&(/^(mhiCashback|fujitsuCashback|manufacturerCashback)/.test(node.name?.text)||functions.includes(node.name?.text)))
).map(node=>node.getText(ast)).join('\n');
const start=Date.parse('2026-10-01T00:01:00+10:00');
const end=Date.parse('2027-02-01T00:00:00+11:00');
const claimEnd=Date.parse('2027-03-01T00:00:00+11:00');
const brand='Mitsubishi Heavy Industries';
const money=amount=>'$'+amount.toFixed(2);
let wall=Date.parse('2025-01-01T00:00:00Z');
let elapsed=90;
class Clock extends Date { static now(){return wall;} }
const window={__mhiCashbackClock:{serverTime:start,wallTime:wall,elapsedTime:elapsed}};
const context=vm.createContext({Date:Clock,window,performance:{now:()=>elapsed},money,
  savedMaterialsInc:row=>row.materialsInc,savedMiscInc:row=>row.miscInc,savedPowerOrElectricianEx:row=>row.powerCost,
  agencyProfitAfterSalesInc:()=>0,proposalSystemTitle:row=>row.type,quoteRowsMissingPriceModels:()=>[]});
vm.runInContext(cashbackSource+'\nglobalThis.schedule=MHI_CASHBACK_PROMOTION;',context);
const {mhiCashbackActive,mhiCashbackPairAmount,mhiCashbackMultiAmount,mhiCashbackQuoteOffer,
  mhiCashbackSnapshot,mhiCashbackDisplay,mhiCashbackNow,mhiCashbackBlock,watchMhiCashbackClock,schedule}=context;
assert.deepEqual([Object.keys(schedule.split).length,Object.keys(schedule.ducted).length,Object.keys(schedule.multi).length],[68,39,7]);
assert.equal(mhiCashbackActive(start-1),false);
assert.equal(mhiCashbackActive(start),true);
assert.equal(mhiCashbackActive(end-1),true);
assert.equal(mhiCashbackActive(end),false);
assert.equal(mhiCashbackNow(),start,'Use the server time instead of the workstation date');
elapsed+=150;
assert.equal(mhiCashbackNow(),start+150,'Use elapsed time even if the workstation clock stalls');
wall+=200;
assert.equal(mhiCashbackNow(),start+200,'Use elapsed wall time when the browser performance clock stalls during sleep');

for(const [type,rows] of Object.entries({split:schedule.split,ducted:schedule.ducted})){
  for(const [pair,amount] of Object.entries(rows)){
    const [outdoor,indoor]=pair.split('/');
    assert.equal(mhiCashbackPairAmount(brand,pair,type),amount);
    assert.equal(mhiCashbackPairAmount(brand,outdoor+' - '+indoor,type),amount);
    assert.equal(mhiCashbackPairAmount(brand,indoor+' / '+outdoor,type),amount);
  }
}
const model='SRC50ZSXA-W/SRK50ZSXA-WF';
assert.equal(mhiCashbackPairAmount(brand,model,'split'),150);
assert.equal(mhiCashbackPairAmount(brand,'FDCA140VNX-W/FDUA140VH','ducted'),350);
assert.equal(mhiCashbackPairAmount(brand,'FDCA140VSX-W/FDUA140VH','ducted'),350);
assert.equal(mhiCashbackPairAmount(brand,'FDC224KXZPE1/FDU224KXZE1','ducted'),500);
assert.equal(mhiCashbackPairAmount(brand,'SRC95ZRA-W/SRK95ZRA-WF1','split'),0);
assert.equal(mhiCashbackPairAmount(brand,'FDC100VNP-W/FDU100VH','ducted'),0);
assert.equal(mhiCashbackPairAmount(brand,'SRC50ZSXA-W/SRK35ZSXA-WF','split'),0);
assert.equal(mhiCashbackPairAmount(brand,'SRK50ZSXA-WF','split'),0);
assert.equal(mhiCashbackPairAmount('Mitsubishi Electric',model,'split'),0);

const head=(capacityNum,model,qty=1)=>({brand,capacityNum,model,qty,unitPriceInc:900});
const outdoor=model=>({brand,model,unitPriceInc:1800});
const small=head(2.5,'SRK25ZSXA-WF',2);
const medium=head(3.5,'SRK35ZSXA-WF',2);
const large=head(5,'SRK50ZSXA-WF',2);
const combinations={
  'SCM40ZS-W':[small],
  'SCM45ZS-W':[small],
  'SCM50ZS-W':[small],
  'SCM60ZS-W':[medium],
  'SCM71ZS-W':[medium],
  'SCM80ZS-W':[large],
  'SCM100ZS-W':[large],
};
for(const [code,amount] of Object.entries(schedule.multi)){
  assert.equal(mhiCashbackMultiAmount(outdoor(code),combinations[code]),amount,code);
}
assert.equal(mhiCashbackMultiAmount(outdoor('SCM40ZS-W'),[]),0);
assert.equal(mhiCashbackMultiAmount(outdoor('SCM40ZS-W'),[{...small,qty:1}]),0);
assert.equal(mhiCashbackMultiAmount(outdoor('SCM40ZS-W'),[{...small,qty:3}]),0);
assert.equal(mhiCashbackMultiAmount(outdoor('SCM40ZS-W'),[large]),0);
assert.equal(mhiCashbackMultiAmount(outdoor('SCM60ZS-W'),[small]),0);
assert.equal(mhiCashbackMultiAmount(outdoor('SCM40ZS-W'),[{...small,brand:'Mitsubishi Electric'}]),0);
assert.equal(mhiCashbackMultiAmount(outdoor('SCM100ZS-W'),[{...large,model:'SRK50ZSA-W'}]),0);
assert.equal(mhiCashbackMultiAmount(outdoor('SCM100ZS-W'),[head(6.1,'SRK60ZSXA-WF'),head(3.5,'SRF35ZS-W')]),400);
assert.equal(mhiCashbackMultiAmount(outdoor('SCM100ZS-W'),[head(7.1,'DXK24ZRA-WF1'),head(2,'SRK20ZSA-W')]),400);

const row={id:'r',type:'Split',brand,model,finalInc:2000,unitInc:1000,rebate:150,syncUpdatedAt:start};
const offer=mhiCashbackQuoteOffer(row);
const display=(items,time,price=2000)=>mhiCashbackDisplay(items.filter(Boolean),price,true,time).lines.join('\n');
assert.match(display([offer],start),/\$150\.00.*\n.*\$1850\.00/);
assert.equal(display([offer],start-1),'');
assert.equal(display([offer],end),'','Legacy quotes have no expired record');
assert.equal(display([mhiCashbackQuoteOffer(row,{wonAt:'2026-09-01'})],end-1,2000),'');
assert.match(display([mhiCashbackQuoteOffer(row,{proposedInstallationDate:'2027-02-01'})],end-1),/unavailable/);
assert.match(display([mhiCashbackQuoteOffer(row,{},'1 Feb 2027')],end-1),/unavailable/);
assert.match(display([mhiCashbackQuoteOffer(row,{},'31/01/2027')],end-1),/\$1850\.00/);
assert.doesNotMatch(display(Array(9).fill(offer),end-1,18000),/Estimated cost|\$1350\.00/);
assert.match(display(Array(9).fill(offer),end-1,18000),/eight eligible systems/);
assert.equal(mhiCashbackSnapshot(offer,end),undefined);
assert.equal(mhiCashbackSnapshot(mhiCashbackQuoteOffer(row,{},'1 Feb 2027'),end-1),undefined);
const manufacturerCashback=mhiCashbackSnapshot(offer,end-1);
const recorded={...row,manufacturerCashback};
const expiredOffer=mhiCashbackQuoteOffer(recorded);
assert.match(display([expiredOffer],end),/Recorded MHIAA cashback \$150\.00.*expired/);
assert.doesNotMatch(display([expiredOffer],end),/Estimated cost/);
assert.match(display([expiredOffer],claimEnd),/claims closed/);
assert.equal(mhiCashbackDisplay([expiredOffer],2000,true,claimEnd-1).showClaim,true);
assert.equal(mhiCashbackDisplay([expiredOffer],2000,true,claimEnd).showClaim,false);
const unavailableRecord=mhiCashbackQuoteOffer(recorded,{},'1 Feb 2027');
assert.match(display([unavailableRecord],end),/unavailable.*\n.*expired/);
assert.equal(mhiCashbackDisplay([unavailableRecord],2000,true,end).showClaim,false);

const rowsKey='installerMasterQuoteLogV1';
const saved={[rowsKey]:JSON.stringify([recorded])};
const merged=mergeCalculatorData(saved,{[rowsKey]:JSON.stringify([{...recorded,finalInc:2500,syncUpdatedAt:start+1}])});
const visible=visibleCalculatorData(merged,false,true);
const [reopened]=JSON.parse(visible[rowsKey]);
assert.deepEqual(reopened.manufacturerCashback,JSON.parse(JSON.stringify(manufacturerCashback)));
assert.equal(reopened.finalInc,2500);
assert.equal(reopened.rebate,150);
assert.deepEqual(copyQuoteWithoutLifecycle(reopened).manufacturerCashback,reopened.manufacturerCashback);

const groups=[{def:{name:'Taylor'},number:1,rows:[recorded]}];
const proposal=context.proposalPricingHtml(groups,'31 January 2027');
assert.match(proposal,/Amount due<\/span><strong>\$2000\.00/);
assert.match(proposal,/Estimated cost after receiving cashback \$1850\.00/);
assert.match(context.proposalPricingHtml(groups,'1 February 2027'),/unavailable for the proposed installation date/);

const pricedMulti={outdoor:outdoor('SCM40ZS-W'),indoorItems:[{row:small,qty:2}],headCount:2,connectedCapacity:5,
  finalInc:6800,unitInc:3600,rebate:375,commissionInc:193,salespersonCommissionInc:96,netProfit:577};
Object.assign(context,{currentAddOptionId:()=> 'o',assertOptionEditable:()=>true,multiSplitQuoteReadiness:()=>({ok:true}),
  calculateMultiSplitCosts:()=>pricedMulti,currentMultiSplitState:()=>({systemType:'multi_split',outdoorModel:pricedMulti.outdoor.model,indoorHeads:[small]}),
  optionNameById:()=> 'Taylor',optionDefById:()=>null,salespersonGstRegistered:()=>true,quotes:[],persistQuotes(){},renderQuotes(){},showQuoteActionNotice(){}});
vm.runInContext('let currentQuoteTotalsEditing=false;',context);
context.addMultiSplitToQuoteNow();
const [multiSaved]=context.quotes;
assert.equal(multiSaved.manufacturerCashback.amount,200,'One SCM payment per complete system, not per head');
for(const key of ['finalInc','rebate','commissionInc','salespersonCommissionInc','netProfit']) assert.equal(multiSaved[key],pricedMulti[key]);

const fakeBlock={dataset:{mhiCashback:JSON.stringify([[expiredOffer],2000,true])}};
const unitLabel={},unitBadge={},unitPresentation={},unitSelect={selectedOptions:[{textContent:'5.0kW - Avanti Plus'}]};
const unitParts={'.productSelectCashback':unitPresentation,'.productCashbackUnitName':unitLabel,'.mhiCashbackBadge':unitBadge,select:unitSelect};
const unitWrap={
  dataset:{mhiCashback:JSON.stringify([[expiredOffer],null,false]),mhiCashbackUnit:'true'},
  classList:{toggle:(name,active)=>{unitWrap.active=active;}},
  querySelector:selector=>unitParts[selector],
};
const listeners={};
let callback;
const view={
  document:{querySelectorAll:()=>[fakeBlock,unitWrap],addEventListener:(event,fn)=>{listeners[event]=fn;}},
  addEventListener:(event,fn)=>{listeners[event]=fn;},
  setTimeout:fn=>{callback=fn;return 1;},clearTimeout(){},
};
window.__mhiCashbackClock={serverTime:end-100,wallTime:wall,elapsedTime:elapsed};
watchMhiCashbackClock(view);
assert.match(fakeBlock.innerHTML,/Estimated cost after receiving cashback \$1850\.00/);
assert.equal(unitLabel.textContent,'5.0kW - Avanti Plus');
assert.equal(unitBadge.textContent,'Potential $150 Cashback');
assert.equal(unitPresentation.hidden,false);
wall+=100;
callback();
assert.match(fakeBlock.innerHTML,/offer expired for new purchases/);
assert.doesNotMatch(fakeBlock.innerHTML,/Estimated cost after receiving cashback/);
assert.equal(unitPresentation.hidden,true,'The selected-unit badge disappears at the same expiry boundary');
assert.equal(unitBadge.textContent,'');
assert.equal(unitWrap.active,false,'The native selected label is restored after expiry');
wall+=claimEnd-end;
listeners.beforeprint();
assert.match(fakeBlock.innerHTML,/claims closed/);
assert.doesNotMatch(fakeBlock.innerHTML,/Claim with MHIAA/);
assert.match(mhiCashbackBlock([offer],2000),/ hidden>/);
console.log('MHI cashback schedule, date boundaries, multi-head combinations, quote persistence, proposal pricing and live expiry passed.');
