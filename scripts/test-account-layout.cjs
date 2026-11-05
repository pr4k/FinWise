// Account detail layout acceptance: isolated database and synthetic household.
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
(async()=>{
const root=require('node:path').resolve(__dirname,'..'),temp=await fs.mkdtemp(path.join(os.tmpdir(),'finwise-account-qa-'));
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
 for(const width of [1500,768,390,320]) {
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<760});
  for(const subtype of ['bank','credit_card']) {
   await run(`navigate('accounts')`);await until(`state.view==='accounts'&&!root.hasAttribute('aria-busy')&&!root.querySelector('.account-detail-page')`);
   const accountId=await run(`state.accounts.find(a=>a.subtype==='${subtype}').id`);
   await run(`document.querySelector('[data-reference-account="${accountId}"]').click()`);await until('dialog.open');
   assert.equal(await run(`dialog.scrollWidth>dialog.clientWidth`),false,`${subtype} drawer overflow at ${width}`);
   const layout=await run(`(()=>{const body=dialog.querySelector('.detail-dialog-body'),hero=body.querySelector('.account-detail-hero');return {bodyHeight:body.clientHeight,heroBackground:getComputedStyle(hero).backgroundImage,heroHeight:hero.clientHeight,contentHeight:hero.scrollHeight,footerBottom:dialog.querySelector('.dialog-actions').getBoundingClientRect().bottom,dialogBottom:dialog.getBoundingClientRect().bottom};})()`);
   assert.ok(layout.heroBackground.includes('linear-gradient'),'Account hero must retain its contrasting background');
   assert.ok(layout.heroHeight>=layout.contentHeight,'Account hero must contain its content');
   assert.ok(layout.bodyHeight>700,'Account content should use the available drawer height');
   assert.ok(layout.dialogBottom-layout.footerBottom<45,'Close action should sit at the bottom of the drawer');
   await run(`dialog.querySelector('.detail-dialog-body').scrollTop=100000`);
   assert.ok(await run(`(()=>{const b=dialog.querySelector('.detail-dialog-body'),history=b.querySelector('.account-ledger-panel');return history.getBoundingClientRect().bottom<=b.getBoundingClientRect().bottom+1;})()`),'History must be reachable by scrolling');
   await run(`dialog.querySelector('.detail-dialog-body').scrollTop=0`);
   if([390,1500].includes(width)){const shot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await fs.writeFile('/tmp/finwise-account-'+subtype+'-'+width+'.png',Buffer.from(shot.data,'base64'));}
   if(subtype==='credit_card')assert.ok(await run(`!!dialog.querySelector('[data-action="card-payment"]')`));
   await run(`dialog.querySelector('[data-action="account-period"]').click()`);
   await until(`!dialog.open&&!root.hasAttribute('aria-busy')&&!!root.querySelector('.account-detail-page')`);
   assert.ok(await run(`root.querySelector('.account-detail-period').textContent.includes('All recorded dates')`));
   assert.equal(await run('document.documentElement.scrollWidth>innerWidth'),false,`${subtype} detail route overflow at ${width}`);
   assert.ok(await run(`getComputedStyle(root.querySelector('.account-detail-hero')).backgroundImage.includes('linear-gradient')`));
  }
  console.log('PASS: bank and card details, drawer height, readable balance, reachable history, all-date navigation at '+width+'px');
 }
 assert.deepEqual(errors,[]);
}catch(error){console.error(error.stack);process.exitCode=1;}finally{ws?.close();chrome.kill();server.kill();await pause(500);await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
})();
