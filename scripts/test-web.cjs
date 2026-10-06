// Real browser acceptance against an isolated server/database. No screenshots or source data are saved.
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
    await page.getByRole('heading',{name:'Your finances'}).waitFor();
    async function open(view) {
      await page.evaluate(view=>location.hash=view,view);
      try { await page.waitForFunction(view=>document.querySelector('#breadcrumb-current').textContent===view && !document.querySelector('#view-root').textContent.includes('Loading your data'),({imports:'Imports',overview:'Overview',transactions:'Transactions',accounts:'Accounts',categories:'Categories',analytics:'Analytics',budgets:'Budgets',statements:'Statements',reconcile:'Reconcile',changes:'Money Manager changes',settings:'Settings',more:'More'})[view]); }
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
    for(const view of ['overview','transactions','accounts','categories','analytics','statements','budgets','reconcile','settings']) {
      await open(view); assert.equal(await page.locator('.live-error').count(),0,`${view} returned an error`);
      assert.equal(await page.locator('#view-root').getByText('Sample data',{exact:false}).count(),0);
    }
    // The compact overview feed remains keyboard accessible and opens ledger detail.
    await open('overview');
    await page.locator('.recent-item').first().focus();
    await page.keyboard.press('Enter');
    await page.getByRole('heading',{name:'Transaction details',exact:true}).waitFor();
    await page.locator('#transaction-detail-form').getByRole('button',{name:'Close',exact:true}).click();
    await open('accounts');
    await page.getByRole('button',{name:'Add account',exact:true}).click();
    await page.getByLabel('Name',{exact:true}).fill('Browser cash');
    await page.getByLabel('Type',{exact:true}).selectOption('cash');
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await page.getByRole('heading',{name:'Browser cash',exact:true}).waitFor();
    await open('transactions');
    await page.locator('#view-root').getByRole('button',{name:'Add transaction',exact:true}).click();
    await page.getByLabel('Description',{exact:true}).fill('Browser smoke entry');
    await page.getByLabel('Amount',{exact:true}).fill('12.34');
    await page.getByLabel('Date',{exact:true}).fill(`${first.month}-05`);
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await page.getByRole('cell',{name:'Browser smoke entry',exact:false}).waitFor();
    await open('changes');
    const newRow=page.locator('#view-root .live-table tbody tr').filter({hasText:'Browser smoke entry'}).first();
    await newRow.waitFor();
    assert.match(await newRow.locator('td').nth(1).textContent(),/Empty · new in Money Manager/);
    // Exercise the budget tracking response shape, including draft activation.
    await open('budgets'); await page.getByRole('button',{name:'Create budget',exact:true}).first().click();
    await page.getByLabel('Name',{exact:true}).fill('Browser budget');
    await page.getByLabel('Expected income',{exact:true}).fill('1000.00');
    await page.locator('#editor .budget-input-grid input').first().fill('1000');
    await page.getByRole('button',{name:'Create draft',exact:true}).click();
    await page.getByRole('heading',{name:'Browser budget · draft'}).waitFor();
    assert.equal(await page.locator('.live-error').count(),0,'Budget precision caused a render error');
    await page.getByRole('button',{name:'Activate',exact:true}).click();
    await page.getByRole('heading',{name:'Browser budget · active'}).waitFor();
    // An invited member can join, see a shared account, and record family spending.
    await open('accounts');
    await page.getByRole('button',{name:'Add account',exact:true}).click();
    await page.getByLabel('Name',{exact:true}).fill('Family cash');
    await page.getByLabel('Type',{exact:true}).selectOption('cash');
    await page.getByLabel('Visibility',{exact:true}).selectOption('shared');
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await page.getByRole('heading',{name:'Family cash',exact:true}).waitFor();
    await open('settings');
    await page.getByLabel('Email address').fill('family-member@example.test');
    await page.getByRole('button',{name:'Create invitation link'}).click();
    const invite=await page.getByLabel('Share this link now').inputValue();
    const memberContext=await browser.newContext({viewport:{width:390,height:844}});
    const memberPage=await memberContext.newPage();
    memberPage.on('pageerror',e=>errors.push(e.message));
    await memberPage.goto(invite);
    await memberPage.getByRole('heading',{name:'Join a household'}).waitFor();
    await memberPage.getByLabel('Your name').fill('Family Member');
    await memberPage.getByLabel('Invited email').fill('family-member@example.test');
    await memberPage.getByLabel('Create password').fill('family-member-password-123');
    await memberPage.getByRole('button',{name:'Create account and join'}).click();
    await memberPage.getByRole('heading',{name:'Your finances'}).waitFor();
    await memberPage.locator('#report-month').fill(first.month);
    await memberPage.locator('#report-scope').selectOption('family');
    await memberPage.locator('.bottom-add').click();
    await memberPage.getByLabel('Description',{exact:true}).fill('Family member groceries');
    await memberPage.getByLabel('Amount',{exact:true}).fill('25.00');
    await memberPage.getByLabel('Date',{exact:true}).fill(`${first.month}-06`);
    await memberPage.getByLabel('Account / transfer source').selectOption({label:'Family cash · INR'});
    await memberPage.getByLabel('Scope',{exact:true}).selectOption('family');
    await memberPage.getByRole('button',{name:'Save',exact:true}).click();
    await memberPage.locator('#view-root').getByText('Family member groceries').waitFor();
    const memberOverflow=await memberPage.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
    assert.equal(memberOverflow,false,'Member transaction screen overflows at 390px');
    await page.locator('#report-scope').selectOption('family');
    await open('transactions');
    await page.locator('#view-root').getByText('Family member groceries').waitFor();
    await memberContext.close();
    for(const width of [320,390,768,1440]) {
      await page.setViewportSize({width,height:900});
      for(const view of ['overview','analytics','transactions','accounts','categories','statements','budgets','reconcile','changes','imports','settings','more']) {
        await open(view);
        const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
        assert.equal(overflow,false,`${view} overflows at ${width}px`);
        assert.equal(await page.locator('.live-error').count(),0,`${view} returned an error at ${width}px`);
        if(process.env.FINWISE_SCREENSHOT_DIR && width===390 && ['statements','budgets','changes'].includes(view)) await page.screenshot({path:path.join(process.env.FINWISE_SCREENSHOT_DIR,`${view}.png`),fullPage:true});
      }
    }
    await open('settings'); await page.locator('#view-root').getByRole('button',{name:'Sign out',exact:true}).click({force:true});
    await page.getByRole('heading',{name:'Welcome back'}).waitFor();
    await page.getByLabel('Email',{exact:true}).fill('browser@example.test');
    await page.getByLabel('Password',{exact:true}).fill('browser-synthetic-password-123');
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.getByRole('heading',{name:'Settings',exact:true}).waitFor();
    await page.setViewportSize({width:390,height:900});
    await page.getByLabel('Month to add',{exact:true}).fill(first.month);
    await page.getByRole('button',{name:'Add month',exact:true}).click();
    await page.getByLabel('Month to add',{exact:true}).fill('2030-01');
    await page.getByRole('button',{name:'Add month',exact:true}).click();
    await page.getByRole('button',{name:'Preview reset',exact:true}).click();
    await page.getByLabel('Type RESET to confirm',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,'Reset preview overflows on mobile');
    await page.getByRole('button',{name:'Remove 2030-01',exact:true}).click();
    assert.equal(await page.getByLabel('Type RESET to confirm',{exact:true}).count(),0,'Changing months must discard the confirmation');
    await page.getByLabel('Month to add',{exact:true}).fill('2030-01');
    await page.getByRole('button',{name:'Add month',exact:true}).click();
    await page.getByRole('button',{name:'Preview reset',exact:true}).click();
    await page.getByLabel('Type RESET to confirm',{exact:true}).fill('RESET');
    await page.getByRole('button',{name:'Reset selected months',exact:true}).click();
    await page.getByText(/Monthly data reset for/).waitFor();
    await page.getByRole('button',{name:'Preview reset',exact:true}).click();
    await page.getByText('No activity found in these months.',{exact:true}).waitFor();
    assert.deepEqual(errors,[]);
    console.log(`Browser acceptance passed: setup/login/logout, import/re-import (${first.count} events, ${first.transfers} transfers), Money Manager comparisons, budget precision, invited member family entry, reload recovery, confirmed multi-month reset, and main views at 320–1440px. Isolated temporary database only.`);
  } finally {
    if(browser) await browser.close();
    try { process.kill(-server.pid,'SIGTERM'); } catch {}
    await Promise.race([new Promise(r=>server.once('exit',r)),new Promise(r=>setTimeout(r,5000))]);
    try { process.kill(-server.pid,'SIGKILL'); } catch {}
    await fs.rm(temporary,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
