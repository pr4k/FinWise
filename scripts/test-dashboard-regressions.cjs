// Dashboard regression checks: isolated Family-only household and synthetic card records.
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
(async()=>{
const root=require('node:path').resolve(__dirname,'..'),temp=await fs.mkdtemp(path.join(os.tmpdir(),'finwise-planner-qa-'));
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

 await run(`(async()=>{
  const bank=await finwiseAPI.request('accounts',{method:'POST',body:{name:'Household bank',subtype:'bank',currency:'INR',opening_balance:{amount:'100000.00',as_of:'2026-11-01T00:00:00+05:30'}}});
  const card=await finwiseAPI.request('accounts',{method:'POST',body:{name:'No statement card',subtype:'credit_card',currency:'INR',opening_balance:{amount:'5000.00',as_of:'2026-11-01T00:00:00+05:30'}}});
  await finwiseAPI.request('accounts',{method:'POST',body:{name:'Current bill card',subtype:'credit_card',currency:'INR',card_due:{amount:'2500.00',due_date:'2026-11-10'},opening_balance:{amount:'7000.00',as_of:'2026-11-01T00:00:00+05:30'}}});
  await finwiseAPI.request('accounts',{method:'POST',body:{name:'Next bill card',subtype:'credit_card',currency:'INR',card_due:{amount:'3000.00',due_date:'2026-12-05'},opening_balance:{amount:'4000.00',as_of:'2026-11-01T00:00:00+05:30'}}});
  await finwiseAPI.request('transactions',{method:'POST',body:{event_type:'transfer',amount:'1500.00',currency:'INR',effective_date:'2026-11-04',description:'November card payment',movements:[{account_id:bank.id,amount:'-1500.00'},{account_id:card.id,amount:'1500.00'}],allocations:[]}});
  for(const [kind,value,description,account] of [['income','10000.00','Salary received',bank],['expense','2000.00','Bank purchase',bank],['expense','3000.00','New card expense',card],['refund','500.00','Card refund',card]])await finwiseAPI.request('transactions',{method:'POST',body:{event_type:kind,amount:value,currency:'INR',effective_date:'2026-11-05',description,movements:[{account_id:account.id,amount:kind==='expense'?'-'+value:value}],allocations:[{category_id:null,amount:value,scope:'personal'}]}});
  await finwiseAPI.request('transactions',{method:'POST',body:{event_type:'transfer',amount:'1000.00',currency:'INR',effective_date:'2026-12-04',description:'December card payment',movements:[{account_id:bank.id,amount:'-1000.00'},{account_id:card.id,amount:'1000.00'}],allocations:[]}});
  const secondBank=await finwiseAPI.request('accounts',{method:'POST',body:{name:'Second bank',subtype:'bank',currency:'INR'}});
  await finwiseAPI.request('transactions',{method:'POST',body:{event_type:'transfer',amount:'100.00',currency:'INR',effective_date:'2026-11-05',description:'Move between bank accounts',movements:[{account_id:bank.id,amount:'-100.00'},{account_id:secondBank.id,amount:'100.00'}],allocations:[]}});
  const investmentCategory=await finwiseAPI.request('categories',{method:'POST',body:{name:'Investment funding',kind:'expense',tracking_type:'investment'}});
  for(const [event_type,amount,description] of [['expense','1200.00','Investment contribution paid'],['refund','200.00','Investment withdrawal received']])await finwiseAPI.request('transactions',{method:'POST',body:{event_type,amount,currency:'INR',effective_date:'2026-11-05',description,movements:[{account_id:bank.id,amount:event_type==='expense'?'-'+amount:amount}],allocations:[{category_id:investmentCategory.id,amount,scope:'personal'}]}});
  await finwiseAPI.request('accounts',{method:'POST',body:{name:'Card with credit balance',subtype:'credit_card',currency:'INR',opening_balance:{amount:'-400.00',as_of:'2026-11-01T00:00:00+05:30'}}});
  await finwiseAPI.request('accounts',{method:'POST',body:{name:'Unknown card balance',subtype:'credit_card',currency:'INR'}});
  const household=await finwiseAPI.request('settings/household');await finwiseAPI.request('settings/household',{method:'PATCH',revision:household.revision,body:{family_only:true}});
  state.me=await finwiseAPI.request('me');state.scope='family';await catalogs();syncScopeControl();setMonth('2026-11');
  window.qaReportCalls=0;window.qaReportsOriginal=views.dashboardReports;views.dashboardReports=async()=>{qaReportCalls++;await new Promise(resolve=>{window.qaReleaseReports=resolve;setTimeout(resolve,2000)});return qaReportsOriginal();};
  const started=performance.now();await renderRoute();window.qaDashboardElapsed=performance.now()-started;
 })()`);
 assert.equal(await run('qaReportCalls'),0,'Collapsed detailed reports must not delay the dashboard');
 assert.ok(await run('!!root.querySelector(".dashboard-credit-cards")'));
 assert.ok(await run('root.querySelector("[data-live-key=metric-card-payments] .metric-number").textContent.includes("1,500")'));
 assert.ok(await run('root.querySelector(".credit-card-rows").textContent.includes("No statement card")'));
 assert.ok(await run('root.querySelector(".credit-card-rows").textContent.includes("2026-11-10")'));
 assert.ok(await run('root.querySelector("[data-reference-cash=bills]").textContent.includes("17,000")'));
 assert.equal(await run('state.referenceCash.net'),'5500.00');
 assert.equal(await run('state.referenceCash.remainingDebt'),'17000.00','Repayment plan uses positive remaining balances, not statement amounts or credit offsets');
 assert.equal(await run('state.referenceCash.unknownCards'),1);
 await run(`root.querySelector('[data-reference-cash=bills]').click()`);await until('dialog.open');
 assert.ok(await run(`dialog.textContent.includes('No statement card')&&dialog.textContent.includes('Unknown card balance')&&dialog.textContent.includes('incomplete')`));await run('dialog.close()');
 assert.equal(await run('state.referenceCash.cardSpent'),'2500.00');
 assert.equal(await run(`state.accounts.find(a=>a.name==='No statement card').balance.amount`),'6000.00','Old debt + new purchases − refund − repayment must retain only remaining card debt');
 assert.equal(await run('state.referenceCash.otherCashOut'),'2000.00');
 assert.equal(await run('state.referenceCash.totals.investments'),'1200.00');
 assert.equal(await run('state.referenceCash.inflow'),'10200.00');
 assert.equal(await run('state.referenceDashboard.summary.net_invested'),'1000.00');
 await run(`root.querySelector('.dc-equation [data-reference-cash=investments]').click()`);await until('dialog.open');
 assert.ok(await run(`dialog.textContent.includes('Investment contribution paid')&&!dialog.textContent.includes('Investment withdrawal received')`));await run('dialog.close()');
 assert.equal(await run('state.referenceDashboard.summary.actual_spending'),'4500.00');
 assert.ok(await run(`root.querySelector('[data-reference-equation] strong').textContent.includes('5,500')`));
 await run(`root.querySelector('[data-reference-cash="cardExpenses"]').click()`);await until('dialog.open');
 assert.ok(await run(`dialog.textContent.includes('New card expense')&&dialog.textContent.includes('Card refund')&&!dialog.textContent.includes('November card payment')`));await run('dialog.close()');
 await run(`root.querySelector('.dc-equation [data-reference-cash="cardPayments"]').click()`);await until('dialog.open');
 assert.ok(await run(`dialog.textContent.includes('November card payment')&&!dialog.textContent.includes('New card expense')`));await run('dialog.close()');
 const widget=await run(`(async()=>{const me=await finwiseAPI.request('me'),settings=await finwiseAPI.request('settings/widgets');await finwiseAPI.request('settings/widgets',{method:'PATCH',revision:settings.revision,body:{enabled:true,user_id:me.user.id,accounts_enabled:true,family_enabled:true}});const response=await fetch('/api/v1/widgets/cash-surplus?month=2026-11&scope=family',{credentials:'omit'});if(!response.ok)throw Error(await response.text());return response.json();})()`);
 const dashboard=await run(`({cash_received:state.referenceCash.inflow,bank_cash_paid:state.referenceCash.otherCashOut,cc_bills_paid:state.referenceCash.totals.cardPayments,investments_paid:state.referenceCash.totals.investments,cash_surplus:state.referenceCash.net,expenses_this_month:state.referenceDashboard.summary.actual_spending,credit_card_expenses_this_month:state.referenceCash.cardSpent,cc_to_pay_next_month:state.referenceCash.remainingDebt})`);
 assert.deepEqual(widget.summary,dashboard,'Public widget and dashboard totals must agree');
 assert.equal(widget.repayment_plan.unknown_card_count,1);
 console.log('Dashboard render: '+Math.round(await run('qaDashboardElapsed'))+'ms; no detailed-report requests on initial load.');
 for(const width of [1500,1100,768,390,320]){
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await pause(80);
  assert.ok(await run('document.documentElement.scrollWidth<=innerWidth'),'Page overflow at '+width);
  const inset=await run('(()=>{const panel=root.querySelector(".dc-equation-panel"),heading=panel.querySelector(".dc-section-label");return heading.getBoundingClientRect().top-panel.getBoundingClientRect().top;})()');
  assert.ok(inset<=24,'Unexpected equation top gap: '+inset);
  if(width>=1100){const gap=await run('root.querySelector(".dc-equation-panel").getBoundingClientRect().top-root.querySelector(".page-heading").getBoundingClientRect().bottom');assert.ok(gap<=115,'Unexpected Family-only header gap: '+gap);}
  await run(`root.querySelector('.dc-equation [data-reference-cash=otherOutflow]').click()`);await until('dialog.open');
  assert.ok(await run(`(()=>{const row=dialog.querySelector('.contributor'),bounds=row.getBoundingClientRect();return getComputedStyle(row).display==='grid'&&[...row.querySelectorAll('*')].every(el=>el.getBoundingClientRect().right<=bounds.right+1)})()`),'Modal rows must be laid out and contained at '+width);
  assert.equal(await run('dialog.scrollWidth>dialog.clientWidth'),false,'Movement modal overflow at '+width);
  if([1500,390].includes(width)){const modalShot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await fs.writeFile('/tmp/finwise-movement-dialog-'+width+'.png',Buffer.from(modalShot.data,'base64'));}
  await run('dialog.close()');
  if([1500,390].includes(width)){const shot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await fs.writeFile('/tmp/finwise-dashboard-fixed-'+width+'.png',Buffer.from(shot.data,'base64'));}
 }
 await run('root.querySelector(".reference-reports").open=true');await until('qaReportCalls===1');
 assert.ok(await run('!!root.querySelector(".dashboard-credit-cards")'),'Card information stays visible during detailed report loading');
 await run('qaReleaseReports()');await until('!root.querySelector("[data-reports-lazy]")');
 assert.equal(await run('qaReportCalls'),1);assert.ok(await run('!!root.querySelector("#dashboard-reports .analytics-view-tabs")||!!root.querySelector("#dashboard-reports canvas")'));
 await run('root.querySelector(".reference-reports").open=false');await run('root.querySelector(".reference-reports").open=true');await pause(100);assert.equal(await run('qaReportCalls'),1);
 await run(`(async()=>{const bank=state.accounts.find(a=>a.name==='Household bank'),card=state.accounts.find(a=>a.name==='No statement card');await finwiseAPI.request('transactions',{method:'POST',body:{event_type:'transfer',amount:'1000.00',currency:'INR',effective_date:'2026-11-05',description:'Extra partial repayment',movements:[{account_id:bank.id,amount:'-1000.00'},{account_id:card.id,amount:'1000.00'}],allocations:[]}});views.dashboardReports=qaReportsOriginal;await renderRoute();})()`);
 assert.equal(await run('state.referenceCash.net'),'4500.00','Partial repayment reduces cash surplus');
 assert.equal(await run('state.referenceCash.totals.cardPayments'),'2500.00','Partial repayment appears in this month’s CC paid');
 assert.equal(await run('state.referenceCash.remainingDebt'),'16000.00','Partial repayment reduces remaining debt without a second deduction');
 assert.ok(await run(`root.querySelector('[data-live-key=metric-card-payments]').textContent.includes('2,500')`));
 await run('(async()=>{views.dashboardReports=qaReportsOriginal;setMonth("2026-12");await renderRoute();})()');
 assert.equal(await run('state.referenceCash.remainingDebt'),'16000.00','Latest remaining debt stays the repayment plan even without next-month statement dates');
 assert.equal(await run('state.referenceCash.net'),'-1000.00');
 assert.ok(await run('root.querySelector(".credit-card-rows").textContent.includes("Current bill card")'),'Cards with existing dues remain visible even without next-month metadata');
 assert.ok(await run('root.querySelector("[data-live-key=metric-card-payments] .metric-number").textContent.includes("1,000.00")'));
 assert.deepEqual(errors,[]);
 console.log('PASS: cash surplus deducts bank purchases and card repayments once; card purchases/refunds remain consumption; partial prior-debt payments and next-month transfers use payment months; internal bank transfers cancel; due dates, 320–1500px layouts and lazy reports remain correct.');
}catch(error){console.error(error.stack);process.exitCode=1;}finally{ws?.close();chrome.kill();server.kill();await pause(500);await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
})();
