// Browser acceptance uses an isolated temporary database; no personal FinWise data is opened.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const net=require('node:net');
const {spawn}=require('node:child_process');
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
    await page.goto(origin);await page.getByLabel('Your name',{exact:true}).fill('Category Tester');await page.getByLabel('Email',{exact:true}).fill('categories@example.test');await page.getByLabel('Password',{exact:true}).fill('synthetic-classification-password-123');await page.getByRole('button',{name:'Create household',exact:true}).click();
    await page.getByRole('heading',{name:'Your month',exact:true}).waitFor();
    const seeds=await page.evaluate(async()=>{
      const api=window.finwiseAPI,post=(route,body)=>api.request(route,{method:'POST',body});
      const bank=await post('accounts',{name:'Test bank',subtype:'bank',currency:'INR',visibility:'private'}),food=await post('categories',{name:'Food',kind:'expense'}),salary=await post('categories',{name:'Salary',kind:'income'});
      const month=new URLSearchParams(location.search).get('month');
      await post('transactions',{event_type:'income',amount:'1000.01',currency:'INR',effective_date:month+'-01',description:'Salary',movements:[{account_id:bank.id,amount:'1000.01'}],allocations:[{category_id:salary.id,amount:'1000.01',scope:'personal'}]});
      const ids=[];for(const value of ['10.01','20.02','30.03','40.04','50.05','60.06']) {const tx=await post('transactions',{event_type:'expense',amount:value,currency:'INR',effective_date:month+'-02',description:'SIP broker investment '+value,merchant:'Test broker',movements:[{account_id:bank.id,amount:'-'+value}],allocations:[{category_id:food.id,amount:value,scope:'personal'}]});ids.push(tx.id);}
      return {ids,month};
    });
    await page.reload();await page.getByRole('heading',{name:'Your month',exact:true}).waitFor();
    for(const label of ['Earned Income','Actual Spending','Net Invested','Economic Surplus'])assert.equal(await page.locator('.metric-label').filter({hasText:label}).count(),1);
    assert.equal(await page.locator('[data-review-type], [data-action^="classification"], [data-action="classify-transaction"]').count(),0);
    const summary=await page.evaluate(async()=>window.finwiseAPI.request('analytics/summary?'+new URLSearchParams({scope:'personal',from:window.finwiseViewState.read(location.search,'2026-10').month.slice(0,4)+'-01-01',to:String(Number(window.finwiseViewState.read(location.search,'2026-10').month.slice(0,4))+1)+'-01-01'})));
    assert.equal(summary.actual_spending,'210.21');assert.equal(summary.net_invested,'0.00');
    if(process.env.FINWISE_SCREENSHOT_DIR){await fs.mkdir(process.env.FINWISE_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.FINWISE_SCREENSHOT_DIR,'overview-desktop.png'),fullPage:true});}
    await page.evaluate(()=>location.hash='transactions/all');await page.getByRole('heading',{name:'Transactions',exact:true}).waitFor();
    assert.equal(await page.locator('#transaction-filter-status, #transaction-filter-transactionType, [data-action="classify-transaction"]').count(),0);
    await page.locator('#transaction-filters > summary').click();
    await page.locator('#transaction-filter-eventType').selectOption('expense');
    await page.waitForFunction(()=>new URLSearchParams(location.search).get('event_type')==='expense'&&document.querySelectorAll('.activity-table tbody tr').length===6);
    await page.getByRole('button',{name:'Sort by Amount',exact:true}).click();
    await page.waitForFunction(()=>new URLSearchParams(location.search).get('sort')==='amount'&&document.querySelector('.activity-table tbody tr')?.textContent.includes('10.01'));
    await page.reload();await page.getByRole('heading',{name:'Transactions',exact:true}).waitFor();
    assert.equal(await page.locator('#transaction-filter-eventType').inputValue(),'expense');
    await page.locator('[data-action="edit-transaction"]').first().click();
    await page.getByRole('heading',{name:'Edit transaction',exact:true}).waitFor();
    assert.equal(await page.locator('#transaction-full-edit-form select[name="category-0"]:visible').count(),1);
    await page.locator('#transaction-full-edit-form button[type="button"]').filter({hasText:'Cancel'}).click();
    // Paid on Behalf reuses Settle Up; several credits from other months settle one purchase.
    const paidSeed=await page.evaluate(async()=>{
      const api=window.finwiseAPI,post=(route,body)=>api.request(route,{method:'POST',body});
      const bank=await post('accounts',{name:'Reimbursement bank',subtype:'bank',currency:'INR',visibility:'private'});
      const expense=await post('categories',{name:'Laptop',kind:'expense'}),income=await post('categories',{name:'Reimbursement receipts',kind:'income'});
      const tx=async(type,value,date,description,category)=>post('transactions',{event_type:type,amount:value,currency:'INR',effective_date:date,description,movements:[{account_id:bank.id,amount:(type==='expense'?'-':'')+value}],allocations:[{category_id:category.id,amount:value,scope:'personal'}]});
      const purchase=await tx('expense','141766.00','2026-09-10','Laptop for Alex',expense);
      const one=await tx('income','100000.00','2026-10-20','Alex laptop first reimbursement',income);
      const two=await tx('income','41766.00','2026-11-20','Manual unmatched laptop credit',income);
      return {purchase:purchase.id,credits:[one.id,two.id],movements:purchase.movements};
    });
    await page.evaluate(()=>location.hash='settlements');await page.getByRole('heading',{name:'Settle up',exact:true}).waitFor();
    await page.getByRole('button',{name:'Paid on Behalf',exact:true}).click();
    await page.locator('#paid-purchase-form select[name=transaction_id]').selectOption(paidSeed.purchase);
    await page.getByRole('button',{name:'Continue',exact:true}).click();
    await page.locator('#paid-on-behalf-form input[name=person]').fill('Alex');
    await page.getByRole('button',{name:'Save receivable',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#editor').open);
    await page.getByRole('button',{name:'Match reimbursements',exact:true}).click();
    await page.getByRole('heading',{name:'Match reimbursements',exact:true}).waitFor();
    assert.equal(await page.locator('#reimbursement-match-form').getByText('Suggested',{exact:false}).count(),1);
    for(const key of paidSeed.credits)await page.locator(`#reimbursement-match-form input[name=credit][value="${key}"]`).check();
    await page.getByRole('button',{name:'Apply selected reimbursements',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#editor').open);
    await page.getByRole('button',{name:'Settled',exact:true}).click();
    const card=page.locator('.settlement-card').filter({has:page.getByRole('heading',{name:'Alex',exact:true})});
    await card.waitFor();assert.match(await card.innerText(),/Settled/);assert.match(await card.innerText(),/INR 0.00/);
    const paidState=await page.evaluate(async(key)=>{const api=window.finwiseAPI;return {purchase:await api.request('transactions/'+key),summary:await api.request('analytics/summary?from=2026-09-01&to=2026-12-01&scope=personal')};},paidSeed.purchase);
    assert.deepEqual(paidState.purchase.movements,paidSeed.movements);assert.equal(paidState.summary.earned_income,'1000.01');
    await card.locator('summary').click();assert.equal(await card.getByRole('button',{name:'Unlink',exact:true}).count(),2);
    page.once('dialog',dialog=>dialog.accept());await card.getByRole('button',{name:'Unlink',exact:true}).first().click();
    await page.getByRole('button',{name:'Open',exact:true}).click();await card.waitFor();
    await card.locator('summary').click();await card.getByText('Reversed',{exact:false}).waitFor();
    page.once('dialog',dialog=>dialog.accept());await card.getByRole('button',{name:'Reverse receivable',exact:true}).click();
    await page.getByRole('button',{name:'Reversed',exact:true}).click();await card.waitFor();assert.match(await card.innerText(),/Reversed/);
    await page.setViewportSize({width:390,height:844});await page.evaluate(()=>location.hash='overview');await page.getByRole('heading',{name:'Your month',exact:true}).waitFor();
    if(process.env.FINWISE_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.FINWISE_SCREENSHOT_DIR,'overview-mobile.png'),fullPage:true});
    assert.deepEqual(errors,[]);assert.equal(await page.locator('.live-error').count(),0);console.log('Category reporting browser acceptance passed: category-driven totals, single transaction type filter, category editor, sorting, URL persistence, Paid on Behalf, reimbursements, reversal and mobile');
  } finally {if(browser)await browser.close();if(server.exitCode===null){server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));}await fs.rm(temporary,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
