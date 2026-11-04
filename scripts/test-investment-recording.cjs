// Manual investment browser acceptance: isolated database and synthetic household.
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
(async()=>{
const root=path.resolve(__dirname,'..'),temp=await fs.mkdtemp(path.join(os.tmpdir(),'finwise-planner-qa-'));
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
 await run(`(async()=>{const value=await window.finwiseAPI.request('auth/bootstrap',{method:'POST',body:{owner:{name:'Planner Tester',email:'planner@example.test',password:'planner-test-password-123'},household:{name:'Planner QA',timezone:'Asia/Kolkata',base_currency:'INR'}}});window.finwiseAPI.setCsrf(value.csrf_token);await signedIn();})()`);
 await until('!!document.querySelector(".dashboard-page")');
 const setup=await run(`(async()=>{
  const bank=await finwiseAPI.request('accounts',{method:'POST',body:{name:'Investment bank',subtype:'bank',currency:'INR',opening_balance:{amount:'10000.00',as_of:'2026-10-01T00:00:00+05:30'}}});
  const holding=await finwiseAPI.request('investments',{method:'POST',body:{name:'Manual SIP folio',type:'investment',currency:'INR',folio:'QA-FOLIO-123',sip:{amount:'1000.00',day:2,start_month:'2026-11',status:'active'}}});
  await catalogs();setMonth('2026-11');location.hash='investments';return {bank:bank.id,holding:holding.id};
 })()`);
 await until('!!document.querySelector("[data-action=investment-tab][data-tab=sips]")&&!document.querySelector("#view-root").hasAttribute("aria-busy")');
 await run(`document.querySelector('[data-action=investment-tab][data-tab=sips]').click()`);
 await until('!!document.querySelector("[data-action=investment-process-sip]")');
 assert.equal(await run('document.querySelector("[data-action=investment-process-sip]").textContent'),'Record investment');
 await run(`document.querySelector('[data-action=investment-process-sip]').click()`);
 await until('document.querySelector("#editor").open&&!!document.querySelector("#investment-process-sip-form")');
 await run(`(()=>{const form=document.querySelector('#investment-process-sip-form');form.elements.account_id.value='${setup.bank}';form.requestSubmit();})()`);
 await until('!document.querySelector("#editor").open&&!document.querySelector("#view-root").hasAttribute("aria-busy")');
 assert.equal(await run('!!document.querySelector("[data-action=investment-process-sip]")'),false);
 let posted=await run(`(async()=>({holding:await finwiseAPI.request('investments/${setup.holding}'),transactions:(await finwiseAPI.collection('transactions')).data}))()`);
 assert.equal(posted.transactions.length,1);assert.equal(posted.transactions[0].investment_id,setup.holding);assert.equal(posted.transactions[0].event_type,'investment');assert.equal(posted.transactions[0].amount,'1000.00');assert.equal(posted.transactions[0].movements[0].account_id,setup.bank);
 assert.equal(posted.holding.folio,'QA-FOLIO-123');assert.ok(posted.holding.records[0].transaction_ids.includes(posted.transactions[0].id));assert.equal(posted.holding.records[0].sip_processed,true);
 await run(`document.querySelector('[data-action=investment-tab][data-tab=holdings]').click()`);
 await until('!!document.querySelector("[data-action=investment-add-money]")');
 await run(`document.querySelector('[data-action=investment-add-money]').click()`);
 await until('document.querySelector("#editor").open&&!!document.querySelector("#investment-transaction-form")');
 assert.equal(await run('document.querySelector("#investment-transaction-form").elements.holding_id.value'),setup.holding);
 await run(`(()=>{const form=document.querySelector('#investment-transaction-form');form.elements.account_id.value='${setup.bank}';form.elements.amount.value='500';form.elements.transaction_date.value='2026-11-02';form.requestSubmit();})()`);
 await until('!document.querySelector("#editor").open&&!document.querySelector("#view-root").hasAttribute("aria-busy")');
 posted=await run(`(async()=>({holding:await finwiseAPI.request('investments/${setup.holding}'),transactions:(await finwiseAPI.collection('transactions')).data,balance:await finwiseAPI.request('accounts/${setup.bank}/balance-at?as_of=2026-11-30T23%3A59%3A00%2B05%3A30')}))()`);
 assert.equal(posted.transactions.length,2);assert.ok(posted.transactions.every(t=>t.investment_id===setup.holding));assert.equal(posted.holding.records[0].contribution,'1500.00');assert.equal(posted.holding.records[0].transaction_ids.length,2);assert.equal(posted.balance.amount,'8500.00');assert.equal(posted.holding.folio,'QA-FOLIO-123');
 assert.deepEqual(errors,[]);console.log('PASS: manual SIP and Add money create bank debits linked to the selected folio; processed SIP action disappears; balance and contribution totals agree.');
}catch(error){console.error(error.stack);process.exitCode=1;}finally{ws?.close();chrome.kill();server.kill();await pause(500);await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
})();
