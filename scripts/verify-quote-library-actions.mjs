import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');
const ast=ts.createSourceFile('calculator.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const fns=new Map(ast.statements.filter(ts.isFunctionDeclaration).map(n=>[n.name.text,n.getText(ast)]));
function setup(names){
  const elements=new Map();
  const ctx={quotes:[{id:'a',optionId:'one',brand:'A',syncUpdatedAt:100},{id:'b',optionId:'two',brand:'B',syncUpdatedAt:200}],quoteOptionDefs:[{id:'one',name:'One'},{id:'two',name:'Two'}],savedQuoteSets:[],recommendedOptionId:'',currentQuoteTotalsEditing:false,pendingCurrentQuoteRemoveIndex:-1,pendingCurrentQuoteRemoveId:'',pendingQuoteLibraryRemoval:null,quoteLibraryView:{},writes:0,deletions:[],alerts:[],
    $:id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',classList:{add(){},remove(){}}});return elements.get(id);},
    ensureSecondaryStartup(){},persistQuotes(){ctx.writes++;},persistOptionDefs(){ctx.writes++;},persistSavedQuoteSets(){ctx.writes++;},renderQuotes(){},renderQuoteLibrary(){},renderSavedQuoteSets(){},saveQuoteExportName(){},setSavedQuoteStatus(){},showQuoteActionNotice(){},discardQuoteLibraryEdit:()=>true,
    recordQuoteSyncDeletions:(rows,defs)=>ctx.deletions.push({rows:rows.map(r=>r.id),defs:defs.map(d=>d.id)}),
    confirm:()=>true,alert:m=>ctx.alerts.push(m),cloneObj:o=>structuredClone(o),defaultSavedQuoteName:()=> 'Backup',optionNameById:id=>id,
    optionIsWon:id=>ctx.quoteOptionDefs.some(d=>d.id===id&&d.wonAt),assertOptionEditable:id=>!ctx.quoteOptionDefs.some(d=>d.id===id&&d.wonAt),
  };
  vm.createContext(ctx);vm.runInContext(names.map(name=>{assert.ok(fns.has(name),name);return fns.get(name);}).join('\n'),ctx);return ctx;
}
let failures=0;
function check(name,fn){try{fn();console.log('PASS '+name);}catch(e){failures++;console.error('FAIL '+name+': '+e.message);}}
check('Retired Clear cannot remove any records',()=>{
  const c=setup(['clearQuotes']);const before=JSON.stringify(c.quotes);c.clearQuotes();assert.equal(JSON.stringify(c.quotes),before);assert.equal(c.writes,0);assert.equal(c.deletions.length,0);
});
check('Backup view is read-only and preserves working list',()=>{
  const c=setup(['loadSelectedSavedQuote']);const saved={id:'backup',name:'Older',quotes:[{id:'old'}],optionDefs:[]};c.selectedSavedQuote=()=>saved;const before=JSON.stringify(c.quotes);c.loadSelectedSavedQuote();assert.equal(JSON.stringify(c.quotes),before);assert.equal(c.writes,0);assert.equal(c.deletions.length,0);assert.equal(c.quoteLibraryView.backupId,'backup');
});
check('Saving backup 101 retains every prior backup',()=>{
  const c=setup(['saveCurrentQuoteSet']);c.savedQuoteSets=Array.from({length:100},(_,i)=>({id:'backup-'+i}));c.saveCurrentQuoteSet();assert.equal(c.savedQuoteSets.length,101);assert.equal(c.savedQuoteSets.at(-1).id,'backup-99');
});
const removalFns=['requestRemoveCurrentQuoteSystem','closeRemoveSystemModal','confirmRemoveCurrentQuoteSystem','removeQuote'];
check('Removal confirmation uses stable ID after list reorder',()=>{
  const c=setup(removalFns);c.requestRemoveCurrentQuoteSystem(0);c.quotes.unshift({id:'new',optionId:'two'});c.confirmRemoveCurrentQuoteSystem();assert.deepEqual(c.quotes.map(r=>r.id),['new','b']);assert.deepEqual([...c.deletions[0].rows],['a']);
});
check('Removal rejects edited, removed or newly won records',()=>{
  for(const change of [c=>{c.quotes[0].syncUpdatedAt=300;},c=>{c.quotes[0].wonAt='2026-10-26';},c=>{c.quoteOptionDefs[0].wonAt='2026-10-26';},c=>{c.quotes.shift();}]){
    const c=setup(removalFns);c.requestRemoveCurrentQuoteSystem(0);change(c);const before=JSON.stringify(c.quotes);c.confirmRemoveCurrentQuoteSystem();assert.equal(JSON.stringify(c.quotes),before);assert.equal(c.deletions.length,0);
  }
});
if(failures)process.exitCode=1;
