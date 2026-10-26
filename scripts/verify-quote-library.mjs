import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]).join('\n');
new Function(source);
const ast=ts.createSourceFile('calculator.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const functions=new Map(ast.statements.filter(ts.isFunctionDeclaration).map(node=>[node.name.text,node.getText(ast)]));
const context={calculatorUserContext:()=>({businessId:'b1'}),activeBusinessName:()=> 'Example Air'};
vm.createContext(context);
const names=['quoteLibraryTime','quoteLibraryBusiness','quoteLibraryGroupData','selectQuoteLibraryGroups'];
vm.runInContext(names.map(name=>functions.get(name)).join('\n'),context);
const defs=[{id:'a',name:'Taylor Smith',syncUpdatedAt:100},{id:'b',name:'Taylor Smith',wonAt:'2026-10-01',syncUpdatedAt:200},{id:'empty',name:'Empty quote'}];
const rows=[{id:'r1',optionId:'a',model:'OUT-25 / IN-25',finalInc:2000,postcode:'2550',state:{businessId:'b1',businessName:'Example Air',address:'1 Test Street'}},{id:'r2',optionId:'b',model:'DUCT-140',finalInc:6000,wonAt:'2026-10-01',state:{businessId:'b2',businessName:'Other Air'}},{id:'orphan',optionId:'legacy',optionName:'Older quote',finalInc:700,customMetadata:{keep:true}}];
const before=JSON.stringify({defs,rows});
const groups=context.quoteLibraryGroupData(defs,rows);
assert.equal(groups.length,4,'Keep empty and orphaned historical quotes visible');
assert.equal(JSON.stringify({defs,rows}),before,'Indexing must not modify stored data');
const filter=extra=>context.selectQuoteLibraryGroups(groups,{query:'',status:'all',business:'all',sort:'recent',...extra}).map(group=>group.def.id);
assert.deepEqual([...filter({query:'taylor 2550'})],['a']);
assert.deepEqual([...filter({query:'IN-25'})],['a']);
assert.deepEqual([...filter({query:'test street'})],['a']);
assert.deepEqual([...filter({status:'won'})],['b']);
assert.deepEqual([...filter({business:'id:b2'})],['b']);
assert.deepEqual([...filter({business:'unassigned'})].sort(),['empty','legacy']);
assert.equal(filter({sort:'value'})[0],'b');
assert.equal(context.quoteLibraryBusiness([rows[0],rows[1]]).key,'mixed');
assert.equal(context.quoteLibraryBusiness([rows[0],rows[2]]).key,'unassigned');
assert.equal(context.quoteLibraryBusiness([rows[2]]).name,'Business not recorded');
assert.equal(context.quoteLibraryGroupData([], [{id:'r',optionId:'q',wonAt:'2026-10-02'}])[0].won,true,'Row-level won locks must be reflected even if definition is missing');
assert.equal(context.quoteLibraryTime('not a date'),0);
assert.equal(JSON.stringify({defs,rows}),before);
console.log('Quote library read-only indexing, search, status, business and sorting checks passed.');
Object.assign(context,{
  rowsShowRebates:()=>true,rowShowsRebate:()=>true,quoteLabourTreatment:()=> 'Expense',
  savedMaterialsInc:row=>row.materialsInc,savedMiscInc:row=>row.miscInc,
  savedPowerOrElectricianEx:row=>row.powerCost,agencyProfitAfterSalesInc:()=>555,
});
vm.runInContext(functions.get('buildQuoteLibraryCsv'),context);
const exportGroup={def:{name:'=UNSAFE()'},business:{name:'Example Air'},won:false,rows:[{
  model:'OUT / IN',finalInc:3300,unitInc:1100,rebate:500,labour:400,materialsInc:100,
  commissionInc:999,salespersonCommissionInc:123,netProfit:456,
}]};
const privateCsv=context.buildQuoteLibraryCsv([exportGroup],{private:true,sales:true,agency:true});
assert.match(privateCsv,/Agency commission inc GST/);
assert.match(privateCsv,/"999"/);
assert.match(privateCsv,/"'=UNSAFE\(\)"/,'Prevent customer names being interpreted as spreadsheet formulas');
const restrictedCsv=context.buildQuoteLibraryCsv([exportGroup],{private:false,sales:false,agency:false});
assert.doesNotMatch(restrictedCsv,/commission|profit|999|123|456/i,'Restricted export must not leak hidden financials');
assert.equal(restrictedCsv.split('\r\n').length,2,'Export contains only the explicitly scoped rows');
const salesCsv=context.buildQuoteLibraryCsv([exportGroup],{private:false,sales:true,agency:false});
assert.match(salesCsv,/Salesperson commission payable/);
assert.doesNotMatch(salesCsv,/Agency commission|Agency profit|999/);
console.log('Scoped CSV export, privacy and spreadsheet formula escaping checks passed.');
vm.runInContext(functions.get('quoteLibraryPriceCandidate'),context);
const priceOriginal={...rows[0],state:{rebate:'123.456789',keep:true},rebate:123.456789,commissionInc:99};
const priceBefore=JSON.stringify(priceOriginal);
const values={finalInc:'3300',unitInc:'1100',labour:'200',materialsInc:'110',miscInc:'0',powerCost:'0',external:true};
const candidate=context.quoteLibraryPriceCandidate(priceOriginal,values);
assert.equal(JSON.stringify(priceOriginal),priceBefore);
assert.deepEqual(JSON.parse(JSON.stringify(candidate.state)),priceOriginal.state);
assert.equal(candidate.commissionInc,99,'Client cannot overwrite derived financials');
assert.equal(candidate.rebate,123.456789);
assert.equal(candidate.labourTreatment,'Expense');
for(const bad of ['',null,-1,Infinity,'NaN'])assert.throws(()=>context.quoteLibraryPriceCandidate(priceOriginal,{...values,labour:bad}));
assert.throws(()=>context.quoteLibraryPriceCandidate(priceOriginal,{...values,unitInc:0}));
assert.equal(context.quoteLibraryPriceCandidate(priceOriginal,{...values,finalInc:'3300.125'}).finalInc,3300.13);
const multiOriginal={...priceOriginal,unitInc:2200,state:{...priceOriginal.state,systemType:'multi_split'}};
assert.equal(context.quoteLibraryPriceCandidate(multiOriginal,{...values,unitInc:'9999'}).unitInc,2200,'Multi-head equipment stays tied to its saved component prices');
console.log('Pricing draft validation and immutable saved model/rebate/commission checks passed.');
context.money=value=>'$'+value.toFixed(2);
vm.runInContext(functions.get('quoteLibraryStoredAmount'),context);
assert.equal(context.quoteLibraryStoredAmount([{salespersonCommissionInc:412.5}],'salespersonCommissionInc'),'$412.50');
assert.equal(context.quoteLibraryStoredAmount([{}],'salespersonCommissionInc'),'Unavailable');
assert.equal(context.quoteLibraryStoredAmount([{netProfit:0}],'netProfit'),'$0.00');
Object.assign(context,{htmlEscape:value=>String(value??''),canSeeProfitDetails:()=>false,canSeeSalespersonCommission:()=>true,canSeeAgencyProfit:()=>false});
vm.runInContext(['groupTotals','quoteLibraryMetric','quoteLibraryFinancialHtml'].map(name=>functions.get(name)).join('\n'),context);
const salesHtml=context.quoteLibraryFinancialHtml([{salespersonCommissionInc:412.5,netProfit:2475,commissionInc:999}]);
assert.match(salesHtml,/\$412\.50/);assert.match(salesHtml,/\$2475\.00/);
assert.doesNotMatch(salesHtml,/Agency commission|Agency profit|999/);
assert.match(context.quoteLibraryFinancialHtml([{}]),/Unavailable/);
console.log('Salesperson displays preserve authorized amounts without exposing agency financials.');
