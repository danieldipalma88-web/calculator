import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { mergeCalculatorData } from '../lib/quote-sync.ts';

const html = fs.readFileSync('index.html', 'utf8');
const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).sort((a,b) => b.length-a.length)[0];
const ast = ts.createSourceFile('calculator.js', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function source(name) {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, `Missing ${name}`);
  return node.getText(ast);
}
let registered = false;
const values = {unitPriceInc:1100, labour:100, materials:110, misc:0, rebate:0, finalInc:1870, electrician:0,
  multiUnitPriceInc:1100, multiLabour:100, multiMaterials:110, multiMisc:0, multiRebate:0, multiFinalInc:1870, multiPower:0};
const sandbox = {
  calculatorUserContext:()=>({salespersonGstRegistered:registered}),
  product:()=>({}),cap:()=>5,systemType:'ducted',num:id=>values[id]||0,multiNum:id=>values[id]||0,
  $:()=>({checked:false}),installAddonTotals:()=>({labour:0,materialsInc:0}),airCost:()=>0,powerCost:()=>0,
  rebatesEnabled:()=>true,effectiveCommissionType:()=> 'agency',shouldUseCommissionModel:()=>true,
  commissionRatePercent:type=>type==='agency'?25:50,
  agencyProfitAfterSalesInc:(agency,sales)=>agency-sales,multiSplitEquipmentTotals:()=>({total:1100}),
};
vm.createContext(sandbox);
for (const name of ['salespersonGstRegistered','calculate','calculateMultiSplitCosts','recomputeSavedQuote']) vm.runInContext(source(name),sandbox);
for (const type of ['split','ducted','multi']) {
  sandbox.systemType = type;
  const calculate = type==='multi'?sandbox.calculateMultiSplitCosts:sandbox.calculate;
  const noGst = calculate();
  assert.ok(Math.abs(noGst.agencyCommission-125)<1e-9);
  assert.ok(Math.abs(noGst.salespersonCommission-62.5)<1e-9);
  assert.equal(noGst.salespersonCommissionGst,0,`${type}: unregistered salesperson must not charge GST`);
  assert.ok(Math.abs(noGst.salespersonCommissionInc-62.5)<1e-9);
  assert.ok(Math.abs(noGst.agencyCommissionGst-12.5)<1e-9,'Agency GST must stay unchanged');
  registered = true;
  assert.ok(Math.abs(calculate().salespersonCommissionInc-68.75)<1e-9,'Registered salesperson retains existing GST treatment');
  registered = false;
}
assert.equal(sandbox.salespersonGstRegistered({salespersonGstRegistered:true,state:{salespersonGstRegistered:false}}),true);
assert.equal(sandbox.salespersonGstRegistered({state:{salespersonGstRegistered:false}}),false);
assert.equal(sandbox.salespersonGstRegistered({salespersonCommission:20,salespersonCommissionGst:0}),false);
assert.equal(sandbox.salespersonGstRegistered({salespersonCommission:20}),true,'Legacy snapshots must not inherit a new account GST status');
assert.equal(sandbox.salespersonGstRegistered({salespersonCommission:20,salespersonCommissionGst:null}),true);
assert.equal(sandbox.salespersonGstRegistered({salespersonCommission:20,salespersonCommissionGst:''}),true);

const paid = {id:'paid',wonAt:'2026-10-13',salespersonCommissionInc:159.4435,salespersonCommissionRate:40};
assert.equal(sandbox.recomputeSavedQuote(paid),paid,'Won jobs must not be repriced by rendering');
assert.equal(sandbox.recomputeSavedQuote({...paid,salespersonCommissionInc:0}).salespersonCommissionInc,0,'A legitimate zero remains a known payable');
// Missing payables must reach normal recalculation, not be mistaken for zero.
for (const value of [null,'']) {
  assert.throws(()=>sandbox.recomputeSavedQuote({...paid,salespersonCommissionInc:value}),/savedMaterialsInc/);
}
const rowsKey = 'installerMasterQuoteLogV1';
const corrected = {id:'corrected',wonAt:'2026-10-19',syncUpdatedAt:200,salespersonCommissionRate:50,salespersonGstRegistered:false,
  salespersonCommission:154.1907954545,salespersonCommissionGst:0,salespersonCommissionInc:154.1907954545,
  agencyCommission:308.381590909,state:{salespersonCommissionRate:50,salespersonGstRegistered:false}};
