// Dashboard acceptance against an isolated server/database and synthetic import fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.FINWISE_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const workbook = process.env.FINWISE_TEST_WORKBOOK || path.join(root,'backend/tests/fixtures/money-manager-synthetic.xlsx');
async function freePort() { const s=net.createServer(); await new Promise(r=>s.listen(0,'127.0.0.1',r)); const p=s.address().port; await new Promise(r=>s.close(r)); return p; }
(async()=>{
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'finwise-web-'));
  const port=await freePort();
  const config=path.join(temporary,'test.env');
  await fs.writeFile(config,`FINWISE_BIND=127.0.0.1:${port}\nFINWISE_DATA_DIR='${temporary}'\nFINWISE_WEB_DIR='${root}/web'\nFINWISE_INSECURE_LOCAL_COOKIES=true\nDATABASE_URL='sqlite://${temporary}/test.sqlite'\n`,{mode:0o600});
  const server=spawn(path.join(root,'run.sh'),[],{cwd:root,env:{...process.env,FINWISE_ENV_FILE:config},stdio:['ignore','ignore','pipe'],detached:true});
  let startup=''; server.stderr.on('data',b=>startup+=b.toString());
  let browser;
  try {
    const origin=`http://127.0.0.1:${port}`;
    for(let attempt=0;;attempt++) {
      try { if((await fetch(`${origin}/health/ready`)).ok) break; } catch {}
      if(attempt>300 || server.exitCode!==null) throw new Error(`Server failed to start: ${startup}`);
      await new Promise(r=>setTimeout(r,200));
    }
    browser=await chromium.launch({headless:true,...(process.env.FINWISE_CHROME_EXECUTABLE?{executablePath:process.env.FINWISE_CHROME_EXECUTABLE}:{})});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin);
    await page.getByRole('heading',{name:'Set up your household'}).waitFor();
    await page.getByLabel('Your name',{exact:true}).fill('Acceptance Owner');
    await page.getByLabel('Email',{exact:true}).fill('browser@example.test');
    await page.getByLabel('Password',{exact:true}).fill('browser-synthetic-password-123');
    await page.getByLabel('Timezone',{exact:true}).fill('Asia/Kolkata');
    await page.getByRole('button',{name:'Create household',exact:true}).click();
    await page.getByRole('heading',{name:'Your month',exact:true}).waitFor();
    async function open(view) {
      await page.evaluate(view=>location.hash=view,view);
      try { await page.waitForFunction(view=>document.querySelector('#breadcrumb-current').textContent===view && !document.querySelector('#view-root').hasAttribute('aria-busy'),({imports:'Imports',overview:'Dashboard',transactions:'Transactions',accounts:'Accounts',categories:'Categories',analytics:'Dashboard',budgets:'Family budget',investments:'Investments',statements:'Statements',reconcile:'Reconcile',changes:'Money Manager changes',settings:'Settings',more:'More'})[view]); }
      catch(error) { throw new Error(`Opening ${view}: ${error.message}`); }
    }
    async function upload(repeat=false) {
      await open('imports');
      await page.locator('#upload-form input[type=file]').setInputFiles(workbook);
      await page.getByRole('button',{name:'Upload and review'}).click();
      await page.getByRole('button',{name:'Save mappings and preview'}).waitFor({timeout:30000});
      await page.getByRole('button',{name:'Save mappings and preview'}).click();
      await page.getByRole('columnheader',{name:'Description / Note'}).waitFor();
      await page.getByRole('button',{name:'Commit ready rows'}).waitFor();
      await page.waitForFunction(()=>document.querySelector('#commit-form button')?.disabled===false);
      if (repeat) {
        const summary=await page.getByRole('heading',{name:'Preview summary'}).locator('..').textContent();
        assert.match(summary,/\b[1-9][0-9]* rows already imported and reusable/);
      }
      await page.locator('#commit-form input[type=checkbox]').check();
      await page.getByRole('button',{name:'Commit ready rows'}).click();
      await page.getByRole('heading',{name:'Commit result'}).waitFor({timeout:30000});
      assert.equal(await page.locator('.live-error').count(),0);
    }
    await upload();
    const first=await page.evaluate(async()=>{
      const tx=await window.finwiseAPI.collection('transactions');
      const periods=tx.data.map(v=>v.effective_date).sort();
      return {count:tx.data.length,month:periods[0].slice(0,7),transfers:tx.data.filter(v=>v.event_type==='transfer').length};
    });
    assert.ok(first.count>0); assert.ok(first.transfers>0);
    await upload(true);
    const second=await page.evaluate(async()=>(await window.finwiseAPI.collection('transactions')).data.length);
    assert.equal(second,first.count,'Repeated browser import created extra transactions');
    const importHash=await page.evaluate(()=>location.hash);
    const edited=await page.evaluate(async()=>{
      const api=window.finwiseAPI;
      const imported=(await api.collection('transactions')).data.find(v=>v.source_refs.length && v.event_type==='expense');
      const updated=await api.request(`transactions/${imported.id}`,{method:'PATCH',revision:imported.revision,body:{description:'Updated Money Manager entry'}});
      return {original:imported.description,updated:updated.description};
    });
    await open('changes');
    const changedRow=page.locator('#view-root .live-table tbody tr').filter({hasText:'Updated Money Manager entry'}).first();
    await changedRow.waitFor();
    assert.match(await changedRow.locator('td').nth(1).textContent(),new RegExp(edited.original.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
    assert.match(await changedRow.locator('td').nth(2).textContent(),/Updated Money Manager entry/);
    // Reload can reconstruct the committed file review from the URL.
    await page.evaluate(hash=>location.hash=hash,importHash);
    await page.reload(); await page.getByRole('heading',{name:'Preview summary'}).waitFor();
    await page.getByLabel('Report month').fill(first.month);
    await open('overview');
    await page.getByRole('heading',{name:'Explore your finances',exact:true}).waitFor();
    assert.equal(await page.locator('#desktop-nav [data-view=analytics]').count(),0);
    for(const metric of ['earned_income','actual_spending','net_invested','economic_surplus']) {
      const trigger=page.locator(`[data-action=metric-detail][data-metric=${metric}]`);
      await trigger.focus();await page.keyboard.press('Enter');
      await page.locator('#metric-dialog .metric-explanation').waitFor().catch(async error=>{console.error(metric,await page.locator('#metric-dialog').textContent(),errors);throw error;});
      assert.equal(await page.locator('#metric-dialog').evaluate(el=>el.open),true);
      const text=await page.locator('#metric-dialog').textContent();
      assert.ok(!text.includes('does not fully reconcile'),`Unreconciled ${metric}`);
      await page.getByRole('tab',{name:/All contributors/}).click();
      assert.equal(await page.locator('#metric-tab-all').getAttribute('aria-selected'),'true');
      await page.getByRole('tab',{name:/Excluded/}).click();
      await page.keyboard.press('Home');
      assert.equal(await page.locator('#metric-tab-top').getAttribute('aria-selected'),'true');
      await page.keyboard.press('Escape');
      await page.waitForFunction(()=>!document.querySelector('#metric-dialog').open);
      await page.waitForFunction(metric=>document.activeElement?.dataset.metric===metric,metric,{timeout:3000}).catch(async error=>{console.error('FOCUS',await page.evaluate(()=>({active:document.activeElement.outerHTML.slice(0,300),editor:document.querySelector('#editor').open,drawer:document.querySelector('#transaction-drawer').hidden,key:state.metricDetail.key,metricOpen:document.querySelector('#metric-dialog').open})),errors);throw error;});
      assert.equal(await trigger.evaluate(el=>document.activeElement===el),true);
    }
    await page.locator('[data-action=metric-detail][data-metric=actual_spending]').click();
    await page.locator('#metric-dialog .metric-explanation').waitFor();
    await page.getByRole('tab',{name:/All contributors/}).click();
    await page.locator('#metric-dialog .metric-contributor').first().click();
    await page.getByRole('heading',{name:'Transaction details',exact:true}).waitFor();
    await page.locator('#transaction-detail-form').getByRole('button',{name:'Close',exact:true}).click();
    await page.locator('[data-action=metric-detail][data-metric=actual_spending]').click();
    await page.locator('#metric-dialog .metric-explanation').waitFor();
    await page.locator('#metric-dialog [data-scope=family]').click();
    await page.waitForFunction(()=>document.querySelector('#metric-dialog .metric-context')?.textContent.startsWith('Family')&&!document.querySelector('#view-root').hasAttribute('aria-busy'));
    assert.equal(await page.locator('.scope-segments [data-scope=family]').getAttribute('aria-pressed'),'true');
    assert.doesNotMatch(await page.locator('#metric-dialog').textContent(),/NaN|Infinity/);
    assert.equal(await page.locator('.overview-summary [data-metric]').count(),4);
    assert.equal(await page.getByRole('tablist',{name:'Analytics sections'}).getByRole('tab').count(),3);
    await page.locator('#metric-dialog [data-scope=personal]').click();
    await page.waitForFunction(()=>document.querySelector('#metric-dialog .metric-context')?.textContent.startsWith('Personal')&&!document.querySelector('#view-root').hasAttribute('aria-busy'));
    for(const width of [320,390,768,1440]) {
      await page.setViewportSize({width,height:1000});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      assert.equal(await page.locator('#metric-dialog').evaluate(el=>el.scrollWidth>el.clientWidth),false,`Breakdown overflow at ${width}`);
      if(process.env.FINWISE_SCREENSHOT_DIR)await page.locator('#metric-dialog').screenshot({path:path.join(process.env.FINWISE_SCREENSHOT_DIR,`metric-${width}.png`)});
    }
    await page.getByRole('button',{name:'Close breakdown',exact:true}).click();
    await page.waitForFunction(()=>document.activeElement?.dataset.metric==='actual_spending');
    for(const width of [320,390,768,1440]) {
      await page.setViewportSize({width,height:1000});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`Dashboard overflow at ${width}`);
    }
    await page.getByRole('tab',{name:'Detailed reports',exact:true}).click();
    await page.locator('#analytics-panel-detailed').waitFor({state:'visible'});
    await page.evaluate(()=>location.hash='analytics');
    await page.waitForFunction(()=>location.hash==='#overview/reports'&&!document.querySelector('#view-root').hasAttribute('aria-busy'));
    assert.equal(await page.locator('#breadcrumb-current').textContent(),'Dashboard');
    assert.equal(await page.locator('.live-error').count(),0);
    assert.deepEqual(errors,[]);
    await page.evaluate(()=>location.hash='overview');
    await page.waitForFunction(()=>!document.querySelector('#view-root').hasAttribute('aria-busy')&&document.querySelector('.dashboard-page'));
    assert.equal(await page.getByRole('heading',{name:'Budget pulse',exact:true}).count(),0);
    assert.equal(await page.locator('#desktop-nav [data-view=budgets]').isVisible(),false);
    await page.locator('.scope-segments [data-scope=family]').click();
    await page.getByRole('heading',{name:'Budget pulse',exact:true}).waitFor();
    assert.equal(await page.locator('#desktop-nav [data-view=budgets]').isVisible(),true);
    await open('budgets');
    await page.getByRole('button',{name:'Create family budget',exact:true}).first().click();
    await page.getByLabel('Name',{exact:true}).fill('Shared family plan');
    await page.getByLabel('Expected income',{exact:true}).fill('1000.00');
    assert.equal(await page.locator('[data-person-limit]').count(),0);
    await page.locator('#editor .budget-input-grid input').first().fill('100.00');
    await page.getByRole('button',{name:'Create draft',exact:true}).click();
    await page.getByRole('heading',{name:'Shared family plan · draft',exact:true}).first().waitFor();
    assert.equal(await page.getByRole('tab',{name:'People',exact:true}).count(),0);
    assert.equal(await page.getByRole('tablist',{name:'Budget sections'}).getByRole('tab').count(),3);
    const familyPlan=await page.evaluate(async()=>{const plans=await window.finwiseAPI.collection('budgets?month='+document.querySelector('#report-month').value+'&scope=family');return plans.data.find(plan=>plan.name==='Shared family plan');});
    assert.equal(familyPlan.scope,'family');assert.equal(familyPlan.people_limits.length,0);
    await page.getByRole('button',{name:'Activate',exact:true}).first().click();
    await page.getByRole('heading',{name:'Shared family plan · active',exact:true}).first().waitFor();
    await page.getByRole('tab',{name:'Categories',exact:true}).click();
    assert.equal(await page.locator('#budget-panel-categories').isVisible(),true);
    assert.equal(await page.locator('[data-action=budget-matrix-detail]').count(),0);
    for(const width of [320,390,768,1440]) {
      await page.setViewportSize({width,height:1000});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`Family budget overflow at ${width}`);
    }
    await page.locator('.scope-segments [data-scope=personal]').click();
    await page.getByRole('button',{name:'View family budget',exact:true}).waitFor();
    assert.equal(await page.locator('#desktop-nav [data-view=budgets]').isVisible(),false);
    assert.equal(await page.locator('.live-error').count(),0);assert.deepEqual(errors,[]);
    await page.evaluate(async month=>{
      const api=window.finwiseAPI;
      for(const holding of [
        {name:'Nifty 50 Index Fund',type:'investment',asset_class:'mutual_fund',opening_value:'285600.00'},
        {name:'Equity portfolio',type:'investment',asset_class:'stock_market',opening_value:'125400.00'}
      ])await api.request('investments',{method:'POST',body:{...holding,currency:'INR',visibility:'shared',opening_month:month}});
      await api.request('investments/goals',{method:'POST',body:{name:'Family safety fund',kind:'emergency',currency:'INR',target_amount:'85000.00',essential_monthly:'17000.00',target_months:5,allocations:[]}});
    },first.month);
    await open('investments');
    await page.getByRole('tab',{name:'Overview',exact:true}).click();
    await page.locator('.investment-summary').waitFor();
    assert.equal(await page.locator('.investment-stat').count(),4);
    assert.equal(await page.locator('.investment-calculation-details').first().evaluate(el=>el.open),false);
    assert.equal(await page.locator('.investment-preview-card').count(),2);
    await page.getByText('How these totals work',{exact:true}).click();
    assert.equal(await page.getByRole('heading',{name:'Monthly cash flow',exact:true}).isVisible(),true);
    await page.getByText('How these totals work',{exact:true}).click();
    for(const width of [320,390,768,1440]) {
      await page.setViewportSize({width,height:1000});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`Investment overview overflow at ${width}`);
      if(process.env.FINWISE_SCREENSHOT_DIR)await page.locator('.investment-summary').screenshot({path:path.join(process.env.FINWISE_SCREENSHOT_DIR,`investment-summary-${width}.png`)});
    }
    await page.locator('.investment-preview-card').filter({hasText:'Nifty 50 Index Fund'}).click();
    await page.locator('#editor[open]').waitFor();
    await page.locator('#editor [data-action=close-editor]').first().click();
    await page.getByRole('button',{name:'View all →',exact:true}).click();
    await page.getByRole('heading',{name:'Holdings',exact:true}).waitFor();
    assert.equal(await page.locator('.live-error').count(),0);assert.deepEqual(errors,[]);
    console.log('Dashboard browser checks passed: merged reports and legacy route, four hero breakdowns, exact reconciliation, contributor/excluded tabs, keyboard/close focus, transaction drill-down, synchronized scopes, family-only budgets, compact investment overview with expandable calculations and holdings drill-down, and 320–1440px layouts.');
  } finally {
    if(browser) await browser.close();
    try { process.kill(-server.pid,'SIGTERM'); } catch {}
    await Promise.race([new Promise(r=>server.once('exit',r)),new Promise(r=>setTimeout(r,5000))]);
    try { process.kill(-server.pid,'SIGKILL'); } catch {}
    await fs.rm(temporary,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});
