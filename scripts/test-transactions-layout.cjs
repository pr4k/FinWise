// Chrome acceptance against an isolated database; uses the built-in DevTools protocol.
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
(async()=>{
const root=path.resolve(__dirname,'..'),temp=await fs.mkdtemp(path.join(os.tmpdir(),'finwise-transactions-qa-'));
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
  const bank=await finwiseAPI.request('accounts',{method:'POST',body:{name:'Balance test bank',subtype:'bank',currency:'INR',opening_balance:{amount:'1000.00',as_of:'2026-11-01T00:00:00+05:30'}}});window.qaBank=bank.id;
  await finwiseAPI.request('transactions',{method:'POST',body:{event_type:'expense',amount:'50.00',currency:'INR',effective_date:'2026-11-02',description:'A long transaction description to verify wrapping with navigation expanded and collapsed',movements:[{account_id:bank.id,amount:'-50.00'}],allocations:[{category_id:null,amount:'50.00',scope:'personal'}]}});
  for(const [date,amount] of [['2026-11-02','960.00'],['2026-11-03','900.00'],['2026-11-04','950.00']]){
   const current=await finwiseAPI.request('accounts/'+bank.id);
   await finwiseAPI.request('accounts/'+bank.id+'/balance-checks',{method:'POST',revision:current.revision,body:{amount,basis:'current',as_of:date+'T20:00:00+05:30',timezone:'Asia/Kolkata'}});
  }
  const unknown=await finwiseAPI.request('accounts',{method:'POST',body:{name:'No starting balance',subtype:'bank',currency:'INR'}});
  await finwiseAPI.request('accounts/'+unknown.id+'/balance-checks',{method:'POST',revision:unknown.revision,body:{amount:'100.00',basis:'current',as_of:'2026-11-05T20:00:00+05:30',timezone:'Asia/Kolkata'}});
  await catalogs();setMonth('2026-11');navigate('transactions');
 })()`);
 await until('!!document.querySelector(".tx-check")&&!root.hasAttribute("aria-busy")');
 const checks=await run(`[...document.querySelectorAll('.tx-check')].map(el=>el.querySelector('summary').innerText)`);
 assert.ok(checks.some(text=>text.includes('960.00')&&text.includes('Calculated')&&text.includes('950.00')&&text.includes('+ ₹10.00')));
 assert.ok(checks.some(text=>text.includes('900.00')&&text.includes('-₹50.00')));
 assert.ok(checks.some(text=>text.includes('Matched')&&text.includes('₹0.00')));
 assert.ok(checks.some(text=>text.includes('No starting balance')&&text.includes('Unknown')));
 assert.equal(await run(`document.querySelectorAll('.tx-day-heading').length`),5);
 for(const width of [1500,1100,900,768,430,390,375,320]){
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:1100,deviceScaleFactor:1,mobile:width<=760});
  await pause(400);
  await until('document.querySelectorAll(".tx-check").length===4&&!root.hasAttribute("aria-busy")');
  for(const collapsed of [false,true,false]){
   await run(`(()=>{const shell=document.querySelector('.app-shell');if(innerWidth>760){if(shell.classList.contains('sidebar-collapsed')!==${collapsed})document.querySelector('#menu-button').click();}else shell.classList.toggle('sidebar-collapsed',${collapsed});})()`);
   await pause(250);
   await until('document.querySelectorAll(".tx-check").length===4&&!root.hasAttribute("aria-busy")');
   assert.ok(await run('document.documentElement.scrollWidth<=innerWidth'), 'Page overflow at '+width+' collapsed='+collapsed);
   assert.ok(await run(`[...document.querySelectorAll('.tx-summary')].every(el=>el.scrollWidth<=el.clientWidth+1)`), 'Row overflow at '+width);
   if(width>760)assert.ok(await run(`document.querySelector('.main-area').getBoundingClientRect().left>=document.querySelector('.sidebar').getBoundingClientRect().right-1`),'Sidebar overlaps page at '+width);
  }
  await pause(400);
  await run(`(()=>{const record=root.querySelector('[data-reference-transaction]');record.open=true;record.scrollIntoView({block:'center'});})()`);
  await until(`!!root.querySelector('[data-reference-transaction] .tx-detail-actions button')`);
  assert.equal(await run(`root.querySelector('[data-reference-transaction] .tx-detail-actions').children.length`),1);
  assert.equal(await run(`root.querySelector('[data-reference-transaction] .tx-detail-actions button').textContent`),'Edit details');
  await run(`root.querySelector('[data-reference-transaction] .tx-detail-actions button').click()`);
  await until(`!!transactionDrawer.querySelector('#transaction-full-edit-form')&&!transactionDrawer.hidden`);
  assert.equal(await run('dialog.open'),false,'Edit should not open a modal');
  assert.ok(await run(`!!root.querySelector('[data-reference-transaction]')`),'List remains available');
  assert.ok(await run('document.documentElement.scrollWidth<=innerWidth'),'Side editor page overflow at '+width);
  assert.ok(await run('transactionDrawer.scrollWidth<=transactionDrawer.clientWidth'),'Side editor overflow at '+width);
  if(width>760)assert.ok(await run(`document.querySelector('.main-area').getBoundingClientRect().right<=transactionDrawer.getBoundingClientRect().left+1`),'Editor overlaps list at '+width);
  else {
   assert.ok(await run(`transactionDrawer.parentElement===document.querySelector('.main-area')&&transactionDrawer.getBoundingClientRect().bottom<=root.getBoundingClientRect().top+1`),'Phone editor must be above the list in page flow');
   assert.equal(await run(`getComputedStyle(transactionDrawer.querySelector('input[name="description"]')).fontSize`),'16px');
   await until(`(()=>{const rect=transactionDrawer.querySelector('.dialog-head h2').getBoundingClientRect();return rect.top>=0&&rect.bottom<=innerHeight})()`);
  }
  if([1500,900,320].includes(width)) {
   const shot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
   await fs.writeFile('/tmp/finwise-transaction-side-editor-'+width+'.png',Buffer.from(shot.data,'base64'));
  }
  await run('closeTransactionDrawer()');
  if([1500,900,320].includes(width)){
   const shot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
   await fs.writeFile('/tmp/finwise-transactions-'+width+'.png',Buffer.from(shot.data,'base64'));
  }
  await run(`document.querySelector('.tx-day-heading [data-date="2026-11-03"]').click()`);
  await until('!!document.querySelector("#transaction-form")');
  assert.equal(await run('dialog.open'),false,'Add transaction uses the same nonmodal panel');
  assert.ok(await run(`!!transactionDrawer.querySelector('#transaction-form.transaction-editor-form')`));
  assert.ok(await run('document.documentElement.scrollWidth<=innerWidth'),'Add panel page overflow at '+width);
  assert.ok(await run('transactionDrawer.scrollWidth<=transactionDrawer.clientWidth'),'Add panel overflow at '+width);
  if(width>760)assert.ok(await run(`document.querySelector('.main-area').getBoundingClientRect().right<=transactionDrawer.getBoundingClientRect().left+1`),'Add editor overlaps list at '+width);
  await run(`transactionDrawer.querySelector('form').elements.description.value='New transaction draft'`);
  await cdp('Emulation.setDeviceMetricsOverride',{width:width===1500?1100:width+1,height:1100,deviceScaleFactor:1,mobile:width<=760});await pause(100);
  assert.equal(await run(`transactionDrawer.querySelector('form').elements.description.value`),'New transaction draft');
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:1100,deviceScaleFactor:1,mobile:width<=760});await pause(100);
  assert.equal(await run(`document.querySelector('#transaction-form').elements.effective_date.value`),'2026-11-03');
  await run('dialog.close();closeTransactionDrawer()');
  console.log('PASS: transaction layout and dated quick add at '+width+'px');
 }
 await run(`(async()=>{state.transactionFilters.account=qaBank;await renderRoute();document.querySelector('.tx-day-heading [data-date="2026-11-03"]').click();})()`);
 await until('!!document.querySelector("#transaction-form")');
 assert.equal(await run(`document.querySelector('#transaction-form').elements.account_id.value`),await run('qaBank'));
 assert.equal(await run(`document.querySelector('#transaction-form').elements.effective_date.value`),'2026-11-03');
 await run(`(async()=>{await transactionEditEditor(root.querySelector('[data-reference-transaction]').dataset.referenceTransaction);const form=transactionDrawer.querySelector('form');form.elements.description.value='Edited in the side panel';form.elements.amount.value='60.00';form.querySelector('[data-edit-kind="expense"] [name="allocation-0"]').value='60.00';form.requestSubmit();})()`);
 await until(`!!transactionDrawer.querySelector('#transaction-full-edit-form')&&!transactionDrawer.querySelector('form').dataset.busy&&root.textContent.includes('Edited in the side panel')`);
 assert.equal(await run(`transactionDrawer.querySelector('form').elements.amount.value`),'60.00');
 assert.equal(await run(`transactionDrawer.querySelector('form').elements.revision.value`),'2');
 assert.equal(await run(`dialog.open`),false);
 await run(`transactionDrawer.querySelector('form').elements.description.value='Draft survives resizing'`);
 await cdp('Emulation.setDeviceMetricsOverride',{width:1100,height:1100,deviceScaleFactor:1,mobile:false});await pause(300);
 assert.equal(await run(`transactionDrawer.querySelector('form').elements.description.value`),'Draft survives resizing');
 await run(`transactionDrawer.querySelector('[data-action="close-transaction-drawer"]').click()`);
 assert.equal(await run('transactionDrawer.hidden'),true);
 assert.equal(await run('document.body.classList.contains("transaction-drawer-open")'),false);
 await run(`(async()=>{await transactionEditEditor(root.querySelector('[data-reference-transaction]').dataset.referenceTransaction);window.qaConfirm=window.confirm;window.qaDeletePrompts=0;window.confirm=()=>{qaDeletePrompts++;return false;};transactionDrawer.querySelector('[data-action="delete-transaction"]').click();})()`);
 await until('qaDeletePrompts===1');
 assert.equal(await run('transactionDrawer.hidden'),false,'Cancelling deletion preserves the editor');
 assert.equal(await run(`root.querySelectorAll('[data-reference-transaction]').length`),1);
 await run(`window.confirm=()=>true;transactionDrawer.querySelector('[data-action="delete-transaction"]').click()`);
 await until(`transactionDrawer.hidden&&!root.hasAttribute('aria-busy')&&!root.querySelector('[data-reference-transaction]')`);
 assert.equal(await run(`(async()=>{const account=await finwiseAPI.request('accounts/'+qaBank);return account.balance.amount;})()`),'950.00','Deleting an expense preserves the latest observed balance anchor');
 assert.equal(await run(`(async()=>{const ledger=await finwiseAPI.collection('accounts/'+qaBank+'/ledger?from=2026-11-01&to=2026-12-01');return ledger.data.some(row=>row.description==='Edited in the side panel');})()`),false,'Deleted expense is removed from the account ledger');
 await run('window.confirm=qaConfirm');
 console.log('PASS: delete confirmation cancellation preserves the transaction; confirmed deletion closes the panel, removes the row and ledger movement, and preserves observed balance anchors.');
 console.log('PASS: one Edit details action, docked editor without list overlap, inline phone editor above the list, saving and fresh revisions, draft retention on resize, and panel close.');
 await run(`(()=>{transactionEditor({accountId:qaBank,date:'2026-11-03'});const form=transactionDrawer.querySelector('form');form.elements.description.value='Created in the shared editor';form.elements.amount.value='25.00';form.requestSubmit();})()`);
 await until(`!!transactionDrawer.querySelector('#transaction-full-edit-form')&&root.textContent.includes('Created in the shared editor')`);
 assert.equal(await run(`transactionDrawer.querySelector('form').elements.amount.value`),'25.00');
 assert.equal(await run(`transactionDrawer.querySelector('form').elements.effective_date.value`),'2026-11-03');
 assert.equal(await run('dialog.open'),false);
 await run(`(()=>{transactionEditor({accountId:qaBank,date:'2026-11-03'});const form=transactionDrawer.querySelector('form');form.elements.description.value='Save and add another from shared editor';form.elements.amount.value='15.00';form.requestSubmit(form.querySelector('[value="another"]'));})()`);
 await until(`!!transactionDrawer.querySelector('#transaction-form')&&!transactionDrawer.querySelector('form').dataset.busy&&root.textContent.includes('Save and add another from shared editor')`);
 assert.equal(await run(`transactionDrawer.querySelector('form').elements.description.value`),'');
 assert.equal(await run(`transactionDrawer.querySelector('form').elements.account_id.value`),await run('qaBank'));
 assert.equal(await run(`transactionDrawer.querySelector('form').elements.effective_date.value`),'2026-11-03');
 console.log('PASS: Add and Edit share the side-panel form layout, keep drafts on resize, preserve date/account context, and support Save and Save & add another.');
 // Confirm each save reveals its own row, including hidden dates/scopes/filters.
 await until(`!!root.querySelector('.tx-just-added')`);
 assert.ok(await run(`root.querySelector('.tx-just-added').textContent.includes('Save and add another from shared editor')`));
 for(const width of [1100,390]) {
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<=760});
  await run(`(async()=>{
   closeTransactionDrawer();setMonth('2026-11');state.scope='personal';state.transactionFilters.search='will hide new transaction';saveView();await renderRoute({inPlace:true});
   transactionEditor({accountId:qaBank,date:'2026-10-15'});const form=transactionDrawer.querySelector('form');form.elements.description.value='Reveal saved transaction at ${width}';form.elements.amount.value='12.00';form.elements.scope.value='family';form.requestSubmit();
  })()`);
  await until(`!!root.querySelector('.tx-just-added')&&root.querySelector('.tx-just-added').textContent.includes('Reveal saved transaction at ${width}')`);
  await until(`(()=>{const rect=root.querySelector('.tx-just-added').getBoundingClientRect();return rect.top>=0&&rect.bottom<=innerHeight})()`);
  assert.equal(await run('state.month'),'2026-10');
  assert.equal(await run('state.scope'),'family');
  assert.equal(await run("state.transactionFilters.search||''"),'');
  assert.ok(await run(`getComputedStyle(root.querySelector('.tx-just-added > summary')).backgroundColor==='rgb(230, 244, 206)'`));
  assert.equal(await run(`root.querySelectorAll('.tx-just-added').length`),1);
  await until(`!root.querySelector('.tx-just-added')`);
 }
 console.log('PASS: each new transaction scrolls into view and is temporarily highlighted on desktop and mobile, including a different month, scope, and an excluding search filter.');
 assert.deepEqual(errors,[]);
 console.log('PASS: entered/calculated balances, positive/negative/zero/unknown differences, date headers including evidence-only dates, and account context preserved; no browser exceptions.');
}catch(error){console.error(error.stack);process.exitCode=1;}finally{ws?.close();chrome.kill();server.kill();await pause(500);await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
})();
