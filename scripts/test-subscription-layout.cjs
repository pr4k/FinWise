// Expanded subscription history regression using isolated synthetic data.
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
(async()=>{
const root=path.resolve(__dirname,'..'),temp=await fs.mkdtemp(path.join(os.tmpdir(),'finwise-subscription-qa-'));
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
  const account=await finwiseAPI.request('accounts',{method:'POST',body:{name:'Subscription bank',subtype:'bank',currency:'INR'}});
  for(const name of ['BACKBLAZE INC BACKBLAZE.COM CA','Vultr','NETFLIX DI SI MUMBAI IN','We share'])for(const month of ['05','06','07','08','09'])await finwiseAPI.request('transactions',{method:'POST',body:{event_type:'expense',amount:'1751.00',currency:'INR',effective_date:'2026-'+month+'-13',description:name,movements:[{account_id:account.id,amount:'-1751.00'}],allocations:[{category_id:null,amount:'1751.00',scope:'personal'}]}});
  const recurring=await finwiseAPI.request('recurring-transactions');
  for(const item of recurring.data)await finwiseAPI.request('recurring-transactions/'+encodeURIComponent(item.key),{method:'PUT',body:{subscription:true}});
  await catalogs();setMonth('2026-11');navigate('subscriptions');
 })()`);
 await until(`state.view==='subscriptions'&&!root.hasAttribute('aria-busy')&&root.querySelectorAll('.cm-service').length===4`);
 for(const width of [1500,1100,768,390,320]){
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<760});
  const neighbor=await run(`root.querySelectorAll('.cm-service')[1].getBoundingClientRect().height`);
  await run(`root.querySelector('.cm-service .recurring-history summary').click()`);await pause(100);
  assert.equal(await run(`root.querySelectorAll('.cm-service')[1].getBoundingClientRect().height`),neighbor,'Expanding history must not stretch neighbors at '+width);
  assert.ok(await run(`(()=>{const card=root.querySelector('.cm-service'),bounds=card.getBoundingClientRect();return [...card.querySelectorAll('.recurring-history *')].every(el=>el.getBoundingClientRect().right<=bounds.right+1&&el.getBoundingClientRect().left>=bounds.left-1)})()`),'Expanded history must fit the card at '+width);
  assert.equal(await run('document.documentElement.scrollWidth>innerWidth'),false,'Page overflow at '+width);
  if([1500,390].includes(width)){await run(`root.querySelector('.cm-card-grid').scrollIntoView({block:'start',behavior:'instant'})`);const shot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await fs.writeFile('/tmp/finwise-subscription-history-'+width+'.png',Buffer.from(shot.data,'base64'));}
  await run(`root.querySelector('.cm-service .recurring-history summary').click()`);await pause(50);
  console.log('PASS: expanded subscription history stays contained and neighboring cards retain their height at '+width+'px');
 }
 assert.deepEqual(errors,[]);
}catch(error){console.error(error.stack);process.exitCode=1;}finally{ws?.close();chrome.kill();server.kill();await pause(500);await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
})();
