// Household permissions browser acceptance: isolated database and synthetic household.
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
 const invite=await run(`(async()=>{const me=await finwiseAPI.request('me'),token=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');await finwiseAPI.request('households/'+me.household.id+'/invites',{method:'POST',body:{email:'member@example.test',role:'member',token}});return token;})()`);
 const accepted=await fetch(origin+'/api/v1/invites/'+invite+'/accept',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({email:'member@example.test',name:'Family Member',password:'synthetic-family-password-123'})});
 assert.ok(accepted.ok,await accepted.text());const cookie=accepted.headers.get('set-cookie').split(';')[0];
 const csrf=(await(await fetch(origin+'/api/v1/auth/csrf',{headers:{Cookie:cookie}})).json()).csrf_token;
 const member=async(path,body,revision)=>{const response=await fetch(origin+'/api/v1/'+path,{method:body?'POST':'GET',headers:{Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID(),...(revision?{'If-Match':String(revision)}:{})},...(body?{body:JSON.stringify(body)}:{})});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;};
 const card=await member('accounts',{name:'Member card',subtype:'credit_card',currency:'INR',visibility:'shared'});
 const bank=await member('accounts',{name:'Member bank',subtype:'bank',currency:'INR',visibility:'shared',opening_balance:{amount:'10000',as_of:'2026-11-01T00:00:00+05:30'}});
 const holding=await member('investments',{name:'Member folio',folio:'FAMILY-123',type:'investment',currency:'INR',visibility:'shared'});
 await run(`(()=>{state.scope='combined';setMonth('2026-11');location.hash='accounts/${card.id}';})()`);
 await until('!!document.querySelector(".account-detail-page")&&!document.querySelector("#view-root").hasAttribute("aria-busy")');
 assert.equal(await run('!!document.querySelector("[data-action=edit-account]")'),false);
 assert.ok(await run('document.querySelector(".account-detail-actions").textContent.includes("View only")'));
 const toggle=async enabled=>{
  await run(`location.hash='settings'`);
  await until('!!document.querySelector("#family-controls-form")&&!document.querySelector("#view-root").hasAttribute("aria-busy")');
  await run(`(()=>{const form=document.querySelector('#family-controls-form');form.elements.family_member_controls.checked=${enabled};form.requestSubmit();})()`);
  await until(`state.me.household.family_member_controls===${enabled}&&!document.querySelector("#view-root").hasAttribute("aria-busy")`);
 };
 await toggle(true);
 await run(`location.hash='accounts/${card.id}'`);
 await until('!!document.querySelector("[data-action=edit-account]")&&!document.querySelector("#view-root").hasAttribute("aria-busy")');
 await run(`document.querySelector('[data-action=edit-account]').click()`);
 await until('document.querySelector("#editor").open&&!!document.querySelector("#account-edit-form")');
 await run(`(()=>{const form=document.querySelector('#account-edit-form');form.elements.due_amount.value='2500';form.elements.due_date.value='2026-11-20';form.requestSubmit();})()`);
 await until('!document.querySelector("#editor").open&&!document.querySelector("#view-root").hasAttribute("aria-busy")');
 const updated=await member('accounts/'+card.id);assert.equal(updated.owner_id,card.owner_id);assert.equal(updated.card_due.amount,'2500');
 await run(`location.hash='investments'`);
 await until('!!document.querySelector("[data-action=investment-tab][data-tab=holdings]")&&!document.querySelector("#view-root").hasAttribute("aria-busy")');
 await run(`document.querySelector('[data-action=investment-tab][data-tab=holdings]').click()`);
 await until('!!document.querySelector("[data-action=investment-add-money]")');
 await run(`document.querySelector('[data-action=investment-add-money]').click()`);
 await until('document.querySelector("#editor").open&&!!document.querySelector("#investment-transaction-form")');
 await run(`(()=>{const form=document.querySelector('#investment-transaction-form');form.elements.account_id.value='${bank.id}';form.elements.amount.value='500';form.elements.transaction_date.value='2026-11-04';form.requestSubmit();})()`);
 await until('!document.querySelector("#editor").open&&!document.querySelector("#view-root").hasAttribute("aria-busy")');
 const invested=await member('investments/'+holding.id);assert.equal(invested.owner_id,holding.owner_id);assert.equal(invested.folio,'FAMILY-123');assert.equal(invested.records[0].contribution,'500.00');
 await toggle(false);
 await run(`location.hash='accounts/${card.id}'`);
 await until('!!document.querySelector(".account-detail-page")&&!document.querySelector("#view-root").hasAttribute("aria-busy")');
 for(const action of ['edit-account','card-payment','transaction-account','opening-balance'])assert.equal(await run(`!!document.querySelector('[data-action=${action}]')`),false);
 await run(`location.hash='investments'`);
 await until('!!document.querySelector("[data-action=investment-tab][data-tab=holdings]")&&!document.querySelector("#view-root").hasAttribute("aria-busy")');
 await run(`document.querySelector('[data-action=investment-tab][data-tab=holdings]').click()`);
 assert.equal(await run('!!document.querySelector("[data-action=investment-add-money]")'),false);
 assert.deepEqual(errors,[]);console.log('PASS: Settings toggle enables editing another member’s card dues and contributing to their folio; disabling restores view-only account and investment controls.');
}catch(error){console.error(error.stack);process.exitCode=1;}finally{ws?.close();chrome.kill();server.kill();await pause(500);await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
})();
