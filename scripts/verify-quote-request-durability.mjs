import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { bootstrapHtml, declaration, loadTsModule } from './verify-business-configuration.mjs';

const { applyQuoteArrange } = loadTsModule('lib/quote-arrange.ts');
const family = loadTsModule('lib/quote-family.ts');
const quoteLibrary = loadTsModule('lib/quote-library-edit.ts');
const sync = loadTsModule('lib/quote-sync.ts');
const validation = loadTsModule('lib/won-job-validation.ts');
const route = fs.readFileSync(new URL('../app/api/calculator-data/route.ts', import.meta.url), 'utf8');
const rowsKey = 'installerMasterQuoteLogV1', defsKey = 'installerQuoteOptionDefsV1';
const clone = value => structuredClone(value);
const tick = () => new Promise(resolve => setImmediate(resolve));
const baseline = {
  [defsKey]: JSON.stringify([{id:'a',name:'Customer',quoteFamilyId:'a',quoteOptionName:'Option 1',quoteOptionOrder:0,syncUpdatedAt:10},
    {id:'b',name:'Customer',quoteFamilyId:'a',quoteOptionName:'Option 2',quoteOptionOrder:1,syncUpdatedAt:10}]),
  [rowsKey]: JSON.stringify([{id:'row',optionId:'a',optionName:'Customer',quotePosition:0,syncUpdatedAt:10,timestamp:10,type:'Split',model:'Fixture',
    unitInc:1100,finalInc:3300,rebate:123.45,agencyCommission:300,salespersonCommissionInc:50,state:{privateExtension:'keep',agencyCommissionRate:25}}]),
  draft:'initial',
};
const payload = {action:'moveRow',optionId:'a',targetOptionId:'b',rowId:'row',saveId:'durable_move_1',expected:{defs:JSON.parse(baseline[defsKey]),rows:JSON.parse(baseline[rowsKey])}};

