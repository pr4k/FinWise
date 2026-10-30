// Browser acceptance uses an isolated temporary database; no personal FinWise data is opened.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const net=require('node:net');
const {spawn,execFileSync}=require('node:child_process');
const {chromium}=require(process.env.FINWISE_PLAYWRIGHT_MODULE||'playwright');
(async()=>{
  const root=path.resolve(__dirname,'..'),temporary=await fs.mkdtemp(path.join(os.tmpdir(),'finwise-classification-'));
  const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const database=path.join(temporary,'test.sqlite');
  const server=spawn(path.join(root,'target/debug/finwise-api'),[],{cwd:root,env:{...process.env,FINWISE_BIND:`127.0.0.1:${port}`,FINWISE_DATA_DIR:temporary,DATABASE_URL:`sqlite://${database}`,FINWISE_INSECURE_LOCAL_COOKIES:'true'},stdio:['ignore','ignore','pipe']});
  let startup='';server.stderr.on('data',b=>startup+=b);let browser;
  try {
    const origin=`http://127.0.0.1:${port}`;
    for(let n=0;;n++){try{if((await fetch(origin+'/health/ready')).ok)break;}catch{}if(n>100||server.exitCode!==null)throw Error(startup);await new Promise(r=>setTimeout(r,100));}
    browser=await chromium.launch({headless:true,...(process.env.FINWISE_CHROME_EXECUTABLE?{executablePath:process.env.FINWISE_CHROME_EXECUTABLE}:{})});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin);await page.getByLabel('Your name',{exact:true}).fill('Classification Tester');await page.getByLabel('Email',{exact:true}).fill('classification@example.test');await page.getByLabel('Password',{exact:true}).fill('synthetic-classification-password-123');await page.getByRole('button',{name:'Create household',exact:true}).click();
    await page.getByRole('heading',{name:'Your month',exact:true}).waitFor();
    const seeds=await page.evaluate(async()=>{
      const api=window.finwiseAPI,post=(route,body)=>api.request(route,{method:'POST',body});
      const bank=await post('accounts',{name:'Test bank',subtype:'bank',currency:'INR',visibility:'private'}),food=await post('categories',{name:'Food',kind:'expense'}),salary=await post('categories',{name:'Salary',kind:'income'});
      const month=new URLSearchParams(location.search).get('month');
      await post('transactions',{event_type:'income',amount:'1000.01',currency:'INR',effective_date:month+'-01',description:'Salary',movements:[{account_id:bank.id,amount:'1000.01'}],allocations:[{category_id:salary.id,amount:'1000.01',scope:'personal'}]});
      const ids=[];for(const value of ['10.01','20.02','30.03','40.04','50.05','60.06']) {const tx=await post('transactions',{event_type:'expense',amount:value,currency:'INR',effective_date:month+'-02',description:'SIP broker investment '+value,merchant:'Test broker',movements:[{account_id:bank.id,amount:'-'+value}],allocations:[{category_id:food.id,amount:value,scope:'personal'}]});ids.push(tx.id);}
      return {ids,month};
    });
    execFileSync('python3',['-c',"import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1]); ids=json.loads(sys.argv[2]); c.executemany(\"UPDATE resources SET document=json_set(document,'$.classification.classification_source','system','$.classification.status','needs_review','$.classification.confidence_score',50) WHERE id=?\",[(i,) for i in ids]); c.commit()",database,JSON.stringify(seeds.ids)]);
    await page.reload();await page.getByRole('heading',{name:'Your month',exact:true}).waitFor();
    for(const label of ['Earned Income','Actual Spending','Net Invested','Economic Surplus'])assert.equal(await page.locator('.metric-label').filter({hasText:label}).count(),1);
    assert.equal(await page.locator('[data-review-type]').count(),5);
    if(process.env.FINWISE_SCREENSHOT_DIR){await fs.mkdir(process.env.FINWISE_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.FINWISE_SCREENSHOT_DIR,'overview-desktop.png'),fullPage:true});}
    await page.locator('[data-review-type]').first().selectOption('expense');await page.getByRole('button',{name:'Confirm',exact:true}).first().click();
    await page.waitForFunction(()=>document.querySelector('#view-root').textContent.includes('Smart Review · 5 pending'));
    let summary=await page.evaluate(async()=>window.finwiseAPI.request('analytics/summary?'+new URLSearchParams({from:new URLSearchParams(location.search).get('month')+'-01',to:(()=>{const d=new Date(new URLSearchParams(location.search).get('month')+'-01T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+1);return d.toISOString().slice(0,10)})(),scope:'personal'})));
    assert.equal(summary.actual_spending,'60.06');assert.equal(summary.net_invested,'150.15');
    await page.getByRole('button',{name:'How calculated?',exact:true}).first().click();await page.getByRole('heading',{name:'How calculated?',exact:true}).waitFor();await page.getByRole('button',{name:'Close',exact:true}).last().click();
    await page.evaluate(()=>location.hash='transactions/all');await page.getByRole('heading',{name:'Transactions',exact:true}).waitFor();
    await page.getByRole('button',{name:'Sort by Amount',exact:true}).click();await page.waitForFunction(()=>new URLSearchParams(location.search).get('sort')==='amount');
    await page.waitForFunction(()=>document.querySelector('.activity-table tbody tr')?.textContent.includes('10.01'));
    await page.locator('#transaction-filter-status').selectOption('suggested');await page.waitForFunction(()=>document.querySelectorAll('.activity-table tbody tr').length===5);
    await page.reload();await page.getByRole('heading',{name:'Transactions',exact:true}).waitFor();assert.equal(await page.locator('#transaction-filter-status').inputValue(),'suggested');
    await page.getByRole('button',{name:'Classify',exact:true}).first().click();await page.getByRole('heading',{name:'Classify transaction',exact:true}).waitFor();
    await page.getByRole('button',{name:'Add split',exact:true}).click();assert.equal(await page.locator('.classification-split').count(),2);await page.getByRole('button',{name:'Remove allocation',exact:true}).last().click();
    await page.locator('#classification-form select[name=transaction_type]').selectOption('expense');await page.getByRole('button',{name:'Save classification',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#editor').open);
    await page.setViewportSize({width:390,height:844});await page.evaluate(()=>location.hash='overview');await page.getByRole('heading',{name:'Your month',exact:true}).waitFor();
    if(process.env.FINWISE_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.FINWISE_SCREENSHOT_DIR,'overview-mobile.png'),fullPage:true});
    assert.deepEqual(errors,[]);assert.equal(await page.locator('.live-error').count(),0);console.log('Classification browser acceptance passed: KPIs, top-five review, confirmation, drill-down, sorting, persisted filters, split editor, mobile.');
  } finally {if(browser)await browser.close();if(server.exitCode===null){server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));}await fs.rm(temporary,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
