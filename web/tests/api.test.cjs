const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const {webcrypto}=require('node:crypto');
const source=fs.readFileSync(require('node:path').join(__dirname,'../api.js'),'utf8');
function client(fetch) {
  const events=[]; const window={dispatchEvent:e=>events.push(e.type)};
  vm.runInNewContext(source,{window,fetch,FormData,File,crypto:webcrypto,Event});
  return {...window.finwiseAPI,events};
}
const response=(value,status=200)=>({ok:status<400,status,json:async()=>value});
test('ambiguous POST retry retains idempotency key and exact money strings',async()=>{
  const calls=[]; let failed=false;
  const api=client(async(url,options)=>{calls.push({url,options});if(!failed){failed=true;throw new TypeError('Network unavailable');}return response({id:'created'},201);});
  api.setCsrf('csrf-test');
  const request={method:'POST',body:{amount:'90071992547409.91'}};
  await assert.rejects(()=>api.request('transactions',request));
  await api.request('transactions',request);
  assert.equal(calls[0].options.headers['Idempotency-Key'],calls[1].options.headers['Idempotency-Key']);
  assert.equal(calls[1].options.headers['X-CSRF-Token'],'csrf-test');
  assert.equal(calls[1].options.credentials,'same-origin');
  assert.equal(JSON.parse(calls[1].options.body).amount,'90071992547409.91');
  await api.request('transactions',request);
  assert.notEqual(calls[1].options.headers['Idempotency-Key'],calls[2].options.headers['Idempotency-Key']);
});
test('collections follow every cursor without converting amounts',async()=>{
  const calls=[];
  const api=client(async url=>{calls.push(url);return response(calls.length===1?{data:[{amount:'0.01'}],page:{next_cursor:'abc/1'},meta:{coverage:'unknown'}}:{data:[{amount:'90071992547409.91'}],page:{},meta:{coverage:'unknown'}});});
  const result=await api.collection('transactions?from=2026-09-01');
  assert.equal(result.data.length,2); assert.equal(result.data[1].amount,'90071992547409.91');
  assert.ok(calls[1].includes('&cursor=abc%2F1')); assert.equal(result.meta.coverage,'unknown');
});
test('expired session emits an event and surfaces the API error',async()=>{
  const api=client(async()=>response({error:{message:'Sign in to continue.',code:'unauthenticated'}},401));
  await assert.rejects(()=>api.request('accounts'),{message:'Sign in to continue.',status:401});
  assert.deepEqual(api.events,['session-expired']);
});