function endpoint(data = baseline, visible = true, collision) {
  const state = {data:clone(data),updated_at:'2026-10-01T00:00:00.123456Z',reads:0,writes:0};
  const db = {from(table) {
    assert.equal(table,'user_calculator_data');
    const filters={};let update;
    const q={
      select() {
        if(!update)return q;
        state.writes++;
        if(collision&&state.writes===1){collision(state);state.updated_at='2026-10-01T00:00:01Z';}
        if(filters.updated_at!==state.updated_at)return Promise.resolve({data:[],error:null});
        state.data=clone(update.data);state.updated_at=update.updated_at;
        return Promise.resolve({data:[{user_id:'user'}],error:null});
      },
      eq(k,v){filters[k]=v;return q;},is(k,v){filters[k]=v;return q;},update(v){update=v;return q;},
      async maybeSingle(){state.reads++;return {data:{user_id:'user',data:clone(state.data),updated_at:state.updated_at},error:null};},
    };return q;
  }};
  const context={...family,...quoteLibrary,...sync,...validation,applyQuoteArrange,calculatorDataHasData:data=>Object.keys(data||{}).length>0};
  vm.runInNewContext(ts.transpileModule(declaration('saveMergedUserData',route),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  return {state,async call(body) {
    const result=await context.saveMergedUserData(db,'user@test','user',body.data||{},false,body.quoteEdit,visible,body.quoteCopy,true,body.quoteArrange);
    return {ok:!result.error,status:result.status||200,json:async()=>clone(result)};
  }};
}

function browser(server) {
  const storage=new Map(),timeouts=new Map(),intervals=new Map(),handlers=new Map(),calls=[],beacons=[];
  let id=0,responder=body=>server.call(body),failStorageKey=null;
  const sandbox={AbortController,Event,CustomEvent,Blob,performance:{now:()=>0},
    setTimeout(fn,ms){const n=++id;timeouts.set(n,{fn,ms});return n;},clearTimeout(n){timeouts.delete(n);},
    setInterval(fn,ms){const n=++id;intervals.set(n,{fn,ms});return n;},clearInterval(n){intervals.delete(n);},
    window:{addEventListener(k,v){handlers.set(k,v);},dispatchEvent(){}},
    document:{body:null,readyState:'loading',visibilityState:'visible',getElementById:()=>null,addEventListener(){}},
    localStorage:{get length(){return storage.size;},key:i=>[...storage.keys()][i],getItem:k=>storage.get(k)??null,
      setItem:(k,v)=>{if(k===failStorageKey){failStorageKey=null;throw new Error('Local quote storage write failed');}storage.set(k,String(v));},removeItem:k=>storage.delete(k),clear:()=>storage.clear()},
    navigator:{sendBeacon(...args){beacons.push(args);return true;}},
    fetch(url,options){const body=JSON.parse(options.body||'{}');calls.push(body);return Promise.resolve(responder(body,options));},
  };
  const bootstrap=bootstrapHtml(baseline,null,true).match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(bootstrap,sandbox);
  return {sandbox,storage,calls,beacons,timeouts,
    failNextWrite(key){failStorageKey=key;},
    setResponder(fn){responder=fn;},periodic(){[...intervals.values()].find(t=>t.ms===5000).fn();},unload(){handlers.get('beforeunload')();},
    fire(ms){const found=[...timeouts].find(([,t])=>t.ms===ms);assert.ok(found,`Missing timer ${ms}`);timeouts.delete(found[0]);found[1].fn();},
    patch(result,saveId=payload.saveId){
      for(const [key,records] of [[defsKey,result.defs],[rowsKey,result.rows]]){
        const current=JSON.parse(storage.get(key));const replacements=new Map(records.map(r=>[r.id,r]));
        sandbox.localStorage.setItem(key,JSON.stringify(current.map(r=>replacements.get(r.id)||r)));
      }
      assert.equal(sandbox.window.__calculatorAcknowledgeQuoteArrange(saveId),true,'Only acknowledge after every local patch write succeeds');
    },
  };
}

// Reproduction: commit, lose response, edit a local draft, then Retry. A stale preflush must not precede the receipt lookup.
const lostServer=endpoint(),lost=browser(lostServer);
let first=true;
lost.setResponder(async body=>{const response=await lostServer.call(body);if(body.quoteArrange&&first){first=false;throw new Error('Lost response AFTER commit');}return response;});
await assert.rejects(lost.sandbox.window.__calculatorQuoteRequest('quoteArrange',clone(payload)),/Lost response/);
assert.equal(lost.sandbox.window.__calculatorAcknowledgeQuoteArrange(payload.saveId),false,'Lost response cannot be acknowledged');
assert.equal(JSON.parse(lostServer.state.data[rowsKey])[0].optionId,'b');
lost.sandbox.localStorage.setItem('draft','unsent unrelated edit after lost response');
lost.periodic();lost.unload();assert.equal(lost.calls.length,1);assert.equal(lost.beacons.length,0);
const confirmed=await lost.sandbox.window.__calculatorQuoteRequest('quoteArrange',clone(payload));
assert.equal(confirmed.ok,true);
assert.equal(lost.sandbox.window.__calculatorAcknowledgeQuoteArrange('wrong_save_id'),false,'Wrong acknowledgement cannot release a valid-response fence');
assert.equal(lost.calls.filter(body=>body.data).length,0,'Retry must reach its receipt without flushing the stale pre-move layout');
assert.equal(lostServer.state.writes,1,'Receipt replay is read-only, without another full-profile CAS');
lost.patch(confirmed);await tick();
await lost.sandbox.window.__calculatorFlushCloudSave();await tick();
assert.equal(lostServer.state.data.draft,'unsent unrelated edit after lost response');
assert.equal(JSON.parse(lostServer.state.data[rowsKey])[0].optionId,'b');

// Slow save: no periodic autosave or unload beacon is allowed to race the committed move before the patch arrives.
const slowServer=endpoint(),slow=browser(slowServer);let release;
slow.setResponder(async body=>{const response=await slowServer.call(body);if(body.quoteArrange)return new Promise(resolve=>{release=()=>resolve(response);});return response;});
const slowRequest=slow.sandbox.window.__calculatorQuoteRequest('quoteArrange',clone(payload));await tick();
assert.equal(slow.sandbox.window.__calculatorAcknowledgeQuoteArrange(payload.saveId),false,'In-flight response cannot be acknowledged');
slow.sandbox.localStorage.setItem('draft','retained during slow move');slow.periodic();slow.unload();
assert.equal(slow.calls.length,1);assert.equal(slow.beacons.length,0);
await assert.rejects(slow.sandbox.window.__calculatorQuoteRequest('quoteArrange',{...clone(payload),saveId:'another_move'}),/pending|progress|confirm/i);
release();const slowResult=await slowRequest;slow.patch(slowResult);await tick();
await slow.sandbox.window.__calculatorFlushCloudSave();await tick();
assert.equal(slowServer.state.data.draft,'retained during slow move');

// The first mutation still waits for a genuinely dirty durable preflush.
const dirtyServer=endpoint(),dirty=browser(dirtyServer);let finishFlush;
dirty.sandbox.localStorage.setItem('draft','must save before move');
dirty.setResponder(body=>body.data?new Promise(resolve=>{finishFlush=async()=>resolve(await dirtyServer.call(body));}):dirtyServer.call(body));
const dirtyRequest=dirty.sandbox.window.__calculatorQuoteRequest('quoteArrange',clone(payload));await tick();
assert.equal(dirty.calls.length,1);assert.ok(dirty.calls[0].data);assert.equal(dirtyServer.state.writes,0);
await finishFlush();const dirtyResult=await dirtyRequest;dirty.patch(dirtyResult);await tick();
assert.equal(dirty.calls.length,2);assert.ok(dirty.calls[1].quoteArrange);

// A timeout before the first preflush completes never sends the arrangement, and retry still flushes first.
const failedFlushServer=endpoint(),failedFlush=browser(failedFlushServer);
failedFlush.sandbox.localStorage.setItem('draft','durable first');
failedFlush.setResponder(async()=>({ok:false,status:503,json:async()=>({error:'Snapshot offline'})}));
const failedPreparation=failedFlush.sandbox.window.__calculatorQuoteRequest('quoteArrange',clone(payload));
const failedPreparationCheck=assert.rejects(failedPreparation,/Current changes could not be confirmed/);
await tick();failedFlush.fire(20000);await failedPreparationCheck;
assert.ok(failedFlush.calls.every(body=>body.data),'No mutation before successful preparation');
failedFlush.setResponder(body=>failedFlushServer.call(body));
const preparedRetry=await failedFlush.sandbox.window.__calculatorQuoteRequest('quoteArrange',clone(payload));
failedFlush.patch(preparedRetry);await tick();
assert.ok(failedFlush.calls.at(-2).data);assert.ok(failedFlush.calls.at(-1).quoteArrange);

// A malformed success cannot release stale snapshots; retry uses the same save receipt.
const malformedServer=endpoint(),malformed=browser(malformedServer);let corrupt=true;
malformed.setResponder(async body=>{const response=await malformedServer.call(body);if(body.quoteArrange&&corrupt){corrupt=false;return {ok:true,status:200,json:async()=>({defs:[],rows:[{}],removedOptionIds:[],removedRowIds:[]})};}return response;});
await assert.rejects(malformed.sandbox.window.__calculatorQuoteRequest('quoteArrange',clone(payload)),/could not be verified/);
assert.equal(malformed.sandbox.window.__calculatorAcknowledgeQuoteArrange(payload.saveId),false,'Malformed success cannot be acknowledged');
malformed.sandbox.localStorage.setItem('draft','retained after malformed success');malformed.periodic();malformed.unload();
assert.equal(malformed.calls.length,1);assert.equal(malformed.beacons.length,0);
malformed.patch(await malformed.sandbox.window.__calculatorQuoteRequest('quoteArrange',clone(payload)));await tick();
assert.equal(malformedServer.state.writes,1);

// Reviewer reproduction: valid server result, partial local patch fails, draft changes, then exact Retry.
const patchFailureServer=endpoint(),patchFailure=browser(patchFailureServer);
assert.equal(patchFailure.sandbox.window.__calculatorAcknowledgeQuoteArrange(payload.saveId),false,'No request means no acknowledgement');
const committed=await patchFailure.sandbox.window.__calculatorQuoteRequest('quoteArrange',clone(payload));
assert.equal(JSON.parse(patchFailureServer.state.data[rowsKey])[0].optionId,'b');
assert.equal(patchFailure.sandbox.window.__calculatorAcknowledgeQuoteArrange('wrong_save_id'),false);
patchFailure.failNextWrite(rowsKey);
assert.throws(()=>patchFailure.patch(committed),/Local quote storage write failed/);
assert.equal(JSON.parse(patchFailure.storage.get(rowsKey))[0].optionId,'a','Failed rows write leaves the old local layout');
patchFailure.sandbox.localStorage.setItem('draft','retained after failed local patch');
patchFailure.periodic();patchFailure.unload();
assert.equal(patchFailure.calls.length,1,'Valid response alone cannot release autosave');
assert.equal(patchFailure.beacons.length,0,'Valid response alone cannot release unload');
await assert.rejects(patchFailure.sandbox.window.__calculatorFlushCloudSave(),/pending option change/);
const patchReplay=await patchFailure.sandbox.window.__calculatorQuoteRequest('quoteArrange',clone(payload));
assert.equal(patchReplay.ok,true);
assert.equal(patchFailure.calls.length,2);assert.ok(patchFailure.calls.every(body=>body.quoteArrange),'Retry after local failure bypasses stale preflush');
assert.equal(patchFailureServer.state.writes,1,'Retry confirms receipt without another database write');
patchFailure.patch(patchReplay);await tick();
assert.equal(patchFailure.sandbox.window.__calculatorAcknowledgeQuoteArrange(payload.saveId),false,'Duplicate acknowledgement cannot release a future request');
await patchFailure.sandbox.window.__calculatorFlushCloudSave();await tick();
assert.equal(patchFailureServer.state.data.draft,'retained after failed local patch');
assert.equal(JSON.parse(patchFailureServer.state.data[rowsKey])[0].optionId,'b');

// Terminal validation/conflict responses release the fence without needing a success acknowledgement.
for(const status of [409,422]){
  const terminalServer=endpoint(),terminal=browser(terminalServer);
  terminal.setResponder(async()=>({ok:false,status,json:async()=>({error:'Terminal option error'})}));
  await assert.rejects(terminal.sandbox.window.__calculatorQuoteRequest('quoteArrange',clone(payload)),error=>error.status===status);
  assert.equal(terminal.sandbox.window.__calculatorAcknowledgeQuoteArrange(payload.saveId),false);
  terminal.sandbox.localStorage.setItem('draft','terminal fence released');
  terminal.setResponder(body=>terminalServer.call(body));
  await terminal.sandbox.window.__calculatorFlushCloudSave();await tick();
  assert.equal(terminalServer.state.data.draft,'terminal fence released');
}

// Two same-turn requests cannot both pass the asynchronous first-preflush boundary.
const doubleServer=endpoint(),double=browser(doubleServer);
const firstMove=double.sandbox.window.__calculatorQuoteRequest('quoteArrange',clone(payload));
const secondMove=double.sandbox.window.__calculatorQuoteRequest('quoteArrange',{...clone(payload),saveId:'different_same_turn'});
const secondMoveCheck=assert.rejects(secondMove,/pending option change/);
const firstMoveResult=await firstMove;double.patch(firstMoveResult);await secondMoveCheck;
assert.equal(double.calls.filter(body=>body.quoteArrange).length,1);

// Receipt lookup must still reject changed requests and subsequent concurrent edits.
const changedServer=endpoint();await changedServer.call({quoteArrange:clone(payload)});
assert.equal((await changedServer.call({quoteArrange:{...clone(payload),targetOptionId:'a'}})).status,409);
const rows=JSON.parse(changedServer.state.data[rowsKey]);rows[0].finalInc=9999;rows[0].syncUpdatedAt+=1;changedServer.state.data[rowsKey]=JSON.stringify(rows);
assert.equal((await changedServer.call({quoteArrange:clone(payload)})).status,409);

const cas=endpoint(baseline,true,state=>{state.data.otherDraft='concurrent';});
assert.equal((await cas.call({quoteArrange:clone(payload)})).ok,true);
assert.equal(cas.state.writes,2);assert.equal(cas.state.data.otherDraft,'concurrent');
const locked=clone(baseline);const lockedDefs=JSON.parse(locked[defsKey]);lockedDefs[0].wonAt='2026-01-01';locked[defsKey]=JSON.stringify(lockedDefs);
assert.equal((await endpoint(locked).call({quoteArrange:clone(payload)})).status,409);
const maskedServer=endpoint(baseline,false);const maskedPayload=clone(payload);maskedPayload.expected.rows=maskedPayload.expected.rows.map(r=>quoteLibrary.quoteLibraryVisibleRow(r,false));
const masked=await (await maskedServer.call({quoteArrange:maskedPayload})).json();
assert.equal(masked.ok,true);assert.ok(masked.rows.every(r=>!('agencyCommission'in r)&&!('agencyCommissionRate'in r.state)));
console.log('Quote-request durability: actual bridge + save loop; valid-response/local-patch failure + receipt retry, matching-ID acknowledgement, in-flight/malformed/wrong-ID ack rejection, terminal release, held autosave/beacon, durable first flush, locks, masking and CAS passed.');
