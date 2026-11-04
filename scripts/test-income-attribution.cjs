// Income attribution browser acceptance: isolated database and synthetic household.
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
 const people=await run(`(async()=>{
  const me=await finwiseAPI.request('me'),token=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
  await finwiseAPI.request('households/'+me.household.id+'/invites',{method:'POST',body:{email:'earner@example.test',role:'member',token}});
  const response=await fetch('/api/v1/invites/'+token+'/accept',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({email:'earner@example.test',name:'Second Earner',password:'synthetic-earner-password-123'})});if(!response.ok)throw Error(JSON.stringify(await response.json()));
  await catalogs();
  const partner=state.members.find(m=>m.name==='Second Earner');
  const bank=await finwiseAPI.request('accounts',{method:'POST',body:{name:'Shared salary account',subtype:'bank',currency:'INR',visibility:'shared',opening_balance:{amount:'0.00',as_of:'2026-10-01T00:00:00+05:30'}}});
  const salary=await finwiseAPI.request('categories',{method:'POST',body:{name:'Salary',kind:'income',visibility:'shared'}});
  await catalogs();setMonth('2026-11');return {me:me.user.id,partner:partner.user_id,bank:bank.id,salary:salary.id};
 })()`);
 await run(`transactionEditor({accountId:'${people.bank}',date:'2026-11-01'})`);
 await run(`(()=>{const form=document.querySelector('#transaction-form');form.elements.event_type.value='income';form.elements.event_type.dispatchEvent(new Event('change',{bubbles:true}));form.elements.scope.value='family';form.elements.scope.dispatchEvent(new Event('change',{bubbles:true}));form.elements.income_member_id.value='${people.partner}';form.elements.category_id.value='${people.salary}';form.elements.description.value='Partner salary recorded by owner';form.elements.amount.value='50000';form.requestSubmit();})()`);
 await until('!document.querySelector("#editor").open&&!document.querySelector("#view-root").hasAttribute("aria-busy")');
 const saved=await run(`(async()=> (await finwiseAPI.collection('transactions')).data.find(t=>t.description==='Partner salary recorded by owner'))()`);
 assert.equal(saved.allocations[0].member_id,people.partner);assert.equal(saved.entered_by,people.me);
 const report=async()=>run(`finwiseAPI.request('analytics/household?from=2026-11-01&to=2026-12-01&currency=INR')`);
 let household=await report();assert.equal(household.data.find(m=>m.id===people.partner).income,'50000.00');assert.equal(household.data.find(m=>m.id===people.me).income,'0.00');
 await run(`transactionEditEditor('${saved.id}')`);await until('!!document.querySelector("#transaction-full-edit-form")');
 assert.equal(await run('document.querySelector("[name=income-member-0]").value'),people.partner);
 await run(`(()=>{const form=document.querySelector('#transaction-full-edit-form');form.elements['income-member-0'].value='${people.me}';form.requestSubmit();})()`);await until('!document.querySelector("#editor").open&&!document.querySelector("#view-root").hasAttribute("aria-busy")');
 household=await report();assert.equal(household.data.find(m=>m.id===people.me).income,'50000.00');assert.equal(household.data.find(m=>m.id===people.partner).income,'0.00');
 await run(`transactionEditEditor('${saved.id}')`);await until('!!document.querySelector("#transaction-full-edit-form")');
 await run(`(()=>{const form=document.querySelector('#transaction-full-edit-form');form.elements['income-member-0'].value='${people.partner}';form.requestSubmit();})()`);await until('!document.querySelector("#editor").open&&!document.querySelector("#view-root").hasAttribute("aria-busy")');
 await run(`(()=>{state.scope='family';syncScopeControl();saveView();location.hash='planner';})()`);await until('!!document.querySelector(".workflow-summary")&&!document.querySelector("#view-root").hasAttribute("aria-busy")');
 await run(`(()=>{const month=document.querySelector('#planner-month');month.value='2026-11';month.dispatchEvent(new Event('change',{bubbles:true}));})()`);await until('!document.querySelector("#view-root").hasAttribute("aria-busy")&&document.querySelector("#planner-month").value==='+'"2026-11"');
 await run(`document.querySelector('[data-plan-action="add-income"]').click()`);await until('!!document.querySelector("#planner-item-form")');
 assert.equal(await run('document.querySelector("label[for=plan-person]").textContent'),'Whose income is this?');
 await run(`(()=>{const form=document.querySelector('#planner-item-form');form.elements.title.value='Expected partner bonus';form.elements.amount.value='5000';form.elements.person.value='${people.partner}';form.requestSubmit();})()`);
 assert.equal(await run('plannerInstance.snapshot().plan.items.find(x=>x.title==="Expected partner bonus").personId'),people.partner);
 await run(`document.querySelector('[data-workflow="import-income"]').click()`);await until('!!document.querySelector("#workflow-income-form")');
 await run(`document.querySelector('#workflow-income-form').requestSubmit()`);
 const planned=await run('plannerInstance.snapshot().plan.items.find(x=>x.incomeRecordId)');assert.equal(planned.personId,people.partner);assert.equal(planned.person,'Second Earner');
 assert.equal(await run(`(async()=> (await finwiseAPI.collection('transactions')).data.length)()`),1);
 await run(`location.hash='household'`);await until('!document.querySelector("#view-root").hasAttribute("aria-busy")&&!!document.querySelector(".household-person")');
 assert.ok(await run('document.querySelector("#view-root").textContent.includes("Second Earner")'));
 assert.deepEqual(errors,[]);console.log('PASS: create/edit income earner, separate recorder, Household member totals, Planner member picker, attributed income import, and unchanged ledger count.');
}catch(error){console.error(error.stack);process.exitCode=1;}finally{ws?.close();chrome.kill();server.kill();await pause(500);await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
})();
