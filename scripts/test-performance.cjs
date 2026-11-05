// Startup and ledger performance acceptance: isolated database and synthetic household.
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
(async()=>{
const root=path.resolve(__dirname,'..'),temp=await fs.mkdtemp(path.join(os.tmpdir(),'finwise-performance-qa-'));
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
 await run(`window.qaFetchCalls=[];window.qaFetch=window.fetch;window.fetch=(...args)=>{qaFetchCalls.push(args[0]);return qaFetch(...args);}`);
 await run(`(async()=>{const value=await window.finwiseAPI.request('auth/bootstrap',{method:'POST',body:{owner:{name:'Planner Tester',email:'planner@example.test',password:'planner-test-password-123'},household:{name:'Planner QA',timezone:'Asia/Kolkata',base_currency:'INR'}}});window.finwiseAPI.setCsrf(value.csrf_token);await signedIn();})()`);
 await until('!!document.querySelector(".dashboard-page")');

 assert.equal(await run(`qaFetchCalls.filter(path=>path==='/api/v1/me').length`),1,'Initial sign-in must not reload me twice');
 assert.equal(await run(`qaFetchCalls.filter(path=>path.includes('/members?')).length`),1,'Initial sign-in must not reload members twice');
 await run(`(async()=>{const bank=await finwiseAPI.request('accounts',{method:'POST',body:{name:'Performance bank',subtype:'bank',currency:'INR',opening_balance:{amount:'100000.00',as_of:'2026-10-01T00:00:00+05:30'}}});await finwiseAPI.request('transactions',{method:'POST',body:{event_type:'expense',amount:'10.00',currency:'INR',description:'Synthetic expense',effective_date:'2026-10-02',movements:[{account_id:bank.id,amount:'-10.00'}],allocations:[{category_id:null,amount:'10.00',scope:'personal'}]}});await catalogs();window.qaRows=(await finwiseAPI.collection('transactions')).data;state.view='transactions';state.transactionFilters={};state.ledgerBalances=new Map();window.qaRecords=Array.from({length:2000},(_,i)=>({...qaRows[0],id:'synthetic-'+i,description:'Synthetic expense '+i}));})()`);
 await run(`navigate('transactions',['all'])`);await until(`!!root.querySelector('.reference-records')&&!root.hasAttribute('aria-busy')`);
 assert.equal(await run(`root.querySelectorAll('.tx-details .tx-impact-grid').length`),0,'Closed rows must skip detail markup');
 const reads=await run('qaFetchCalls.length');
 await run(`root.querySelector('[data-reference-transaction] summary').click()`);await until(`!!root.querySelector('[data-reference-transaction][open] .tx-impact-grid')`);
 assert.equal(await run('qaFetchCalls.length'),reads,'Opening a loaded row must not fetch again');
 await run(`renderRoute({inPlace:true})`);await until(`!root.hasAttribute('aria-busy')`);
 assert.ok(await run(`!!root.querySelector('[data-reference-transaction][open] .tx-impact-grid')`),'An open row stays populated after an in-place refresh');
 const beforeSource=await fs.readFile(path.join(root,'scripts/fixtures/ledger-render-baseline.js'),'utf8');
 await run(beforeSource+';window.qaBeforeRenderer=window.finwiseLedgerBaseline;window.qaAfterRenderer=window.finwiseReference.transactions;');
 const results=await run(`(()=>{
   function measure(renderer){const start=performance.now();const html=renderer(qaRecords);const built=performance.now();const parsed=document.createElement('template');parsed.innerHTML=html;const complete=performance.now();return {buildMs:built-start,parseMs:complete-built,totalMs:complete-start,htmlCharacters:html.length,rows:parsed.content.querySelectorAll('.tx-record').length,expandedMarkup:parsed.content.querySelectorAll('.tx-details .tx-impact-grid').length,summaries:[...parsed.content.querySelectorAll('summary')].map(n=>n.textContent)};}
   const before=measure(qaBeforeRenderer),after=measure(qaAfterRenderer);const same=JSON.stringify(before.summaries)===JSON.stringify(after.summaries);delete before.summaries;delete after.summaries;return {before,after,same};
 })()`);
 assert.equal(results.same,true,'Visible ledger summaries must remain identical');assert.equal(results.before.rows,2000);assert.equal(results.after.rows,2000);assert.equal(results.before.expandedMarkup,2000);assert.equal(results.after.expandedMarkup,0);
 console.log(JSON.stringify(results));
 assert.deepEqual(errors,[]);console.log('PASS: single startup catalog pass; 2000 unchanged summaries with on-demand details. Timings are synthetic browser measurements, not NAS guarantees.');
}catch(error){console.error(error.stack);process.exitCode=1;}finally{ws?.close();chrome.kill();server.kill();await pause(500);await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
})();
