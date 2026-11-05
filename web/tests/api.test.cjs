const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const {webcrypto}=require('node:crypto');
const source=fs.readFileSync(require('node:path').join(__dirname,'../api.js'),'utf8');
function client(fetch, cryptoValue=webcrypto) {
  const events=[]; const window={dispatchEvent:e=>events.push(e.type)};
  vm.runInNewContext(source,{window,fetch,FormData,File,crypto:cryptoValue,Event});
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
test('POST works when randomUUID is unavailable',async()=>{
  const api=client(async(_url,options)=>{
    assert.match(options.headers['Idempotency-Key'],/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    return response({id:'created'},201);
  },{getRandomValues:array=>webcrypto.getRandomValues(array)});
  await api.request('auth/bootstrap',{method:'POST',body:{}});
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
test('catalog reads are reused briefly and a mutation invalidates them',async()=>{
  const calls=[];
  const api=client(async(url,options)=>{
    calls.push({url,method:options.method});
    return response(options.method==='GET'?{data:[{id:String(calls.length)}],page:{}}:{id:'created'});
  });
  api.setCsrf('csrf-test');
  const first=await api.collection('categories?include_archived=true');
  const second=await api.collection('categories?include_archived=true');
  assert.equal(first.data[0].id,second.data[0].id);
  assert.equal(calls.length,1);
  await api.request('categories',{method:'POST',body:{name:'Food'}});
  const third=await api.collection('categories?include_archived=true');
  assert.equal(third.data[0].id,'3');
});
test('investment pages and reports reuse reads and refresh after writes or session changes',async()=>{
  const calls=[];
  const api=client(async(url,options)=>{
    calls.push({url,method:options.method});
    return response({data:[],page:{},revision:calls.length});
  });
  for(const path of ['investments?limit=200','investments?limit=200&cursor=page2','investments/report?month=2026-10&scope=personal&currency=INR','investments/goals?month=2026-10']) {
    const first=await api.request(path);
    assert.equal(await api.request(path),first);
  }
  assert.equal(calls.length,4);
  await api.request('investments/h/valuations',{method:'POST',body:{value:'123.45'}});
  await api.request('investments?limit=200');
  assert.equal(calls.length,6);
  api.reset();
  await api.request('investments?limit=200');
  assert.equal(calls.length,7);
});
test('simultaneous uncached reads share a request, but later reads stay fresh',async()=>{
  let calls=0,release;
  const api=client(async()=>{calls++;return new Promise(resolve=>{release=resolve;});});
  const first=api.request('recurring-transactions'),second=api.request('recurring-transactions');
  assert.equal(calls,1);release(response({data:[{amount:'123.45'}]}));
  assert.deepEqual(await first,await second);
  const third=api.request('recurring-transactions');assert.equal(calls,2);release(response({data:[]}));await third;
});
test('failed shared reads can retry and session changes discard in-flight reuse',async()=>{
  let calls=0;const releases=[];
  const api=client(async()=>{calls++;return new Promise((resolve,reject)=>releases.push({resolve,reject}));});
  const first=api.request('me'),second=api.request('me');assert.equal(calls,1);
  releases[0].reject(new TypeError('Offline'));await Promise.all([assert.rejects(first),assert.rejects(second)]);
  const retry=api.request('me');assert.equal(calls,2);
  api.reset();const fresh=api.request('me');assert.equal(calls,3);
  releases[2].resolve(response({user:{id:'new-session'}}));assert.equal((await fresh).user.id,'new-session');
  releases[1].resolve(response({user:{id:'old-session'}}));await retry;
});
test('writes break in-flight reuse and abortable reads remain independent',async()=>{
  let calls=0;const releases=[];
  const api=client(async(_url,options)=>{calls++;if(options.method==='POST')return response({id:'saved'});return new Promise(resolve=>releases.push(resolve));});
  const before=api.request('recurring-transactions');await api.request('transactions',{method:'POST',body:{}});
  const after=api.request('recurring-transactions');assert.equal(calls,3);
  releases[0](response({data:[]}));releases[1](response({data:[{id:'new'}]}));await before;assert.equal((await after).data[0].id,'new');
  const a=api.request('me',{signal:{}}),b=api.request('me',{signal:{}});assert.equal(calls,5);
  releases[2](response({}));releases[3](response({}));await Promise.all([a,b]);
});