const merge = incoming => JSON.parse(mergeCalculatorData({[rowsKey]:JSON.stringify([corrected,paid])},{[rowsKey]:JSON.stringify(incoming)})[rowsKey]);
const stale = {...corrected,syncUpdatedAt:300,salespersonCommissionRate:40,salespersonGstRegistered:true,
  salespersonCommissionInc:135.6879,state:{salespersonCommissionRate:40,salespersonGstRegistered:true},installationAddress:'Preserved address edit'};
let result = merge([stale,{...paid,syncUpdatedAt:500,salespersonCommissionInc:200}]);
assert.equal(result[0].salespersonCommissionInc,corrected.salespersonCommissionInc,'An older open tab cannot undo the correction');
assert.equal(result[0].state.salespersonCommissionRate,50);
assert.equal(result[0].state.salespersonGstRegistered,false);
assert.equal(result[0].installationAddress,'Preserved address edit','Unrelated fields retain normal merge behaviour');
assert.equal(result[1].salespersonCommissionInc,paid.salespersonCommissionInc,'Paid history must be preserved');
result = merge([{...stale,wonAt:''}]);
assert.equal(result[0].salespersonCommissionInc,stale.salespersonCommissionInc,'An explicitly unlocked quote remains editable');

const raw = fs.readFileSync('app/calculator/raw/route.ts','utf8');
const rawAst = ts.createSourceFile('raw.ts',raw,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const sanitize = rawAst.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='stripSensitiveQuoteFields');
const sanitizing = {};
vm.runInNewContext(ts.transpile(sanitize.getText(rawAst)),sanitizing);
const visible = sanitizing.stripSensitiveQuoteFields({...corrected,cashProfit:1200,agencyCommissionRate:25});
assert.equal(visible.salespersonCommissionInc,corrected.salespersonCommissionInc,'Salespeople retain their own agreed won-job payable');
assert.equal(visible.agencyCommission,undefined,'Private agency amounts stay hidden');
assert.equal(visible.agencyCommissionRate,undefined,'Private rates stay hidden');
assert.equal(visible.cashProfit,undefined,'Private profit stays hidden');
assert.equal(visible.state.salespersonCommissionRate,undefined,'Private nested rates stay hidden');
assert.equal(sanitizing.stripSensitiveQuoteFields({...corrected,wonAt:''}).salespersonCommissionInc,undefined,'Draft commission sanitization is unchanged');
assert.ok(html.includes('salespersonGstRegistered:salespersonGstRegistered()'),'New quote snapshots must retain GST registration');
const admin = fs.readFileSync('app/admin/users/page.tsx','utf8');
const adminAst = ts.createSourceFile('admin.tsx',admin,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const saveNode = adminAst.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='saveWonCalculatorSnapshot');
const casSandbox = {dbMessage:error=>error.message};
vm.runInNewContext(ts.transpile(saveNode.getText(adminAst)),casSandbox);
function client(currentVersion) {
  let writes = 0;
  let versionFilter;
  const query = {
    update(){return this;},
    eq(key,value){if(key==='updated_at') versionFilter=value;return this;},
    is(key,value){if(key==='updated_at') versionFilter=value;return this;},
    async select(){if(versionFilter===currentVersion){writes++;return {data:[{user_id:'test'}],error:null};}return {data:[],error:null};},
  };
  return {from:()=>query,get writes(){return writes;}};
}
const matching = client('current');
assert.equal(await casSandbox.saveWonCalculatorSnapshot(matching,'email','test',{},'current'),'');
assert.equal(matching.writes,1);
const stalePayment = client('corrected');
assert.match(await casSandbox.saveWonCalculatorSnapshot(stalePayment,'email','test',{},'old'),/Refresh Won Jobs/);
assert.equal(stalePayment.writes,0,'An in-flight payment save must not overwrite a correction');
const noVersion = client(null);
assert.equal(await casSandbox.saveWonCalculatorSnapshot(noVersion,'email','test',{},null),'');
assert.equal(noVersion.writes,1);
console.log('Salesperson GST, locked-job commission history and stale-tab safeguards verified.');
