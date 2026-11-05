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
 assert.ok(await run('root.querySelector(".dc-next-card").textContent.includes("3,000")'));
 assert.equal(await run('state.referenceCash.net'),'-1500.00');
 console.log('Dashboard render: '+Math.round(await run('qaDashboardElapsed'))+'ms; no detailed-report requests on initial load.');
 for(const width of [1500,1100,768,390,320]){
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await pause(80);
  assert.ok(await run('document.documentElement.scrollWidth<=innerWidth'),'Page overflow at '+width);
  const inset=await run('(()=>{const panel=root.querySelector(".dc-equation-panel"),heading=panel.querySelector(".dc-section-label");return heading.getBoundingClientRect().top-panel.getBoundingClientRect().top;})()');
  assert.ok(inset<=24,'Unexpected equation top gap: '+inset);
  if(width>=1100){const gap=await run('root.querySelector(".dc-equation-panel").getBoundingClientRect().top-root.querySelector(".page-heading").getBoundingClientRect().bottom');assert.ok(gap<=115,'Unexpected Family-only header gap: '+gap);}
  if([1500,390].includes(width)){const shot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await fs.writeFile('/tmp/finwise-dashboard-fixed-'+width+'.png',Buffer.from(shot.data,'base64'));}
 }
 await run('root.querySelector(".reference-reports").open=true');await until('qaReportCalls===1');
 assert.ok(await run('!!root.querySelector(".dashboard-credit-cards")'),'Card information stays visible during detailed report loading');
 await run('qaReleaseReports()');await until('!root.querySelector("[data-reports-lazy]")');
 assert.equal(await run('qaReportCalls'),1);assert.ok(await run('!!root.querySelector("#dashboard-reports .analytics-view-tabs")||!!root.querySelector("#dashboard-reports canvas")'));
 await run('root.querySelector(".reference-reports").open=false');await run('root.querySelector(".reference-reports").open=true');await pause(100);assert.equal(await run('qaReportCalls'),1);
 await run('(async()=>{views.dashboardReports=qaReportsOriginal;setMonth("2026-12");await renderRoute();})()');
 assert.equal(await run('!!root.querySelector(".dc-next-card")'),false,'Do not invent January statement dues');
 assert.ok(await run('root.querySelector(".credit-card-rows").textContent.includes("Current bill card")'),'Cards with existing dues remain visible even without next-month metadata');
 assert.ok(await run('root.querySelector("[data-live-key=metric-card-payments] .metric-number").textContent.includes("0.00")'));
 assert.deepEqual(errors,[]);
 console.log('PASS: Family-only current/next-month card dues, cards without statements, selected-month payments, no fabricated future bill totals, compact header/panel spacing at 320–1500px, and lazy reports loaded once.');
}catch(error){console.error(error.stack);process.exitCode=1;}finally{ws?.close();chrome.kill();server.kill();await pause(500);await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
})();
