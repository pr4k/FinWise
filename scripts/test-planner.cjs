// Chrome acceptance against an isolated database; uses the built-in DevTools protocol.
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
 const until=async expression=>{for(let i=0;i<150;i++){if(await run(expression))return;await pause(100);}throw Error('Timed out: '+expression+'\n'+await run('document.body.innerText'));};
 await cdp('Runtime.enable');await cdp('Page.enable');await cdp('Page.navigate',{url:origin});await until('!!document.querySelector("#auth-form")');
 await run(`(async()=>{const value=await window.finwiseAPI.request('auth/bootstrap',{method:'POST',body:{owner:{name:'Planner Tester',email:'planner@example.test',password:'planner-test-password-123'},household:{name:'Planner QA',timezone:'Asia/Kolkata',base_currency:'INR'}}});window.finwiseAPI.setCsrf(value.csrf_token);await signedIn();})()`);
 await until('!!document.querySelector(".dashboard-page")');
 await run(`(async()=>{await window.finwiseAPI.request('accounts',{method:'POST',body:{name:'Savings',subtype:'bank',currency:'INR',visibility:'private',opening_balance:{amount:'100000.00',as_of:'2026-10-01T00:00:00+05:30'}}});await window.finwiseAPI.request('accounts',{method:'POST',body:{name:'Travel Card',subtype:'credit_card',currency:'INR',visibility:'private'}});setMonth('2026-11');location.hash='planner';})()`);
 await until('!!document.querySelector(".plan-hero")&&!document.querySelector("#view-root").hasAttribute("aria-busy")');
 const click=async selector=>run(`document.querySelector(${JSON.stringify(selector)}).click()`);
 for(const tab of ['calendar','scenarios','funds','actual','canvas']){await click(`[data-plan-tab="${tab}"]`);assert.equal(await run(`document.querySelector('[data-plan-tab="${tab}"]').getAttribute('aria-selected')`),'true');}
 await click('[data-plan-add="extras"]');await until('!!document.querySelector("#planner-item-form")');
 await run(`(()=>{const f=document.querySelector('#planner-item-form');f.elements.title.value='Weekend trip';f.elements.amount.value='1500';f.requestSubmit();})()`);
 assert.equal(await run("plannerInstance.snapshot().totals.spend"),1500);
 await click('[data-plan-edit]');await until('document.querySelector("#planner-dialog").open');await click('#planner-dialog [data-action="close"]');assert.equal(await run('document.querySelector("#planner-dialog").open'),false);
 await click('[data-plan-tab="calendar"]');for(const mode of ['agenda','data','month'])await click(`[data-calendar-view="${mode}"]`);
 for(const width of [1440,768,390,320]){
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<760});await pause(100);
  assert.equal(await run('document.documentElement.scrollWidth>innerWidth'),false,'Calendar overflow at '+width);
  if(process.env.FINWISE_SCREENSHOT_DIR&&(width===1440||width===390)){const screenshot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await fs.writeFile(path.join(process.env.FINWISE_SCREENSHOT_DIR,`planner-${width}.png`),Buffer.from(screenshot.data,'base64'));}
 }
 await click('[data-plan-tab="canvas"]');for(const width of [1440,390,320]){await cdp('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<760});await pause(100);assert.equal(await run('document.documentElement.scrollWidth>innerWidth'),false,'Canvas overflow at '+width);}
 await cdp('Page.reload');await until('!!document.querySelector(".plan-hero")');assert.equal(await run('plannerInstance.snapshot().totals.spend'),1500);
 await click('[data-plan-tab="scenarios"]');await run('renderRoute()');await until('!document.querySelector("#view-root").hasAttribute("aria-busy")&&!!document.querySelector("#scenario-room")');
 assert.notEqual(await run('document.querySelector("#scenario-room").textContent'),'');
 await click('[data-plan-tab="funds"]');await click('[data-plan-action="add-fund"]');
 await run(`(()=>{const f=document.querySelector('#planner-fund-form');f.elements.name.value='Annual insurance';f.elements.target.value='12000';f.requestSubmit();})()`);
 assert.equal(await run('document.querySelectorAll(".fund-card").length'),1);
 await click('[data-plan-tab="canvas"]');await click('[data-plan-action="activate"]');
 await run(`(()=>{const f=document.querySelector('#planner-activate-form');f.querySelector('input').checked=true;f.requestSubmit();})()`);
 assert.equal(await run('plannerInstance.snapshot().plan.status'),'active');
 await click('[data-plan-action="linked-budget"]');assert.ok(await run('document.querySelector("#content").textContent.includes("Planner-linked category allowances")'));
 await click('[data-plan-action="back-plan"]');await click('[data-plan-tab="canvas"]');await click('[data-plan-action="close-plan"]');await click('[data-plan-action="confirm-close"]');
 assert.equal(await run('plannerInstance.snapshot().plan.status'),'closed');
 await click('[data-plan-action="reopen"]');assert.equal(await run('plannerInstance.snapshot().plan.status'),'draft');
 await run(`(()=>{const s=document.querySelector('#planner-currency');const o=document.createElement('option');o.value='USD';o.textContent='USD';s.append(o);s.value='USD';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 await until('!document.querySelector("#view-root").hasAttribute("aria-busy")&&!!document.querySelector(".plan-empty-currency")');
 assert.equal(await run('plannerInstance.snapshot().totals.spend'),0);
 await run(`(()=>{const s=document.querySelector('#planner-currency');s.value='INR';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await until('!document.querySelector("#view-root").hasAttribute("aria-busy")&&!!document.querySelector(".plan-lane")');
 assert.equal(await run('plannerInstance.snapshot().totals.spend'),1500);
 await run(`document.querySelector('.scope-segments [data-scope="family"]').click()`);await until('!document.querySelector("#view-root").hasAttribute("aria-busy")&&!!document.querySelector(".plan-empty-currency")');
 assert.equal(await run('plannerInstance.snapshot().totals.spend'),0);
 assert.equal(await run("(async()=> (await finwiseAPI.collection('transactions')).data.length)()"),0);

 // Exercise the guided workflow with real API income, subscription, SIP and card data.
 await run(`(async()=>{
  const accounts=(await finwiseAPI.collection('accounts')).data,bank=accounts.find(a=>a.name==='Savings'),card=accounts.find(a=>a.name==='Travel Card');
  const salary=await finwiseAPI.request('categories',{method:'POST',body:{name:'Salary',kind:'income',visibility:'private'}});
  const subs=await finwiseAPI.request('categories',{method:'POST',body:{name:'Subscriptions',kind:'expense',tracking_type:'subscription',visibility:'private'}});
  const food=await finwiseAPI.request('categories',{method:'POST',body:{name:'Food',kind:'expense',visibility:'private'}});window.workflowFoodId=food.id;
  await finwiseAPI.request('transactions',{method:'POST',body:{event_type:'income',description:'November salary',effective_date:'2026-11-01',amount:'50000.00',currency:'INR',movements:[{account_id:bank.id,amount:'50000.00'}],allocations:[{category_id:salary.id,scope:'personal',amount:'50000.00'}]}});
  await finwiseAPI.request('transactions',{method:'POST',body:{event_type:'expense',description:'Streaming',effective_date:'2026-10-05',amount:'500.00',currency:'INR',movements:[{account_id:bank.id,amount:'-500.00'}],allocations:[{category_id:subs.id,scope:'personal',amount:'500.00'}],subscription:{name:'Streaming'}}});
  await finwiseAPI.request('investments',{method:'POST',body:{name:'Monthly fund',type:'investment',asset_class:'mutual_fund',currency:'INR',visibility:'private',sip:{amount:'5000.00',day:10,start_month:'2026-10',status:'active'}}});
  await finwiseAPI.request('accounts/'+card.id,{method:'PATCH',revision:card.revision,body:{card_due:{amount:'2000.00',due_date:'2026-11-05'}}});
  state.scope='personal';syncScopeControl();saveView();await renderRoute();
 })()`);
 await until('!document.querySelector("#view-root").hasAttribute("aria-busy")&&!!document.querySelector("#planner-month")');
 assert.equal(await run('state.month'),'2026-11');
 assert.equal(await run('document.querySelector("#planner-month").value'),await run('finwisePlannerData.nextMonth(householdDate())'));
 await run(`(()=>{const month=document.querySelector('#planner-month');month.value='2026-11';month.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 await until('!document.querySelector("#view-root").hasAttribute("aria-busy")&&document.querySelector("#planner-month").value==="2026-11"');
 await click('[data-plan-tab="setup"]');
 assert.equal(await run('plannerInstance.snapshot().totals.invested'),5000);
 assert.equal(await run('plannerInstance.snapshot().totals.spend'),500);
 await click('[data-workflow="import-income"]');await run(`document.querySelector('#workflow-income-form').requestSubmit()`);
 assert.equal(await run('plannerInstance.snapshot().workflow.income'),50000);
 const incomeBank=await run('plannerInstance.snapshot().forecast.start.bank');
 assert.equal(await run('plannerInstance.snapshot().totals.cashReceipts'),0);
 await click('[data-workflow-bill]');await run(`(()=>{const form=document.querySelector('#workflow-payment-form');form.elements.mode.value='partial';form.elements.amount.value='1000';form.requestSubmit();})()`);
 assert.equal(await run('plannerInstance.snapshot().totals.card'),1000);
 assert.equal(await run('plannerInstance.snapshot().workflow.beforeCategories'),43500);
 await run(`(()=>{const form=document.querySelector('#workflow-category-form');form.elements['category-'+window.workflowFoodId].value='40000';form.requestSubmit();})()`);
 assert.equal(await run('plannerInstance.snapshot().workflow.remainingIncome'),3500);
 assert.equal(await run('plannerInstance.snapshot().workflow.bankCash'),incomeBank-46500);
 await click('[data-workflow="review-budget"]');await run(`document.querySelector('#workflow-publish-form').requestSubmit()`);
 await until('!!document.querySelector("[data-workflow=activate-budget]")');
 const published=await run(`(async()=>{const budgets=await finwiseAPI.collection('budgets?month=2026-11&scope=personal');return budgets.data[0];})()`);
 assert.equal(published.state,'draft');assert.equal(published.expected_income,'50000.00');assert.equal(published.lines.length,2);
 assert.equal(published.lines.reduce((n,l)=>n+Number(l.amount),0),40500);
 await click('[data-workflow="activate-budget"]');await until('plannerInstance.snapshot().plan.serverBudget.state==="active"');
 assert.equal(await run(`(async()=> (await finwiseAPI.collection('transactions')).data.length)()`),2);
 for(const width of [1440,768,390,320]){await cdp('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<760});await pause(100);assert.equal(await run('document.documentElement.scrollWidth>innerWidth'),false,'Guided workflow overflow at '+width);if(process.env.FINWISE_SCREENSHOT_DIR&&(width===1440||width===390)){const screenshot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await fs.writeFile(path.join(process.env.FINWISE_SCREENSHOT_DIR,`workflow-${width}.png`),Buffer.from(screenshot.data,'base64'));}}
 await cdp('Page.reload');await until('!!document.querySelector(".workflow-summary")');assert.equal(await run('plannerInstance.snapshot().workflow.remainingIncome'),3500);

 // The recorded due stays read-only while a monthly hypothetical due can be higher or lower.
 await click('[data-workflow-bill]');
 assert.equal(await run('document.querySelector("#workflow-planning-due").value'),'2000');
 await run(`(()=>{const form=document.querySelector('#workflow-payment-form');form.elements.dueAmount.value='3500';form.elements.mode.value='full';form.requestSubmit();})()`);
 assert.equal(await run('plannerInstance.snapshot().totals.card'),3500);
 assert.equal(await run(`(async()=> (await finwiseAPI.collection('accounts')).data.find(a=>a.name==='Travel Card').card_due.amount)()`),'2000.00');
 await cdp('Page.reload');await until('!!document.querySelector(".workflow-summary")');assert.equal(await run('plannerInstance.snapshot().totals.card'),3500);
 await run(`(async()=>{const card=(await finwiseAPI.collection('accounts')).data.find(a=>a.name==='Travel Card');await finwiseAPI.request('accounts/'+card.id,{method:'PATCH',revision:card.revision,body:{card_due:{amount:'2400.00',due_date:'2026-11-05'}}});await renderRoute();})()`);
 assert.equal(await run('plannerInstance.snapshot().totals.card'),3500);
 assert.equal(await run('plannerInstance.snapshot().plan.items.find(x=>x.statementId).statementSnapshot.recordedDue'),2400);
 await click('[data-workflow-reset-bill]');assert.equal(await run('plannerInstance.snapshot().totals.card'),2400);
 assert.equal(await run(`(async()=> (await finwiseAPI.collection('accounts')).data.find(a=>a.name==='Travel Card').card_due.amount)()`),'2400.00');
 assert.equal(await run(`(async()=> (await finwiseAPI.collection('transactions')).data.length)()`),2);
 await run(`location.hash='overview'`);await until('!!document.querySelector(".dashboard-page")');assert.equal(await run('document.querySelector("#report-month").value'),'2026-11');

 // Balance-only cards must be visible even without card_due metadata.
 const balanceCards=await run(`(async()=>{
  const kiwi=await finwiseAPI.request('accounts',{method:'POST',body:{name:'Balance-only Kiwi',subtype:'credit_card',currency:'INR',visibility:'private',opening_balance:{amount:'18709.00',as_of:'2026-10-01T00:00:00+05:30'}}});
  const unknown=await finwiseAPI.request('accounts',{method:'POST',body:{name:'Unknown due card',subtype:'credit_card',currency:'INR',visibility:'private'}});
  const shared=await finwiseAPI.request('accounts',{method:'POST',body:{name:'Shared balance card',subtype:'credit_card',currency:'INR',visibility:'shared'}});
  return {kiwi:kiwi.id,unknown:unknown.id,shared:shared.id};
 })()`);
 await run(`location.hash='planner'`);await until('!!document.querySelector(".workflow-summary")&&!document.querySelector("#view-root").hasAttribute("aria-busy")');
 assert.ok(await run(`!!document.querySelector('[data-workflow-account-card="${balanceCards.kiwi}"]')`));
 assert.ok(await run(`!!document.querySelector('[data-workflow-account-card="${balanceCards.unknown}"]')`));
 assert.equal(await run(`!!document.querySelector('[data-workflow-account-card="${balanceCards.shared}"]')`),false);
 const cardBefore=await run('plannerInstance.snapshot().totals.card');
 await click(`[data-workflow-account-card="${balanceCards.kiwi}"]`);assert.equal(await run('document.querySelector("#workflow-account-estimate").value'),'18709');
 await run(`(()=>{const form=document.querySelector('#workflow-account-card-form');form.elements.dueAmount.value='15000';form.requestSubmit();})()`);
 assert.equal(await run('plannerInstance.snapshot().totals.card'),cardBefore+15000);
 assert.equal(await run(`(async()=> (await finwiseAPI.collection('accounts')).data.find(a=>a.id==='${balanceCards.kiwi}').card_due??null)()`),null);
 await cdp('Page.reload');await until('!!document.querySelector(".workflow-summary")');assert.equal(await run('plannerInstance.snapshot().totals.card'),cardBefore+15000);
 assert.equal(await run('Array.from(document.querySelectorAll(".workflow-bill h4")).filter(el=>el.textContent==="Balance-only Kiwi").length'),1);
 await run(`(async()=>{const card=(await finwiseAPI.collection('accounts')).data.find(a=>a.id==='${balanceCards.kiwi}');await finwiseAPI.request('accounts/'+card.id,{method:'PATCH',revision:card.revision,body:{card_due:{amount:'5000.00',due_date:'2026-11-09'}}});await renderRoute();})()`);
 assert.equal(await run('plannerInstance.snapshot().totals.card'),cardBefore+15000);
 assert.equal(await run('plannerInstance.snapshot().plan.items.filter(x=>x.destination==="Balance-only Kiwi").length'),1);
 const kiwiSnapshot=await run('plannerInstance.snapshot().plan.items.find(x=>x.destination==="Balance-only Kiwi").statementSnapshot');assert.equal(kiwiSnapshot.recordedDue,5000);assert.equal(kiwiSnapshot.planningOnly,false);
 await run(`document.querySelector('.scope-segments [data-scope="family"]').click()`);await until('!document.querySelector("#view-root").hasAttribute("aria-busy")&&!!document.querySelector(".workflow-summary")');
 assert.ok(await run(`!!document.querySelector('[data-workflow-account-card="${balanceCards.shared}"]')`));assert.equal(await run(`!!document.querySelector('[data-workflow-account-card="${balanceCards.unknown}"]')`),false);
 assert.equal(await run(`(async()=> (await finwiseAPI.collection('transactions')).data.length)()`),2);
 assert.deepEqual(errors,[]);console.log('PASS: planner tabs, edits, dialogs, calendar modes, scenario refresh, funds, activation, linked allowances, close/reopen, scope/currency isolation, persistence, unchanged ledger, guided income import without double counting, subscription/SIP suggestions, partial card payments, server budget creation/activation, independent months, current card due refresh, monthly planning overrides/reset without account writes, balance-only/unknown card visibility, explicit estimates without account writes, real-due adoption without duplication, and 320–1440px layouts.');
}catch(error){console.error(error.stack);process.exitCode=1;}finally{ws?.close();chrome.kill();server.kill();await pause(500);await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
})();
