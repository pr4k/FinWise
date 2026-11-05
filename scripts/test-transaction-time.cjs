// Transaction device time acceptance: isolated database and synthetic household.
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
(async()=>{
const root=require('node:path').resolve(__dirname,'..'),temp=await fs.mkdtemp(path.join(os.tmpdir(),'finwise-time-qa-'));
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
 const until=async expression=>{for(let i=0;i<150;i++){if(await run(expression))return;await pause(100);}throw Error('Timed out: '+expression+'\n'+await run('(document.querySelector("#editor")?.innerText||document.querySelector("#view-root")?.innerText||"").slice(0,1400)'));};
 await cdp('Runtime.enable');await cdp('Page.enable');await cdp('Page.navigate',{url:origin});await until('!!document.querySelector("#auth-form")');
 await run(`(async()=>{const value=await window.finwiseAPI.request('auth/bootstrap',{method:'POST',body:{owner:{name:'Account Tester',email:'accounts@example.test',password:'accounts-test-password-123'},household:{name:'Account QA',timezone:'Asia/Kolkata',base_currency:'INR'}}});window.finwiseAPI.setCsrf(value.csrf_token);await signedIn();})()`);
 await until('!!document.querySelector(".dashboard-page")');


 await run(`(async()=>{
  const bank=await finwiseAPI.request('accounts',{method:'POST',body:{name:'Salary account',subtype:'bank',currency:'INR',opening_balance:{amount:'100000.00',as_of:'2026-10-01T00:00:00+05:30'}}});
  const card=await finwiseAPI.request('accounts',{method:'POST',body:{name:'Everyday card',subtype:'credit_card',currency:'INR'}});
  for(const [kind,value,desc] of [['income','180000.00','Monthly salary'],['expense','24000.00','Monthly rent'],['expense','4500.00','Groceries']])await finwiseAPI.request('transactions',{method:'POST',body:{event_type:kind,amount:value,currency:'INR',effective_date:'2026-10-02',description:desc,movements:[{account_id:bank.id,amount:kind==='income'?value:'-'+value}],allocations:[{category_id:null,amount:value,scope:'personal'}]}});
  await finwiseAPI.request('transactions',{method:'POST',body:{event_type:'transfer',amount:'1500.00',currency:'INR',effective_date:'2026-10-04',description:'Card payment',movements:[{account_id:bank.id,amount:'-1500.00'},{account_id:card.id,amount:'1500.00'}],allocations:[]}});
  await catalogs();setMonth('2026-10');await renderRoute();
 })()`);
 await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 for(const timezone of ['Asia/Kolkata','America/Los_Angeles']) {
  await cdp('Emulation.setTimezoneOverride',{timezoneId:timezone});
  await run(`transactionEditor()`);
  const clock=await run(`({actual:document.querySelector('#transaction-form').elements.effective_time.value,expected:localDateTime(new Date().toISOString()).slice(11)})`);
  assert.equal(clock.actual,clock.expected,'Entry defaults to the device clock');
  const expected=await run(`(()=>{const f=document.querySelector('#transaction-form');f.elements.effective_date.value='2026-07-15';f.elements.effective_time.value='23:47';f.elements.amount.value='12';f.elements.description.value='Device time ${timezone}';const instant=Date.parse(localTimestamp('2026-07-15T23:47'));f.requestSubmit();return instant;})()`);
  await until(`!dialog.open&&!root.hasAttribute('aria-busy')`);
  const tx=await run(`(async()=>{const rows=(await finwiseAPI.collection('transactions')).data;return rows.find(t=>t.description==='Device time ${timezone}');})()`);
  assert.ok(tx,'Transaction saved');assert.equal(Date.parse(tx.effective_at),expected,'Saved timestamp matches device wall time');
  await run(`transactionEditEditor('${tx.id}')`);await until(`dialog.open&&!!document.querySelector('#transaction-full-edit-form')`);
  await run(`document.querySelector('#transaction-full-edit-form').requestSubmit()`);await until(`!dialog.open&&!root.hasAttribute('aria-busy')`);
  assert.equal(await run(`(async()=>{const tx=await finwiseAPI.request('transactions/${tx.id}');return tx.effective_at;})()`),tx.effective_at,'Editing preserves the recorded instant');
  console.log('PASS: device time default, manual time, timezone conversion, saved timestamp and edit preservation in '+timezone);
 }
 await run(`cardPaymentEditor(state.accounts.find(a=>a.subtype==='credit_card').id)`);
 const clock=await run(`({actual:document.querySelector('#card-payment-form').elements.effective_time.value,expected:localDateTime(new Date().toISOString()).slice(11)})`);
 assert.equal(clock.actual,clock.expected,'Card payments default to device time');
 const expected=await run(`(()=>{const f=document.querySelector('#card-payment-form');f.elements.effective_date.value='2026-07-15';f.elements.effective_time.value='19:32';f.elements.amount.value='10';f.elements.description.value='Timed card payment';const instant=Date.parse(localTimestamp('2026-07-15T19:32'));f.requestSubmit();return instant;})()`);
 await until(`!dialog.open&&!root.hasAttribute('aria-busy')`);
 const payment=await run(`(async()=>{const rows=(await finwiseAPI.collection('transactions')).data;return rows.find(t=>t.description==='Timed card payment');})()`);
 assert.equal(payment.event_type,'transfer');assert.equal(Date.parse(payment.effective_at),expected);
 console.log('PASS: card payments save the selected device time as a transfer');
 assert.deepEqual(errors,[]);
}catch(error){console.error(error.stack);process.exitCode=1;}finally{ws?.close();chrome.kill();server.kill();await pause(500);await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
})();
