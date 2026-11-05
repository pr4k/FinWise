// Manual investment browser acceptance: isolated database and synthetic household.
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
  const bank=await finwiseAPI.request('accounts',{method:'POST',body:{name:'Salary account',subtype:'bank',currency:'INR',opening_balance:{amount:'100000.00',as_of:'2026-10-01T00:00:00+05:30'}}});
  const card=await finwiseAPI.request('accounts',{method:'POST',body:{name:'Everyday card',subtype:'credit_card',currency:'INR'}});
  await finwiseAPI.request('investments',{method:'POST',body:{name:'Index fund',type:'investment',currency:'INR',sip:{amount:'5000.00',day:5,start_month:'2026-10',status:'active'}}});
  for(const [kind,value,desc] of [['income','180000.00','Monthly salary'],['expense','24000.00','Monthly rent'],['expense','4500.00','Groceries']])await finwiseAPI.request('transactions',{method:'POST',body:{event_type:kind,amount:value,currency:'INR',effective_date:'2026-10-02',description:desc,movements:[{account_id:bank.id,amount:kind==='income'?value:'-'+value}],allocations:[{category_id:null,amount:value,scope:'personal'}]}});
  await finwiseAPI.request('transactions',{method:'POST',body:{event_type:'transfer',amount:'1500.00',currency:'INR',effective_date:'2026-10-04',description:'Card payment',movements:[{account_id:bank.id,amount:'-1500.00'},{account_id:card.id,amount:'1500.00'}],allocations:[]}});
  const category=await finwiseAPI.request('categories',{method:'POST',body:{name:'Memberships',kind:'expense',visibility:'private',tracking_type:'regular'}});window.qaCategoryId=category.id;
  await catalogs();setMonth('2026-10');await renderRoute();
 })()`);
 for(const width of [1500,390,320,768,1100]) {
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
  for(const view of ['overview','transactions','accounts','investments','planner','subscriptions','recurring','budgets','household','settlements','categories','statements','reconcile','more']) {
   await run(`(async()=>{navigate('${view}');})()`);
   await until(`state.view==='${view}'&&!document.querySelector('#view-root').hasAttribute('aria-busy')`);
   await pause(100);
   assert.equal(await run('!!document.querySelector("#view-root .live-error")'),false,'Route failed: '+view);
   assert.equal(await run('document.querySelector("#view-root").textContent.includes("undefined")'),false,'Invalid rendered content: '+view);
   const layout=await run('({width:innerWidth,scroll:document.documentElement.scrollWidth})');
   if(layout.scroll>layout.width)console.log(await run('JSON.stringify([...document.querySelectorAll("#view-root *")].filter(e=>e.getBoundingClientRect().right>innerWidth+1).map(e=>({tag:e.tagName,cls:e.className,id:e.id,right:e.getBoundingClientRect().right,width:e.getBoundingClientRect().width,text:e.textContent.slice(0,60)})).slice(0,20))'));
   assert.ok(layout.scroll<=layout.width,`${view} at ${width}px overflows: ${JSON.stringify(layout)}`);
   if([390,1500].includes(width)) {
    const shot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
    await fs.writeFile('/tmp/finwise-layout-'+view+'-'+width+'.png',Buffer.from(shot.data,'base64'));
   }
  }
  console.log('PASS: all 14 screens at '+width+'px');
 }
 await run(`navigate('overview')`);
 await until(`!!document.querySelector('.dashboard-page')&&!document.querySelector('#view-root').hasAttribute('aria-busy')`);

 assert.equal(await run('state.referenceCash.net'),'150000.00');
 assert.equal(await run('state.referenceCash.totals.cardPayments'),'1500.00');
 assert.equal(await run('state.referenceDashboard.summary.after_investment_cash_flow'),'151500.00');
 await run(`document.querySelector('[data-reference-cash="cardPayments"]').click()`);
 await until('dialog.open');assert.ok(await run(`document.querySelector('#editor').textContent.includes('Card payment')`));await run('dialog.close()');
 await run(`document.querySelector('[data-reference-equation]').click()`);await until('dialog.open');assert.ok(await run(`document.querySelector('#editor').textContent.includes('Surplus after investments')`));await run('dialog.close()');
 await run(`document.querySelector('[data-reference-month="-1"]').click()`);await until(`state.month==='2026-09'&&!root.hasAttribute('aria-busy')`);
 await run(`document.querySelector('[data-reference-month="1"]').click()`);await until(`state.month==='2026-10'&&!root.hasAttribute('aria-busy')`);
 await run(`navigate('accounts')`);await until(`state.view==='accounts'&&!root.hasAttribute('aria-busy')`);
 await run(`document.querySelector('[data-reference-account]').click()`);await until('dialog.open');assert.ok(await run(`!!document.querySelector('#editor .account-detail-page')`));await run('dialog.close()');
 await run(`navigate('transactions',['all'])`);await until(`state.view==='transactions'&&!root.hasAttribute('aria-busy')`);
 await run(`document.querySelector('.reference-records .tx-record:not(.tx-evidence) summary').click()`);
 assert.ok(await run(`!!document.querySelector('.reference-records .tx-record[open]')`));
 await run(`document.querySelector('.reference-records .tx-record[open] [data-action="edit-transaction"]').click()`);await until(`dialog.open&&!!document.querySelector('#transaction-full-edit-form')`);await run('dialog.close()');
 await run(`(()=>{const input=document.querySelector('#transaction-filter-search');input.value='Groceries';input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 await until(`!root.hasAttribute('aria-busy')&&document.querySelectorAll('.reference-records .tx-record:not(.tx-evidence)').length===1`);
 assert.ok(await run(`root.textContent.includes('Groceries')`));
 await run(`state.transactionFilters={};saveView();navigate('categories')`);await until(`state.view==='categories'&&!root.hasAttribute('aria-busy')`);
 await run(`(()=>{document.querySelector('#reference-category-'+qaCategoryId).value='subscription';document.querySelector('#reference-category-routing').requestSubmit();})()`);
 await until(`!root.hasAttribute('aria-busy')&&state.categories.find(c=>c.id===qaCategoryId)?.tracking_type==='subscription'`);
 assert.equal(await run(`(async()=>{const rows=(await finwiseAPI.collection('categories')).data;return rows.find(c=>c.id===qaCategoryId).tracking_type;})()`),'subscription');
 await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:1000,deviceScaleFactor:1,mobile:false});
 await run(`document.querySelector('.bottom-nav [data-view="more"]').click()`);
 assert.ok(await run(`document.querySelector('.app-shell').classList.contains('mobile-nav-open')&&!document.querySelector('.sidebar').inert`));
 await run(`document.querySelector('.sidebar [data-view="subscriptions"]').click()`);await until(`state.view==='subscriptions'&&!root.hasAttribute('aria-busy')`);
 assert.equal(await run(`document.querySelector('.app-shell').classList.contains('mobile-nav-open')`),false);
 await run(`document.querySelector('#menu-button').click()`);await run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);assert.equal(await run(`document.querySelector('.app-shell').classList.contains('mobile-nav-open')`),false);
 await run(`navigate('overview')`);await until(`!!document.querySelector('.dashboard-page')&&!root.hasAttribute('aria-busy')`);
 await run(`document.querySelector('.reference-page .heading-actions [data-action="transaction"]').click()`);
 await until(`dialog.open`);
 assert.ok(await run(`!!document.querySelector('#transaction-form')`));
 await run('dialog.close()');
 await run(`document.querySelector('.reference-page .heading-actions [data-view="imports"]').click()`);
 await until(`state.view==='imports'&&!document.querySelector('#view-root').hasAttribute('aria-busy')`);
 assert.deepEqual(errors,[]);
 console.log('PASS: cash-flow totals exclude double-counted card payments, equation drill-down, month arrows, ledger expansion/edit/search, saved category routing, accessible mobile drawer, and dashboard shortcuts; no browser exceptions.');
}catch(error){console.error(error.stack);process.exitCode=1;}finally{ws?.close();chrome.kill();server.kill();await pause(500);await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
})();
