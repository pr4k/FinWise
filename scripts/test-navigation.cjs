// Chrome acceptance against an isolated database; uses the built-in DevTools protocol.
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
(async()=>{
const root=path.resolve(__dirname,'..'),temp=await fs.mkdtemp(path.join(os.tmpdir(),'finwise-navigation-qa-'));
async function freePort(){const server=require('node:net').createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
const port=await freePort(),debugPort=await freePort(),origin=`http://127.0.0.1:${port}`;
const server=spawn(path.join(root,'target/debug/finwise-api'),[],{cwd:root,env:{...process.env,FINWISE_BIND:`127.0.0.1:${port}`,FINWISE_DATA_DIR:temp,FINWISE_WEB_DIR:path.join(root,'web'),FINWISE_INSECURE_LOCAL_COOKIES:'true',DATABASE_URL:`sqlite://${temp}/test.sqlite`},stdio:['ignore','ignore','pipe']});
const chrome=spawn(process.env.FINWISE_CHROME_EXECUTABLE||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'chromium'),['--headless=new','--no-first-run','--no-default-browser-check',`--user-data-dir=${temp}/chrome`,`--remote-debugging-port=${debugPort}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
let diagnostics='';server.stderr.on('data',x=>diagnostics+=x);chrome.stderr.on('data',x=>diagnostics+=x);
const pause=ms=>new Promise(r=>setTimeout(r,ms));let ws;
try{
 let tabs;for(let i=0;i<100;i++){try{if((await fetch(origin+'/health/ready')).ok){tabs=await(await fetch(`http://127.0.0.1:${debugPort}/json`)).json();break;}}catch{}await pause(200);}if(!tabs)throw Error(diagnostics);
 ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));let seq=0;const pending=new Map(),errors=[];
 ws.addEventListener('message',event=>{const msg=JSON.parse(event.data);if(msg.id){const request=pending.get(msg.id);pending.delete(msg.id);if(msg.error)request.reject(Error(msg.error.message));else request.resolve(msg.result);}if(msg.method==='Runtime.exceptionThrown')errors.push(msg.params.exceptionDetails.exception?.description||msg.params.exceptionDetails.text);});
 const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
 const run=async expression=>{const result=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
 const until=async expression=>{for(let i=0;i<150;i++){if(await run(expression))return;await pause(100);}throw Error('Timed out: '+expression+'\n'+await run('document.body.innerText'));};
 await cdp('Runtime.enable');await cdp('Page.enable');await cdp('Page.navigate',{url:origin});await until('!!document.querySelector("#auth-form")');
 await run(`(async()=>{const value=await window.finwiseAPI.request('auth/bootstrap',{method:'POST',body:{owner:{name:'Planner Tester',email:'planner@example.test',password:'planner-test-password-123'},household:{name:'Planner QA',timezone:'Asia/Kolkata',base_currency:'INR'}}});window.finwiseAPI.setCsrf(value.csrf_token);await signedIn();})()`);
 await until('!!document.querySelector(".dashboard-page")');
 await run(`(async()=>{
  const account=await finwiseAPI.request('accounts',{method:'POST',body:{name:'Savings',subtype:'bank',currency:'INR',visibility:'private'}});
  const transaction=await finwiseAPI.request('transactions',{method:'POST',body:{event_type:'expense',amount:'50.00',currency:'INR',effective_date:'2026-11-02',description:'Navigation QA',movements:[{account_id:account.id,amount:'-50.00'}],allocations:[{category_id:null,amount:'50.00',scope:'personal'}]}});
  window.qaTransaction=transaction.id;
  setMonth('2026-10');location.hash='transactions/all';
 })()`);
 await until('!!document.querySelector(".transaction-page")&&!document.querySelector("#view-root").hasAttribute("aria-busy")');
 await run(`(()=>{const control=document.querySelector('#report-month');control.value='2026-11';control.dispatchEvent(new Event('input',{bubbles:true}));control.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 await until('location.hash==="#transactions"&&!document.querySelector("#view-root").hasAttribute("aria-busy")');
 assert.equal(await run('state.month'),'2026-11');
 assert.equal(await run('document.querySelector("#report-month").value'),'2026-11');
 assert.equal(await run('new URL(location.href).searchParams.get("month")'),'2026-11');
 await cdp('Page.reload');
 await until('!!document.querySelector(".transaction-page")&&!document.querySelector("#view-root").hasAttribute("aria-busy")');
 assert.equal(await run('document.querySelector("#report-month").value'),'2026-11');
 await run(`document.querySelector('.activity-table tr[data-action="transaction-detail"]').click()`);
 await until('!!document.querySelector("#transaction-detail-form")');
 await run(`document.querySelector('#transaction-detail-form [data-action="edit-transaction"]').click()`);
 await until('!!document.querySelector("#transaction-full-edit-form")');
 assert.equal(await run('document.querySelector("#transaction-full-edit-form").elements.amount.value'),'50.00');
 await run(`dialog.close();window.qaOriginalCollection=finwiseAPI.collection;finwiseAPI.collection=path=>path.includes('/ledger?')?Promise.reject(new TypeError('Load failed')):qaOriginalCollection(path);document.querySelector('.activity-table tr[data-action="transaction-detail"]').click();`);
 await until('!!document.querySelector("#transaction-detail-form")');
 assert.ok(await run('document.querySelector("#transaction-detail-form").textContent.includes("Account balances could not be loaded")'));
 assert.ok(await run('!!document.querySelector("#transaction-detail-form [data-action=edit-transaction]")'));
 assert.deepEqual(errors,[]);
 console.log('PASS: November selected from October, input/change deduplication, month persists after reload, existing transaction opens and edits, and failed balance fetch leaves details available.');
}catch(error){console.error(error.stack);process.exitCode=1;}finally{ws?.close();chrome.kill();server.kill();await pause(500);await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
})();
