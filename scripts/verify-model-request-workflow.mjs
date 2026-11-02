import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const read = path => readFileSync(new URL('../'+path,import.meta.url),'utf8');
function moduleAt(path,stubs={}) {
  const {outputText}=ts.transpileModule(read(path),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}});
  const exports={};
  vm.runInThisContext(`(function(exports,require){${outputText}\n})`)(exports,id=>id in stubs?stubs[id]:require(id));
  return exports;
}
const catalogue=moduleAt('lib/model-catalogue.ts',{
  './public-rebate-catalogue.generated.json':JSON.parse(read('lib/public-rebate-catalogue.generated.json')),
  './supabase/config':{},
});
const p={systemType:'split',brand:'Example',model:'OUT25 / IN25',series:'Test',capacityKw:2.5,phase:'Single'};
const row={id:'test',product:p,active:true,created_at:'2026-11-03T00:00:00Z'};
const products=catalogue.calculatorAddedProducts([row]);
assert.equal(products[0].priceIncGst,0);
assert.equal(products[0].warrantyYears,0);
assert.equal(products[0].wifiStatus,'unknown');
assert.equal(products[0].nswOnly,true);
const merged=catalogue.mergedPublicCatalogue([row,{...row,id:'duplicate',product:{...p,model:'IN25/OUT25'}},{...row,id:'disabled',active:false}]);
assert.equal(merged.products.filter(x=>x.brand==='Example').length,1);
assert.equal(merged.products.find(x=>x.brand==='Example').dcceewEligible,undefined);

const html=read('index.html');
const start=html.indexOf('const verifiedCatalogueProductCache');
const end=html.indexOf('function data()',start);
let state='NSW',business='one';
const existing={brand:'Daikin',model:'OUT1 / IN1',priceIncGst:100};
const privateUnit={brand:'LG',model:'PRIVATE / IN',priceIncGst:200};
const context={window:{__verifiedCatalogueAdditions:products},activeBusinessState:()=>state,activeCatalogKey:()=> 'default',calculatorUserContext:()=>({businessId:business}),normaliseBrandName:b=>b,baseProductListFor:()=>[existing],mergeBusinessProducts:(_,list)=>list.concat(privateUnit)};
vm.runInNewContext(html.slice(start,end)+'\nglobalThis.list=productListFor;',context);
assert.equal(context.list('split')[0],existing);
assert.equal(context.list('split')[1],privateUnit,'private product positions preserved');
assert.equal(context.list('split')[2].model,p.model);
context.list('split')[2].unitPriceInc=777;
assert.equal(context.list('split')[2].unitPriceInc,777,'price-manager mutation survives subsequent data lookup');
state='QLD';assert.equal(context.list('split').length,2);
state='NSW';assert.equal(context.list('split').length,3);

const ast=ts.createSourceFile('calculator.js',html.slice(html.indexOf('const SPLIT_PRODUCTS =')),ts.ScriptTarget.Latest,true);
function declaration(name){return ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name)?.getText(ast);}
const restore={normalizeLookup:s=>String(s).toUpperCase().replace(/[^A-Z0-9]/g,''),normaliseModelName:s=>s,brandsEquivalent:(a,b)=>a===b,parseManagedIndexFromKey:()=>-1,activeCatalogKey:()=> 'default'};
vm.runInNewContext(declaration('productLookupIndexFromState')+'\n'+declaration('managedStoredTypeFromKey')+'\nglobalThis.lookup=productLookupIndexFromState;globalThis.storedType=managedStoredTypeFromKey;',restore);
assert.equal(restore.lookup({brand:'Disabled brand',model:'SAME / CODE',productManagedKey:'split|verified_removed'},[{brand:'Other brand',model:'SAME / CODE'}]),-1,'disabled addition cannot load another brand with same code');
assert.equal(restore.storedType('split|verified_removed'),'','addition prices never enter model-only legacy migration');

process.env.MODEL_REQUEST_AUTOMATION_ENABLED='true';process.env.MODEL_REQUEST_WORKER_SECRET='test-only';
async function scenario({verification,claimState='checking',sendFails=false,publishState='added'}) {
  const calls=[];let emails=0;let published=false;
  const request={id:'request',requester_email:'person@example.invalid',...p};
  const job={lease_token:'lease',state:claimState,product:p,existing:false};
  const worker=moduleAt('lib/model-request-worker.ts',{
    './model-catalogue':{
      catalogueClient:()=>({rpc:async(_,args)=>{
        calls.push(args.p_action);
        if(args.p_action==='claim')return {data:{request,job,operating_state:'NSW',user_enabled:true}};
        if(args.p_action==='verified'){published=true;return {data:{...job,state:publishState}};}
        return {data:{}};
      }}),
      modelIdentity:catalogue.modelIdentity,
      readAddedModels:async()=>published||claimState==='added'?[row]:[],
      mergedPublicCatalogue:catalogue.mergedPublicCatalogue,
    },
    './model-request-verification':{verifyRequestedModel:async()=>{if(verification instanceof Error)throw verification;return verification;}},
    './model-request-email':{sendModelRequestConfirmation:async()=>{assert.ok(published||claimState==='added','never email before publication');emails++;if(sendFails)throw Error('timeout');return 'mail-id';}},
  });
  const result=await worker.processModelRequest('request');
  return {result,calls,emails};
}
let result=await scenario({verification:{kind:'verified',product:p,evidence:{}}});
assert.deepEqual(result.calls,['claim','verified','email_start','email_sent']);assert.equal(result.emails,1);
result=await scenario({verification:{kind:'review',reason:'Ambiguous'}});assert.deepEqual(result.calls,['claim','review']);assert.equal(result.emails,0);
result=await scenario({verification:new Error('Registry timeout')});assert.deepEqual(result.calls,['claim','retry']);assert.equal(result.emails,0);
result=await scenario({verification:{kind:'verified',product:p,evidence:{}},sendFails:true});assert.deepEqual(result.calls,['claim','verified','email_start','email_error']);
result=await scenario({claimState:'added'});assert.deepEqual(result.calls,['claim','email_start','email_sent'],'email retry cannot republish');
result=await scenario({verification:{kind:'verified',product:p,evidence:{}},publishState:'review'});assert.equal(result.emails,0);
const sql=read('supabase/model_request_automation_upgrade.sql');
assert.match(sql,/for update skip locked/);
assert.match(sql,/identity text not null unique/);
assert.match(sql,/secret_hash=sha256/);
assert.match(sql,/interval '23 hours'/);
assert.match(sql,/after insert on public.calculator_model_requests/);
assert.doesNotMatch(sql,/insert into public.calculator_model_request_jobs[\s\S]{0,100}select/i,'no historical backfill');
assert.match(read('app/api/cron/model-requests/route.ts'),/timingSafeEqual/);
assert.match(read('app/api/admin/model-requests/route.ts'),/canManageUsers/);
console.log('Model workflow: publication ordering, duplicate merge, NSW scope, private catalogue positions, no-price support, verification failures and email retries passed.');
