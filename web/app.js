'use strict';
const themeLink=document.querySelector('link[href^="/reference-theme.css"]');
if(themeLink && themeLink.getAttribute('href')!=='/reference-theme.css?v=20261012f')
  themeLink.href='/reference-theme.css?v=20261012f';
const api = window.finwiseAPI;
const viewState = window.finwiseViewState;
const categoryView = window.finwiseCategories;
const analyticsView = window.finwiseAnalytics;
const subscriptionBrands = window.finwiseSubscriptionBrands;
const activityView = window.finwiseActivity;
const { matchAllocations, amendmentPlan, sumSignedRows } = window.finwiseReconciliation;
const localTimestamp = window.finwiseTime.localTimestamp;
const savedView = viewState.read(location.search, localDate().slice(0,7));
const savedBudgetTab=new URLSearchParams(location.search).get('budget_tab');
const root = document.querySelector('#view-root');
const authRoot = document.querySelector('#auth-root');
const shell = document.querySelector('.app-shell');
const dialog = document.querySelector('#editor');
const transactionDrawer = document.querySelector('#transaction-drawer');
function closeTransactionDrawer() {
  transactionDrawer.hidden=true;
  transactionDrawer.replaceChildren();
  document.body.classList.remove('transaction-drawer-open');
}
const menuButton = document.querySelector('#menu-button');
function syncMenuButton() {
  const mobile=window.matchMedia('(max-width:760px)').matches;
  menuButton.setAttribute('aria-label',mobile?'Open navigation':shell.classList.contains('sidebar-collapsed')?'Expand navigation':'Collapse navigation');
  menuButton.setAttribute('aria-expanded',String(!mobile && !shell.classList.contains('sidebar-collapsed')));
  document.querySelector('.sidebar').inert=mobile;
}
function syncScopeControl() {
  document.querySelector('.scope-segments').hidden=familyMode();
  document.querySelectorAll('.scope-segments [data-scope]').forEach(el=>{
    const active=el.dataset.scope===state.scope;
    el.classList.toggle('selected',active);
    el.setAttribute('aria-pressed',String(active));
  });
}
const labels = { overview:'Overview', household:'Household', analytics:'Analytics', transactions:'Transactions', recurring:'Recurring', planner:'Planner', accounts:'Accounts', categories:'Categories', statements:'Statements', budgets:'Budgets', settlements:'Settle up', investments:'Investments', reconcile:'Reconcile', imports:'Imports', settings:'Settings', changes:'Money Manager changes', more:'More' };
const previousMonth=new Date(`${savedView.month}-01T00:00:00Z`); previousMonth.setUTCMonth(previousMonth.getUTCMonth()-1);
const compareParam=new URLSearchParams(location.search).get('compare');
const state = { me:null, accounts:[], categories:[], members:[], plannedItems:[], ledgerBalances:new Map(), transactionFilters:viewState.readFilters(location.search), recurringFilter:'review', settlementFilter:'open', investmentFilter:'all', analyticsTab:'summary', budgetTab:['top','people','categories','ahead'].includes(savedBudgetTab)?savedBudgetTab:'top', compareMonth:/^\d{4}-(0[1-9]|1[0-2])$/.test(compareParam||'')?compareParam:previousMonth.toISOString().slice(0,7), inviteLink:null, view:'overview', month:savedView.month, scope:savedView.scope, batch:null, file:null, preview:[], cleanupPreview:null, metadata:null, fileInfo:null, importResult:null, session:null, generation:0 };
let recentTransactions=[];
let transactionFiltersExpanded=false;
let previousRoute='';
function familyMode() { return state.me?.household?.family_only===true; }
function scopeField(name='scope') { return familyMode()?input(name,'type="hidden" value="family"'):field('Scope',`<select name="${name}">${option('personal','Personal',defaultTransactionScope()==='personal')}${option('family','Family',defaultTransactionScope()==='family')}</select>`); }
function budgetDestinationOptions(selected='unassigned') { return [option('unassigned','Unassigned',selected==='unassigned'),option('shared','Shared household pool',selected==='shared'),...state.members.map(member=>option(member.user_id,member.name,selected===member.user_id)),...(!['unassigned','shared'].includes(selected)&&!state.members.some(member=>member.user_id===selected)?[option(selected,'Archived member',true)]:[])].join(''); }
let toastTimer;
const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const id = value => encodeURIComponent(value);
const button = (title,action,extra='') => `<button type="button" class="outline-button" data-action="${action}" ${extra}>${h(title)}</button>`;
const dangerButton = (title,action,extra='') => `<button type="button" class="outline-button danger-button" data-action="${action}" ${extra}>${h(title)}</button>`;
const navButton = (view,title=labels[view]) => `<button type="button" class="outline-button" data-view="${view}">${h(title)}</button>`;
const empty = message => `<p class="empty-state">${h(message)}</p>`;
function displayMoney(value,currency) {
  const parts=/^(-?)(\d+)(\.\d+)?$/.exec(String(value));
  if(!parts) return h(value);
  let whole=parts[2];
  if(currency==='INR' && whole.length>3) {
    const tail=whole.slice(-3);whole=whole.slice(0,-3).replace(/\B(?=(\d{2})+(?!\d))/g,',')+','+tail;
  } else whole=whole.replace(/\B(?=(\d{3})+(?!\d))/g,',');
  return `${parts[1]}${whole}${parts[3]||''}`;
}
const amount = (value,currency=state.me?.household.base_currency || 'INR') => value == null ? 'Unknown' : `${h(currency)} ${displayMoney(value,currency)}`;
const responsiveAmount = (value,currency,full=amount(value,currency)) => value == null ? 'Unknown' : `<span class="adaptive-money"><span class="sr-only">${amount(value,currency)}</span><span class="amount-full" aria-hidden="true">${h(full)}</span><span class="amount-short" aria-hidden="true">${h(window.finwiseCompactMoney.format(value,currency))}</span></span>`;
const recurringAmount = item => item.min_amount===item.max_amount?amount(item.max_amount,item.currency):`${amount(item.min_amount,item.currency)}–${amount(item.max_amount,item.currency)}`;
const moneyTone = (value,kind='asset') => value == null ? 'unknown' : Number(value)===0?'neutral':kind==='debt'?(Number(value)>0?'debt':'positive'):Number(value)<0?'negative':'positive';
const moneyFigure = (value,currency,kind='asset') => `<strong class="money-figure ${moneyTone(value,kind)}">${responsiveAmount(value,currency)}</strong>`;
const accountBalance = a => moneyFigure(a.balance?.amount,a.currency,a.subtype==='credit_card'?'debt':'asset')+'<small>'+h(a.subtype==='credit_card'?'Amount owed':a.balance?.source==='balance_check'?'From observed check':a.balance?.source==='opening_balance'?'From known balance':'No balance anchor')+'</small>'+(a.subtype==='credit_card' && a.card_due?'<small class="due-line">Payment due '+(a.card_due.amount==null?'amount not entered':amount(a.card_due.amount,a.currency))+' · '+h(a.card_due.due_date)+'</small>':'');
const field = (label,input) => `<label class="field">${h(label)}${input.replace(/<(input|select|textarea)(?=[ >])/, `<$1 aria-label="${h(label)}"`)}</label>`;
const input = (name,extras='') => `<input name="${name}" ${extras}>`;
const moneyInput = name => input(name,'inputmode="decimal" pattern="[0-9]+(\\.[0-9]+)?" required placeholder="0.00"');
const option = (value,label,selected=false) => `<option value="${h(value)}"${selected?' selected':''}>${h(label)}</option>`;
function defaultTransactionScope() {
  if(familyMode()) return 'family';
  const saved=localStorage.getItem(`finwise-default-scope:${state.me?.user.id}`);
  return saved==='family'?'family':'personal';
}
function lastTransactionAccount() {
  const key=localStorage.getItem(`finwise-last-account:${state.me.user.id}`);
  return state.accounts.some(a=>a.id===key && a.active!==false)?key:null;
}
const accountOptions = selected => state.accounts.filter(a=>a.active!==false).map(a=>option(a.id,`${a.name} · ${a.currency}`,a.id===selected)).join('');
const payerId = t => t.paid_by_user_id || (t.source_refs?.length?state.accounts.find(a=>a.id===t.movements[0]?.account_id)?.owner_id:t.entered_by);
const payerName = t => state.members.find(m=>m.user_id===payerId(t))?.name||'Unknown';
const categoryName = key => categoryView.path(state.categories,key);
const categoryOptions = (kind,selected='',exclude='') => {
  const byId=new Map(state.categories.map(c=>[c.id,c]));
  const wouldCycle=category=>{let current=category;const seen=new Set();while(current && !seen.has(current.id)){if(current.id===exclude)return true;seen.add(current.id);current=byId.get(current.parent_id);}return false;};
  return categoryView.ordered(state.categories,kind).filter(({category})=>category.archived!==true && (!exclude || !wouldCycle(category))).map(({category,depth})=>option(category.id,`${'　'.repeat(depth)}${depth?'↳ ':''}${category.name}`,category.id===selected)).join('');
};
const accountName = key => state.accounts.find(a=>a.id===key)?.name || 'Account';
function localDate() { const now=new Date(); return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`; }
function householdDate() { const parts=Object.fromEntries(new Intl.DateTimeFormat('en',{timeZone:state.me?.household.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(part=>[part.type,part.value]));return `${parts.year}-${parts.month}-${parts.day}`; }
function localDateTime(value) { const date=new Date(value); return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}T${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`; }
function period(month=state.month) { const [y,m]=month.split('-').map(Number); return {from:`${month}-01`,to:`${m===12?y+1:y}-${String(m===12?1:m+1).padStart(2,'0')}-01`}; }
function sipDueDate(sip,month) {
  if(!sip || sip.status!=='active' || month<sip.start_month || (sip.end_month && month>sip.end_month)) return null;
  const [year,number]=month.split('-').map(Number);
  const lastDay=new Date(Date.UTC(year,number,0)).getUTCDate();
  return `${month}-${String(Math.min(sip.day,lastDay)).padStart(2,'0')}`;
}
function investmentMovementActions(record,holding) {
  return (record.transaction_ids||[]).map((movementId,index)=>button(`Edit movement ${index+1}`,'investment-movement-edit',`data-id="${h(holding.id)}" data-movement="${h(movementId)}"`)).join('');
}
function reportQuery(month=state.month) { return new URLSearchParams({...period(month),scope:state.scope,currency:state.me.household.base_currency}).toString(); }
function heading(title,description,actions='') { return `<div class="page-heading"><div><span class="eyebrow">${h(state.me?.household?.name||'MY HOUSEHOLD')} / ${h(state.scope.toUpperCase())}</span><h1>${h(title)}</h1><p>${h(description)}</p></div><div class="heading-actions">${actions}</div></div>`; }
function scopeTabs() { return familyMode()?'':`<div class="analytics-scope-tabs" role="group" aria-label="View scope">${[['personal','Personal'],['family','Family'],['combined','Combined']].map(([scope,label])=>`<button type="button" data-action="analytics-scope" data-scope="${scope}" aria-pressed="${state.scope===scope}" class="${state.scope===scope?'active':''}">${label}</button>`).join('')}</div>`; }
function panel(title,body) { return `<section class="panel live-panel"><h2>${h(title)}</h2>${body}</section>`; }
function table(headers,rows) { return rows.length ? `<div class="table-scroll"><table class="live-table"><thead><tr>${headers.map(v=>`<th>${h(v)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map((v,i)=>`<td data-label="${h(headers[i])}"><div class="cell-value">${v}</div></td>`).join('')}</tr>`).join('')}</tbody></table></div>` : empty('No records yet.'); }
function notify(message) { const toast=document.querySelector('#toast'); toast.textContent=message; toast.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>toast.classList.remove('show'),6000); }
function failure(error,target=root) { const p=document.createElement('p'); p.className='live-error'; p.setAttribute('role','alert'); p.textContent=error.message || 'Could not reach the server. Please retry.'; target.querySelector('.live-error')?.remove(); target.prepend(p); }
function coverage() { return '<p class="helper coverage-note">Recorded data only. Source coverage is unconfirmed; transfers do not count as spending.</p>'; }
async function catalogs() { const [accounts,categories,members]=await Promise.all([api.collection('accounts?include_archived=true'),api.collection('categories?include_archived=true'),api.collection(`households/${id(state.me.household.id)}/members`)]); state.accounts=accounts.data; state.categories=categories.data; state.members=members.data; }
async function allInvestments() {
  return (await api.collection('investments')).data;
}
function saveView() { viewState.save(state.month,state.scope,location.href,path=>history.replaceState(null,'',path),state.transactionFilters); }
function setMonth(value) { state.month=value; if(state.compareMonth===value) { const previous=new Date(`${value}-01T00:00:00Z`);previous.setUTCMonth(previous.getUTCMonth()-1);state.compareMonth=previous.toISOString().slice(0,7);const url=new URL(location.href);url.searchParams.set('compare',state.compareMonth);history.replaceState(null,'',url.pathname+url.search+url.hash); } document.querySelector('#report-month').value=value; saveView(); }
function authForm(bootstrap=false) {
  shell.hidden=true; authRoot.hidden=false; dialog.close(); closeTransactionDrawer();
  authRoot.innerHTML=`<section class="panel auth-card"><a class="brand" href="#overview">finwise.</a><h1>${bootstrap?'Set up your household':'Welcome back'}</h1><p>${bootstrap?'Create the first owner account. Your data stays on this server.':'Sign in to your FinWise account.'}</p><form id="auth-form" data-bootstrap="${bootstrap}">${bootstrap?field('Your name',input('name','required autocomplete="name"')):''}${field('Email',input('email','type="email" required autocomplete="username"'))}${field('Password',input('password',`type="password" required minlength="12" maxlength="1024" autocomplete="${bootstrap?'new-password':'current-password'}"`))}${bootstrap?field('Household name',input('household','required value="My household"'))+field('Timezone',input('timezone',`required value="${h(Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata')}"`))+field('Base currency',input('currency','required value="INR" pattern="[A-Z]{3}"')):''}<button class="primary-button" type="submit">${bootstrap?'Create household':'Sign in'}</button></form></section>`;
}
function inviteToken() { const token=location.hash.startsWith('#join/')?location.hash.slice(6):''; return /^[a-fA-F0-9]{64}$/.test(token)?token:null; }
async function inviteView() {
  shell.hidden=true; authRoot.hidden=false; dialog.close(); closeTransactionDrawer();
  const token=inviteToken();
  if(!token) { authRoot.innerHTML=panel('Invalid invitation',`<p>This invitation link is incomplete.</p><a href="#overview">Go to FinWise</a>`); return; }
  let existing=null;
  try { existing=await api.request('me'); api.setCsrf((await api.request('auth/csrf')).csrf_token); } catch(e) { if(e.status!==401) throw e; }
  authRoot.innerHTML=`<section class="panel auth-card"><a class="brand" href="#overview">finwise.</a><h1>Join a household</h1>${existing?
    `<p>Signed in as ${h(existing.user.email)}. Accept this invitation only if it was sent to that address.</p><form id="invite-accept-form"><button class="primary-button" type="submit">Accept invitation</button></form><form id="invite-signout-form"><button class="outline-button" type="submit">Use another account</button></form>`:
    `<p>Use the email address that received this invitation. Your link expires after one day.</p><form id="invite-register-form">${field('Your name',input('name','required autocomplete="name"'))}${field('Invited email',input('email','type="email" required autocomplete="username"'))}${field('Create password',input('password','type="password" required minlength="12" autocomplete="new-password"'))}<button class="primary-button" type="submit">Create account and join</button></form><details><summary>Already have a FinWise account?</summary><form id="invite-existing-form">${field('Email',input('email','type="email" required autocomplete="username"'))}${field('Password',input('password','type="password" required autocomplete="current-password"'))}<button class="primary-button" type="submit">Sign in and join</button></form></details>`}</section>`;
}
async function signedIn() {
  state.me=await api.request('me'); api.setCsrf((await api.request('auth/csrf')).csrf_token);
  if(familyMode()) state.scope='family';
  syncScopeControl(); saveView();
  await catalogs();
  authRoot.hidden=true; shell.hidden=false;
  document.querySelector('#user-name').textContent=state.me.user.name;
  document.querySelector('#household-name').textContent=state.me.household.name;
  document.querySelector('#household-currency').textContent=[state.me.household.base_currency,state.me.household.timezone].filter(Boolean).join(' · ');
  document.querySelector('.household-icon').textContent=state.me.household.name.split(/\s+/).slice(0,2).map(word=>word[0]||'').join('').toUpperCase();
  document.querySelectorAll('.avatar').forEach(el=>el.textContent=state.me.user.name.split(/\s+/).slice(0,2).map(word=>word[0]||'').join('').toUpperCase());
  renderRoute();
}
async function start() {
  const localHttp=location.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(location.hostname);
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15000);
  try { const status=await api.request('auth/bootstrap-status',{signal:controller.signal}); clearTimeout(timer); if(location.protocol!=='https:' && !localHttp && status.requires_https) {
    shell.hidden=true;authRoot.hidden=false;
    authRoot.innerHTML='<section class="panel auth-card"><h1>Open FinWise over HTTPS</h1><p>This server requires an HTTPS address for household setup and sign-in. Ask the server administrator to enable trusted HTTP access or configure HTTPS, then reload this page.</p></section>';
    return;
  }
    if(status.required) authForm(true); else if(location.hash.startsWith('#join/')) await inviteView(); else { try { await signedIn(); } catch(e) { if(e.status===401) authForm(); else throw e; } } }
  catch(e) { authRoot.innerHTML='<section class="panel auth-card"><h1>FinWise is unavailable</h1><p>Could not complete startup. Check the NAS connection, then reload this page.</p><button class="primary-button" onclick="location.reload()">Retry connection</button></section>'; failure(e.name==='AbortError'?new Error('The FinWise API did not respond within 15 seconds.'):e,authRoot); }
  finally { clearTimeout(timer); }
}
function resetSession() { state.generation++; state.me=null; state.accounts=[]; state.categories=[]; recentTransactions=[]; state.selectedChecks=[]; state.editingTransaction=null; state.preview=[]; state.cleanupPreview=null; state.resetPreview=null; state.resetMonths=null; state.fileInfo=null; state.metadata=null; state.importResult=null; state.session=null; state.ledger=[]; state.observations=[]; state.amendments=[]; state.createdEntries=[]; state.ignoreSelection=null; state.createObservationIds=null; state.transferSelection=null; state.transferCandidates=[]; state.recentMatch=null; state.amendmentGroup=null; state.inviteLink=null; api.reset(); root.replaceChildren(); authForm(); }
window.addEventListener('session-expired',resetSession);
function navigate(view,parts=[]) { const hash=[view,...parts].map(encodeURIComponent).join('/'); if(location.hash.slice(1)===hash) renderRoute(); else location.hash=hash; }
async function loadLedgerBalances(values,allDates=false,extraAccountIds=[]) {
  const ids=[...new Set([...values.flatMap(t=>t.movements.map(m=>m.account_id)),...extraAccountIds])];
  const results=await Promise.all(ids.map(accountId=>api.collection('accounts/'+id(accountId)+'/ledger'+(allDates?'':'?'+new URLSearchParams(period())))));
  state.ledgerBalances=new Map();
  const byAccount=new Map();
  ids.forEach((accountId,i)=>{
    byAccount.set(accountId,results[i].data);
    results[i].data.forEach(row=>{ if(row.transaction_id) state.ledgerBalances.set(accountId+':'+row.transaction_id,row); });
  });
  return byAccount;
}
function balanceLabel(row) { return row?.balance_source==='balance_check'?'from observed check':row?.balance_source==='opening_balance'?'from known balance':'no balance anchor'; }
function groupBalanceLabel(row,accountId) {
  if(!row || row.same_time_count<=1) return '';
  if(row.same_time_group_movement==null) return ' · after '+row.same_time_count+' entries at the same time';
  const account=state.accounts.find(a=>a.id===accountId);
  const card=account?.subtype==='credit_card';
  const change=card?analyticsView.negate(row.same_time_group_movement):row.same_time_group_movement;
  return ' · after '+row.same_time_count+' entries at the same time (combined '+(card?'amount owed':'balance')+' change '+amount(change,row.currency)+')';
}

function transactionIndicators(t) { const tracked=t.movements.some(m=>['bank','credit_card'].includes(state.accounts.find(a=>a.id===m.account_id)?.subtype));return `<span class="transaction-indicators">${tracked?`<span class="transaction-indicator ${h(t.reconciliation_state)}">${h(t.reconciliation_state==='matched'?'Reconciled':t.reconciliation_state==='partial'?'Partly reconciled':'Not reconciled')}</span>`:''}${t.amendment?`<span class="transaction-indicator amended">Amended · ${t.money_manager_synced_at?'updated in Money Manager':'update Money Manager'}</span>`:''}${t.reconciliation_created?`<span class="transaction-indicator created">${t.money_manager_synced_at?'Updated in Money Manager':t.reconciliation_created.action==='update_transfer'?'Internal transfer · update Money Manager':'Created from statement · add to Money Manager'}</span>`:''}</span>`; }
function transactionFeed(entries) {
  let lastDate='';
  const rows=entries.map(entry=>{
    const t=entry.transaction;
    const date=t?.effective_date || entry.row.effective_at.slice(0,10);
    const group=date!==lastDate?`<div class="tx-date-group"><time datetime="${h(date)}">${h(new Date(`${date}T00:00:00`).toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short',year:'numeric'}))}</time></div>`:'';
    lastDate=date;
    if(!t) {
      const {account,row}=entry;
      const opening=entry.kind==='opening_balance';
      const observed=opening?account.opening_balance?.amount:row.observed_amount;
      const title=opening?'Starting balance':'Balance check';
      return `${group}<details class="tx-expand tx-anchor"><summary class="tx-scan-row" aria-label="${h(title)} for ${h(account.name)} on ${h(date)}. Expand balance details"><span class="tx-scan-icon" aria-hidden="true"><svg class="icon"><use href="#i-wallet"/></svg></span><span class="tx-scan-content"><span class="tx-scan-primary"><strong>${title}</strong><b class="tx-scan-amount">${amount(observed,account.currency)}</b></span><span class="tx-scan-secondary">${h(account.name)} · ${opening?'Opening':'Observed check'}</span></span><span class="tx-expand-chevron" aria-hidden="true">⌄</span></summary><div class="tx-quick-breakdown"><p class="tx-expanded-description">${h(account.name)} · ${title}</p>${opening?'<p class="tx-quick-note">Known opening balance.</p>':`<div class="tx-quick-line"><span>Calculated from start</span><b>${amount(row.computed_from_start,account.currency)}</b></div><div class="tx-quick-line"><span>Difference</span><b>${amount(row.computed_from_start==null?null:analyticsView.difference(observed,row.computed_from_start),account.currency)}</b></div>`}<div class="tx-quick-footer">${button('Account ledger','account-ledger',`data-id="${h(account.id)}"`)}</div></div></details>`;
    }
    const scale=new Intl.NumberFormat('en',{style:'currency',currency:t.currency}).resolvedOptions().maximumFractionDigits;
    const scoped=['transfer','investment','investment_withdrawal'].includes(t.event_type)?t.amount:analyticsView.sumMoney(t.allocations.map(a=>a.amount),scale);
    const signed=`${t.event_type==='income'||t.event_type==='refund'||t.event_type==='investment_withdrawal'?'+ ':t.event_type==='expense'||t.event_type==='investment'?'− ':t.event_type==='transfer'?'↔ ':''}${amount(scoped,t.currency)}`;
    const accountNames=[...new Set(t.movements.map(m=>accountName(m.account_id)))].join(t.event_type==='transfer'?' ↔ ':' · ');
    const scopes=['transfer','investment','investment_withdrawal'].includes(t.event_type)?'No budget allocation':([...new Set(t.allocations.map(a=>a.scope))].map(s=>s==='family'?'Family':'Personal').join(' + ')||'No allocation');
    const author=t.entered_by===state.me.user.id?'You':state.members.find(m=>m.user_id===t.entered_by)?.name||'Household member';
    const review=t.amendment&&!t.money_manager_synced_at?'Update Money Manager':t.reconciliation_created&&!t.money_manager_synced_at?'Add to Money Manager':t.reconciliation_state==='matched'?'Reconciled':t.reconciliation_state==='partial'?'Partly reconciled':'Not reconciled';
    const movements=t.movements.map(m=>{const balance=state.ledgerBalances.get(`${m.account_id}:${t.id}`);return `<div class="tx-quick-line"><span>${h(accountName(m.account_id))}<small>${h(balanceLabel(balance))}</small></span><b>${amount(m.amount,t.currency)}<small>After ${amount(balance?.balance_after,t.currency)}</small></b></div>`;}).join('');
    const allocations=['transfer','investment','investment_withdrawal'].includes(t.event_type)?'<p class="tx-quick-note">This movement does not count as spending.</p>':t.allocations.map(a=>`<div class="tx-quick-line"><span>${h(categoryName(a.category_id))}<small>${h(a.scope)}</small></span><b>${amount(a.amount,t.currency)}</b></div>`).join('')||'<p class="tx-quick-note">No allocations recorded.</p>';
    return `${group}<details class="tx-expand"><summary class="tx-scan-row ${h(t.event_type)}" aria-label="${h(t.description||'Untitled')}, ${h(date)}, ${h(t.event_type)}, ${h(accountNames)}, ${h(signed)}, ${h(scopes)}, ${h(review)}. Expand quick breakdown"><span class="tx-scan-icon" aria-hidden="true"><svg class="icon"><use href="#${t.event_type==='transfer'?'i-arrow':t.event_type==='income'||t.event_type==='refund'?'i-chart':'i-receipt'}"/></svg></span><span class="tx-scan-content"><span class="tx-scan-primary"><strong title="${h(t.description||'Untitled')}">${h(t.description||'Untitled')}</strong><b class="tx-scan-amount">${signed}</b></span><span class="tx-scan-secondary"><span>${h(accountNames)} · ${h(t.event_type)}</span></span><span class="tx-scan-context"><span>${h(scopes)} · ${h(author)}</span><span class="tx-review ${review==='Reconciled'?'':'unresolved'}">${h(review)}</span></span></span><span class="tx-expand-chevron" aria-hidden="true">⌄</span></summary><div class="tx-quick-breakdown"><p class="tx-expanded-description">${h(t.description||'Untitled')}</p><div class="tx-quick-facts"><div><span>Total transaction</span><b>${amount(t.amount,t.currency)} · ${h(t.event_type)}</b></div><div><span>Recorded by</span><b>${h(author)} · ${h(date)}</b></div></div><div class="tx-quick-section"><span class="tx-quick-label">Account movements</span>${movements}</div><div class="tx-quick-section"><span class="tx-quick-label">${t.event_type==='transfer'?'Allocation':'Budget allocations'}</span>${allocations}</div><div class="tx-quick-footer"><span>${h(review)}<small>${h(scopes)}${['expense','refund'].includes(t.event_type)?` · Paid by ${h(payerName(t))}`:''}</small></span>${button('Full details & edit','transaction-detail',`data-id="${h(t.id)}"`)}</div></div></details>`;
  }).join('');
  return `<div class="tx-feed">${rows}</div>`;
}
function transactionTable(values,balanceEvents=[],accountFilter='') {
  const entries=activityView.timeline(values,balanceEvents,state.ledgerBalances,accountFilter);
  const mobile=window.matchMedia('(max-width:600px)').matches;
  const rows=entries.map(entry=>{
    if(entry.kind!=='transaction') {
      const {account,row}=entry;
      const opening=entry.kind==='opening_balance';
      const observed=opening?account.opening_balance?.amount:row.observed_amount;
      const variance=!opening && observed!=null && row.computed_from_start!=null?analyticsView.difference(observed,row.computed_from_start):null;
      const varianceClass=variance==null?'unknown':Number(variance)===0?'positive':'negative';
      return [
        '<time datetime="'+h(row.effective_at)+'">'+h(new Date(row.effective_at).toLocaleDateString('sv-SE'))+'</time><small>'+h(new Date(row.effective_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}))+'</small>',
        '<div class="activity-title"><strong>'+(opening?'Starting balance':'Balance check')+'</strong><span class="activity-type">'+(opening?'Start':'Check')+'</span></div><small>'+h(opening?'Known opening balance':row.description.replace(/^Balance check · /,''))+'</small>',
        '<span class="activity-account-name">'+h(account.name)+'</span>'+(opening?'':'<small>Calculated '+amount(row.computed_from_start,account.currency)+'</small>'),
        '<span class="activity-amount">'+amount(observed,account.currency)+'</span>'+(opening?'':'<small class="balance-variance '+varianceClass+'">Difference '+amount(variance,account.currency)+'</small>'),
        button('Account ledger','account-ledger','data-id="'+h(account.id)+'"')
      ];
    }
    const t=entry.transaction;
    const scale=new Intl.NumberFormat('en',{style:'currency',currency:t.currency}).resolvedOptions().maximumFractionDigits;
    const scopedAmount=['transfer','investment','investment_withdrawal'].includes(t.event_type)?t.amount:analyticsView.sumMoney(t.allocations.map(a=>a.amount),scale);
    const when=t.effective_at?h(new Date(t.effective_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})):'10:00 AM · assumed';
    const category=t.allocations.map(a=>h(categoryName(a.category_id))).join(', ');
    const accounts=t.movements.map(m=>{
      const row=state.ledgerBalances.get(m.account_id+':'+t.id);
      const account=state.accounts.find(a=>a.id===m.account_id);
      const canCheck=state.view==='transactions' && row && account?.subtype!=='settle_up';
      const after=row?'Balance after · '+amount(row.balance_after,row.currency):'Balance unknown';
      const group=row?.same_time_count>1?'<small class="activity-grouped">'+h(row.same_time_count)+' entries at this time'+(row.same_time_group_movement==null?'':' · combined '+amount(account?.subtype==='credit_card'?analyticsView.negate(row.same_time_group_movement):row.same_time_group_movement,row.currency))+'</small>':'';
      const detail=row?'<details class="activity-account-detail"><summary>'+after+'</summary><div>'+group+h(balanceLabel(row))+(canCheck?'<div>'+button('Check after','transaction-balance-after','data-account="'+h(m.account_id)+'" data-id="'+h(t.id)+'"')+'</div>':'')+'</div></details>':'<small>'+after+'</small>';
      return '<div class="activity-account"><span class="activity-account-name">'+h(accountName(m.account_id))+'</span>'+detail+'</div>';
    }).join('');
    const accountCell=mobile?'<details class="activity-accounts"><summary>'+t.movements.map(m=>h(accountName(m.account_id))).join(t.event_type==='transfer'?' ↔ ':' · ')+'</summary><div>'+accounts+'</div></details>':accounts;
    const meta=mobile?'<div class="activity-meta">'+(category&&t.event_type!=='transfer'?'<small>'+category+'</small>':'')+transactionIndicators(t)+'</div>':'<div class="activity-meta"><small>'+(category||(['investment','investment_withdrawal'].includes(t.event_type)?'Investment':'Uncategorized'))+' · '+(t.allocations?.length?([...new Set(t.allocations.map(a=>a.scope))].map(scope=>scope==='family'?'Family':'Personal').join(' / ')+' · '):'')+(['expense','refund'].includes(t.event_type)?('Paid by '+h(payerName(t))+' · '):'')+'Entered by '+(t.entered_by===state.me.user.id?'you':'household member')+'</small>'+transactionIndicators(t)+'</div>';
    return [
      '<time datetime="'+h(t.effective_date)+'">'+h(t.effective_date)+'</time><small>'+when+'</small>',
      '<div class="activity-title"><strong>'+h(t.description || 'Untitled')+'</strong><span class="activity-type">'+h(t.event_type)+'</span></div>'+meta,
      accountCell,
      '<span class="activity-amount">'+(t.event_type==='income'||t.event_type==='refund'||t.event_type==='investment_withdrawal'?'+ ':t.event_type==='expense'||t.event_type==='investment'?'− ':t.event_type==='transfer'?'↔ ':'')+amount(scopedAmount,t.currency)+'</span>',
      button('Details','transaction-detail','data-id="'+h(t.id)+'"')
    ];
  });
  return rows.length?'<div class="tx-desktop"><div class="table-scroll activity-table-wrap"><table class="live-table activity-table"><thead><tr><th>Date</th><th>Activity</th><th>Account</th><th>Amount</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>'+rows.map((row,i)=>'<tr class="'+(entries[i].kind==='transaction'?'activity-'+(['income','expense','refund','transfer'].includes(entries[i].transaction.event_type)?entries[i].transaction.event_type:'other'):'activity-marker-row')+'">'+row.map((cell,j)=>'<td data-label="'+['Date','Activity','Account','Amount','Actions'][j]+'">'+cell+'</td>').join('')+'</tr>').join('')+'</tbody></table></div></div><div class="tx-mobile">'+transactionFeed(entries)+'</div>':empty('No activity yet.');
}
async function renderRoute() {
  if(!state.me) return;
  const generation=++state.generation;
  const routeKey=location.hash||'#overview';
  const routeChanged=routeKey!==previousRoute;
  previousRoute=routeKey;
  const parts=location.hash.slice(1).split('/').map(v=>decodeURIComponent(v));
  const view=labels[parts[0]]?parts[0]:'overview'; state.view=view;
  if(view!=='transactions')closeTransactionDrawer();
  shell.dataset.activeView=view;
  document.querySelector('#breadcrumb-current').textContent=labels[view];
  document.querySelectorAll('.sidebar [data-view], .bottom-nav [data-view]').forEach(el=>{
    const active=el.dataset.view===view || (el.closest('.bottom-nav') && el.dataset.view==='more' && !['overview','transactions','budgets'].includes(view));
    el.classList.toggle('active',active);
    if(active) el.setAttribute('aria-current','page'); else el.removeAttribute('aria-current');
  });
  root.querySelectorAll('canvas[data-chart]').forEach(canvas=>window.Chart?.getChart(canvas)?.destroy());
  root.setAttribute('aria-busy','true');
  root.innerHTML='<div class="route-loading"><p class="route-loading-copy" role="status">Loading '+h(labels[view])+'…</p><div class="route-loading-head" aria-hidden="true"></div><div class="route-loading-grid" aria-hidden="true"><div class="route-loading-card"></div><div class="route-loading-card"></div><div class="route-loading-card"></div></div></div>';
  try {
    await catalogs();
    const html=await views[view](parts.slice(1),generation);
    if(generation!==state.generation || !state.me) return;
    root.innerHTML=html; analyticsView.hydrateCharts(root); subscriptionBrands.hydrate(root); root.focus({preventScroll:true});
    root.removeAttribute('aria-busy');
    const account=view==='accounts'?state.accounts.find(a=>a.id===parts[1]):null;
    document.querySelector('#breadcrumb-current').textContent=account?.name||labels[view];
    document.title=`${account?account.name+' · ':''}${labels[view]} · FinWise`;
    if(routeChanged) window.scrollTo({top:0,behavior:'instant'});
    if(view==='reconcile') updateMatchComparison();
  } catch(e) { if(generation===state.generation && state.me) { root.removeAttribute('aria-busy'); root.innerHTML=heading(labels[view],'Could not load this view.',button('Retry','refresh')); failure(e); } }
}
async function loadBulkScopePanel(panel) {
  if(!panel.open || panel.dataset.loaded || panel.dataset.loading) return;
  const content=panel.querySelector('#bulk-scope-content');
  panel.dataset.loading='true';
  content.innerHTML='<p role="status">Loading eligible transactions…</p>';
  try {
    const fullHistory=await api.collection('transactions');
    if(!panel.isConnected) return;
    const movable=fullHistory.data.filter(t=>t.voided!==true && t.entered_by===state.me.user.id && t.allocations?.some(a=>a.scope==='personal'));
    panel.querySelector('summary').textContent=`Move transactions to Family · ${movable.length} eligible`;
    content.innerHTML=`<p class="helper">Choose transactions from all dates and accounts, then move their allocations to Family. Transfers have no scope. Balances and source records stay the same.</p>${movable.length?`<form id="bulk-scope-form"><label class="confirm-line"><input type="checkbox" id="bulk-scope-all"> Select all ${movable.length} personal transactions</label><div class="table-scroll"><table class="live-table"><thead><tr><th>Select</th><th>Date</th><th>Transaction</th><th>Amount</th></tr></thead><tbody>${movable.map(t=>`<tr><td><input type="checkbox" name="transaction_id" value="${h(t.id)}" aria-label="Select ${h(t.description||'transaction')}"></td><td>${h(t.effective_date)}</td><td>${h(t.description||'Untitled')}</td><td>${amount(t.amount,t.currency)}</td></tr>`).join('')}</tbody></table></div><button type="submit" class="primary-button">Move selected to Family</button></form>`:empty('No personal transactions remain.')}`;
    panel.dataset.loaded='true';
  } catch(error) { if(panel.isConnected) failure(error,content); }
  finally { delete panel.dataset.loading; }
}
async function reconciliationComparison(session) {
  const path=`reconciliation/sessions/${id(session.id)}`;
  const [ledger,statement]=await Promise.all([api.collection(`${path}/items?side=ledger`),api.collection(`${path}/items?side=statement`)]);
  const [amendments,matches,created]=await Promise.all([api.collection(`${path}/amendments`),api.collection(`${path}/matches`),api.collection(`${path}/created-ledger-entries`)]);
  state.session=session; state.ledger=ledger.data; state.observations=statement.data; state.amendments=amendments.data; state.createdEntries=created.data;
  if(!state.recentMatch || state.recentMatch.sessionId!==session.id) {
    const match=[...matches.data].reverse().find(v=>{
      if(v.state!=='accepted' || !v.allocations?.length) return false;
      const observationIds=[...new Set(v.allocations.map(a=>a.observation_id))];
      const ledgerIds=[...new Set(v.allocations.map(a=>a.ledger_id))];
      return observationIds.some(key=>statement.data.find(o=>o.id===key)?.state==='partial') || ledgerIds.some(key=>ledger.data.find(l=>l.id===key)?.state==='partial');
    });
    state.recentMatch=match?{sessionId:session.id,ledgerIds:[...new Set(match.allocations.map(a=>a.ledger_id))],observationIds:[...new Set(match.allocations.map(a=>a.observation_id))]}:null;
  }
  const available=items=>items.filter(v=>v.state==='unmatched' || v.state==='partial');
  const select=(name,items,label)=>`<div class="recon-picker" role="group" aria-label="${h(label)}">${items.map(v=>`<label class="recon-pick"><input type="checkbox" name="${name}" value="${h(v.id)}"><span class="recon-pick-content"><span class="recon-pick-metrics"><strong class="recon-pick-amount">${amount(v.remaining,v.currency)}</strong><time class="recon-pick-date" datetime="${h(v.effective_date)}">${h(v.effective_date)}</time></span><span class="recon-pick-description">${h(v.description || 'Entry')}</span><small class="recon-pick-state">${h(v.state)}</small></span></label>`).join('')||empty('No unmatched rows.')}</div>`;
  const marked=(items,side)=>items.filter(v=>v.state==='matched').map(v=>`<li>${h(v.effective_date)} · ${h(v.description || 'Entry')} · ${amount(v.amount,v.currency)} <strong>Matched</strong>${side==='ledger' && !['transfer','investment','investment_withdrawal'].includes(v.event_type) && session.state==='open'?button('Make internal transfer','convert-matched-transfer',`data-id="${h(v.id)}"`):''}</li>`).join('');
  const ignored=items=>items.filter(v=>v.state==='ignored').map(v=>`<li>${h(v.effective_date)} · ${h(v.description || 'Entry')} · ${amount(v.amount,v.currency)} <strong>Ignored</strong><small>${h(v.ignore_reason||'')}</small>${session.state==='open'?button('Restore','restore-ignored',`data-id="${h(v.ignore_id)}"`):''}</li>`).join('');
  return panel(`${accountName(session.account_id)} · ${session.month} comparison`,
    `<p class="helper">${h(session.current?.ledger_unmatched_count || 0)} ledger entries and ${h(session.current?.observation_unmatched_count || 0)} statement rows still need matching. Run exact matching to attach unique same-date, same-amount pairs.</p>`+
    (session.state==='open' && available(ledger.data).length && available(statement.data).length?button('Run exact matching','auto-match',`data-id="${h(session.id)}"`):'')+
    (ledger.data.length || statement.data.length?`<form id="match-form"><div class="reconcile-workspace"><div class="reconcile-side"><h3>Ledger transactions</h3>${select('ledger',available(ledger.data),'Select ledger transactions')}<ul class="matched-items">${marked(ledger.data,'ledger')}${ignored(ledger.data)}</ul></div><div class="reconcile-side"><h3>Bank statement</h3>${select('observation',available(statement.data),'Select statement rows')}<ul class="matched-items">${marked(statement.data,'statement')}${ignored(statement.data)}</ul></div><aside class="reconcile-attachment" aria-label="Selected transaction attachment"><h3>Attachment preview</h3><div class="reconcile-choice"><p id="match-comparison" class="helper" role="status">Select one or more rows on each side to compare and attach.</p><div id="match-allocation-preview" class="match-allocation-preview" hidden></div><div id="match-difference" class="match-difference" hidden></div>${session.state==='open'?'<button type="submit" class="primary-button" disabled>Attach selected transactions</button>'+button('Apply amendment to FinWise','save-amendment','id="amendment-option" hidden')+button('Create from statement','create-from-statement','id="create-option" hidden')+button('Mark as internal transfer','mark-internal-transfer','id="transfer-option" hidden')+button('Ignore selected rows','ignore-selected','id="ignore-option" hidden'):''}</div></aside></div></form>`:empty('No ledger or statement rows in this month.'))+
    `<p class="helper">An applied amendment changes FinWise balances and analytics. The original value and source reference stay in the amendment record for updating Money Manager.</p>`+
    `<h3>Saved amendments (${amendments.data.length})</h3>`+
    (amendments.data.length?(amendments.data.some(v=>v.status==='pending_money_manager_update')?button('Download amendments CSV','download-amendments'):'')+table(['Transaction','Original movement','Amended movement','Difference','Status',''],amendments.data.map(v=>[`${h(v.original_date)} · ${h(v.description)}`,amount(v.original_movement,v.currency),amount(v.proposed_movement,v.currency),amount(v.difference,v.currency),h(v.stale?'Transaction changed again · review amendment':v.status),v.status==='pending_money_manager_update' && session.state==='open' && !v.applied_transaction_revision?button('Cancel','cancel-amendment',`data-id="${h(v.id)}" data-revision="${h(v.revision)}"`):''])):empty('No amendments saved for this session.'))+
    `<h3>Money Manager changes from reconciliation (${created.data.length})</h3>`+
    (created.data.length?(created.data.some(t=>!t.voided && !t.money_manager_synced_at)?button('Download Money Manager changes CSV','download-created'):'')+table(['Date','Description','Amount','Statement rows','Status'],created.data.map(t=>[h(t.effective_date),h(t.description),amount(t.amount,t.currency),h(t.reconciliation_created?.observation_ids?.length||0),t.voided?'Voided':t.money_manager_synced_at?'Updated in Money Manager':`${t.reconciliation_created?.action==='update_transfer'?'Update transfer':'Add transaction'} in Money Manager${t.reconciliation_state!=='matched'?' · other leg open':''}`])):empty('No transactions created or converted in this review.'))+
    `<p class="helper">Matching marks evidence only. It does not change account balances.${statement.data.length?'':' Import a bank statement to compare transactions.'}</p>`);
}
function selectedComparison() {
  const form=document.querySelector('#match-form');
  if(!form) return null;
  const formData=new FormData(form);
  return {ledger:formData.getAll('ledger').map(key=>state.ledger.find(v=>v.id===key)).filter(Boolean),observations:formData.getAll('observation').map(key=>state.observations.find(v=>v.id===key)).filter(Boolean)};
}
function amendmentGroupFromRecent() {
  const recent=state.recentMatch;
  if(!recent || recent.sessionId!==state.session?.id) return null;
  const ledger=recent.ledgerIds.map(key=>state.ledger.find(v=>v.id===key)).filter(Boolean);
  const observations=recent.observationIds.map(key=>state.observations.find(v=>v.id===key)).filter(Boolean);
  return ledger.length===recent.ledgerIds.length && observations.length===recent.observationIds.length && [...ledger,...observations].some(v=>v.state==='partial')?{ledger,observations}:null;
}
function openAmendmentGroup(group,attached=false) {
  const {ledger,observations}=group;
  const plan=amendmentPlan(ledger,observations,attached?'amount':'remaining');
  if(plan.error || (!attached && plan.minor(plan.difference)===0n && !(ledger.length===1 && observations.length===1 && ledger[0].effective_date!==observations[0].effective_date))) throw new Error(plan.error || 'There is no difference to amend.');
  state.amendmentGroup={ledgerIds:ledger.map(v=>v.id),observationIds:observations.map(v=>v.id),attached};
  const rows=ledger.map((v,i)=>`<div class="amendment-allocation"><strong>${h(v.description || 'Transaction')}</strong><small>${h(v.effective_date)} · current ${amount(v.amount,v.currency)}</small>${field('Amended signed movement',input(`proposed_${i}`,`value="${h(plan.proposed[i])}" required inputmode="decimal"`))}${field('Amended date',input(`date_${i}`,`type="date" value="${h(ledger.length===1 && observations.length===1?observations[0].effective_date:v.effective_date)}" required`))}${field('Statement evidence',`<select name="observation_${i}">${observations.map(o=>option(o.id,`${o.effective_date} · ${o.description || 'Statement row'} · ${o.amount}`)).join('')}</select>`)}</div>`).join('');
  editor('Apply FinWise amendment',`<p>Selected difference: ${amount(plan.difference,plan.currency)}. The first transaction is prefilled with the full difference. Change the amounts to split it across transactions; their combined adjustment must equal this difference.</p>${ledger.length>1?field('Put the full difference on',`<select id="amendment-target">${ledger.map((v,i)=>option(String(i),`${v.description || 'Transaction'} · ${v.amount}`)).join('')}</select>`):''}<div class="amendment-allocations">${rows}</div>${field('Why is this amendment needed?',input('reason','required maxlength="500"'))}<p class="helper">Only changed transactions create amendments. FinWise balances and analytics use the amended amounts; original values remain in the Money Manager export.${attached?' Existing attachments involving an amended transaction will be released; attach the refreshed rows afterward.':''}</p>`,'amendment-form','Apply amendment');
}
function updateMatchComparison() {
  const form=document.querySelector('#match-form'); if(!form) return;
  const {ledger,observations}=selectedComparison(), comparison=form.querySelector('#match-comparison'), difference=form.querySelector('#match-difference'), preview=form.querySelector('#match-allocation-preview'), amendment=form.querySelector('#amendment-option'),create=form.querySelector('#create-option'),transfer=form.querySelector('#transfer-option'),ignore=form.querySelector('#ignore-option'),submit=form.querySelector('[type="submit"]');
  state.proposedAllocations=[];
  const statementTotal=observations.length?sumSignedRows(observations):null;
  if(create) create.hidden=!(observations.length && !ledger.length && !statementTotal.error && state.session?.state==='open');
  if(transfer) transfer.hidden=!(ledger.length<=1 && observations.length<=1 && (ledger.length || observations.length) && [...ledger,...observations].every(v=>v.state==='unmatched') && (!ledger.length || !observations.length || ledger[0].amount===observations[0].amount) && state.accounts.some(a=>a.id!==state.session?.account_id && a.active!==false && a.currency===state.session?.currency) && state.session?.state==='open');
  if(ignore) ignore.hidden=!([...ledger,...observations].length && [...ledger,...observations].every(v=>v.state==='unmatched') && state.session?.state==='open');
  if(!ledger.length || !observations.length) {
    const recent=amendmentGroupFromRecent();
    const plan=recent && amendmentPlan(recent.ledger,recent.observations,'amount');
    comparison.textContent=observations.length && !ledger.length?statementTotal.error || `${observations.length} statement row${observations.length===1?'':'s'} selected (${statementTotal.currency} ${statementTotal.total}). Create one tagged transaction or ignore the selection.`:ledger.length?`${ledger.length} ledger row${ledger.length===1?'':'s'} selected. Select statement evidence to attach, or ignore the ledger selection.`:plan && !plan.error && plan.minor(plan.difference)!==0n?`The last attachment left ${plan.currency} ${plan.difference}. Amend the attached group, then attach the refreshed remaining rows.`:'Select one or more rows on each side to compare and attach.';
    difference.hidden=true; preview.hidden=true;
    if(amendment) {amendment.hidden=!(plan && !plan.error && plan.minor(plan.difference)!==0n && state.session?.state==='open');amendment.textContent='Amend last attached group';}
    if(submit)submit.disabled=true; return;
  }
  const group=matchAllocations(ledger,observations);
  if(group.error) {comparison.textContent=group.error;difference.hidden=true;preview.hidden=true;if(amendment)amendment.hidden=true;if(submit)submit.disabled=true;return;}
  state.proposedAllocations=group.allocations;
  comparison.textContent=`${ledger.length} ledger row${ledger.length===1?'':'s'} (${group.currency} ${group.ledgerTotal}) and ${observations.length} statement row${observations.length===1?'':'s'} (${group.currency} ${group.statementTotal}). ${group.allocations.length} link${group.allocations.length===1?'':'s'} will attach ${group.currency} ${group.matchedTotal}.${group.allocations.length>200?' Select a smaller group; one decision allows up to 200 links.':''}`;
  preview.hidden=false;
  preview.innerHTML=`<strong>Proposed links</strong><ul>${group.allocations.map(link=>{const left=ledger.find(v=>v.id===link.ledger_id),right=observations.find(v=>v.id===link.observation_id);return `<li>${h(left.description || left.effective_date)} → ${h(right.description || right.effective_date)} · ${amount(link.amount,group.currency)}</li>`;}).join('')}</ul>`;
  const single=ledger.length===1 && observations.length===1;
  const amountDiff=single && ledger[0].amount!==observations[0].amount;
  const dateDiff=single && ledger[0].effective_date!==observations[0].effective_date;
  difference.hidden=!(group.hasDifference || amountDiff || dateDiff);
  if(!difference.hidden) difference.textContent=`${group.hasDifference?`Selected total difference: ${group.currency} ${group.difference}. Unmatched remainder stays open. `:''}${dateDiff?`Ledger date ${ledger[0].effective_date}; statement date ${observations[0].effective_date}. `:''}${single&&observations[0].reference?`Statement ref ${observations[0].reference}. `:''}${amountDiff?'You can amend the FinWise transaction and retain its original value for Money Manager.':''}`;
  if(amendment) {amendment.hidden=!(group.hasDifference || dateDiff) || state.session?.state!=='open';amendment.textContent='Amend selected transactions';}
  if(submit)submit.disabled=!group.allocations.length || group.allocations.length>200;
}
async function refreshReconciliationComparison(preferred=null) {
  const host=document.querySelector('#reconcile-comparison'); if(!host || !state.session) return;
  const old=document.querySelector('#match-form');
  const selection=old?{ledger:preferred?.ledger||[...old.querySelectorAll('[name="ledger"]:checked')].map(v=>v.value),observation:preferred?.observation||[...old.querySelectorAll('[name="observation"]:checked')].map(v=>v.value),ledgerScroll:old.querySelector('[aria-label="Select ledger transactions"]')?.scrollTop||0,observationScroll:old.querySelector('[aria-label="Select statement rows"]')?.scrollTop||0}:null;
  const scrollY=window.scrollY;
  const session=await api.request(`reconciliation/sessions/${id(state.session.id)}`);
  host.innerHTML=await reconciliationComparison(session);
  const current=document.querySelector('#match-form');
  if(current && selection) for(const name of ['ledger','observation']) {
    const values=new Set(selection[name]);
    const controls=[...current.querySelectorAll(`[name="${name}"]`)];
    for(const control of controls) control.checked=values.has(control.value);
    const picker=current.querySelector(name==='ledger'?'[aria-label="Select ledger transactions"]':'[aria-label="Select statement rows"]');
    if(picker)picker.scrollTop=selection[`${name}Scroll`];
  }
  updateMatchComparison(); window.scrollTo(0,scrollY);
}
function downloadAmendments() {
  const headers=['amendment_id','status','transaction_changed_since_proposal','account','ledger_transaction_id','statement_observation_id','date_original','date_proposed','description','currency','amount_original','amount_proposed','signed_movement_original','signed_movement_proposed','signed_difference','source_refs_json','statement_reference','reason'];
  const safe=value=>{let raw=String(value??'');if(/^[=+@]/.test(raw)||/^-(?!\d+(?:\.\d+)?$)/.test(raw))raw=`'${raw}`;return `"${raw.replaceAll('"','""')}"`;};
  const rows=state.amendments.filter(v=>v.status==='pending_money_manager_update').map(v=>[v.id,v.status,v.stale?'yes':'no',accountName(v.account_id),v.ledger_id,v.observation_id,v.original_date,v.proposed_date,v.description,v.currency,v.original_transaction_amount,v.proposed_transaction_amount,v.original_movement,v.proposed_movement,v.difference,JSON.stringify(v.source_refs||[]),v.statement_reference,v.reason]);
  const csv=[headers,...rows].map(row=>row.map(safe).join(',')).join('\r\n')+'\r\n';
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download=`finwise-amendments-${state.session.month}.csv`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function downloadCreated() {
  const safe=value=>{let raw=String(value??'');if(/^[=+@]/.test(raw)||/^-(?!\d+(?:\.\d+)?$)/.test(raw))raw=`'${raw}`;return `"${raw.replaceAll('"','""')}"`;};
  const headers=['action','status','reconciliation_state','finwise_transaction_id','account','other_account','date','description','type','original_type','amount','currency','signed_movement','scope','category','statement_observation_ids','statement_source_refs_json','money_manager_source_refs_json','reason'];
  const rows=state.createdEntries.filter(t=>!t.voided && !t.money_manager_synced_at).map(t=>[t.reconciliation_created?.action||'add_transaction',t.reconciliation_created?.status,t.reconciliation_state,t.id,accountName(t.reconciliation_created.account_id),t.event_type==='transfer'?t.movements.filter(m=>m.account_id!==t.reconciliation_created.account_id).map(m=>accountName(m.account_id)).join('; '):'',t.effective_date,t.description,t.event_type,t.reconciliation_created?.original_event_type||'',t.amount,t.currency,t.movements.find(m=>m.account_id===t.reconciliation_created.account_id)?.amount,t.allocations[0]?.scope,t.allocations[0]?.category_id?categoryName(t.allocations[0].category_id):'',JSON.stringify(t.reconciliation_created.observation_ids||[]),JSON.stringify(t.reconciliation_created.statement_source_refs||t.source_refs||[]),JSON.stringify(t.reconciliation_created.action==='update_transfer'?t.source_refs||[]:[]),t.reconciliation_created.reason]);
  const url=URL.createObjectURL(new Blob([[headers,...rows].map(row=>row.map(safe).join(',')).join('\r\n')+'\r\n'],{type:'text/csv;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download=`finwise-money-manager-changes-${state.session.month}.csv`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function createFromStatementEditor() {
  const selected=selectedComparison();
  if(!selected || selected.ledger.length || !selected.observations.length) return;
  const total=sumSignedRows(selected.observations);
  if(total.error) throw new Error(total.error);
  state.createObservationIds=selected.observations.map(v=>v.id);
  const first=selected.observations[0];
  const description=selected.observations.length===1?first.description||'Statement transaction':`Grouped statement entries (${selected.observations.length})`;
  editor('Create transaction from statement',`<p>${selected.observations.length} statement row${selected.observations.length===1?'':'s'} → one ${h(total.eventType)} of ${amount(total.total,total.currency)}. The rows will be attached to the new transaction.</p>${field('Description',input('description',`required maxlength="300" value="${h(description)}"`))}${field('Date',input('effective_date',`type="date" required value="${h(first.effective_date)}"`))}${field('Category',`<select name="category_id">${option('','Uncategorized')}${categoryOptions(total.eventType)}</select>`)}${scopeField()}${field('Why is this missing from Money Manager?',input('reason','required maxlength="500"'))}<p class="helper">FinWise balances and analytics will include the new transaction. It will be tagged for the Money Manager additions export.</p>`,'create-statement-form','Create and attach');
}
function updateTransferCounterparts(preferred='') {
  const accountId=dialog.querySelector('#transfer-destination')?.value;
  const select=dialog.querySelector('#transfer-counterpart');if(!select)return;
  const candidates=(state.transferCandidates||[]).filter(v=>v.account_id===accountId);
  select.innerHTML=option('','No destination statement row yet')+candidates.map(v=>option(v.observation_id,`${v.effective_date} · ${v.description || 'Statement row'} · ${v.amount}`,v.observation_id===preferred)).join('');
  if(preferred && candidates.some(v=>v.observation_id===preferred))select.value=preferred;
}
async function internalTransferEditor(forcedLedgerId=null) {
  const selected=typeof forcedLedgerId==='string'?{ledger:state.ledger.filter(v=>v.id===forcedLedgerId),observations:[]}:selectedComparison();
  if(!selected || selected.ledger.length>1 || selected.observations.length>1 || !(selected.ledger.length || selected.observations.length))return;
  const source=selected.ledger[0]||selected.observations[0];
  if([...selected.ledger,...selected.observations].some(v=>v.state!=='unmatched' && !(forcedLedgerId && v.id===forcedLedgerId && v.state==='matched')))throw new Error('Choose fully unmatched rows, or a matched ledger transaction.');
  if(selected.ledger.length && selected.observations.length && selected.ledger[0].amount!==selected.observations[0].amount)throw new Error('Amend the amount difference before connecting this transfer.');
  const query=selected.ledger.length?`ledger_id=${id(source.id)}`:`observation_id=${id(source.id)}`;
  const candidates=await api.collection(`reconciliation/sessions/${id(state.session.id)}/internal-transfer-candidates?${query}`);
  const accounts=state.accounts.filter(a=>a.id!==state.session.account_id && a.active!==false && a.currency===state.session.currency);
  if(!accounts.length)throw new Error('Add another active account in the same currency first.');
  state.transferCandidates=candidates.data;
  state.transferSelection={ledger_id:selected.ledger[0]?.id||null,observation_id:selected.observations[0]?.id||null};
  const unique=candidates.data.length===1?candidates.data[0]:null;
  const destination=unique?.account_id||accounts[0].id;
  editor('Connect internal transfer',`<p>${h(accountName(state.session.account_id))} · ${h(source.effective_date)} · ${amount(source.amount,source.currency)}<br>${h(source.description||'Transaction')}</p>${field('Other account',`<select name="counterpart_account_id" id="transfer-destination">${accounts.map(a=>option(a.id,`${a.name} · ${a.currency}`,a.id===destination)).join('')}</select>`)}${field('Other account statement row (optional)',`<select name="counterpart_observation_id" id="transfer-counterpart"></select>`)}${selected.ledger.length?'':field('Transfer description',input('description',`required maxlength="300" value="${h(source.description||'Internal transfer')}"`))}${field('Reason',input('reason','required maxlength="500"'))}<p class="helper">One transfer will connect both account ledgers. The selected statement row will be attached now; choose a row from the other account to reconcile that side too. Without one, its ledger leg stays open for later matching.${selected.ledger.length && !selected.observations.length?' Select a statement row on this account as well if you want to reconcile this side now.':''}</p>`,'internal-transfer-form','Connect transfer');
  updateTransferCounterparts(unique?.observation_id||'');
}
function analyticsPlanningPanels(plans,tracking,investments,obligations,recorded,currency) {
  const scale=new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits;
  const snapshot=analyticsView.planningSummary(investments,obligations,state.month,currency,scale);
  const budgetPanels=plans.length?plans.map((plan,index)=>{
    const result=tracking[index],lines=result.data;
    const planScale=new Intl.NumberFormat('en',{style:'currency',currency:plan.currency}).resolvedOptions().maximumFractionDigits;
    const planned=analyticsView.sumMoney(lines.map(line=>line.planned),planScale);
    const actual=analyticsView.sumMoney([...lines.map(line=>line.actual),result.unbudgeted],planScale);
    const remaining=analyticsView.difference(planned,actual);
    const savings=plan.savings_goal||'0';
    const afterGoals=analyticsView.difference(analyticsView.difference(plan.expected_income,planned),savings);
    const overspent=lines.filter(line=>Number(line.remaining)<0).sort((a,b)=>Number(a.remaining)-Number(b.remaining));
    const categoryRows=[...lines.map(line=>({category_id:line.category_id,planned:line.planned,actual:line.actual,remaining:line.remaining})),...(result.unbudgeted_lines||[]).map(line=>({category_id:line.category_id,planned:null,actual:line.actual,remaining:null}))];
    const detail=table(['Category','Limit','Actual','Remaining',''],categoryRows.sort((a,b)=>Number(b.actual)-Number(a.actual)).map(line=>[h(line.category_id==='uncategorized'?'Uncategorized':categoryName(line.category_id)),line.planned==null?'Unbudgeted':amount(line.planned,plan.currency),amount(line.actual,plan.currency),line.remaining==null?'—':amount(line.remaining,plan.currency),button('View entries','analytics-category-detail',`data-category="${h(line.category_id)}" data-currency="${h(plan.currency)}"`)]));
    return `<div class="planning-subsection"><h3>${h(plan.name||'Monthly plan')} <small>· ${h(plan.scope)} · ${h(plan.state)}</small></h3><div class="budget-summary-grid"><article><span>Category limits</span><strong>${responsiveAmount(planned,plan.currency)}</strong></article><article><span>Actual spending</span><strong>${responsiveAmount(actual,plan.currency)}</strong></article><article><span>${Number(remaining)<0?'Over plan':'Remaining'}</span><strong class="${Number(remaining)<0?'bad':'good'}">${responsiveAmount(remaining,plan.currency)}</strong></article><article><span>Unbudgeted spending</span><strong>${responsiveAmount(result.unbudgeted,plan.currency)}</strong></article></div><p class="helper">Expected income ${amount(plan.expected_income,plan.currency)} · Savings goal ${amount(savings,plan.currency)} · Planned income after limits and savings ${amount(afterGoals,plan.currency)}.${state.scope!=='combined'&&plan.currency===currency?` Recorded income ${amount(recorded.income,currency)}.`:''}</p><div class="planning-insight"><strong>${overspent.length?`${overspent.length} categor${overspent.length===1?'y is':'ies are'} over limit`:'No category is over limit'}</strong><span>${overspent.length?`${h(categoryName(overspent[0].category_id))} has the largest overrun.`:'Review the full category breakdown below.'}</span></div><h4>Category detail</h4>${detail}</div>`;
  }).join(''):empty(state.scope==='combined'?'No personal or family budget for this month. Create one to compare limits and actual spending.':'No budget for this month and scope. Create one to compare limits and actual spending.');
  const budgetPanel=panel('Budget performance',`<p class="helper">${h(state.month)} · ${state.scope==='combined'?'Personal and family plans shown separately':`${h(state.scope)} plan`}. Actuals use recorded expense allocations and refunds. Transfers and settlements stay outside spending.</p>${budgetPanels}<div class="planning-actions">${navButton('budgets','Open budgets →')}</div>`);
  const baseHoldings=snapshot.holdings.filter(item=>item.currency===currency);
  const investmentStats=`<div class="budget-summary-grid"><article><span>Added in ${h(state.month)}</span><strong>${responsiveAmount(snapshot.added,currency)}</strong></article><article><span>Withdrawn in ${h(state.month)}</span><strong>${responsiveAmount(snapshot.withdrawn,currency)}</strong></article><article><span>Baseline + net additions through month</span><strong>${snapshot.valuedCount?responsiveAmount(snapshot.invested,currency):'No valuation'}</strong></article><article><span>Current value by month-end</span><strong>${snapshot.valuedCount?responsiveAmount(snapshot.value,currency):'No valuation'}</strong></article><article><span>Value change</span><strong class="investment-gain ${investmentGainTone(snapshot.gain,snapshot.valuedCount>0)}">${snapshot.valuedCount?responsiveAmount(snapshot.gain,currency):'No valuation'}</strong></article></div>`;
  const holdingRows=snapshot.holdings.map(item=>{
    const last=item.snapshot,monthRecord=item.monthRecord;
    const progress=item.type==='emergency_fund'&&Number(item.target)>0&&last?` · ${Math.min(100,Math.round(Number(last.value)/Number(item.target)*100))}% of ${amount(item.target,item.currency)} target`:'';
    const goal=item.monthly_goal?`<small>Monthly goal ${amount(item.monthly_goal,item.currency)}</small>`:'';
    return [h(item.name)+`<small>${h(item.type==='emergency_fund'?'Emergency fund':item.asset_class==='stock_market'?'Stock market':item.sip?'SIP':'Lump sum mutual fund')}${progress}</small>`+goal,monthRecord?amount(monthRecord.contribution,item.currency):'—',last?h(last.month):'No valuation',last?amount(last.net_contributions,item.currency):'Unknown',last?amount(last.value,item.currency):'Unknown',last?amount(last.gain_loss,item.currency):'Unknown',button('View months','analytics-investment-detail',`data-id="${h(item.id)}"`)];
  });
  const investmentPanel=panel('Investments and emergency funds',`${investmentStats}<p class="helper">Your holdings through ${h(state.month)}, independent of the report scope. ${snapshot.valuedCount} of ${baseHoldings.length} ${h(currency)} holdings have a valuation by month-end. Totals use those holdings only. Value change is current value less the starting baseline and net additions; it can include market movement, interest, and unrecorded cash flows.</p>${investmentInsightCards(snapshot.holdings,Infinity,currency)}${table(['Holding','Added this month','Last valued','Baseline + net additions','Current value','Value change',''],holdingRows)}<div class="planning-actions">${navButton('investments','Open investments →')}</div>`);
  const grouped=new Map();
  for(const row of snapshot.settlementRows){const key=JSON.stringify([row.person.toLowerCase(),row.direction,row.currency]);const group=grouped.get(key)||{person:row.person,direction:row.direction,currency:row.currency,amounts:[]};group.amounts.push(row.asOfRemaining);grouped.set(key,group);}
  const personRows=[...grouped.values()].sort((a,b)=>a.person.localeCompare(b.person)).map(group=>[h(group.person),h(group.direction==='owed_to_me'?'Owes me':'I owe'),amount(analyticsView.sumMoney(group.amounts,new Intl.NumberFormat('en',{style:'currency',currency:group.currency}).resolvedOptions().maximumFractionDigits),group.currency),button('View obligations','analytics-person-detail',`data-person="${h(group.person)}" data-direction="${h(group.direction)}" data-currency="${h(group.currency)}"`)]);
  const settlePanel=panel('Settle-up position',`<div class="budget-summary-grid"><article><span>Others owed me</span><strong class="good">${responsiveAmount(snapshot.owedToMe,currency)}</strong></article><article><span>I owed others</span><strong class="bad">${responsiveAmount(snapshot.iOwe,currency)}</strong></article></div><p class="helper">Your private obligations at the end of ${h(state.month)}, after repayments dated through that month. ${h(currency)} totals are separate from other currencies and from income, spending, and account balances.</p>${table(['Person','Direction','Open amount',''],personRows)}<div class="planning-actions">${navButton('settlements','Open Settle up →')}</div>`);
  return `<div class="analytics-planning">${budgetPanel}${investmentPanel}${state.scope!=='family'?settlePanel:''}</div>`;
}
const investmentGainTone = (value,valued=true) => !valued || value==null || !Number.isFinite(Number(value)) || Number(value)===0 ? 'neutral' : Number(value)>0 ? 'gain' : 'loss';
function investmentInsightCards(holdings,limit=Infinity,preferredCurrency=null) {
  if(!holdings.length)return empty('No investments or emergency funds recorded yet.');
  const shown=[...holdings].sort((a,b)=>Number(b.currency===preferredCurrency)-Number(a.currency===preferredCurrency) || Number(Boolean(b.snapshot))-Number(Boolean(a.snapshot)) || a.name.localeCompare(b.name)).slice(0,limit);
  return `<div class="investment-insight-grid">${shown.map(item=>{
    const latest=item.snapshot;
    const kind=item.type==='emergency_fund'?'Emergency fund':item.asset_class==='stock_market'?'Stock market':item.sip?'SIP':'Lump sum mutual fund';
    return `<article class="investment-insight-card"><div class="investment-insight-head"><span>${h(kind)} · ${h(item.currency)}</span><h3>${h(item.name)}</h3></div><div class="investment-insight-values"><div><span>Baseline + net additions</span><strong>${latest?responsiveAmount(latest.net_contributions,item.currency):'No valuation'}</strong></div><div><span>Current value</span><strong>${latest?responsiveAmount(latest.value,item.currency):'No valuation'}</strong></div><div><span>Value change</span><strong class="investment-gain ${investmentGainTone(latest?.gain_loss,Boolean(latest))}">${latest?responsiveAmount(latest.gain_loss,item.currency):'No valuation'}</strong></div></div><small>${latest?`Valued ${h(latest.month)}`:'Add a monthly valuation to calculate gain or loss.'}</small></article>`;
  }).join('')}</div>`;
}
const views = {
  async household(parts) {
    const currency=state.me.household.base_currency;
    const query=new URLSearchParams({...period(),currency});
    const report=await api.request(`analytics/household?${query}`);
    const members=report.data;
    const selected=members.find(member=>member.id===parts[0]);
    const monthLabel=new Intl.DateTimeFormat('en',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(`${state.month}-01T00:00:00Z`));
    const metric=(label,value,tone='')=>`<div class="household-amount ${tone}"><span>${label}</span><strong>${responsiveAmount(value,currency)}</strong></div>`;
    const cards=members.map(member=>`<button type="button" class="household-person ${selected?.id===member.id?'selected':''}" data-view="household" data-member="${h(member.id)}" aria-label="View ${h(member.name)} category spending"><span class="household-person-head"><span class="person-avatar" aria-hidden="true">${h(member.name.slice(0,1).toUpperCase())}</span><span><strong>${h(member.name)}${member.id===state.me.user.id?' · You':''}</strong><small>${member.id===state.me.user.id?'Your visible records':'Shared records you can access'}</small></span><span class="household-person-arrow" aria-hidden="true">→</span></span><span class="household-person-metrics">${metric('Earned',member.income,'earned')}${metric('Spent',member.net_spending,'spent')}${metric('Invested',member.net_invested,'invested')}</span></button>`).join('');
    let detail='';
    if(selected) {
      const rolled=categoryView.rollup(selected.categories.map(row=>({id:row.category_id,amount:row.amount,currency,count:0})),state.categories);
      const roots=[...rolled].filter(([key])=>key==='uncategorized'||!state.categories.find(category=>category.id===key)?.parent_id).sort((a,b)=>Number(b[1].amount)-Number(a[1].amount));
      const max=Math.max(1,...roots.map(([,row])=>Math.abs(Number(row.amount))));
      const rows=roots.map(([key,row])=>`<li><span><strong>${h(key==='uncategorized'?'Uncategorized':state.categories.find(category=>category.id===key)?.name||'Category')}</strong><small>${amount(row.amount,currency)}</small></span><span class="household-category-track" aria-hidden="true"><i style="width:${Math.abs(Number(row.amount))/max*100}%"></i></span></li>`).join('');
      detail=`<section class="panel household-detail"><div class="overview-panel-heading"><div><span class="section-kicker">CATEGORY DETAIL</span><h2>${h(selected.name)} · Expenses</h2></div>${navButton('household','All members')}</div>${rows?`<ul class="household-categories">${rows}</ul>`:empty('No visible expenses recorded for this month.')}<p class="helper">Amounts are net of refunds. Open a category in Analytics for the full household category breakdown.</p></section>`;
    }
    return heading('Household 360',`${monthLabel} · ${members.length} household member${members.length===1?'':'s'}`)+`<div class="household-grid">${cards||empty('No household members yet.')}</div>${detail}<p class="helper household-note">Spending and refunds are attributed to Paid by; income to the person who entered it. Your personal allocations and accessible family allocations are included. Other members’ private accounts and investments remain private; their invested amount covers holdings they chose to share. All amounts use ${h(currency)} and recorded data only.</p>`;
  },
  async recurring() {
    const {data}=await api.request('recurring-transactions');
    const review=data.filter(item=>!item.subscription&&!item.ignored);
    const tagged=data.filter(item=>item.subscription&&!item.ignored);
    const ignored=data.filter(item=>item.ignored);
    const groups={review,subscriptions:tagged,ignored};
    const shown=groups[state.recurringFilter]||review;
    const tabs=`<div class="recurring-tabs" role="group" aria-label="Recurring payment status">${[['review','To review',review.length],['subscriptions','Subscriptions',tagged.length],['ignored','Ignored',ignored.length]].map(([filter,label,count])=>`<button type="button" data-action="recurring-filter" data-filter="${filter}" aria-pressed="${state.recurringFilter===filter}" class="${state.recurringFilter===filter?'active':''}">${label}<span>${count}</span></button>`).join('')}</div>`;
    const rows=shown.map(item=>{
      const history=item.occurrences.map(o=>`<li><time datetime="${h(o.date)}">${h(o.date)}</time><strong>${amount(o.amount,item.currency)}</strong><span>${h(o.source==='bank_statement'?'Bank statement':'Money Manager / ledger')}</span></li>`).join('');
      const status=item.ignored?'Ignored':item.subscription?'Subscription':'Possible recurring';
      const actions=item.ignored?button('Restore to review','recurring-status',`data-key="${h(item.key)}" data-field="ignored" data-value="false"`):
        `${button(item.subscription?'Remove subscription tag':'Mark as subscription','recurring-status',`data-key="${h(item.key)}" data-field="subscription" data-value="${item.subscription?'false':'true'}"`)}${button('Ignore','recurring-status',`data-key="${h(item.key)}" data-field="ignored" data-value="true"`)}`;
      return `<article class="panel recurring-card ${item.ignored?'is-ignored':item.subscription?'is-subscription':''}"><div class="recurring-card-main"><div class="recurring-card-identity">${subscriptionBrands.markup(item.name,h)}<div class="recurring-card-title"><span class="recurring-status">${status}</span><h2>${h(item.name)}</h2><p>${h(accountName(item.account_id))}</p></div></div><div class="recurring-card-price"><span>Observed payment${item.min_amount===item.max_amount?'':' range'}</span><strong>${recurringAmount(item)}</strong><small>${h(item.frequency)} · ${h(item.count)} payments</small></div></div><div class="recurring-card-meta"><span>First seen <strong>${h(item.first_date)}</strong></span><span>Latest <strong>${h(item.last_date)}</strong></span></div><div class="recurring-card-actions">${actions}</div><details class="recurring-history"><summary>Payment history <span>${item.count}</span></summary><ul>${history}</ul></details></article>`;
    }).join('');
    const summary=`<div class="recurring-summary"><div><span>Needs review</span><strong>${review.length}</strong><small>Detected patterns</small></div><div><span>Subscriptions</span><strong>${tagged.length}</strong><small>Saved tags</small></div><div><span>Ignored</span><strong>${ignored.length}</strong><small>Hidden from review</small></div></div>`;
    const noRows={review:'No patterns need review. Import more months to find repeating payments.',subscriptions:'No subscriptions tagged yet. Mark a pattern as a subscription from To review.',ignored:'No ignored patterns.'};
    return heading('Recurring transactions','Review repeating payments and keep track of subscriptions.')+summary+tabs+`<p class="helper recurring-note">Patterns come from your visible Money Manager transactions and bank statements. Bank evidence linked to a ledger transaction counts once. Ignored patterns stay in the Ignored tab and can be restored.</p><div class="recurring-list">${rows||empty(noRows[state.recurringFilter]||noRows.review)}</div>`;
  },
  async overview() {
    const query=reportQuery();
    const [dashboard,transactions,plans,investments]=await Promise.all([api.request(`analytics/dashboard?${query}`),api.request(`analytics/transactions?${query}&limit=10`),api.collection(`budgets?month=${state.month}${state.scope==='combined'?'':`&scope=${state.scope}`}`).catch(()=>({data:[]})),api.collection('investments')]);
    const {summary,categories,accounts,series:daily}=dashboard;
    const currency=state.me.household.base_currency;
    const monthLabel=new Intl.DateTimeFormat('en',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(`${state.month}-01T00:00:00Z`));
    const surplus=Number(summary.recorded_surplus);
    const budgetPlans=plans.data.filter(plan=>plan.currency===currency);
    const budgetPlan=state.scope==='combined'?null:budgetPlans.find(plan=>plan.state==='active')||budgetPlans[0];
    const budgetTracking=budgetPlan?await api.request(`budgets/${id(budgetPlan.id)}/tracking`).catch(()=>null):null;
    const budgetScale=new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits;
    const planned=budgetTracking?Number(analyticsView.sumMoney(budgetTracking.data.map(line=>line.planned),budgetScale)):null;
    const actual=budgetTracking?Number(analyticsView.sumMoney([...budgetTracking.data.map(line=>line.actual),budgetTracking.unbudgeted],budgetScale)):null;
    const budgetPercent=planned>0?Math.round(actual/planned*100):null;
    const metrics=[
      [surplus<0?'Recorded shortfall':'Recorded surplus',summary.recorded_surplus,moneyTone(summary.recorded_surplus),'Income minus net spending',surplus<0?'↘':'↗','position-card'],
      ['Income',summary.income,moneyTone(summary.income),'Recorded money in','↓',''],
      ['Net spending',summary.net_spending,moneyTone(summary.net_spending,'debt'),'Expenses minus refunds','↑',''],
      ['Transfers',summary.transfer_volume,'neutral','Between accounts · not spending','↔','']
    ];
    const overviewAmount=value=>new Intl.NumberFormat('en-IN',{style:'currency',currency}).format(Number(value));
    const metricCard=([label,value,tone,description,icon,extra])=>`<article class="overview-metric ${extra} ${tone}"><div class="metric-label">${label}<span class="metric-icon" aria-hidden="true">${icon}</span></div><strong class="metric-number">${responsiveAmount(value,currency,overviewAmount(value))}</strong><span class="metric-caption">${description}</span></article>`;
    const scale=new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits;
    const cashflow=analyticsView.moneyLines(daily.data.map(row=>row.period.slice(-2)),[
      {name:'Income',color:'#197b61',values:analyticsView.cumulativeMoney(daily.data,'income',scale)},
      {name:'Spending',color:'#b88653',values:analyticsView.cumulativeMoney(daily.data,'net_spending',scale)}
    ],currency,`Cumulative recorded income and spending for ${monthLabel}`);
    const budgetCard=`<article class="overview-metric overview-budget"><div class="metric-label">Budget pacing<span class="metric-icon" aria-hidden="true">▤</span></div><strong class="metric-number">${budgetPercent==null?(state.scope==='combined'?`${plans.data.length} plans`:'No plan'):`${budgetPercent}<small>% used</small>`}</strong><div class="overview-budget-track" ${budgetPercent==null?'aria-hidden="true"':`role="progressbar" aria-label="Budget used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.max(0,Math.min(100,budgetPercent))}"`}><span style="width:${budgetPercent==null?0:Math.max(0,Math.min(100,budgetPercent))}%"></span></div><div class="overview-budget-foot"><span>${planned>0?`${responsiveAmount(planned,currency,overviewAmount(planned))} planned · ${responsiveAmount(Math.abs(planned-actual),currency,overviewAmount(Math.abs(planned-actual)))} ${actual>planned?'over plan':'remaining'}`:state.scope==='combined'?'Personal and family plans stay separate':'Create a monthly budget'}</span><button type="button" data-view="budgets" aria-label="Review budgets" class="outline-button">›</button></div></article>`;
    const investmentSnapshot=analyticsView.planningSummary(investments.data,[],state.month,currency,scale);
    const investmentPanel=investmentSnapshot?`<section class="panel overview-investments"><div class="overview-panel-heading"><div><span class="section-kicker">INVESTMENT INSIGHTS</span><h2>Portfolio through ${h(monthLabel)}</h2><p class="helper">Your holdings · separate from report scope</p></div>${navButton('investments','All investments →')}</div><div class="budget-summary-grid"><article><span>Baseline + net additions</span><strong>${investmentSnapshot.valuedCount?responsiveAmount(investmentSnapshot.invested,currency):'No valuation'}</strong></article><article><span>Current value</span><strong>${investmentSnapshot.valuedCount?responsiveAmount(investmentSnapshot.value,currency):'No valuation'}</strong></article><article><span>Value change</span><strong class="investment-gain ${investmentGainTone(investmentSnapshot.gain,investmentSnapshot.valuedCount>0)}">${investmentSnapshot.valuedCount?responsiveAmount(investmentSnapshot.gain,currency):'No valuation'}</strong></article><article><span>Added in ${h(state.month)}</span><strong>${responsiveAmount(investmentSnapshot.added,currency)}</strong></article></div>${investmentInsightCards(investmentSnapshot.holdings,3,currency)}<p class="helper">${investmentSnapshot.valuedCount} of ${investmentSnapshot.holdingCount} ${h(currency)} holdings valued by month-end. Totals exclude other currencies and holdings without a valuation. Value change is current value less the starting baseline and net additions and may include unrecorded cash flows.</p></section>`:'';
    const cards=`<section class="overview-hero" aria-label="Monthly financial summary"><div class="position-summary ${surplus<0?'shortfall':''}"><div class="hero-top"><span class="section-kicker">${h(monthLabel)} <i></i> ${h(state.scope)} scope</span><span class="hero-mark" aria-hidden="true"><svg class="icon"><use href="#i-chart"/></svg></span></div>${metricCard(metrics[0])}<p class="hero-basis">Income minus net spending · Not an account balance</p><div class="position-note"><span aria-hidden="true">✓</span><p>Ledger allocations counted once<small>Recorded data for ${h(monthLabel)}</small></p>${navButton('analytics','Explore analytics →')}</div></div><div class="overview-metrics">${metrics.slice(1).map(metricCard).join('')}${budgetCard}</div></section>`;
    const roots=[...categoryView.rollup(categories.data,state.categories)].filter(([key,row])=>(key==='uncategorized'||state.categories.find(c=>c.id===key)?.parent_id==null) && Number(row.amount)!==0).sort((a,b)=>Number(b[1].amount)-Number(a[1].amount));
    const largest=Math.max(1,...roots.map(([,row])=>Math.abs(Number(row.amount))));
    const spending=roots.slice(0,4).map(([key,row])=>`<li><div><span>${h(key==='uncategorized'?'Uncategorized':state.categories.find(c=>c.id===key)?.name||'Category')}</span><strong class="${moneyTone(row.amount,'debt')}">${responsiveAmount(row.amount,currency)}</strong></div><div class="overview-track" aria-hidden="true"><span class="${Number(row.amount)<0?'refund':''}" style="width:${Math.abs(Number(row.amount))/largest*100}%"></span></div></li>`).join('');
    const activeAccounts=accounts.data.filter(a=>a.active!==false).sort((a,b)=>Number(b.balance?.amount!=null)-Number(a.balance?.amount!=null));
    const balances=activeAccounts.slice(0,4).map(a=>{const due=state.accounts.find(account=>account.id===a.id)?.card_due;return `<li><span class="overview-account-icon" aria-hidden="true"><svg class="icon"><use href="#i-wallet"/></svg></span><div><strong>${h(a.name)}</strong><small>${a.subtype==='credit_card'?'Amount owed':a.balance?.source==='balance_check'?'Observed balance':a.balance?.source==='opening_balance'?'Starting balance':'Balance not set'} · ${h(a.currency)}${a.balance?.as_of?` · ${h(a.balance.as_of)}`:''}</small>${a.subtype==='credit_card'&&due?`<small class="overview-card-due">Payment due ${due.amount==null?'amount not entered':amount(due.amount,a.currency)} · ${h(due.due_date)}</small>`:''}</div>${moneyFigure(a.balance?.amount,a.currency,a.subtype==='credit_card'?'debt':'asset')}</li>`;}).join('');
    const spendingPanel=`<section class="panel overview-panel"><div class="overview-panel-heading"><div><h2>Where it went</h2><p class="helper">Top expense categories · Refunds deducted</p></div>${navButton('budgets','Budgets →')}</div>${spending?`<ul class="overview-spending">${spending}</ul><p class="helper">${roots.length>4?'Top 4 categories. ':''}Net of refunds. Negative amounts are net refunds.</p>`:empty('No spending recorded for this month.')}</section>`;
    const accountsPanel=`<section class="panel overview-panel"><div class="overview-panel-heading"><div><h2>Account position</h2><p class="helper">Latest known balances · Not month-end totals</p></div>${navButton('accounts','All accounts →')}</div>${balances?`<ul class="overview-balances">${balances}</ul>`:empty('Add an account or import a statement to get started.')}<p class="helper">${activeAccounts.length>4?`Showing 4 of ${activeAccounts.length} accounts. `:''}Currencies stay separate.</p></section>`;
    const unknownCount=activeAccounts.filter(a=>a.balance?.amount==null).length;
    const attention=`<section class="attention-panel" aria-label="Items needing attention"><div class="attention-heading"><span class="attention-dot" aria-hidden="true"></span><h2>Needs your attention</h2><span>Review recorded data</span></div><div class="attention-grid"><button type="button" data-view="budgets" class="attention-item"><span class="attention-icon warm" aria-hidden="true">▤</span><span><strong>${budgetPercent==null?'Review monthly budgets':budgetPercent>100?'Budget over recorded limit':'Budgets within recorded limits'}</strong><small>${budgetPercent==null?'Compare limits with recorded spending':'Based on recorded spending'}</small></span><span aria-hidden="true">›</span></button><button type="button" data-view="reconcile" class="attention-item"><span class="attention-icon violet" aria-hidden="true">⇄</span><span><strong>Review statement evidence</strong><small>Match rows and inspect differences</small></span><span aria-hidden="true">›</span></button><button type="button" data-view="accounts" class="attention-item"><span class="attention-icon neutral" aria-hidden="true">⌁</span><span><strong>${unknownCount} ${unknownCount===1?'balance needs':'balances need'} an anchor</strong><small>Unknown until dated evidence is added</small></span><span aria-hidden="true">›</span></button></div></section>`;
    const recent=transactions.data.map(t=>{
      const incoming=['income','refund','investment_withdrawal'].includes(t.event_type),outgoing=['expense','investment'].includes(t.event_type);
      const tone=incoming?'positive':outgoing?'negative':'neutral';
      const scopedAmount=['transfer','investment','investment_withdrawal'].includes(t.event_type)?t.amount:analyticsView.sumMoney(t.allocations.map(a=>a.amount),new Intl.NumberFormat('en',{style:'currency',currency:t.currency}).resolvedOptions().maximumFractionDigits);
      return `<li><button type="button" class="recent-item ${tone}" data-action="transaction-detail" data-id="${h(t.id)}"><span class="recent-icon" aria-hidden="true">${incoming?'↙':outgoing?'↗':'⇄'}</span><span class="recent-copy"><strong>${h(t.description||'Untitled')}</strong><small>${h(t.effective_date)} · ${h([...new Set(t.movements.map(m=>accountName(m.account_id)))].join(' → '))}</small></span><span class="recent-value">${incoming?'+ ':outgoing?'− ':''}${responsiveAmount(scopedAmount,t.currency)}<small>${h(t.event_type)}</small></span></button></li>`;
    }).join('');
    return heading('Your month, clearly.','Recorded activity, account position, and the things worth a closer look.',navButton('imports','Import statements')+'<button type="button" class="primary-button" data-action="transaction"><span aria-hidden="true">+</span> Add transaction</button>')+
      cards+investmentPanel+attention+`<div class="overview-chart-grid"><section class="panel cashflow-panel"><div class="overview-panel-heading"><div><h2>Recorded money flow</h2><p class="helper">Cumulative income and spending · ${h(monthLabel)} · ${h(currency)}</p></div>${navButton('analytics','Full report →')}</div>${cashflow}</section>${spendingPanel}</div><div class="overview-workspace"><section class="panel live-panel overview-activity"><div class="overview-panel-heading"><div><h2>Latest activity</h2></div>${navButton('transactions','All activity →')}</div>${recent?`<ul class="recent-list">${recent}</ul>`:empty('Your activity will appear here when you add a transaction.')}</section>${accountsPanel}</div>${coverage()}`+
      (!state.accounts.length?panel('Get started',`<p>Import your Money Manager workbook, map the account and category labels, then review before committing.</p>${navButton('imports','Start an import')}`):'');
  },
  async analytics() {
    const query=reportQuery();
    const [year,month]=state.month.split('-').map(Number);
    const trendFrom=new Date(Date.UTC(year,month-6,1)).toISOString().slice(0,10);
    const trendQuery=new URLSearchParams({from:trendFrom,to:period().to,scope:state.scope,currency:state.me.household.base_currency,grain:'month'});
    const categoryTrendMonths=Array.from({length:6},(_,index)=>new Date(Date.UTC(year,month-6+index,1)).toISOString().slice(0,7));
    const categoryTrendReports=Promise.all(categoryTrendMonths.map(month=>month===state.month?Promise.resolve(null):api.request(`analytics/categories?${reportQuery(month)}`)));
    const [dashboard,trend,transfers,activity,comparison,comparisonCategories,comparisonSeries,budgetList,investments,obligations,recurring,trendCategories]=await Promise.all([
      api.request(`analytics/dashboard?${query}`),api.request(`analytics/series?${trendQuery}`),api.collection(`analytics/transfers?${query}`),
      api.request(`analytics/transactions?${query}&limit=1`),
      api.request(`analytics/summary?${reportQuery(state.compareMonth)}`),
      api.request(`analytics/categories?${reportQuery(state.compareMonth)}`),
      api.request(`analytics/series?${reportQuery(state.compareMonth)}&grain=day`),
      api.collection(`budgets?month=${state.month}${state.scope==='combined'?'':`&scope=${state.scope}`}`),api.collection('investments'),state.scope==='family'?Promise.resolve({data:[]}):api.collection('settle-ups'),api.request('recurring-transactions'),categoryTrendReports
    ]);
    const {summary,categories,'income-categories':incomeCategories,merchants,series,types,accounts}=dashboard;
    const categoryBars=(rows,kind)=>{
      const rolled=categoryView.rollup(rows,state.categories);
      const roots=categoryView.ordered(state.categories,kind).filter(({category})=>rolled.has(category.id));
      const largest=Math.max(0,...roots.filter(({depth})=>depth===0).map(({category})=>Math.abs(Number(rolled.get(category.id).amount))));
      const bar=({category,depth})=>{const value=rolled.get(category.id);return `<div class="analytics-bar-row" style="--depth:${depth}"><div><strong>${h(category.name)}</strong><span>${amount(value.amount,value.currency)} · ${h(value.count)} allocations</span></div><div class="analytics-bar-track"><span style="width:${largest?Math.max(2,Math.round(Math.abs(Number(value.amount))/largest*100)):0}%"></span></div></div>`;};
      const unknown=rolled.get('uncategorized');
      return roots.map(bar).join('')+(unknown?`<div class="analytics-bar-row"><div><strong>Uncategorized</strong><span>${amount(unknown.amount,unknown.currency)}</span></div></div>`:'') || empty('No recorded amounts for this month.');
    };
    let recent='';
    if(!activity.data.length) {
      const all=await api.collection('transactions');
      const latest=all.data.map(t=>t.effective_date?.slice(0,7)).filter(Boolean).sort().at(-1);
      recent=panel('No activity in this month',`<p>No recorded transactions match ${h(state.month)} and the selected scope.</p>${latest && latest!==state.month?button(`View ${latest}`,'select-month',`data-month="${h(latest)}"`):''}`);
    }
    const currency=state.me.household.base_currency;
    const changeCell=(value,goodWhenHigher,baseline)=>`<span class="metric-change ${Number(value)===0?'neutral':(Number(value)>0)===goodWhenHigher?'good':'bad'}">${Number(value)>0?'↑ ':Number(value)<0?'↓ ':''}${amount(value,currency)}${Number(baseline)>0?` <small>(${Math.round(Math.abs(Number(value)/Number(baseline))*100)}%)</small>`:''}</span>`;
    const comparisonRows=[['Income','income',true],['Net spending','net_spending',false],['Recorded surplus','recorded_surplus',true],['Transfer volume','transfer_volume',null]].map(([label,key,goodWhenHigher])=>{const difference=analyticsView.difference(summary[key],comparison[key]);return [h(label),amount(summary[key],currency),amount(comparison[key],currency),goodWhenHigher==null?amount(difference,currency):changeCell(difference,goodWhenHigher,comparison[key])];});
    const currentRollup=categoryView.rollup(categories.data,state.categories),previousRollup=categoryView.rollup(comparisonCategories.data,state.categories);
    const zero=summary.net_spending.includes('.')?'0.'+'0'.repeat(summary.net_spending.split('.')[1].length):'0';
    const categoryCompare=categoryView.ordered(state.categories,'expense').filter(({category,depth})=>depth===0 && (currentRollup.has(category.id)||previousRollup.has(category.id))).map(({category})=>{
      const current=currentRollup.get(category.id)?.amount || zero, before=previousRollup.get(category.id)?.amount || zero;
      return [h(category.name),amount(current,currency),amount(before,currency),changeCell(analyticsView.difference(current,before),false,before)];
    });
    if(currentRollup.has('uncategorized')||previousRollup.has('uncategorized')){const current=currentRollup.get('uncategorized')?.amount||zero,before=previousRollup.get('uncategorized')?.amount||zero;categoryCompare.push(['Uncategorized',amount(current,currency),amount(before,currency),changeCell(analyticsView.difference(current,before),false,before)]);}
    const flowRows=rows=>rows.map(r=>({label:categoryName(r.id),amount:r.amount,currency:r.currency}));
    const expenseRoots=[...currentRollup.entries()].filter(([key,row])=>(key==='uncategorized'||state.categories.find(c=>c.id===key)?.parent_id==null) && Number(row.amount)>0).sort((a,b)=>Number(b[1].amount)-Number(a[1].amount));
    const currencyScale=new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits;
    const dayLabels=series.data.map(row=>row.period.slice(-2));
    const cashflowChart=analyticsView.moneyLines(dayLabels,[
      {name:'Cumulative income',color:'#197b61',values:analyticsView.cumulativeMoney(series.data,'income',currencyScale)},
      {name:'Cumulative net spending',color:'#b88653',values:analyticsView.cumulativeMoney(series.data,'net_spending',currencyScale)},
      {name:'Recorded surplus',values:analyticsView.cumulativeMoney(series.data,'recorded_surplus',currencyScale),dashed:true}
    ],currency,`Income, spending and surplus through ${state.month}`);
    const trendMonths=trend.data.map(row=>row.period);
    const monthlyCashflowChart=analyticsView.moneyLines(trendMonths,[
      {name:'Income',color:'#197b61',values:trend.data.map(row=>row.income)},
      {name:'Net spending',color:'#b88653',values:trend.data.map(row=>row.net_spending)},
      {name:'Recorded surplus',values:trend.data.map(row=>row.recorded_surplus),dashed:true}
    ],currency,'Monthly recorded income, net spending and surplus');
    const categoryMonths=trendMonths.map(month=>month===state.month?categories:trendCategories[categoryTrendMonths.indexOf(month)]);
    const categoryRollups=categoryMonths.map(response=>categoryView.rollup(response.data,state.categories));
    const rootCategories=categoryView.ordered(state.categories,'expense').filter(({category,depth})=>depth===0).map(({category})=>({id:category.id,name:category.name}));
    rootCategories.push({id:'uncategorized',name:'Uncategorized'});
    const allCategoryTrends=rootCategories.map(category=>({...category,values:categoryRollups.map(rollup=>rollup.get(category.id)?.amount||zero)})).filter(category=>category.values.some(value=>Number(value)!==0)).sort((a,b)=>b.values.reduce((sum,value)=>sum+Math.max(0,Number(value)),0)-a.values.reduce((sum,value)=>sum+Math.max(0,Number(value)),0));
    const categoryTrends=allCategoryTrends.slice(0,4);
    const rest=allCategoryTrends.slice(4);
    if(rest.length)categoryTrends.push({name:'Other categories',values:trendMonths.map((_,index)=>analyticsView.sumMoney(rest.map(category=>category.values[index]),currencyScale))});
    const categoryTrendChart=categoryTrends.length?analyticsView.moneyLines(trendMonths,categoryTrends.map(category=>({name:category.name,values:category.values})),currency,'Recorded spending by category across months'):empty('No recorded category spending in this period.');
    const categoryTrendTable=categoryTrends.length?table(['Category',...trendMonths],categoryTrends.map(category=>[h(category.name),...category.values.map(value=>amount(value,currency))])):'';
    const visibleAccounts=accounts.data.filter(a=>a.active!==false);
    const balanceItem=a=>{
      const card=a.subtype==='credit_card';
      const basis=a.balance?.source==='balance_check'?'checked balance':a.balance?.source==='opening_balance'?'starting balance':'no balance anchor';
      return `<li><span><strong>${h(a.name)}</strong><small>${h(card?'Card · amount owed':a.subtype==='settle_up'?'Settlement balance':'Bank / cash balance')} · ${h(basis)}</small></span>${moneyFigure(a.balance?.amount,a.currency,card?'debt':'asset')}</li>`;
    };
    const knownBalances=visibleAccounts.filter(a=>a.balance?.amount!=null);
    const unknownBalances=visibleAccounts.filter(a=>a.balance?.amount==null);
    const missingBalances=unknownBalances.length?`<details class="glance-missing"><summary>${unknownBalances.length} ${unknownBalances.length===1?'account needs':'accounts need'} a balance anchor</summary><ul>${unknownBalances.map(balanceItem).join('')}</ul></details>`:'';
    const budgetTracking=await Promise.all(budgetList.data.map(plan=>api.request(`budgets/${id(plan.id)}/tracking`)));
    const planning=analyticsPlanningPanels(budgetList.data,budgetTracking,investments.data,obligations.data,summary,currency);
    const subscriptionMonth=analyticsView.subscriptionMonth(recurring.data,state.month);
    const subscriptions=subscriptionMonth.rows;
    const subscriptionTotals=subscriptionMonth.totals.map(total=>`<div class="subscription-total"><span>${h(state.month)} · ${h(total.currency)}</span><strong>${responsiveAmount(total.amount,total.currency)}</strong><small>${h(total.count)} observed payment${total.count===1?'':'s'}${total.statementCount?` · ${h(total.statementCount)} from bank statements`:''}</small></div>`).join('');
    const subscriptionCards=subscriptions.map(item=>`<article class="analytics-subscription"><div class="analytics-subscription-identity">${subscriptionBrands.markup(item.name,h)}<div><span class="recurring-status">Subscription</span><h3>${h(item.name)}</h3><p>${h(accountName(item.account_id))} · ${h(item.frequency)}</p></div></div><div class="analytics-subscription-amount"><strong>${responsiveAmount(item.monthAmount,item.currency)}</strong><small>${item.monthCount?`${h(item.monthCount)} payment${item.monthCount===1?'':'s'} in ${h(state.month)}${item.statementCount?` · ${h(item.statementCount)} statement-only`:''}`:`No payment in ${h(state.month)}`}</small><small>Typical: ${recurringAmount(item)}</small></div></article>`).join('');
    const subscriptionPanel=`<section class="panel live-panel analytics-subscriptions"><div class="overview-panel-heading"><div><span class="section-kicker">REPEATING PAYMENTS</span><h2>Subscriptions <span class="subscription-count">${subscriptions.length}</span></h2></div>${navButton('recurring','Manage recurring →')}</div><p class="helper">Observed payments for tagged subscriptions in ${h(state.month)}, across accounts you can access. Totals stay separate by currency and are not added to spending again. This section is independent of the selected report scope.</p><div class="subscription-totals">${subscriptionTotals||`<div class="subscription-total subscription-total-empty"><span>${h(state.month)}</span><strong>No payments recorded</strong><small>Tagged subscriptions may have payments in other months.</small></div>`}</div><div class="analytics-subscription-grid">${subscriptionCards||empty('No subscriptions tagged yet. Review recurring transactions to add one.')}</div></section>`;
    const scopeNote=state.scope==='combined'?'Your personal allocations plus shared family allocations, counted once. Personal and family budgets remain separate.':state.scope==='personal'?'Your personal allocations and budget.':'Shared family allocations and the family budget.';
    const formatMoney=(value,unit=currency)=>new Intl.NumberFormat(unit==='INR'?'en-IN':'en-US',{style:'currency',currency:unit}).format(Number(value));
    const summaryMetric=(label,value,caption,symbol,featured=false)=>`<article class="analytics-metric${featured?' featured':''}"><div class="analytics-metric-head"><span>${h(label)}</span><span class="analytics-metric-icon" aria-hidden="true">${symbol}</span></div><strong>${h(formatMoney(value))}</strong><p>${h(caption)}</p></article>`;
    const metricCards=`<div class="analytics-metrics">${summaryMetric('Income',summary.income,'Recorded allocations · Comparison: '+(Number(comparison.income)===0?'no activity':formatMoney(comparison.income)),'↓')}${summaryMetric('Net spending',summary.net_spending,'Expenses minus refunds · Comparison: '+(Number(comparison.net_spending)===0?'no activity':formatMoney(comparison.net_spending)),'↑')}${summaryMetric(Number(summary.recorded_surplus)<0?'Recorded shortfall':'Recorded surplus',summary.recorded_surplus,'Income minus net spending · Not account balance','▣',true)}${summaryMetric('Transfers',summary.transfer_volume,'Account movements · Excluded from spending','⇄')}</div>`;
    const topDriver=expenseRoots[0];
    const driverName=topDriver?(topDriver[0]==='uncategorized'?'Uncategorized':state.categories.find(item=>item.id===topDriver[0])?.name||'Category'):null;
    const driverShare=topDriver&&Number(summary.net_spending)>0?Math.round(Number(topDriver[1].amount)/Number(summary.net_spending)*100):null;
    const insight=`<div class="analytics-signal"><span class="signal-icon" aria-hidden="true">♧</span><span>${topDriver?`<strong>${h(driverName)}</strong> is your largest recorded category${driverShare==null?'':` at ${h(driverShare)}% of net spending`}.`:'No recorded category spending for this month.'} ${unknownBalances.length?`<button type="button" data-view="accounts">${unknownBalances.length} account balance${unknownBalances.length===1?' is':'s are'} unknown.</button>`:'All visible accounts have a balance anchor.'}</span></div>`;
    const topFive=expenseRoots.slice(0,5),largestDriver=Math.max(1,...topFive.map(([,row])=>Math.abs(Number(row.amount))));
    const driverRows=topFive.map(([key,row],index)=>`<li><span class="driver-number">${String(index+1).padStart(2,'0')}</span><div><span class="driver-line"><strong>${h(key==='uncategorized'?'Uncategorized':state.categories.find(item=>item.id===key)?.name||'Category')}</strong><b>${h(formatMoney(row.amount))}</b></span><span class="driver-track"><span style="width:${Math.max(2,Math.abs(Number(row.amount))/largestDriver*100)}%"></span></span></div></li>`).join('');
    const budgetSnapshots=budgetList.data.map((plan,index)=>{const tracking=budgetTracking[index];const scale=new Intl.NumberFormat('en',{style:'currency',currency:plan.currency}).resolvedOptions().maximumFractionDigits;const planned=analyticsView.sumMoney(tracking.data.map(row=>row.planned),scale);const actual=analyticsView.sumMoney([...tracking.data.map(row=>row.actual),tracking.unbudgeted],scale);const remaining=analyticsView.difference(planned,actual);return `<li><span><strong>${h(plan.name||`${plan.scope} budget`)}</strong><small>${h(plan.scope)} · ${h(plan.state)}</small></span><span><b>${h(formatMoney(remaining,plan.currency))}</b><small>${Number(remaining)<0?'over plan':'remaining'}</small></span></li>`}).join('');
    const balanceGroups=new Map();
    knownBalances.forEach(account=>{const kind=account.subtype==='credit_card'?'card':account.subtype==='settle_up'?'settlement':'cash';const key=`${account.currency}|${kind}`;const group=balanceGroups.get(key)||{currency:account.currency,kind,values:[]};group.values.push(account.balance.amount);balanceGroups.set(key,group)});
    const balanceSummary=[...balanceGroups.values()].map(group=>`<li><span>${group.kind==='card'?'Card amount owed':group.kind==='settlement'?'Settlement balance':'Bank & cash'} · ${h(group.currency)}</span><b>${h(formatMoney(analyticsView.sumMoney(group.values,new Intl.NumberFormat('en',{style:'currency',currency:group.currency}).resolvedOptions().maximumFractionDigits),group.currency))}</b></li>`).join('');
    const subscriptionSummary=subscriptionMonth.totals.map(total=>`<li><span><strong>${h(total.currency)} · ${h(total.count)} observed payment${total.count===1?'':'s'}</strong><small>${h(total.statementCount)} statement-only payment${total.statementCount===1?'':'s'}</small></span><b>${h(formatMoney(total.amount,total.currency))}</b></li>`).join('');
    const summaryCards=`<div class="analytics-primary-grid"><section class="panel analytics-summary-panel"><div class="analytics-panel-head"><h2>Income vs net spending</h2>${navButton('transactions','Activity →')}</div><p>Six months · ${h(currency)} · Recorded activity</p>${analyticsView.groupedBars(trend.data,currency)}<small>Quiet months may have no recorded rows. Refunds reduce net spending; source coverage remains unconfirmed.</small><details><summary>Exact monthly values</summary>${table(['Month','Income','Net spending'],trend.data.map(row=>[h(row.period),amount(row.income,currency),amount(row.net_spending,currency)]))}</details></section><section class="panel analytics-summary-panel"><div class="analytics-panel-head"><h2>What drove spending</h2><button type="button" class="analytics-soft-action" data-action="analytics-tab" data-tab="detailed">All category detail</button></div><p>Top five categories · Net of refunds</p>${driverRows?`<ol class="analytics-drivers">${driverRows}</ol>`:empty('No recorded expense categories for this month.')}</section></div><div class="analytics-secondary-grid"><section class="panel analytics-summary-panel"><div class="analytics-panel-head"><h2>Budget snapshot</h2>${navButton('budgets','Manage →')}</div>${budgetSnapshots?`<ul class="analytics-compact-list">${budgetSnapshots}</ul>`:empty('No budget for this month and scope.')}</section><section class="panel analytics-summary-panel"><div class="analytics-panel-head"><h2>Account position now</h2>${navButton('accounts','Accounts →')}</div>${balanceSummary?`<ul class="analytics-compact-list analytics-balance-list">${balanceSummary}</ul>`:empty('No known account balances.')}${unknownBalances.length?`<div class="analytics-unknown">${unknownBalances.length} account${unknownBalances.length===1?'':'s'} unknown · Excluded from totals</div>`:''}${missingBalances}<p>Current account position, separate from this month’s surplus. Other currencies remain separate.</p></section><section class="panel analytics-summary-panel"><div class="analytics-panel-head"><h2>Observed subscriptions</h2>${navButton('recurring','Review patterns →')}</div>${subscriptionSummary?`<ul class="analytics-compact-list">${subscriptionSummary}</ul>`:empty('No tagged subscription payments this month.')}<p>Independent of report scope. Observed payments already in ledger or statement evidence are not added to spending again.</p></section></div>`;
    const analyticsTabs=`<div class="analytics-view-tabs" role="tablist" aria-label="Analytics sections">${[['summary','Summary'],['trends','Trends'],['planning','Planning'],['detailed','Detailed reports']].map(([key,label])=>`<button type="button" role="tab" id="analytics-tab-${key}" aria-controls="analytics-panel-${key}" aria-selected="${state.analyticsTab===key}" tabindex="${state.analyticsTab===key?'0':'-1'}" class="${state.analyticsTab===key?'active':''}" data-action="analytics-tab" data-tab="${key}">${label}</button>`).join('')}</div>`;
    const tabPanel=(key,body)=>`<div id="analytics-panel-${key}" role="tabpanel" aria-labelledby="analytics-tab-${key}" ${state.analyticsTab===key?'':'hidden'}>${body}</div>`;
    return `<div class="analytics-page">${heading('Analytics','The useful signals first. Explore the details when you need them.')}<div class="analytics-controls">${scopeTabs()}<label class="analytics-compare">Compare with ${input('compare_month',`id="compare-month" type="month" value="${h(state.compareMonth)}" required`)}</label></div>${analyticsTabs}${tabPanel('summary',metricCards+insight+summaryCards+recent)}${tabPanel('trends',
      panel('Income, expenses and surplus over the month',`${cashflowChart}<p class="helper">Each line accumulates recorded entries from the first day of the selected month. Transfers are excluded; missing source coverage can make a line appear flat.</p>`)+
      panel('Where expenses changed over six months',`${categoryTrendChart}<p class="helper">Top four expense categories plus all remaining categories. Refunds stay in net spending; source coverage is unconfirmed.</p>${categoryTrendTable}`)+
      `<div class="analytics-lead">${panel('Six-month income and spending',monthlyCashflowChart)}${panel('Spending by category',categoryBars(categories.data,'expense'))}</div>`+
      panel('How spending builds through the month',`${analyticsView.cumulativeSpending?.(series.data,comparisonSeries.data,currency,state.month,state.compareMonth)||empty('Daily chart unavailable.')}<p class="helper">Lines compare recorded cumulative net spending by calendar day. The months can have different lengths and source coverage is unconfirmed.</p>`)+
      '')}${tabPanel('planning',planning+subscriptionPanel)}${tabPanel('detailed',
      panel('Compare months',table(['Measure',state.month,state.compareMonth,'Difference'],comparisonRows)+`<h3>Expense category changes</h3>`+table(['Category',state.month,state.compareMonth,'Difference'],categoryCompare)+`<p class="helper">Differences are recorded amounts in the selected scope and currency. Source coverage may differ by month.</p>`)+
      panel('Income flow',analyticsView.sankey(flowRows(incomeCategories.data),'Recorded income','income'))+
      panel('Spending flow',analyticsView.sankey(flowRows(categories.data),'Recorded spending','expense'))+
      panel('Income by category and subcategory',categoryBars(incomeCategories.data,'income'))+
      panel('Last six months',table(['Month','Income','Net spending','Recorded surplus'],trend.data.map(r=>[h(r.period),`<span class="metric-value good">${amount(r.income)}</span>`,`<span class="metric-value spend">${amount(r.net_spending)}</span>`,`<span class="metric-value ${Number(r.recorded_surplus)>=0?'good':'bad'}">${amount(r.recorded_surplus)}</span>`])))+
      panel('Daily trend',table(['Date','Income','Net spending','Recorded surplus'],series.data.filter(r=>Number(r.income)!==0||Number(r.net_spending)!==0).map(r=>[h(r.period),`<span class="metric-value good">${amount(r.income)}</span>`,`<span class="metric-value spend">${amount(r.net_spending)}</span>`,`<span class="metric-value ${Number(r.recorded_surplus)>=0?'good':'bad'}">${amount(r.recorded_surplus)}</span>`])))+
      panel('Transaction mix',table(['Type','Transactions','Recorded amount'],types.data.map(r=>[h(r.event_type),h(r.count),amount(r.amount,r.currency)])))+
      panel('Merchants',table(['Merchant','Net spending','Transactions'],merchants.data.map(m=>[h(m.id==='unknown'?'Unspecified':m.id),amount(m.amount,m.currency),h(m.count)])))+
      panel('Account activity',table(['Account','Movement / debt change','Current balance / amount owed'],accounts.data.map(a=>[h(a.name),moneyFigure(state.accounts.find(v=>v.id===a.id)?.subtype==='credit_card'?analyticsView.negate(a.signed_movements):a.signed_movements,a.currency),`${moneyFigure(a.balance?.amount,a.currency,state.accounts.find(v=>v.id===a.id)?.subtype==='credit_card'?'debt':'asset')}<small>${state.accounts.find(v=>v.id===a.id)?.subtype==='credit_card'?'Amount owed':'Available balance'}</small>`])))+
      panel('Transfers',`<p>${h(transfers.data.length)} recorded transfers in this period.</p>`))}</div>`;
  },
  async transactions(parts) {
    const allDates=parts[0]==='all';
    if(state.transactionFilters.account && !state.accounts.some(a=>a.id===state.transactionFilters.account)) {
      state.transactionFilters.account=''; saveView();
    }
    const filters=state.transactionFilters;
    const values=await api.collection(viewState.transactionsPath(state.month,!allDates,filters,state.scope));
    const eventAccounts=state.accounts.filter(a=>(!filters.account || a.id===filters.account) && (!filters.accountType || a.subtype===filters.accountType));
    const ledgers=await loadLedgerBalances(values.data,allDates,eventAccounts.map(a=>a.id));
    const balanceEvents=eventAccounts.flatMap(account=>(ledgers.get(account.id)||[]).filter(row=>['opening_balance','balance_check'].includes(row.event_type)).map(row=>({account,row})));
    const mobile=window.matchMedia('(max-width:760px)').matches;
    const activeFilterCount=Number(Boolean(filters.account))+Number(Boolean(filters.accountType))+Number(Boolean(filters.eventType));
    const picker=`<details id="transaction-filters" class="ledger-filter-disclosure" ${mobile&&!transactionFiltersExpanded?'':'open'}><summary>Filters${activeFilterCount?` · ${activeFilterCount} active`:''}</summary><div class="ledger-filters" role="group" aria-label="Filter transactions">${field('Account',`<select id="transaction-filter-account">${option('','All accounts',!filters.account)}${state.accounts.map(a=>option(a.id,`${a.name} · ${a.currency}`,a.id===filters.account)).join('')}</select>`)}${field('Account type',`<select id="transaction-filter-account-type">${option('','All types',!filters.accountType)}${['bank','credit_card','cash','settle_up'].map(v=>option(v,v.replace('_',' '),v===filters.accountType)).join('')}</select>`)}${field('Transaction type',`<select id="transaction-filter-event-type">${option('','All types',!filters.eventType)}${['expense','income','refund','transfer','investment','investment_withdrawal'].map(v=>option(v,v.replace('_',' '),v===filters.eventType)).join('')}</select>`)}${button('Clear filters','clear-transaction-filters')}${mobile?navButton('changes','Money Manager changes ↗'):''}</div></details>`;
    const legend='<div class="activity-legend" aria-label="Transaction amount key"><span class="income">+ Income</span><span class="expense">− Expense</span><span class="refund">+ Refund</span><span class="transfer">↔ Transfer</span></div>';
    const monthLabel=new Intl.DateTimeFormat('en',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(`${state.month}-01T00:00:00Z`));
    const movePanel=familyMode()?'':'<details id="bulk-scope-panel" class="panel live-panel"><summary>Move transactions to Family</summary><div id="bulk-scope-content"><p class="helper">Open to load eligible transactions.</p></div></details>';
    const cardAction=state.accounts.some(a=>a.subtype==='credit_card' && a.active!==false)?button('Pay card','card-payment'):'';
    const transactionHeading=mobile?`<div class="page-heading transaction-heading"><h1>Transactions</h1>${button('Balance check','transaction-balance')}</div><div class="transaction-mobile-actions">${button('Add investment','add-investment-transaction')}${cardAction}</div>`:heading('Transactions',allDates?'Your transaction history':`${monthLabel} · Your money in and out`,(familyMode()?'':button('Move to Family','show-bulk-scope'))+button('Add investment','add-investment-transaction')+cardAction+button('Add balance check','transaction-balance')+'<button type="button" class="primary-button" data-action="transaction"><span aria-hidden="true">+</span> Add transaction</button>');
    const ledgerHeading=mobile?`<div class="ledger-mobile-toolbar"><strong>${values.data.length} ${values.data.length===1?'transaction':'transactions'}</strong>${button(allDates?`Show ${state.month}`:'Show all dates','transaction-period')}</div>`:`<div class="ledger-heading"><div><h2>Recorded activity <span class="record-count">${values.data.length}</span></h2><p>${balanceEvents.length} balance ${balanceEvents.length===1?'marker':'markers'}${filters.account||filters.accountType||filters.eventType?' · Filters applied':''}</p></div><div class="ledger-view-actions">${button(allDates?`Show ${state.month}`:'Show all dates','transaction-period')}${navButton('changes','Money Manager changes ↗')}</div></div>`;
    return `<div class="transaction-page">${transactionHeading}${mobile?'':scopeTabs()+`<p class="analytics-scope-note">${state.scope==='combined'?'Your personal and shared family transactions together.':state.scope==='family'?'Shared family transactions.':'Your personal transactions.'} Each transaction appears once. Amounts show allocations in this view.</p>`+movePanel}<section class="panel ledger-workspace" aria-label="Transaction ledger">${ledgerHeading}${picker}${mobile?'':`<div class="ledger-caption"><span>Latest first</span>${legend}</div>`}${transactionTable(values.data,balanceEvents,filters.account)}<div class="ledger-footer"><span>${values.data.length} ${values.data.length===1?'transaction':'transactions'} shown</span><span>Transfers match either participating account.</span></div></section>${mobile?movePanel:''}${coverage()}</div>`;
  },
  async planner() {
    const [response,budgets]=await Promise.all([api.request(`planned-items?month=${id(state.month)}`),api.collection(`budgets?month=${id(state.month)}`)]);
    const commitmentSets=await Promise.all(budgets.data.map(b=>api.request(`budgets/${id(b.id)}/commitments`)));
    const commitmentStates=new Map(commitmentSets.flatMap(result=>result.data.map(item=>[item.id,item.state])));
    state.plannedItems=response.data;
    const items=response.data.map(item=>`<li class="compact-item plan-item">
      <div class="compact-item-main"><time class="date-chip" datetime="${h(item.due_date)}">${h(item.due_date.slice(-2))}<small>${h(item.due_date.slice(0,7))}</small></time><div class="compact-item-copy"><strong>${h(item.title)}</strong><span>${h(categoryName(item.category_id))} · ${h(item.account_id?accountName(item.account_id):'No account chosen')}</span></div></div>
      <div class="compact-item-end"><strong class="compact-amount">${amount(item.amount,item.currency)}</strong><span class="quiet-tag ${h(item.status)}">${h(commitmentStates.get(item.id)==='needs_review'?'Needs review':item.status==='done'?(item.budget_commitment?'Matched':'Done'):item.status==='skipped'?'Skipped':item.budget_commitment?'Committed':'Planned')}</span><span class="quiet-tag">${h(item.visibility==='shared'?'Household':'Personal')}</span></div>
      ${item.owner_id===state.me.user.id?`<div class="compact-item-actions">${button('Edit','edit-plan',`data-id="${h(item.id)}"`)}${item.budget_commitment?(item.status==='done'?button('Unmatch','unmatch-plan',`data-id="${h(item.id)}"`):item.status==='planned'?button('Match posted expense','match-plan',`data-id="${h(item.id)}"`):''):button(item.status==='planned'?'Mark done':'Mark planned','toggle-plan',`data-id="${h(item.id)}"`)}${item.budget_commitment&&item.status!=='done'?button(item.status==='skipped'?'Restore':'Skip','skip-plan',`data-id="${h(item.id)}"`):''}${button('Remove','delete-plan',`data-id="${h(item.id)}"`)}</div>`:''}
    </li>`).join('');
    return heading('Planner',`${h(state.month)} · Expected expenses and bills`,'<button type="button" class="primary-button" data-action="add-plan">Add planned expense</button>')+
      panel('Planned expenses',`<p class="helper">Budget commitments reduce available funds until matched to a posted expense. Other plans are reminders only. Recording a payment changes balances and spending; matching it prevents counting the commitment twice.</p>${items?`<ul class="compact-list" aria-label="Planned expenses for ${h(state.month)}">${items}</ul>`:empty('No expenses planned for this month.')}`);
  },
  async accounts(parts) {
    const selected=state.accounts.find(a=>a.id===parts[0]);
    if(selected) {
      const allDates=parts[1]==='all';
      const range=allDates?'':`?${new URLSearchParams(period())}`;
      const [ledger,transactions,checks,recurring]=await Promise.all([
        api.collection(`accounts/${id(selected.id)}/ledger${range}`),
        api.collection(viewState.transactionsPath(state.month,!allDates,{account:selected.id})),
        api.collection(`accounts/${id(selected.id)}/balance-checks`),
        api.request('recurring-transactions')
      ]);
      state.selectedChecks=checks.data;
      const rows=[...ledger.data].reverse();
      const byTransaction=new Map(transactions.data.map(t=>[t.id,t]));
      const movementRows=ledger.data.filter(r=>r.movement!=null);
      const scale=new Intl.NumberFormat('en',{style:'currency',currency:selected.currency}).resolvedOptions().maximumFractionDigits;
      const sum=values=>analyticsView.sumMoney(values,scale);
      const incoming=sum(movementRows.filter(r=>Number(r.movement)>0).map(r=>r.movement));
      const outgoing=sum(movementRows.filter(r=>Number(r.movement)<0).map(r=>analyticsView.negate(r.movement)));
      const net=analyticsView.difference(incoming,outgoing);
      const spends=movementRows.filter(r=>r.event_type==='expense' && Number(r.movement)<0 && r.transaction_id).sort((a,b)=>Number(a.movement)-Number(b.movement)).slice(0,5);
      const subscriptions=analyticsView.subscriptionMonth(recurring.data,state.month).rows.filter(item=>item.account_id===selected.id);
      const periodLabel=allDates?'All recorded dates':new Intl.DateTimeFormat('en',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(`${state.month}-01T00:00:00Z`));
      const metric=(label,value,note,tone='',count=false)=>`<article class="account-detail-metric"><span>${h(label)}</span><strong class="${tone}">${count?h(value):amount(value,selected.currency)}</strong><small>${h(note)}</small></article>`;
      const rowHtml=r=>{
        const tx=r.transaction_id?byTransaction.get(r.transaction_id):null;
        const marker=r.movement==null;
        const movement=marker?'Balance anchor':`${Number(r.movement)>0?'+ ':Number(r.movement)<0?'− ':''}${amount(r.movement==null?null:String(r.movement).replace(/^-/,'') ,selected.currency)}`;
        const date=new Date(r.effective_at);
        const dateText=Number.isNaN(date.getTime())?r.effective_date:date.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});
        return `<article class="account-ledger-row ${marker?'is-anchor':''}"><div class="account-ledger-date"><time datetime="${h(r.effective_at)}">${h(dateText)}</time><small>${h(date.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}))}</small></div><div class="account-ledger-copy"><strong>${h(r.description||'Transaction')}</strong><small>${h(marker?r.event_type==='opening_balance'?'Starting balance':'Observed balance check':r.event_type.replace(/_/g,' '))}${tx?.allocations?.length?` · ${h([...new Set(tx.allocations.map(a=>categoryName(a.category_id)))].join(', '))}`:''}</small>${r.same_time_count>1?`<small>${h(groupBalanceLabel(r,selected.id).replace(/^ · /,''))}</small>`:''}</div><div class="account-ledger-values"><strong class="${marker?'':Number(r.movement)<0?'out':'in'}">${movement}</strong><small>${selected.subtype==='credit_card'?'Amount owed':'Balance'} after · ${amount(r.balance_after,selected.currency)}</small><small>From known start · ${amount(r.computed_from_start,selected.currency)} · ${h(balanceLabel(r))}</small></div>${tx?button('Details','transaction-detail',`data-id="${h(tx.id)}"`):''}</article>`;
      };
      const checkRows=checks.data.map(c=>`<div class="account-check-row"><div><strong>${h(new Date(c.as_of).toLocaleString())}</strong><small>${h(c.voided?'Removed':c.stale?'Ledger changed':'Current')}</small></div><div><strong>${amount(c.amount,c.currency)}</strong><small>Observed</small></div><div><strong>${amount(c.current_variance,c.currency)}</strong><small>Difference now · calculated ${amount(c.current_calculated,c.currency)}</small></div>${c.voided?'':`<div class="account-check-actions">${button('Edit','edit-balance-check',`data-account="${h(selected.id)}" data-id="${h(c.id)}"`)}${button('Remove','remove-balance-check',`data-account="${h(selected.id)}" data-id="${h(c.id)}"`)}</div>`}</div>`).join('');
      const subscriptionPanel=`<section class="panel account-subscription-panel"><div class="account-panel-heading"><div><span class="section-kicker">REPEATING PAYMENTS</span><h2>Subscriptions <span class="record-count">${subscriptions.length}</span></h2><p>Observed on this account · ${h(state.month)}</p></div>${navButton('recurring','Manage →')}</div>${subscriptions.length?`<div class="account-subscription-list">${subscriptions.map(item=>`<article class="account-subscription"><div class="account-subscription-name">${subscriptionBrands.markup(item.name,h)}<div><strong>${h(item.name)}</strong><small>${h(item.frequency)} · last paid ${h(item.last_date)}</small></div></div><div class="account-subscription-value"><strong>${amount(item.monthAmount,item.currency)}</strong><small>${item.monthCount?`${h(item.monthCount)} observed payment${item.monthCount===1?'':'s'} this month`:'No payment this month'} · typical ${recurringAmount(item)}</small></div></article>`).join('')}</div>`:empty('No subscription payments are recorded for this account yet. Add or import a payment to track one.')}</section>`;
      return `<div class="account-detail-page"><div class="account-detail-back">${navButton('accounts','← All accounts')}</div><header class="account-detail-hero"><div><span class="eyebrow">${h(selected.subtype.replace(/_/g,' '))} · ${h(selected.visibility)} · ${h(selected.currency)}</span><h1>${h(selected.name)}</h1><p>${h(selected.balance?.amount!=null?'Calculated as of '+new Date(selected.balance.as_of).toLocaleString():'Balance has no dated anchor')}</p></div><div class="account-detail-position"><span>${selected.subtype==='credit_card'?'Amount owed':'Current balance'}</span>${moneyFigure(selected.balance?.amount,selected.currency,selected.subtype==='credit_card'?'debt':'asset')}<small>${h(selected.balance?.source==='balance_check'?'From observed check':selected.balance?.source==='opening_balance'?'From known balance':'No balance anchor')}</small></div></header><div class="account-detail-actions">${button('Add transaction','transaction-account',`data-account="${h(selected.id)}"`)}${selected.subtype==='credit_card'&&selected.active!==false?button('Pay card','card-payment',`data-id="${h(selected.id)}"`):''}${selected.subtype==='settle_up'?'':button('Check balance','balance',`data-id="${h(selected.id)}"`)}${selected.owner_id===state.me.user.id?button('Edit account','edit-account',`data-id="${h(selected.id)}"`)+button(selected.opening_balance?'Edit known balance':'Set known balance','opening-balance',`data-id="${h(selected.id)}"`):''}</div><div class="account-detail-period"><div><span class="section-kicker">ACCOUNT ACTIVITY</span><h2>${h(periodLabel)}</h2><p>Movements and balances for this account. Transfers affect the account, but are not spending.</p></div>${button(allDates?`Show ${state.month}`:'Show all dates','account-period',`data-id="${h(selected.id)}" data-all="${allDates?'false':'true'}"`)}</div><div class="account-detail-metrics">${metric('Money in',incoming,'Income, transfers in and refunds','positive')}${metric('Money out',outgoing,'Expenses, transfers out and investments','debt')}${metric('Net movement',net,'Money in minus money out',moneyTone(net))}${metric('Activity',String(movementRows.length),'Recorded account movements','',true)}</div><div class="account-detail-grid"><section class="panel account-spend-panel"><div class="account-panel-heading"><div><span class="section-kicker">SPENDING</span><h2>Top spends</h2></div><small>${h(periodLabel)}</small></div>${spends.length?`<ol class="account-top-spends">${spends.map((r,index)=>`<li><span class="spend-rank">${index+1}</span><div><strong>${h(r.description||'Expense')}</strong><small>${h(r.effective_date)}${byTransaction.get(r.transaction_id)?.allocations?.length?` · ${h([...new Set(byTransaction.get(r.transaction_id).allocations.map(a=>categoryName(a.category_id)))].join(', '))}`:''}</small></div><b>${amount(analyticsView.negate(r.movement),selected.currency)}</b></li>`).join('')}</ol>`:empty('No expenses recorded for this account in this period.')}<p class="helper">Ranked by this account’s expense movements. Transfers and card payments are excluded.</p></section><section class="panel account-basis-panel"><span class="section-kicker">BALANCE RECORD</span><h2>Known starting point</h2>${selected.opening_balance?`<strong>${amount(selected.opening_balance.amount,selected.currency)}</strong><p>Recorded ${h(new Date(selected.opening_balance.as_of).toLocaleString())}</p>`:empty('No known starting balance recorded.')}<div class="account-basis-divider"></div><strong>${checks.data.filter(c=>!c.voided).length} balance ${checks.data.filter(c=>!c.voided).length===1?'check':'checks'}</strong><p>Observed checks anchor the calculated balance at their recorded time.</p>${checks.data.length?`<details class="account-checks"><summary>Review balance checks</summary>${checkRows}<p class="helper">Difference = observed balance minus the current ledger calculation.</p></details>`:''}</section></div>${subscriptionPanel}<section class="panel account-ledger-panel"><div class="account-panel-heading"><div><span class="section-kicker">TRACK RECORD</span><h2>Account history <span class="record-count">${rows.length}</span></h2><p>Newest first · balance shown after each movement</p></div></div>${rows.length?`<div class="account-ledger-list">${rows.map(rowHtml).join('')}</div>`:empty('No account activity recorded for this period.')}</section>${coverage()}</div>`;
    }
    const recurringAccounts=(await api.request('recurring-transactions')).data.filter(item=>item.subscription&&!item.ignored);
    const subscriptionCounts=new Map();
    recurringAccounts.forEach(item=>subscriptionCounts.set(item.account_id,(subscriptionCounts.get(item.account_id)||0)+1));
    const accountCard=a=>`<article class="account-card ${h(a.subtype)}"><div class="account-card-top"><span class="account-symbol" aria-hidden="true">${a.subtype==='credit_card'?'▤':a.subtype==='cash'?'¤':a.subtype==='settle_up'?'↔':'⌂'}</span><span class="account-visibility">${h(a.visibility)}</span></div><div class="account-card-name"><h3><a class="account-card-link" href="#accounts/${encodeURIComponent(a.id)}">${h(a.name)}</a></h3><small>${h(a.subtype.replace('_',' '))} · ${h(a.currency)}</small></div><div class="account-card-balance">${accountBalance(a)}</div>${subscriptionCounts.has(a.id)?`<span class="account-subscription-count">${subscriptionCounts.get(a.id)} subscription${subscriptionCounts.get(a.id)===1?'':'s'}</span>`:''}<div class="account-card-actions">${button('Open account →','account-ledger',`data-id="${h(a.id)}"`)}</div></article>`;
    const accountSection=(title,values,description)=>`<section class="account-section"><div class="section-heading"><div><h2>${h(title)}</h2><p>${h(description)}</p></div><span>${values.length} ${values.length===1?'account':'accounts'}</span></div>${values.length?`<div class="account-grid">${values.map(accountCard).join('')}</div>`:empty('No accounts in this group.')}</section>`;
    return heading('Accounts','Choose an account to see its activity, spending and balance history.',button('Add account','account'))+
      accountSection('Bank and cash',state.accounts.filter(a=>['bank','cash'].includes(a.subtype)),'Money held in bank and cash accounts.')+
      accountSection('Credit cards',state.accounts.filter(a=>a.subtype==='credit_card'),'Card purchases and payments, with the amount owed kept visible.')+
      (state.accounts.some(a=>a.subtype==='settle_up')?accountSection('Settlements',state.accounts.filter(a=>a.subtype==='settle_up'),'Amounts to settle with other people.'): '')+coverage();
  },
  async changes() {
    const changes=await api.collection('money-manager/changes?include_done=true');
    const pending=changes.data.filter(t=>!t.money_manager_synced_at);
    const completed=changes.data.filter(t=>t.money_manager_synced_at);
    const snapshot=t=>`${h(t.effective_date)}<br>${h(t.description||'Transaction')}<br>${t.movements.map(m=>h(accountName(m.account_id))).join(', ')}<br><strong>${amount(t.amount,t.currency)}</strong>`;
    const changeRow=t=>[h(t.amendment?'Amendment':t.reconciliation_created?'Statement entry':t.money_manager_manual_edit?'Edited transaction':'New transaction'),t.money_manager_initial?snapshot(t.money_manager_initial):'<span class="new-initial">Empty · new in Money Manager</span>',snapshot(t),t.money_manager_synced_at?`${h(t.money_manager_synced_at)} ${button('Reopen','reopen-money-manager',`data-id="${h(t.id)}" data-revision="${t.revision}"`)}`:button('Mark updated','sync-money-manager',`data-id="${h(t.id)}" data-revision="${t.revision}"`)];
    return heading('Money Manager changes','Compare the original Money Manager entry with the value to enter now.')+panel(`To update · ${pending.length}`,pending.length?`<div class="money-manager-list">${table(['Change','Initial','New','Action'],pending.map(changeRow))}</div>`:empty('All changes are marked as updated.'))+`<details class="completed-changes"><summary>Updated in Money Manager · ${completed.length}</summary>${completed.length?`<div class="money-manager-list">${table(['Change','Initial','New','Updated'],completed.map(changeRow))}</div>`:empty('No completed changes yet.')}</details>`;
  },
  async categories() {
    const section=kind=>panel(kind==='expense'?'Expense categories':'Income categories',
      `<div class="category-tree">${categoryView.ordered(state.categories,kind).map(({category,depth})=>`<div class="category-tree-row" style="--depth:${depth}"><div class="category-tree-name"><span class="category-branch">${depth?'↳':'●'}</span><strong>${h(category.name)}</strong><small>${h(categoryName(category.id))} · ${category.visibility==='private'?'personal':'household'}${category.archived?' · archived':''}</small></div><div>${category.archived?'':button('Add subcategory','add-subcategory',`data-parent="${h(category.id)}"`)}${category.archived?'':button('Edit','edit-category',`data-id="${h(category.id)}"`)}</div></div>`).join('') || empty('No categories yet.')}</div>`);
    return heading('Categories','Categories and subcategories are grouped by their parent.',button('Add category','category'))+section('expense')+section('income');
  },
  async statements(parts) {
    const account=state.accounts.find(a=>a.id===parts[0]) || state.accounts.find(a=>['bank','credit_card'].includes(a.subtype)) || state.accounts[0];
    if(!account) return heading('Statements','Create or import an account first.')+navButton('imports');
    const [value,uploaded]=await Promise.all([api.request(`accounts/${id(account.id)}/statements?month=${state.month}`),api.request(`accounts/${id(account.id)}/statement-months`)]);
    const monthCards=uploaded.data.map(row=>`<article class="statement-month-card"><div><strong>${h(row.month)}</strong><span>${h(row.filename)}</span><small>${h(row.first_date)} to ${h(row.last_date)} · ${h(row.row_count)} rows</small></div><div><small>Opening from file</small>${moneyFigure(row.opening_balance,row.currency)}</div><div><small>Closing from file</small>${moneyFigure(row.closing_balance,row.currency)}</div></article>`).join('');
    const balanceKind=account.subtype==='credit_card'?'debt':'asset';
    const summary=`<div class="statement-summary"><article><span>Recorded opening</span>${moneyFigure(value.opening?.amount,account.currency,balanceKind)}</article><article><span>${account.subtype==='credit_card'?'Recorded amount owed':'Recorded closing'}</span>${moneyFigure(value.closing?.amount,account.currency,balanceKind)}</article><article><span>${account.subtype==='credit_card'?'Change in amount owed':'Signed movements'}</span>${moneyFigure(account.subtype==='credit_card'?analyticsView.negate(value.signed_movements):value.signed_movements,account.currency)}</article></div>`;
    return heading('Monthly statements','Compare uploaded balances with the recorded account ledger.')+`<div class="statement-account-picker">${field('Account',`<select id="statement-account">${accountOptions(account.id)}</select>`)}</div>`+panel(`${account.name} · ${state.month}`,summary+`<div class="statement-status"><span>Ledger entries awaiting a match: <strong>${h(value.ledger_unmatched_count)}</strong></span><span>Statement rows awaiting a match: <strong>${h(value.observation_unmatched_count)}</strong></span><span>Coverage: <strong>${h(value.coverage)}</strong></span></div>${account.subtype==='credit_card'&&account.card_due?`<p class="helper">Payment due ${h(account.card_due.due_date)} · ${amount(account.card_due.amount,account.currency)}</p>`:''}`)+panel('Uploaded statement months',`<p class="helper">Opening is inferred from the first reported balance minus its movement. A file covering part of a month is not a full monthly statement.</p><div class="statement-month-list">${monthCards||empty('No uploaded statement months for this account.')}</div>`)+coverage();
  },
  async budgets() {
    const plans=await api.collection(`budgets?month=${state.month}${state.scope==='combined'?'':`&scope=${state.scope}`}`);
    if(!plans.data.length) { const canCreateFamily=['owner','admin'].includes(state.me.membership.role);const create=state.scope==='combined'?button('Create personal budget','budget-personal')+(canCreateFamily?button('Create family budget','budget-family'):''):state.scope==='family'?(canCreateFamily?button('Create budget','budget'):''):button('Create budget','budget');return heading('Monthly budgets',`${state.month} · ${state.scope}`,create)+coverage()+panel('Plan this month',`<p>No budget exists for this month and scope. ${create?'Create a plan with category limits, then compare recorded spending with those limits over time.':'A household owner or admin can create the family plan.'}</p>${create}`); }
    const [tracking,people,commitments,forecasts,histories]=await Promise.all([Promise.all(plans.data.map(b=>api.request(`budgets/${id(b.id)}/tracking`))),Promise.all(plans.data.map(b=>api.request(`budgets/${id(b.id)}/people`))),Promise.all(plans.data.map(b=>api.request(`budgets/${id(b.id)}/commitments`))),Promise.all(plans.data.map(b=>api.request(`budgets/${id(b.id)}/forecast`))),Promise.all(plans.data.map(b=>api.request(`budgets/${id(b.id)}/revisions`)))]);
    const previous=new Date(Date.UTC(Number(state.month.slice(0,4)),Number(state.month.slice(5,7))-2,1)).toISOString().slice(0,7);
    const dailyReports=await Promise.all(plans.data.map(async b=>{const query=month=>new URLSearchParams({...period(month),scope:b.scope,currency:b.currency,grain:'day'});const [daily,prior,summary]=await Promise.all([api.request(`analytics/series?${query(state.month)}`),api.request(`analytics/series?${query(previous)}`),api.request(`analytics/summary?${new URLSearchParams({...period(state.month),scope:b.scope,currency:b.currency})}`)]);return {daily,prior,summary};}));
    const today=householdDate();
    const sections=plans.data.map((b,i)=>{
      const {daily,prior,summary:recorded}=dailyReports[i],cutoff=state.month<today.slice(0,7)?daily.data.length:state.month===today.slice(0,7)?Number(today.slice(-2)):0;
      const lines=tracking[i].data,scale=new Intl.NumberFormat('en',{style:'currency',currency:b.currency}).resolvedOptions().maximumFractionDigits;
      const planned=analyticsView.sumMoney(lines.map(line=>line.planned),scale);
      const actual=analyticsView.sumMoney([...lines.map(line=>line.actual),tracking[i].unbudgeted],scale);
      const remaining=analyticsView.difference(planned,actual);
      const incomeGap=analyticsView.difference(b.expected_income,planned);
      const plannedSavings=b.savings_goal||'0';
      const afterPlan=analyticsView.difference(incomeGap,plannedSavings);
      const actualSavings=analyticsView.difference(recorded.income,actual);
      const labels=daily.data.map(row=>row.period.slice(-2));
      const actualLine=analyticsView.cumulativeMoney(daily.data,'net_spending',scale).map((value,day)=>day<cutoff?value:null);
      const priorLine=analyticsView.cumulativeMoney(prior.data,'net_spending',scale);
      const guide=analyticsView.pacedBudget(planned,labels.length,scale);
      const chart=analyticsView.moneyLines(labels,[{name:'Recorded spending',values:actualLine,color:'#b88653'},{name:'Even budget guide',values:guide,dashed:true,color:'#729a58'},{name:`${previous} recorded`,values:labels.map((_,day)=>priorLine[day]??null),dashed:true,color:'#7f82bc'}],b.currency,`${b.name||b.month} spending against plan`);
      const dailyDetails=table(['Day','Net spending','Cumulative spending','Even guide'],daily.data.slice(0,cutoff).map((row,day)=>[h(row.period),amount(row.net_spending,b.currency),amount(actualLine[day],b.currency),amount(guide[day],b.currency)]));
      const canManage=b.scope==='family'?['owner','admin'].includes(state.me.membership.role):b.owner_id===state.me.user.id;
      const actions=canManage?`<div class="budget-plan-actions">${b.state==='archived'?'':button('Edit plan','edit-budget',`data-id="${h(b.id)}"`)}${b.state==='draft'?button('Activate','activate-budget',`data-id="${h(b.id)}" data-revision="${b.revision}"`):''}${button('Copy to next month','copy-budget',`data-id="${h(b.id)}" data-revision="${b.revision}"`)}</div>`:'';
      const summary=`<div class="budget-summary-grid"><article><span>Effective allowance</span><strong>${responsiveAmount(planned,b.currency)}</strong></article><article><span>Spent</span><strong class="${Number(actual)>Number(planned)?'bad':'spend'}">${responsiveAmount(actual,b.currency)}</strong></article><article><span>Available after commitments</span><strong class="${Number(tracking[i].available_after_commitments)<0?'bad':'good'}">${responsiveAmount(tracking[i].available_after_commitments,b.currency)}</strong><small>Remaining ${amount(remaining,b.currency)} less commitments ${amount(tracking[i].total_committed,b.currency)}</small></article><article><span>Forecast headroom</span><strong class="${Number(forecasts[i].forecast_headroom)<0?'bad':'good'}">${forecasts[i].forecast_headroom==null?'Unavailable':responsiveAmount(forecasts[i].forecast_headroom,b.currency)}</strong><small>${h(forecasts[i].status==='limited_history'?'Limited history':forecasts[i].reason)}</small></article></div>`;
      const commitmentRows=commitments[i].data.map(item=>[h(item.due_date),h(item.title),h(categoryName(item.category_id)),amount(item.amount,b.currency),h(item.state==='needs_review'?'Needs review':item.state==='posted'?'Posted':item.state==='skipped'?'Skipped':'Committed')]);
      const commitmentsPanel=`<h3>Scheduled commitments</h3><p class="helper">Available after commitments is remaining limit minus planned commitments that are not matched to a posted expense. Record the expense and match it in Planner. An unmatched payment and commitment may temporarily both appear; review any "Needs review" item.</p>${table(['Due','Item','Category','Amount','State'],commitmentRows)}`;
      const forecast=forecasts[i];
      const forecastPanel=`<h3>Month-end forecast</h3>${forecast.status==='limited_history'?`<div class="budget-summary-grid"><article><span>Forecast headroom</span><strong class="${Number(forecast.forecast_headroom)<0?'bad':'good'}">${responsiveAmount(forecast.forecast_headroom,b.currency)}</strong><small>Limited history · as of ${h(forecast.as_of)}</small></article><article><span>Forecast spending</span><strong>${responsiveAmount(forecast.forecast_spending,b.currency)}</strong></article></div>${Number(forecast.forecast_headroom)<0?`<p class="helper">Projected over allowance by ${amount(analyticsView.negate(forecast.forecast_headroom),b.currency)}. Review variable spending and upcoming commitments, then edit the plan if needed.</p>`:''}`:`<p class="helper">Forecast unavailable: ${h(forecast.reason)}</p>`}${forecast.quality_flags.includes('possible_unmatched_payment')?'<p class="helper">A recorded expense may match a planned commitment. Review it in Planner to avoid counting both.</p>':''}<details><summary>How estimated</summary><p class="helper">${h(forecast.reason)} Recorded spending ${amount(forecast.spent,b.currency)} + unmatched commitments ${amount(forecast.unmatched_commitments,b.currency)} + estimated remaining variable spending ${amount(forecast.remaining_variable_estimate,b.currency)}. Elapsed variable spending ${amount(forecast.elapsed_variable_spending,b.currency)} over ${h(forecast.elapsed_days)} days, projected across ${h(forecast.remaining_days)} remaining days in a ${h(forecast.total_days)}-day month. Coverage is unconfirmed; this is a budget estimate, not a cash balance.</p>${forecast.quality_flags.length?`<p class="helper">Data notes: ${h(forecast.quality_flags.join(', ').replace(/_/g,' '))}.</p>`:''}</details>`;
      const amendmentRows=histories[i].data.filter(entry=>entry.action==='budget_amendment'&&entry.after?.last_amendment).reverse().map(entry=>[h(new Date(entry.created_at).toLocaleString()),h(entry.after.last_amendment.reason),amount(entry.after.last_amendment.total_allowance_delta,b.currency)]);
      const amendmentHistory=`<details><summary>Plan amendment history · ${amendmentRows.length}</summary>${table(['Saved','Reason','Limit change'],amendmentRows)}</details>`;
      const incomeNote=`<div class="budget-summary-grid"><article><span>Recorded income</span><strong>${responsiveAmount(recorded.income,b.currency)}</strong></article><article><span>Planned savings</span><strong>${responsiveAmount(plannedSavings,b.currency)}</strong></article><article><span>Recorded income less spending</span><strong class="${Number(actualSavings)<0?'bad':'good'}">${responsiveAmount(actualSavings,b.currency)}</strong></article><article><span>Income left after limits and savings goal</span><strong class="${Number(afterPlan)<0?'bad':'good'}">${responsiveAmount(afterPlan,b.currency)}</strong></article></div><p class="helper">Recorded income less spending is a cash-flow measure. Investment additions and transfers are excluded from spending; compare those separately in Investments.</p>`;
      const peoplePanel=`<h3>People · budget used</h3><p class="helper">Expense shares, regardless of who paid. Shared pool is intentional; Unassigned needs review. ${people[i].meta.visibility==='authorized_accounts_only'?'Visible accounts only; private accounts may make this a subset.':''}</p>${table(['Person or pool','Allowance','Budget used','Committed','Available','Categories','Transactions'],people[i].data.map(row=>[h(row.name),row.allowance==null?'No limit set':amount(row.allowance,b.currency),amount(row.spent,b.currency),amount(row.committed,b.currency),row.available_after_commitments==null?'—':amount(row.available_after_commitments,b.currency),button('View','budget-matrix-detail',`data-budget="${h(b.id)}" data-destination="${h(row.destination)}"`),button('View','budget-allocation-detail',`data-budget="${h(b.id)}" data-destination="${h(row.destination)}"`)]))}<p class="helper">Visible spending: ${amount(people[i].total_spent,b.currency)} · commitments: ${amount(people[i].total_committed,b.currency)}.</p>`;
      const categoryCards=`<div class="budget-progress-list">${lines.map(l=>{const percent=Number(l.planned)>0?Math.max(0,Math.min(100,Number(l.actual)/Number(l.planned)*100)):0;return `<article class="budget-progress"><div><strong>${h(categoryName(l.category_id))}${l.mode==='pooled'?' · Pool':''}</strong><span>${amount(l.actual,b.currency)} of ${amount(l.planned,b.currency)}</span></div><div class="budget-track" role="progressbar" aria-label="${h(categoryName(l.category_id))} budget used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(percent)}"><span class="budget-fill ${Number(l.remaining)<0?'red':percent>=80?'orange':'green'}" style="width:${percent}%"></span></div><small class="${Number(l.remaining)<0?'negative':''}">${Number(l.remaining)<0?'Over by':'Remaining'} ${amount(Number(l.remaining)<0?analyticsView.negate(l.remaining):l.remaining,b.currency)}</small></article>`;}).join('')||empty('No category limits yet.')}</div><p class="budget-unbudgeted">Unbudgeted spending <strong>${amount(tracking[i].unbudgeted,b.currency)}</strong></p>`;
      const title=`${b.name || b.month} · ${b.state}`;
      return {
        top:panel(title,actions+summary+`${Number(forecast.forecast_headroom)<0?`<p class="helper">Projected over allowance by ${amount(analyticsView.negate(forecast.forecast_headroom),b.currency)}. Review variable spending and upcoming commitments.</p>`:''}<h3>Upcoming obligations</h3>${commitments[i].data.filter(item=>item.state==='planned'||item.state==='needs_review').length?table(['Due','Item','Amount','State'],commitments[i].data.filter(item=>item.state==='planned'||item.state==='needs_review').slice(0,5).map(item=>[h(item.due_date),h(item.title),amount(item.committed,b.currency),h(item.state==='needs_review'?'Needs review':'Committed')])):empty('No open budget commitments for this month.')}<h3>People summary</h3>${table(['Person or pool','Used','Committed','Available'],people[i].data.slice(0,4).map(row=>[h(row.name),amount(row.spent,b.currency),amount(row.committed,b.currency),row.available_after_commitments==null?'—':amount(row.available_after_commitments,b.currency)]))}<p class="helper">Source coverage is unconfirmed. Values include only accounts visible to you.</p>`),
        people:panel(title,peoplePanel),
        categories:panel(title,`<h3>Category limits</h3><p class="helper">Exact limits cover one category. Pooled limits cover that category and its descendants once.</p>${categoryCards}<h3>Detailed variance</h3>${table(['Category','Coverage','Limit','Actual','Committed','Available','People','Transactions'],lines.map(l=>[h(categoryName(l.category_id)),h(l.mode==='pooled'?'Pooled':'Exact'),amount(l.planned,b.currency),amount(l.actual,b.currency),amount(l.committed,b.currency),amount(l.available_after_commitments,b.currency),button('View','budget-matrix-detail',`data-budget="${h(b.id)}" ${l.mode==='pooled'?'data-line-category':'data-category'}="${h(l.category_id)}"`),button('View','budget-allocation-detail',`data-budget="${h(b.id)}" ${l.mode==='pooled'?'data-line-category':'data-category'}="${h(l.category_id)}"`)]))}<h3>Unbudgeted categories</h3>${table(['Category','Spent','People','Transactions'],(tracking[i].unbudgeted_lines||[]).map(l=>[h(categoryName(l.category_id)),amount(l.actual,b.currency),button('View','budget-matrix-detail',`data-budget="${h(b.id)}" data-category="${h(l.category_id||'uncategorized')}"`),button('View','budget-allocation-detail',`data-budget="${h(b.id)}" data-category="${h(l.category_id||'uncategorized')}"`)]))}`),
        ahead:panel(title,actions+forecastPanel+commitmentsPanel+incomeNote+amendmentHistory+`<h3>Spending through the month</h3>${chart}<p class="helper">The guide divides the full monthly limit evenly across days; it is a reference, not a forecast. Recorded values include unbudgeted spending. The prior month may end on an earlier calendar day. Flat lines do not confirm complete coverage.</p><details class="budget-day-details"><summary>Show daily amounts</summary>${dailyDetails}</details>`)
      };
    });
    const tabs=[['top','Top View'],['people','People'],['categories','Categories'],['ahead','Plan Ahead']];
    const tabBar=`<div class="analytics-view-tabs budget-view-tabs" role="tablist" aria-label="Budget sections">${tabs.map(([key,label])=>`<button type="button" id="budget-tab-${key}" role="tab" data-action="budget-tab" data-tab="${key}" aria-controls="budget-panel-${key}" aria-selected="${state.budgetTab===key}" tabindex="${state.budgetTab===key?'0':'-1'}" class="${state.budgetTab===key?'active':''}">${label}</button>`).join('')}</div>`;
    return heading('Monthly budgets',`${state.month} · ${state.scope}`)+coverage()+tabBar+tabs.map(([key])=>`<section id="budget-panel-${key}" role="tabpanel" aria-labelledby="budget-tab-${key}" ${state.budgetTab===key?'':'hidden'}>${sections.map(section=>section[key]).join('')}</section>`).join('');
  },
  async settlements() {
    const obligations=(await api.collection('settle-ups')).data;
    const currency=state.me.household.base_currency;
    const scale=new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits;
    const open=obligations.filter(v=>v.status==='open');
    const total=direction=>analyticsView.sumMoney(open.filter(v=>v.currency===currency&&v.direction===direction).map(v=>v.remaining),scale);
    const overview=`<section class="finance-hero"><div class="finance-hero-intro"><span class="section-kicker">PRIVATE SETTLEMENTS</span><h2>Know exactly what is outstanding.</h2><p>Loans and purchase splits stay separate from income and spending. Repayments reduce each person's balance.</p></div><div class="finance-metrics"><article><span>To collect</span><strong class="positive">${responsiveAmount(total('owed_to_me'),currency)}</strong><small>${open.filter(v=>v.direction==='owed_to_me'&&v.currency===currency).length} open obligations</small></article><article><span>To pay</span><strong class="negative">${responsiveAmount(total('i_owe'),currency)}</strong><small>${open.filter(v=>v.direction==='i_owe'&&v.currency===currency).length} open obligations</small></article><article><span>People</span><strong>${new Set(open.map(v=>v.person.toLowerCase())).size}</strong><small>With an open balance</small></article></div></section>`;
    const byPerson=new Map();
    for(const v of open) {const key=JSON.stringify([v.person.toLowerCase(),v.direction,v.currency]);const entry=byPerson.get(key)||{person:v.person,direction:v.direction,currency:v.currency,amounts:[]};entry.amounts.push(v.remaining);byPerson.set(key,entry);}
    const people=[...byPerson.values()].sort((a,b)=>a.person.localeCompare(b.person)).map(v=>`<article class="person-chip"><span class="person-avatar" aria-hidden="true">${h(v.person.slice(0,1).toUpperCase())}</span><span><strong>${h(v.person)}</strong><small>${h(v.direction==='owed_to_me'?'Owes me':'I owe')}</small></span><b>${responsiveAmount(analyticsView.sumMoney(v.amounts,new Intl.NumberFormat('en',{style:'currency',currency:v.currency}).resolvedOptions().maximumFractionDigits),v.currency)}</b></article>`).join('');
    const filters=[['open','Open'],['owed_to_me','Owed to me'],['i_owe','I owe'],['settled','Settled'],['all','All']];
    const tabs=`<div class="finance-tabs" role="group" aria-label="Filter obligations">${filters.map(([key,label])=>`<button type="button" class="${state.settlementFilter===key?'active':''}" data-action="settlement-filter" data-filter="${key}" aria-pressed="${state.settlementFilter===key}">${label}</button>`).join('')}</div>`;
    const visible=obligations.filter(v=>state.settlementFilter==='all'||(state.settlementFilter==='open'?v.status==='open':state.settlementFilter==='settled'?v.status==='settled':v.status==='open'&&v.direction===state.settlementFilter));
    const cards=visible.map(v=>{
      const paid=analyticsView.difference(v.amount,v.remaining),ratio=Math.max(0,Math.min(100,Number(paid)/Number(v.amount)*100));
      const history=v.repayments.length?`<details class="finance-history"><summary>Payment history <span>${v.repayments.length}</span></summary><div class="finance-history-rows">${v.repayments.map(payment=>`<div><span><strong>${h(payment.date)}</strong><small>${h(payment.note||'Repayment')}</small></span><b>${amount(payment.amount,v.currency)}</b>${button('Remove payment','repayment-remove',`data-id="${h(v.id)}" data-payment="${h(payment.id)}" data-revision="${v.revision}"`)}</div>`).join('')}</div></details>`:'';
      return `<article class="finance-card settlement-card"><div class="finance-card-head"><span class="person-avatar" aria-hidden="true">${h(v.person.slice(0,1).toUpperCase())}</span><div><span class="finance-eyebrow">${h(v.kind==='split'?'PURCHASE SPLIT':v.kind==='loan'?'LOAN':'PERSONAL DEBT')}</span><h3>${h(v.person)}</h3></div><span class="finance-badge ${v.status==='settled'?'complete':v.direction==='i_owe'?'outgoing':'incoming'}">${h(v.status==='settled'?'Settled':v.direction==='i_owe'?'I owe':'Owes me')}</span></div><div class="finance-card-amount"><span>Remaining</span><strong>${responsiveAmount(v.remaining,v.currency)}</strong><small>of ${amount(v.amount,v.currency)} · opened ${h(v.date)}</small></div><p class="finance-description">${h(v.description)}</p><div class="finance-progress" role="progressbar" aria-label="Amount repaid" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(ratio)}"><span style="width:${ratio}%"></span></div><div class="finance-progress-caption"><span>Repaid ${amount(paid,v.currency)}</span><span>${Math.round(ratio)}%</span></div>${history}<div class="finance-card-actions">${v.status==='open'?button('Record payment','repayment',`data-id="${h(v.id)}"`):''}${button('Edit','settlement-edit',`data-id="${h(v.id)}"`)}${dangerButton(v.split_id?'Delete split':'Delete','settlement-delete',`data-id="${h(v.id)}" data-revision="${v.revision}" data-split="${v.split_id?'true':'false'}"`)}</div></article>`;
    }).join('');
    return heading('Settle up','Track each person, payment, and shared purchase.',button('Add loan or debt','settlement')+button('Split a purchase','split'))+overview+(people?`<section class="finance-section"><div class="finance-section-head"><h2>People with open balances</h2><small>Amounts stay in their original currency</small></div><div class="person-grid">${people}</div></section>`:'')+`<section class="finance-section"><div class="finance-section-head"><h2>Obligations</h2><small>${visible.length} shown</small></div>${tabs}<div class="finance-card-grid">${cards||`<div class="finance-empty">${empty('No obligations match this filter.')}${button('Add loan or debt','settlement')}</div>`}</div></section><p class="helper finance-footnote">Record a bank or cash transfer separately when a payment should change an account balance. Deleting a split removes its linked obligations but leaves the original expense.</p>`;
  },
  async investments() {
    const holdings=await allInvestments();
    const currency=state.me.household.base_currency;
    const inCurrency=holdings.filter(v=>v.currency===currency);
    const scale=new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits;
    const lastKnown=inCurrency.filter(v=>v.current_value!=null);
    const valued=lastKnown.filter(v=>v.gain_loss!=null);
    const sum=(items,key)=>analyticsView.sumMoney(items.map(v=>v[key]),scale);
    const added=analyticsView.sumMoney(inCurrency.map(v=>v.records.find(r=>r.month===state.month)?.contribution||'0'),scale);
    const summary=`<section class="finance-hero"><div class="finance-hero-intro"><span class="section-kicker">YOUR PORTFOLIO</span><h2>A clearer view of what you added and what changed.</h2><p>Values are the last amounts you recorded for each holding, not live market prices. Their valuation months may differ.</p></div><div class="finance-metrics"><article><span>Last recorded values</span><strong>${lastKnown.length?responsiveAmount(sum(lastKnown,'current_value'),currency):'No valuation'}</strong><small>${lastKnown.length} of ${inCurrency.length} ${h(currency)} holdings have a value${lastKnown.length-valued.length?` · ${lastKnown.length-valued.length} await a new valuation after activity`:''}</small></article><article><span>Baseline + net additions in valued holdings</span><strong>${valued.length?responsiveAmount(sum(valued,'net_contributions'),currency):'No valuation'}</strong><small>Starting value plus contributions less withdrawals</small></article><article><span>Value change</span><strong class="investment-gain ${investmentGainTone(valued.length?sum(valued,'gain_loss'):'0',valued.length>0)}">${valued.length?responsiveAmount(sum(valued,'gain_loss'),currency):'No valuation'}</strong><small>From starting value plus recorded additions; excludes holdings awaiting a new valuation</small></article><article><span>Added in ${h(state.month)}</span><strong>${responsiveAmount(added,currency)}</strong><small>Across ${h(currency)} holdings</small></article></div></section>`;
    const filters=[['all','All'],['investment','Investments'],['emergency_fund','Emergency funds']];
    const tabs=`<div class="finance-tabs" role="group" aria-label="Filter holdings">${filters.map(([key,label])=>`<button type="button" class="${state.investmentFilter===key?'active':''}" data-action="investment-filter" data-filter="${key}" aria-pressed="${state.investmentFilter===key}">${label}</button>`).join('')}</div>`;
    const cards=holdings.filter(v=>state.investmentFilter==='all'||v.type===state.investmentFilter).map(v=>{
      const latest=v.records.at(-1);
      const current=v.records.find(r=>r.month===state.month),pct=Number(v.target)>0&&v.current_value!=null?Math.max(0,Math.min(100,Number(v.current_value)/Number(v.target)*100)):null;
      const goal=v.target?`<div class="finance-goal"><div><span>${h(v.type==='emergency_fund'?'Emergency target':'Target value')}</span><strong>${amount(v.target,v.currency)}</strong></div><div class="finance-progress" role="progressbar" aria-label="Target progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct==null?0:Math.round(pct)}"><span style="width:${pct||0}%"></span></div><small>${pct==null?'Add a valuation to see progress.':`${Math.round(pct)}% reached`}</small></div>`:'';
      const monthly=v.monthly_goal?`<p class="finance-goal-note">${h(state.month)} added <strong>${amount(current?.contribution||'0',v.currency)}</strong> of ${amount(v.monthly_goal,v.currency)} monthly goal</p>`:'';
      const due=v.sip?sipDueDate(v.sip,state.month):null;
      const sip=v.sip?`<div class="finance-sip"><strong>SIP · ${amount(v.sip.amount,v.currency)} monthly</strong><small>${v.sip.status==='paused'?'Paused':due?`Planned for ${h(due)}`:state.month<v.sip.start_month?`Starts ${h(v.sip.start_month)}`:'Outside schedule'}${v.sip.end_month?` · ends ${h(v.sip.end_month)}`:''}</small>${due?`<small>${current?.sip_processed?'Processed':'Recorded additions'} in ${h(state.month)}: ${amount(current?.contribution||'0',v.currency)}</small>`:''}</div>`:'';
      const history=v.records.length?`<details class="finance-history"><summary>Monthly history <span>${v.records.length}</span></summary><div class="finance-history-rows">${[...v.records].reverse().map(r=>`<div><span><strong>${h(r.month)}</strong><small>Added ${amount(r.contribution,v.currency)} · Withdrawn ${amount(r.withdrawal,v.currency)}</small></span><b>${r.value==null?'Valuation pending':amount(r.value,v.currency)}<small>${r.gain_loss==null?'Add a valuation for change':`Change ${amount(r.gain_loss,v.currency)}`}</small></b>${investmentMovementActions(r,v)}${button('Delete month','investment-month-delete',`data-id="${h(v.id)}" data-month="${h(r.month)}" data-revision="${v.revision}"`)}</div>`).join('')}</div></details>`:'';
      return `<article class="finance-card investment-card"><div class="finance-card-head"><span class="finance-icon" aria-hidden="true">${v.type==='emergency_fund'?'✚':'↗'}</span><div><span class="finance-eyebrow">${h(v.type==='emergency_fund'?'EMERGENCY FUND':v.asset_class==='stock_market'?'STOCK MARKET':v.sip?'SIP':'LUMP SUM FUND')}</span><h3>${h(v.name)}</h3></div><span class="finance-badge">${h(v.currency)}</span></div><div class="finance-card-amount"><span>Current value</span><strong>${responsiveAmount(v.current_value,v.currency)}</strong><small>${v.valuation_month?`Valued ${h(v.valuation_month)}`:'No value recorded yet'}</small></div><div class="finance-inline-metrics"><div><span>Baseline + net additions</span><strong>${responsiveAmount(v.net_contributions,v.currency)}</strong></div><div><span>Value change</span><strong class="investment-gain ${investmentGainTone(v.gain_loss,v.gain_loss!=null)}">${v.gain_loss==null?'Valuation pending':responsiveAmount(v.gain_loss,v.currency)}</strong></div></div>${goal}${monthly}${sip}${history}<div class="finance-card-actions">${button('Add or correct month','investment-month',`data-id="${h(v.id)}"`)}${due&&!current?.sip_processed&&!(Number(current?.contribution)>0||Number(current?.withdrawal)>0)?button('Process SIP','investment-process-sip',`data-id="${h(v.id)}"`):''}${v.type==='investment'?button(v.sip?'Edit SIP':'Set up SIP','investment-sip',`data-id="${h(v.id)}"`):''}${button('Edit plan','investment-edit',`data-id="${h(v.id)}"`)}${dangerButton('Delete holding','investment-delete',`data-id="${h(v.id)}" data-revision="${v.revision}"`)}</div></article>`;
    }).join('');
    return heading('Investments','Manage holdings, SIP schedules, emergency funds, and monthly valuations.',button('Add investment or fund','investment'))+summary+`<section class="finance-section"><div class="finance-section-head"><div><h2>Holdings</h2><p>${h(holdings.length)} tracked · Value change includes market movement, interest, and unrecorded cash flows.</p></div></div>${tabs}<div class="finance-card-grid">${cards||`<div class="finance-empty">${empty('No holdings match this filter.')}${button('Add investment or fund','investment')}</div>`}</div></section><p class="helper finance-footnote">SIP schedules are plans. Press Process SIP to post a monthly account transaction; add a valuation separately when known. Last recorded values include holdings whose valuations are stale after later activity; value change excludes them. Other currencies stay in their own cards.</p>`;
  },
  async imports(parts,generation) { return importView(parts,generation); },
  async reconcile(parts) {
    const [sessions,checkLists]=await Promise.all([api.collection(`reconciliation/sessions?month=${state.month}`),Promise.all(state.accounts.filter(a=>a.subtype!=='settle_up').map(async account=>({account,checks:(await api.collection(`accounts/${id(account.id)}/balance-checks?${new URLSearchParams(period())}`)).data})))]);
    const selected=sessions.data.find(s=>s.id===parts[0]); state.session=selected || null;
    const checks=checkLists.flatMap(({account,checks})=>checks.filter(c=>!c.voided).map(c=>({account,check:c}))).sort((a,b)=>b.check.as_of.localeCompare(a.check.as_of));
    const differences=checks.filter(({check})=>check.current_variance==null || Number(check.current_variance)!==0);
    const reviewAccounts=state.accounts.filter(a=>['bank','credit_card'].includes(a.subtype));
    const inboxItems=reviewAccounts.map(a=>{const s=sessions.data.find(v=>v.account_id===a.id);const owner=state.members.find(m=>m.user_id===a.owner_id);return `<li class="compact-item review-inbox-item"><div class="compact-item-main"><span class="account-glyph" aria-hidden="true">${a.subtype==='credit_card'?'▤':'⌂'}</span><div class="compact-item-copy"><strong>${h(a.name)}</strong><span>${h(a.subtype==='credit_card'?'Credit card':'Bank account')} · ${h(owner?.name||'Household member')}</span></div></div><div class="compact-item-end"><span class="quiet-tag ${s?.stale?'stale':s?.state==='closed'?'done':''}">${h(s?.stale?'Stale review':s?.state==='closed'?'Closed':s?'Open':'Not started')}</span>${s?.current?.unresolved_count==null?'':`<small>${h(s.current.unresolved_count)} unresolved</small>`}</div><div class="compact-item-actions">${s?button('Open review','open-session',`data-id="${h(s.id)}"`):button('Start review','review-account',`data-id="${h(a.id)}"`)}</div></li>`;}).join('');
    const inbox=panel('Shared review inbox',`<p class="helper">Everyone with account access can review it, including accounts another member shared. Each decision records who made it.</p>${inboxItems?`<ul class="compact-list" aria-label="Account reviews for ${h(state.month)}">${inboxItems}</ul>`:empty('No bank or card accounts available. Share an account in Settings to make it available here.')}`);
    let content=heading('Reconciliation','Review bank evidence and dated balance differences.',selected||parts[0]==='balance'?navButton('reconcile','All reviews'):'');
    if(!selected && parts[0]!=='balance') content+=inbox;
    if(selected) content+=`<div id="reconcile-comparison">${await reconciliationComparison(selected)}</div>`;
    content+=panel('Balance differences',`<p>${differences.length} checks need review in ${h(state.month)}. Difference = entered balance minus the balance computed from the starting balance and transactions.</p>`+table(['Account','As of','Entered','Computed','Difference',''],differences.map(({account,check})=>[h(account.name),h(check.as_of),amount(check.amount,account.currency),amount(check.current_calculated,account.currency),check.current_variance==null?'Starting balance needed':amount(check.current_variance,account.currency),button('Compare balances','review-balance',`data-account="${h(account.id)}" data-check="${h(check.id)}"`)]))+`<p class="helper">Correct a mistaken check in Accounts. If the check is right, review missing or incorrect transactions; changing a check does not create a transaction.</p>`);
    if(parts[0]==='balance') {
      const account=state.accounts.find(a=>a.id===parts[1]);
      const check=checks.find(v=>v.account.id===parts[1] && v.check.id===parts[2])?.check;
      if(account && check) {
        const ledger=await api.collection(`accounts/${id(account.id)}/ledger`);
        const cutoff=new Date(check.as_of).getTime();
        const rows=ledger.data.filter(r=>new Date(r.effective_at).getTime()<=cutoff).slice(0,100);
        content+=panel(`${account.name} · balance comparison`,
          `<div class="balance-compare"><div><small>Entered balance · ${h(check.as_of)}</small><strong>${amount(check.amount,account.currency)}</strong></div><div><small>Computed from starting balance</small><strong>${amount(check.current_calculated,account.currency)}</strong></div><div><small>Unexplained difference</small><strong>${amount(check.current_variance,account.currency)}</strong></div></div>`+
          `<p class="helper">The displayed ledger can use this observed check as an anchor. The computed column always uses the starting balance and recorded movements. Matching statement evidence does not change this difference; correct an incorrect transaction, add a missing transaction, or correct the check.</p>`+
          table(['Date','Transaction','Movement','Computed from start','Displayed balance',''],rows.map(r=>[h(r.effective_date),h(r.description),r.movement==null?'—':amount(r.movement,r.currency),amount(r.computed_from_start,r.currency),`${amount(r.balance_after,r.currency)}<small>${h(balanceLabel(r))}</small>`,r.transaction_id?button('Inspect','transaction-detail',`data-id="${h(r.transaction_id)}"`):['opening_balance','balance_check'].includes(r.event_type)?'Balance anchor':'Private transfer']))+
          button('Add missing transaction','add-reconcile-transaction',`data-account="${h(account.id)}"`)+button('Open account ledger','account-ledger',`data-id="${h(account.id)}"`));
      }
    }
    return content;
  },
  async settings() {
    const members=await api.request(`households/${id(state.me.household.id)}/members`);
    const canInvite=['owner','admin'].includes(state.me.membership.role);
    let quickPanel='', widgetPanel='';
    if(state.me.membership.role==='owner') {
      const initialWidgets=await api.request('settings/widgets');
      const widgetUser=initialWidgets.members.some(m=>m.id===state.widgetSettingsUser)?state.widgetSettingsUser:initialWidgets.members.some(m=>m.id===initialWidgets.user_id)?initialWidgets.user_id:state.me.user.id;
      const widgets=widgetUser===(initialWidgets.user_id||state.me.user.id)?initialWidgets:await api.request(`settings/widgets?user_id=${encodeURIComponent(widgetUser)}`);
      const calendarScope=['personal','family','combined'].includes(state.widgetCalendarScope)?state.widgetCalendarScope:'personal';
      const calendarAccount=widgets.accounts.some(a=>a.id===state.widgetCalendarAccount)?state.widgetCalendarAccount:'';
      state.widgetCalendarAccount=calendarAccount;
      const calendarUrl=`${location.origin}/api/v1/widgets/expense-calendar?scope=${calendarScope}${calendarAccount?`&account_id=${encodeURIComponent(calendarAccount)}`:''}`;
      widgetPanel=panel('Widget analytics API',`<form id="widget-settings-form">${field('Show data visible to',`<select id="widget-user-select" name="user_id">${widgets.members.map(m=>option(m.id,`${m.name} · ${m.email}`,m.id===widgetUser)).join('')}</select>`)}<label class="confirm-line"><input type="checkbox" name="enabled" ${widgets.enabled?'checked':''}> Enable unauthenticated widget analytics</label><label class="confirm-line"><input type="checkbox" name="family_enabled" ${widgets.family_enabled?'checked':''}> Allow Family and Combined spending scopes</label><label class="confirm-line"><input type="checkbox" name="accounts_enabled" ${widgets.accounts_enabled?'checked':''}> Expose accessible account balances and last transaction dates</label><p class="helper">Anyone who can reach an enabled URL can read the allowed data. Keep these URLs on your trusted LAN or private VPN. Responses may be cached for five minutes.</p><p class="helper">Spending URL: <code>${h(location.origin)}/api/v1/widgets/spending</code><br>Accounts URL: <code>${h(location.origin)}/api/v1/widgets/accounts</code></p><button type="submit" class="primary-button">Save widget settings</button></form><div class="widget-calendar-controls"><h3>Expense calendar URL</h3><p class="helper">Choose a view and an account to build the URL for your script. Family and Combined require the Family scope switch above. Save widget settings before using the URL. URL choices do not restrict other allowed widget URLs.</p>${field('Spending view',`<select id="widget-calendar-scope">${option('personal','Personal',calendarScope==='personal')}${option('family','Family',calendarScope==='family')}${option('combined','Personal + Family',calendarScope==='combined')}</select>`)}${field('Account',`<select id="widget-calendar-account">${option('','All accessible accounts',!calendarAccount)}${widgets.accounts.map(a=>option(a.id,`${a.name} · ${a.currency}`,a.id===calendarAccount)).join('')}</select>`)}<p class="helper">Calendar URL: <code id="widget-calendar-url">${h(calendarUrl)}</code></p>${button('Copy calendar URL','copy-widget-calendar-url')}</div>`);
      state.widgetSettingsRevision=widgets.revision;
      const initial=await api.request('settings/quick-expense');
      const selected=state.quickSettingsUser||(initial.members.some(m=>m.id===initial.user_id)?initial.user_id:state.me.user.id);
      const quick=selected===(initial.user_id||state.me.user.id)?initial:await api.request(`settings/quick-expense?user_id=${encodeURIComponent(selected)}`);
      const sameUser=!quick.user_id||quick.user_id===selected;
      const allowed=sameUser?quick.account_ids:[];
      const defaultId=sameUser?quick.default_account_id:'';
      quickPanel=panel('Apple Shortcuts quick expense',`<form id="quick-expense-settings-form">${field('Record expenses as',`<select id="quick-user-select" name="user_id" required>${quick.members.map(m=>option(m.id,`${m.name} · ${m.email}`,m.id===selected)).join('')}</select>`)}<p class="helper">This feature starts disabled. Anyone who can reach its API can add expenses as this user. Keep the API on your trusted LAN or private VPN; never expose it through a public reverse proxy or tunnel.</p><fieldset class="quick-account-list"><legend>Allowed accounts</legend>${quick.accounts.map(a=>`<label class="confirm-line"><input type="checkbox" name="quick_account_id" value="${h(a.id)}" ${allowed.includes(a.id)?'checked':''}> ${h(a.name)} · ${h(a.currency)}</label>`).join('')||'<p>No accounts accessible to this user and the owner.</p>'}</fieldset>${field('Default account',`<select name="default_account_id">${option('','Choose an account',!defaultId)}${quick.accounts.map(a=>option(a.id,`${a.name} · ${a.currency}`,a.id===defaultId)).join('')}</select>`)}<label class="confirm-line"><input type="checkbox" name="enabled" ${quick.enabled?'checked':''}> Enable unauthenticated quick expenses</label><button type="submit" class="primary-button">Save quick expense settings</button><p class="helper">Shortcut URL: <code>${h(location.origin)}/api/v1/quick-transactions</code>. The options URL ends in <code>/options</code>.</p></form>`);
      state.quickSettingsRevision=quick.revision;
    }
    const privateAccounts=state.accounts.filter(a=>a.owner_id===state.me.user.id&&a.visibility==='private');
    const privateCategories=state.categories.filter(c=>c.owner_id===state.me.user.id&&c.visibility==='private');
    const accessList=(items,label)=>items.length?`<ul class="compact-list" aria-label="${h(label)}">${items.join('')}</ul>`:empty(`No ${label.toLowerCase()} to move.`);
    const accountRows=privateAccounts.map(a=>`<li class="compact-item access-item"><div class="compact-item-main"><span class="account-glyph" aria-hidden="true">${a.subtype==='credit_card'?'▤':a.subtype==='cash'?'¤':'⌂'}</span><div class="compact-item-copy"><strong>${h(a.name)}</strong><span>${h(a.subtype.replace('_',' '))} · ${h(a.currency)}</span></div></div><div class="compact-item-actions">${button('Move to household','share-account',`data-id="${h(a.id)}"`)}</div></li>`);
    const categoryRows=privateCategories.map(c=>`<li class="compact-item access-item"><div class="compact-item-main"><span class="account-glyph" aria-hidden="true">●</span><div class="compact-item-copy"><strong>${h(categoryName(c.id))}</strong><span>${h(c.kind)} category</span></div></div><div class="compact-item-actions">${button('Move to household','share-category',`data-id="${h(c.id)}"`)}</div></li>`);
    const householdAccess=panel('Move to household access',`<p class="helper access-intro">Sharing an account gives every member access to its full history. Share any personal categories it uses first.</p><div class="access-groups"><section><h3>Your personal accounts</h3>${accessList(accountRows,'Personal accounts')}</section><section><h3>Your personal categories</h3>${accessList(categoryRows,'Personal categories')}</section></div>`);
    const invite=canInvite?panel('Add a member',`<form id="invite-form">${field('Email address',input('email','type="email" required autocomplete="email"'))}${field('Role',`<select name="role">${option('member','Member')}${state.me.membership.role==='owner'?option('admin','Admin'):''}</select>`)}<p class="helper">Create a one-day invitation link and share it with the intended person. FinWise does not send email. Private accounts stay private unless you grant access.</p><button type="submit" class="primary-button">Create invitation link</button></form>${state.inviteLink?`<div class="invite-link">${field('Share this link now',input('link',`readonly value="${h(state.inviteLink)}"`))}${button('Copy link','copy-invite-link')}</div>`:''}`):'';
    const familySetting=panel('Family only mode',`<form id="family-mode-form"><label class="confirm-line"><input type="checkbox" name="family_only" ${familyMode()?'checked':''} ${canInvite?'':'disabled'}> Use Family for all household finances</label><p class="helper">When enabled, existing personal transactions, categories, accounts, plans, and budgets become family records. Private account history becomes visible to household members. Turning this off restores the scope choices but does not make converted records private again.</p>${canInvite?'<button type="submit" class="primary-button">Save family mode</button>':'<p class="helper">An owner or admin can change this setting.</p>'}</form>`);
    return heading('Settings','Your connected household.')+panel('Household',table(['Setting','Value'],[['Name',h(state.me.household.name)],['Timezone',h(state.me.household.timezone)],['Currency',h(state.me.household.base_currency)],['Signed in as',h(state.me.user.email)],['Role',h(state.me.membership.role)]]))+familySetting+quickPanel+widgetPanel+(familyMode()?'':panel('Default transaction scope',`<form id="default-scope-form">${field('Scope for new transactions and imports',`<select name="scope">${option('personal','Personal',defaultTransactionScope()==='personal')}${option('family','Family',defaultTransactionScope()==='family')}</select>`)}<p class="helper">Saved in this browser for your account. You can choose a different scope during import review or when adding a transaction.</p><button type="submit" class="primary-button">Save default</button></form>`))+(!familyMode()?householdAccess:'')+panel('Members',table(['Name','Email','Role'],members.data.map(m=>[h(m.name),h(m.email),h(m.role)])))+invite+(canInvite?monthResetPanel():'')+panel('AI providers','<p>AI provider configuration is not available in this backend release.</p>')+button('Sign out','logout');
  },
  async more() {
    const groups=[
      ['Insights',['overview','household','analytics']],
      ['Your money',['transactions','recurring','planner','accounts','budgets','settlements','investments']],
      ['Workspace',['categories','statements','reconcile','changes','imports','settings']]
    ];
    return heading('More','All your household finance views.')+`<div class="mobile-more-index">${groups.map(([title,items])=>`<section class="panel more-section"><h2>${title}</h2><div class="mobile-more">${items.map(view=>navButton(view,labels[view])).join('')}</div></section>`).join('')}<div class="more-session">${button('Sign out','logout')}</div></div>`;
  }
};

function editor(title,fields,formId,submit='Save',host=dialog) {
  const drawer=host===transactionDrawer;
  host.innerHTML=`<div class="dialog-head"><h2 id="${drawer?'transaction-drawer-title':'editor-title'}">${h(title)}</h2><button type="button" class="icon-button" data-action="${drawer?'close-transaction-drawer':'close-editor'}" aria-label="Close">×</button></div><form id="${formId}">${fields}<div class="dialog-actions">${button('Cancel',drawer?'close-transaction-drawer':'close-editor')}<button class="primary-button" type="submit">${h(submit)}</button></div></form>`;
  addModalChips(host);
  if(drawer) {if(dialog.open)dialog.close();host.hidden=false;document.body.classList.add('transaction-drawer-open');}
  else dialog.showModal();
}
function detailDialog(title,body) {
  dialog.innerHTML=`<div class="dialog-head"><h2 id="editor-title">${h(title)}</h2><button type="button" class="icon-button" data-action="close-editor" aria-label="Close">×</button></div><div class="detail-dialog-body">${body}</div><div class="dialog-actions">${button('Close','close-editor')}</div>`;
  dialog.showModal();
}
async function budgetAllocationDetail(el) {
  const budget=await api.request(`budgets/${id(el.dataset.budget)}`);
  const query=new URLSearchParams();
  if(el.dataset.category) query.set('category_id',el.dataset.category);
  if(el.dataset.lineCategory) query.set('line_category_id',el.dataset.lineCategory);
  if(el.dataset.destination) query.set('destination',el.dataset.destination);
  const result=await api.collection(`budgets/${id(budget.id)}/allocations?${query}`);
  const destinationName=key=>key==='shared'?'Shared pool':key==='unassigned'?'Unassigned':state.members.find(member=>member.user_id===key)?.name||'Archived member';
  const title=el.dataset.lineCategory?`${categoryName(el.dataset.lineCategory)} pool`:el.dataset.category?(el.dataset.category==='uncategorized'?'Uncategorized':categoryName(el.dataset.category)):destinationName(el.dataset.destination);
  const rows=result.data.map(row=>[h(row.effective_date),h(row.description||'Transaction'),h(categoryName(row.category_id)),h(destinationName(row.destination)),amount(row.amount,budget.currency),h(state.members.find(member=>member.user_id===row.paid_by_user_id)?.name||'Unknown'),button('Open','analytics-open-transaction',`data-id="${h(row.transaction_id)}"`)]);
  if(dialog.open)dialog.close();
  detailDialog(`${title} · ${budget.month}`,`<p class="detail-lead">${rows.length} visible expense or refund allocation${rows.length===1?'':'s'} in this budget. Refunds reduce spending.</p>${table(['Date','Transaction','Category','Budget used by','Allocation','Paid by',''],rows)}<p class="helper">Only transactions you can access are shown. Private accounts can make this a subset of household spending.</p>`);
}
async function budgetMatrixDetail(el) {
  const budget=await api.request(`budgets/${id(el.dataset.budget)}`);
  const query=new URLSearchParams();
  if(el.dataset.category)query.set('category_id',el.dataset.category);
  if(el.dataset.lineCategory)query.set('line_category_id',el.dataset.lineCategory);
  if(el.dataset.destination)query.set('destination',el.dataset.destination);
  const result=await api.request(`budgets/${id(budget.id)}/matrix?${query}`);
  const destinationName=key=>key==='shared'?'Shared pool':key==='unassigned'?'Unassigned':state.members.find(member=>member.user_id===key)?.name||'Archived member';
  const categoryLabel=key=>key==null?'Uncategorized':categoryName(key);
  const title=el.dataset.lineCategory?`${categoryName(el.dataset.lineCategory)} pool`:el.dataset.category?categoryLabel(el.dataset.category==='uncategorized'?null:el.dataset.category):destinationName(el.dataset.destination);
  const rows=result.data.map(row=>[h(categoryLabel(row.category_id)),h(destinationName(row.destination)),amount(row.spent,budget.currency),button('Transactions','budget-allocation-detail',`data-budget="${h(budget.id)}" data-category="${h(row.category_id||'uncategorized')}" data-destination="${h(row.destination)}"`)]);
  if(dialog.open)dialog.close();
  detailDialog(`${title} · budget used`, `<p class="detail-lead">Visible net spending ${amount(result.total_spent,budget.currency)} in ${h(budget.month)}. Refunds reduce usage.</p>${table(['Category','Budget used by','Spent',''],rows)}<p class="helper">Amounts include only accounts you can access. These rows break down recorded usage; they do not create separate allowances.</p>`);
}
async function analyticsCategoryDetail(key,currency) {
  const query=new URLSearchParams({...period(),scope:state.scope,currency});
  if(key!=='uncategorized')query.set('category_id',key);
  const rows=(await api.collection(`analytics/transactions?${query}`)).data.flatMap(transaction=>(transaction.allocations||[]).filter(a=>key==='uncategorized'?a.category_id==null:a.category_id===key).filter(()=>['expense','refund'].includes(transaction.event_type)).map(a=>({transaction,allocation:a})));
  const name=key==='uncategorized'?'Uncategorized':categoryName(key);
  const signed=({transaction,allocation})=>transaction.event_type==='refund'?analyticsView.negate(allocation.amount):allocation.amount;
  const scale=new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits;
  const total=analyticsView.sumMoney(rows.map(signed),scale);
  detailDialog(`${name} · ${state.month}`,`<p class="detail-lead">Recorded net spending ${amount(total,currency)} across ${rows.length} allocation${rows.length===1?'':'s'} in the ${h(state.scope)} scope.</p>${key==='uncategorized'?'':button('Add transaction in this category','transaction-category-context',`data-category="${h(key)}"`)}${table(['Date','Transaction','Type','Allocation',''],rows.map(row=>[h(row.transaction.effective_date),h(row.transaction.description||'Transaction'),h(row.transaction.event_type),amount(signed(row),currency),button('Open','analytics-open-transaction',`data-id="${h(row.transaction.id)}"`)]))}<p class="helper">Refunds reduce spending. Each row is an allocation from a visible ledger transaction.</p>`);
}
async function analyticsInvestmentDetail(key) {
  const item=await api.request(`investments/${id(key)}`);
  const records=item.records.filter(r=>r.month<=state.month);
  const lastValued=[...records].reverse().find(r=>r.value!=null);
  const detailMonth=lastValued?.month||(item.opening_month<=state.month?item.opening_month:null);
  const detailValue=lastValued?.value??(detailMonth===item.opening_month?item.opening_value:null);
  const rows=records.map((record,index)=>[h(record.month),amount(record.contribution,item.currency),amount(record.withdrawal,item.currency),amount(record.net_contributions,item.currency),amount(record.value,item.currency),amount(record.gain_loss,item.currency),record.gain_loss==null?'Valuation pending':amount(analyticsView.difference(record.gain_loss,index&&records[index-1].gain_loss!=null?records[index-1].gain_loss:'0'),item.currency)]);
  if(item.opening_value!=null&&item.opening_month<=state.month)rows.unshift([`${h(item.opening_month)} · opening`,'—','—',amount(item.opening_value,item.currency),amount(item.opening_value,item.currency),amount('0',item.currency),'—']);
  detailDialog(item.name,`<p class="detail-lead">${h(item.type==='emergency_fund'?'Emergency fund':'Investment')} · ${h(item.currency)} · Records through ${h(state.month)}. ${detailMonth?`Latest recorded value ${amount(detailValue,item.currency)} in ${h(detailMonth)}.`:'No value recorded by this month.'}</p>${table(['Month','Added','Withdrawn','Net added','Value','Value change','Change since prior record'],rows)}<p class="helper">Value change uses the starting portfolio value plus recorded additions less withdrawals as its baseline. Change since the prior record is the difference between those two snapshots, including market movement, interest, and unrecorded cash flows.</p>`);
}
async function analyticsPersonDetail(person,direction,currency) {
  const obligations=(await api.collection('settle-ups')).data.filter(v=>v.person.toLowerCase()===person.toLowerCase()&&v.direction===direction&&v.currency===currency&&v.date.slice(0,7)<=state.month);
  const scale=new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits;
  const rows=obligations.map(item=>{const payments=item.repayments.filter(payment=>payment.date.slice(0,7)<=state.month);const paid=analyticsView.sumMoney(payments.map(payment=>payment.amount),scale);return {item,payments,paid,remaining:analyticsView.difference(item.amount,paid)};});
  const open=analyticsView.sumMoney(rows.map(row=>row.remaining),scale);
  const paymentRows=rows.flatMap(row=>row.payments.map(payment=>[h(payment.date),h(row.item.description),h(payment.note||'Payment'),amount(payment.amount,currency)]));
  detailDialog(`${person} · ${direction==='owed_to_me'?'Owes me':'I owe'}`,`<p class="detail-lead">At the end of ${h(state.month)}, ${amount(open,currency)} remained across ${rows.length} obligation${rows.length===1?'':'s'}.</p><h3>Obligations</h3>${table(['Opened','Description','Original','Paid by month-end','Remaining'],rows.map(row=>[h(row.item.date),h(row.item.description),amount(row.item.amount,currency),amount(row.paid,currency),amount(row.remaining,currency)]))}<h3>Payments through month-end</h3>${table(['Date','For','Note','Amount'],paymentRows)}<p class="helper">Later payments are excluded from this historical view. Deleting an obligation removes it from current and historical Analytics views.</p>`);
}

function monthResetPanel() {
  state.resetMonths ??= [state.month];
  const preview=state.resetPreview;
  const names={transactions:'Transactions',statement_entries:'Statement entries',reconciliation_sessions:'Reconciliation sessions',balance_checks:'Balance checks',budgets:'Budgets',import_rows:'Imported rows'};
  const total=preview?Object.values(preview.counts).reduce((sum,n)=>sum+n,0):0;
  return panel('Reset monthly data',`<p>Clear one or more months from accounts you can access, including shared activity, and your personal and family budgets. Other members’ private accounts and budgets are excluded.</p><p class="helper">Account setup, starting balances, categories, original uploaded files, and audit history are retained. Transactions and balance checks are voided. Reopen closed reconciliation sessions first. Removing activity may change later balances. Upload files again to reimport cleared months.</p><div class="reset-month-picker">${field('Month to add',input('reset_month','id="reset-month" type="month" value="'+h(state.month)+'"'))}${button('Add month','reset-add-month')}</div><ul class="reset-months" aria-label="Months to reset">${state.resetMonths.map(month=>`<li><span>${h(month)}</span>${button('Remove','reset-remove-month',`data-month="${h(month)}" aria-label="Remove ${h(month)}"`)}</li>`).join('')}</ul><form id="reset-preview-form"><button type="submit" class="outline-button" ${state.resetMonths.length?'':'disabled'}>Preview reset</button></form>${preview?`<div class="reset-preview"><h3>Reset preview · ${h(preview.months.join(', '))}</h3>${table(['Activity','Records to clear'],Object.entries(preview.counts).map(([kind,count])=>[h(names[kind]||kind),h(count)]))}${total?`<form id="reset-apply-form"><p>This cannot be undone in the app. Review the months and counts before continuing.</p>${field('Type RESET to confirm',input('confirmation','required pattern="RESET" autocomplete="off"'))}<button type="submit" class="primary-button reset-danger">Reset selected months</button></form>`:'<p role="status">No activity found in these months.</p>'}</div>`:''}`);
}
function addModalChips(host=dialog) {
  const formId=host.querySelector('form')?.id;
  const namePresets=formId==='account-form'||formId==='account-edit-form'?['Savings','Cash','Credit card']:formId==='category-form'?['Groceries','Transport','Utilities']:['budget-form','budget-edit-form'].includes(formId)?[`${state.month} budget`]:[];
  const presets={name:namePresets,description:['Groceries','Dining out','Transfer'],reason:['Correction','Statement review'],amount:['100','500','1000'],opening:['0','1000'],due_amount:['0','500'],expected_income:['25000','50000','100000'],currency:['INR','USD','EUR']};
  for(const control of host.querySelectorAll('input')) {
    if(control.type==='hidden' || control.type==='date' || control.type==='datetime-local' || control.type==='file') continue;
    const values=presets[control.name] || (control.name.startsWith('allocation-')?presets.amount:null);
    if(!values?.length || !control.closest('.field')) continue;
    const chips=document.createElement('span');chips.className='quick-chips';chips.setAttribute('aria-label',`Quick values for ${control.getAttribute('aria-label')||control.name}`);
    for(const value of values) { const chip=document.createElement('button');chip.type='button';chip.className='quick-chip';chip.textContent=value;chip.addEventListener('click',()=>{control.value=value;control.dispatchEvent(new Event('input',{bubbles:true}));control.focus();});chips.append(chip); }
    control.after(chips);
  }
}
function accountEditor() {
  editor('Add account',field('Name',input('name','required maxlength="100"'))+field('Type',`<select name="subtype" id="account-subtype">${['bank','credit_card','cash','settle_up'].map(v=>option(v,v.replace('_',' '))).join('')}</select>`)+field('Currency',input('currency',`required value="${h(state.me.household.base_currency)}" pattern="[A-Z]{3}"`))+(familyMode()?input('visibility','type="hidden" value="shared"'):field('Visibility','<select name="visibility"><option value="private">Private</option><option value="shared">Shared household</option></select>'))+field('Known balance (optional, card: amount owed)',input('opening','inputmode="decimal" placeholder="Unknown"'))+field('Balance as of (your browser timezone)',input('as_of',`type="datetime-local" value="${h(localDateTime(new Date().toISOString()))}"`))+`<p class="helper">Today is prefilled. The balance anchors earlier and later transactions.</p><div id="card-due-fields" hidden>${field('Statement payment amount (optional)',input('due_amount','inputmode="decimal" placeholder="0.00"'))}${field('Payment due date',input('due_date','type="date"'))}</div>`,'account-form');
}
function editAccountEditor(key) {
  const account=state.accounts.find(a=>a.id===key);
  if(!account || account.owner_id!==state.me.user.id) return;
  editor('Edit account',input('account_id',`type="hidden" value="${h(key)}"`)+input('revision',`type="hidden" value="${account.revision}"`)+field('Name',input('name',`required maxlength="100" value="${h(account.name)}"`))+field('Account type',`<select name="subtype" id="account-subtype">${['bank','credit_card','cash','settle_up'].map(v=>option(v,v.replace('_',' '),v===account.subtype)).join('')}</select>`)+`<div id="card-due-fields" ${account.subtype==='credit_card'?'':'hidden'}>${field('Statement payment amount (optional)',input('due_amount',`inputmode="decimal" value="${h(account.card_due?.amount||'')}" placeholder="0.00"`))}${field('Payment due date',input('due_date',`type="date" value="${h(account.card_due?.due_date||'')}"`))}</div>`+`<p class="helper">Amount owed comes from the balance anchor and transactions. A statement payment amount is optional and can be added later. Use Pay card on the card account to record a partial or full payment without adding a new expense.</p>`,'account-edit-form','Save account');
}
function openingBalanceEditor(key) {
  const account=state.accounts.find(a=>a.id===key);
  if(!account) return;
  const opening=account.opening_balance;
  editor(opening?'Edit known balance':'Set known balance',input('account_id',`type="hidden" value="${h(key)}"`)+input('revision',`type="hidden" value="${account.revision}"`)+field(`Known balance (${account.currency}${account.subtype==='credit_card'?', amount owed':''})`,input('amount',`required inputmode="decimal" value="${h(opening?.amount||'')}"`))+field('As of (your browser timezone)',input('as_of',`type="datetime-local" required value="${h(opening?localDateTime(opening.as_of):localDateTime(new Date().toISOString()))}"`))+`<p class="helper">Enter today's balance or a balance from any known date. Transactions before this time are subtracted to calculate earlier balances; later transactions are added. Balance checks remain separate observations.</p>`,'opening-balance-form','Save known balance');
}
function balanceCheckEditor(accountId,checkId) {
  const account=state.accounts.find(a=>a.id===accountId),check=state.selectedChecks?.find(c=>c.id===checkId);
  if(!account || !check || check.voided) return;
  editor('Correct balance check',input('account_id',`type="hidden" value="${h(accountId)}"`)+input('check_id',`type="hidden" value="${h(checkId)}"`)+input('revision',`type="hidden" value="${check.revision}"`)+field(`Entered balance (${account.currency})`,input('amount',`required inputmode="decimal" value="${h(check.amount)}"`))+field('Basis',`<select name="basis">${(account.subtype==='cash'?['cash_count']:['posted','current','statement_closing']).map(v=>option(v,v,v===check.basis)).join('')}</select>`)+field('As of (your browser timezone)',input('as_of',`type="datetime-local" required value="${h(localDateTime(check.as_of))}"`))+`<p class="helper">The original value stays in the audit history. The difference is recalculated from current transactions.</p>`,'balance-check-edit-form','Save correction');
}
function categoryEditor(key=null,parentKey=null) {
  const current=state.categories.find(c=>c.id===key);
  const parent=state.categories.find(c=>c.id===parentKey);
  const kind=current?.kind || parent?.kind || 'expense';
  const parentId=current?.parent_id || parentKey || '';
  const access=current?(current.visibility||'shared'):parent?(parent.visibility||'shared'):state.me.membership.role==='member'?'private':'shared';
  const kindField=current || parent
    ?input('kind',`type="hidden" value="${h(kind)}"`)+`<p class="helper">Type: ${h(kind)}</p>`
    :field('Type',`<select name="kind" id="category-kind">${option('expense','Expense',kind==='expense')}${option('income','Income',kind==='income')}</select>`);
  editor(current?'Edit category':parent?'Add subcategory':'Add category',
    input('category_id',`type="hidden" value="${h(key||'')}"`)+input('revision',`type="hidden" value="${current?.revision||''}"`)+
    field('Name',input('name',`required maxlength="100" value="${h(current?.name||'')}"`))+kindField+
    field('Parent category',`<select name="parent_id" id="category-parent">${option('','Top level',!parentId)}${categoryOptions(kind,parentId,key||'')}</select>`)+
    (familyMode()?input('visibility','type="hidden" value="shared"'):field('Access',`<select name="visibility" ${current&&access==='shared'?'disabled':''}>${option('private','Personal',access==='private')}${option('shared','Household',access==='shared')}</select>`))+
    (current&&access==='shared'?input('visibility','type="hidden" value="shared"'):'')+
    `<p class="helper">Personal categories work with your private accounts. Move a personal category to household access in Settings.</p>`,
    'category-form',current?'Save category':'Create category');
}
function transactionEditor({accountId=null,date=localDate(),categoryId=null}={}) {
  const host=state.view==='transactions' && window.matchMedia('(min-width:1350px)').matches?transactionDrawer:dialog;
  if(host===dialog)closeTransactionDrawer();
  const chosen=state.accounts.find(a=>a.id===(accountId||lastTransactionAccount()) && a.active!==false)?.id;
  editor('Add transaction',`<div class="transaction-quick-fields">${field('Amount',moneyInput('amount'))}${field('Description',input('description','required maxlength="240" autocomplete="off"'))}</div>`+field('Account / transfer source',`<select name="account_id" required>${accountOptions(chosen)}</select>`)+button('+ New account','quick-account-open',`data-target="account_id"`)+field('Type','<select name="event_type" id="event-type"><option value="expense">Expense</option><option value="income">Income</option><option value="refund">Refund</option><option value="transfer">Transfer</option></select>')+field('Date',input('effective_date',`type="date" required value="${h(date)}"`))+`<div id="transfer-target" hidden>${field('Transfer destination',`<select name="destination">${accountOptions()}</select>`)}${button('+ New destination account','quick-account-open',`data-target="destination"`)}<p id="transfer-help" class="helper"></p></div><section id="transaction-quick-account" class="transaction-quick-panel" aria-label="Create account" hidden><strong>New account</strong>${field('Account name',input('quick_account_name','maxlength="100"'))}${field('Account type',`<select name="quick_account_subtype">${['bank','credit_card','cash','settle_up'].map(v=>option(v,v.replace('_',' '))).join('')}</select>`)}${field('Currency',input('quick_account_currency',`value="${h(state.me.household.base_currency)}" pattern="[A-Z]{3}"`))}${familyMode()?input('quick_account_visibility','type="hidden" value="shared"'):field('Access',`<select name="quick_account_visibility">${option('private','Private')}${option('shared','Shared household')}</select>`)}<div class="transaction-quick-actions">${button('Cancel','quick-create-cancel')}${button('Create account','quick-account-save')}</div></section><div id="allocation-fields">${field('Search categories',input('category_search','id="transaction-category-search" type="search" placeholder="Search by name or parent" autocomplete="off"'))}<div class="transaction-category-heading"><strong>Category</strong><span id="transaction-category-hint" class="helper"></span></div><div id="transaction-category-results" class="transaction-category-results" role="group" aria-label="Choose category"></div><select name="category_id" id="transaction-category" class="sr-only" aria-label="Category"></select>${button('+ New category','quick-category-open','')}<section id="transaction-quick-category" class="transaction-quick-panel" aria-label="Create category" hidden><strong>New category</strong>${field('Category name',input('quick_category_name','maxlength="100"'))}${field('Under',`<select name="quick_category_parent"></select>`)}${familyMode()?input('quick_category_visibility','type="hidden" value="shared"'):field('Access',`<select name="quick_category_visibility">${option('private','Private',state.me.membership.role==='member')}${option('shared','Shared household',state.me.membership.role!=='member')}</select>`)}<div class="transaction-quick-actions">${button('Cancel','quick-create-cancel')}${button('Create category','quick-category-save')}</div></section>${scopeField()}<div id="budget-destination-field">${field('Budget used by',`<select name="budget_destination">${budgetDestinationOptions()}</select>`)}<p class="helper">Choose a member, Shared pool, or Unassigned. Paid by is recorded separately.</p></div><div id="paid-by-field">${field('Paid by',`<select name="paid_by_user_id">${state.members.map(m=>option(m.user_id,m.name,m.user_id===state.me.user.id)).join('')}</select>`)}</div></div><p id="transaction-summary" class="transaction-summary" aria-live="polite"></p><p id="transaction-duplicate" class="transaction-duplicate" role="status" hidden></p>`,'transaction-form','Save',host);
  const form=host.querySelector('#transaction-form');
  const byId=new Map(state.categories.map(category=>[category.id,category]));
  const paths=new Map();
  const pathFor=(category,seen=new Set())=>{
    if(paths.has(category.id))return paths.get(category.id);
    if(seen.has(category.id))return category.name;
    seen.add(category.id);
    const parent=byId.get(category.parent_id);
    const path=parent?`${pathFor(parent,seen)} › ${category.name}`:category.name;
    paths.set(category.id,path);
    return path;
  };
  form.categoryChoices=categoryView.ordered(state.categories).filter(({category})=>category.archived!==true).map(({category,depth})=>{
    let root=category;const seen=new Set();
    while(root.parent_id && byId.has(root.parent_id) && !seen.has(root.id)) {seen.add(root.id);root=byId.get(root.parent_id);}
    return {id:category.id,kind:category.kind,name:category.name,path:pathFor(category),rootId:root.id,rootName:root.name,depth};
  });
  form.querySelector('.dialog-actions').insertAdjacentHTML('beforeend','<button class="outline-button" type="submit" name="save_action" value="another">Save & add another</button>');
  updateCategories();
  if(categoryId && [...form.elements.category_id.options].some(o=>o.value===categoryId)) { form.elements.category_id.value=categoryId; form.elements.category_id.dataset.manual='true'; renderTransactionCategoryGrid(form); }
  updateTransactionPreview();
  form.elements.amount.focus();
  api.request('transactions?limit=100').then(result=>{
    if(document.querySelector('#transaction-form')!==form) return;
    recentTransactions=result.data.filter(t=>!t.voided);
    suggestTransactionCategory();
    updateTransactionPreview();
  }).catch(()=>{});
}
function cardPaymentEditor(cardId=null) {
  const cards=state.accounts.filter(a=>a.subtype==='credit_card' && a.active!==false);
  const card=cards.find(a=>a.id===cardId)||cards[0];
  if(!card)return;
  if(!state.accounts.some(a=>['bank','cash'].includes(a.subtype) && a.active!==false && a.currency===card.currency)) {notify(`Add a bank or cash account in ${card.currency} to pay this card.`);return;}
  const host=state.view==='transactions' && transactionDrawer.hidden && window.matchMedia('(min-width:1350px)').matches?transactionDrawer:dialog;
  editor('Pay credit card',field('Card',`<select name="card_id" required>${cards.map(a=>option(a.id,`${a.name} · ${a.currency}`,a.id===card.id)).join('')}</select>`)+field('Pay from',`<select name="source_account" required></select>`)+field('Payment',`<select name="payment_mode">${option('partial','Partial payment')}${option('statement','Statement due')}${option('full','Full current balance')}</select>`)+field('Amount',moneyInput('amount'))+`<p id="card-payment-balance" class="helper"></p>`+field('Date',input('effective_date',`type="date" required value="${h(localDate())}"`))+field('Description',input('description',`required maxlength="240" value="${h(`Credit card payment · ${card.name}`)}"`))+`<p class="helper">This moves money from your bank or cash account to the card. It reduces the card balance and does not count as a new expense.</p>`,'card-payment-form','Record payment',host);
  updateCardPaymentForm();
  host.querySelector('#card-payment-form [name="amount"]').focus();
}
function updateCardPaymentForm() {
  const form=document.querySelector('#card-payment-form');if(!form)return;
  const card=state.accounts.find(a=>a.id===form.elements.card_id.value);
  const oldSource=form.elements.source_account.value;
  const sources=state.accounts.filter(a=>['bank','cash'].includes(a.subtype) && a.active!==false && a.currency===card?.currency && a.id!==card?.id);
  form.elements.source_account.innerHTML=sources.map(a=>option(a.id,`${a.name} · ${a.currency}`,a.id===oldSource)).join('');
  const owed=Number(card?.balance?.amount);
  const fullAvailable=card?.balance?.amount!=null && Number.isFinite(owed) && owed>0;
  const dueAvailable=card?.card_due?.amount!=null && Number(card.card_due.amount)>0;
  form.elements.payment_mode.querySelector('[value="full"]').disabled=!fullAvailable;
  form.elements.payment_mode.querySelector('[value="statement"]').disabled=!dueAvailable;
  if(!fullAvailable && form.elements.payment_mode.value==='full')form.elements.payment_mode.value='partial';
  if(!dueAvailable && form.elements.payment_mode.value==='statement')form.elements.payment_mode.value='partial';
  const mode=form.elements.payment_mode.value;
  if(form.dataset.paymentMode && form.dataset.paymentMode!=='partial' && mode==='partial')form.elements.amount.value='';
  form.dataset.paymentMode=mode;
  form.elements.amount.readOnly=mode!=='partial';
  if(form.elements.amount.nextElementSibling)form.elements.amount.nextElementSibling.hidden=mode!=='partial';
  if(mode==='full')form.elements.amount.value=card.balance.amount;
  if(mode==='statement')form.elements.amount.value=card.card_due.amount;
  form.querySelector('#card-payment-balance').textContent=`${card.balance?.amount==null?'Current balance is unknown':`Current amount owed: ${card.currency} ${card.balance.amount}`}${card.card_due?.amount?` · Statement due: ${card.currency} ${card.card_due.amount} by ${card.card_due.due_date}`:''}. ${mode==='full'?'Full payment uses the current recorded balance.':mode==='statement'?'Statement payment uses the recorded amount due.':'Enter the amount you want to pay.'}`;
}
async function investmentTransactionEditor() {
  const holdings=(await allInvestments()).filter(v=>v.type==='investment' && v.owner_id===state.me.user.id);
  const accounts=state.accounts.filter(a=>a.active!==false && a.subtype!=='settle_up');
  if(!accounts.length) {notify('Add an account before recording an investment.');return;}
  const host=state.view==='transactions' && transactionDrawer.hidden && window.matchMedia('(min-width:1350px)').matches?transactionDrawer:dialog;
  editor('Add investment',field('Holding',`<select name="holding_id">${option('','New lump sum holding')}${holdings.map(v=>option(v.id,`${v.name} · ${v.asset_class==='stock_market'?'Stock market':'Mutual fund'} · ${v.currency}`)).join('')}</select>`)+`<div id="investment-transaction-new">${field('Investment kind',`<select name="asset_class">${option('mutual_fund','Mutual fund · lump sum')}${option('stock_market','Stock market')}</select>`)}${field('Holding name',input('investment_name','maxlength="100" placeholder="Fund or stock name"'))}</div>`+field('Amount invested',moneyInput('amount'))+field('Paid from account',`<select name="account_id" required></select>`)+field('Investment date',input('transaction_date',`type="date" required value="${h(localDate().startsWith(state.month)?localDate():`${state.month}-01`)}"`))+field('Current value after investment (optional)',input('value','inputmode="decimal" pattern="[0-9]+(\\.[0-9]+)?" placeholder="Add when known"'))+`<p id="investment-transaction-hint" class="helper"></p>`,'investment-transaction-form','Record investment',host);
  const form=host.querySelector('#investment-transaction-form');
  form.investmentHoldings=holdings;
  updateInvestmentTransactionForm();
  form.elements.amount.focus();
}
function updateInvestmentTransactionForm() {
  const form=document.querySelector('#investment-transaction-form');if(!form)return;
  const holding=form.investmentHoldings.find(v=>v.id===form.elements.holding_id.value);
  form.querySelector('#investment-transaction-new').hidden=!!holding;
  form.elements.investment_name.required=!holding;
  const previous=form.elements.account_id.value||state.transactionFilters.account||lastTransactionAccount();
  const accounts=state.accounts.filter(a=>a.active!==false && a.subtype!=='settle_up' && (!holding || a.currency===holding.currency));
  form.elements.account_id.innerHTML=accounts.map(a=>option(a.id,`${a.name} · ${a.currency}`,a.id===previous)).join('');
  form.querySelector('#investment-transaction-hint').textContent=holding?`Adds to ${holding.name}. Its ${holding.currency} investment movement will appear in Transactions and will not count as an expense.`:'Creates a new lump sum holding and records its first account movement. Choose Stock market for shares; a valuation can be added later.';
}
function planEditor(key=null) {
  const item=state.plannedItems.find(v=>v.id===key);
  const currency=item?.currency||state.me.household.base_currency;
  const defaultDueDate=localDate().startsWith(`${state.month}-`)?localDate():`${state.month}-01`;
  const accountChoices=state.accounts.filter(a=>a.currency===currency && a.active!==false && (item?.visibility!=='shared'||a.visibility==='shared'));
  editor(item?'Edit planned expense':'Add planned expense',
    input('plan_id',`type="hidden" value="${h(item?.id||'')}"`)+input('revision',`type="hidden" value="${item?.revision||''}"`)+
    field('Title',input('title',`required maxlength="200" value="${h(item?.title||'')}"`))+
    field('Due date',input('due_date',`type="date" required value="${h(item?.due_date||defaultDueDate)}"`))+
    field(`Expected amount (${currency})`,input('amount',`required inputmode="decimal" value="${h(item?.amount||'')}"`))+
    (familyMode()?input('visibility','type="hidden" value="shared"'):field('Visibility',`<select name="visibility">${option('private','Personal',item?.visibility!=='shared')}${option('shared','Household',item?.visibility==='shared')}</select>`))+
    field('Category',`<select name="category_id">${option('','Uncategorized',!item?.category_id)}${categoryOptions('expense',item?.category_id)}</select>`)+
    field('Expected account',`<select name="account_id">${option('','No account',!item?.account_id)}${accountChoices.map(a=>option(a.id,a.name,a.id===item?.account_id)).join('')}</select>`)+
    field('Count in budget commitments',input('budget_commitment',`type="checkbox" ${item?.budget_commitment?'checked':''}`))+
    field('Household budget destination',`<select name="budget_destination">${budgetDestinationOptions(item?.budget_destination||'unassigned')}</select>`)+
    `<p class="helper">Choose a category for a commitment. The household destination applies only to household commitments. A plan does not post money movement.</p>`,
    'plan-form',item?'Save plan':'Add plan');
}
async function matchPlanEditor(key) {
  const item=state.plannedItems.find(v=>v.id===key);
  if(!item || item.budget_commitment!==true || item.status!=='planned')return;
  const transactions=(await api.collection(`transactions?event_type=expense&${new URLSearchParams(period(item.due_date.slice(0,7)))}`)).data;
  const scope=item.visibility==='shared'?'family':'personal';
  const candidates=transactions.filter(t=>t.event_type==='expense' && !t.voided && t.currency===item.currency && Number(t.amount)===Number(item.amount) && (scope==='family'||t.entered_by===item.owner_id) && t.allocations?.length && t.allocations.every(a=>a.scope===scope&&a.category_id===item.category_id) && (!item.account_id||t.movements?.some(m=>m.account_id===item.account_id)) && (scope!=='family'||t.movements?.every(m=>state.accounts.find(a=>a.id===m.account_id)?.visibility==='shared')));
  editor('Match posted expense',`<p>Match ${h(item.title)} · ${amount(item.amount,item.currency)} to one recorded expense. Matching changes the commitment state; the expense already counts in spending.</p>${field('Posted expense',`<select name="transaction_id" required>${candidates.map(t=>option(t.id,`${t.effective_date} · ${t.description||'Expense'} · ${t.amount} ${t.currency}`)).join('')}</select>`)}${field('Reason',input('reason','required maxlength="500" value="Posted payment for planned commitment"'))}${input('plan_id',`type="hidden" value="${h(item.id)}"`)}${candidates.length?'':'<p class="helper">No matching expense is visible. Record or import it first, then return here.</p>'}`,'match-plan-form','Match expense');
}
function renderTransactionCategoryGrid(form) {
  const selected=form.elements.category_id.value;
  const search=form.elements.category_search.value.trim().toLocaleLowerCase();
  const kind=form.elements.event_type.value==='income'?'income':'expense';
  const choices=form.categoryChoices.filter(choice=>choice.kind===kind && (!search || choice.path.toLocaleLowerCase().includes(search)));
  const groups=new Map();
  for(const choice of choices) {
    if(!groups.has(choice.rootId))groups.set(choice.rootId,{name:choice.rootName,choices:[]});
    groups.get(choice.rootId).choices.push(choice);
  }
  const tile=choice=>`<button type="button" class="transaction-category-tile${choice.id===selected?' selected':''}" data-action="choose-transaction-category" data-category="${h(choice.id)}" aria-pressed="${choice.id===selected}" title="${h(choice.path)}"><span>${h(choice.name)}</span>${choice.depth?`<small>${h(choice.path.slice(0,-choice.name.length-3))}</small>`:''}</button>`;
  form.querySelector('#transaction-category-results').innerHTML=`<button type="button" class="transaction-category-tile uncategorized${selected?'':' selected'}" data-action="choose-transaction-category" data-category="" aria-pressed="${!selected}">Uncategorized</button>`+
    [...groups.values()].map(group=>`<section class="transaction-category-group"><h3>${h(group.name)}</h3><div class="transaction-category-grid">${group.choices.map(tile).join('')}</div></section>`).join('')+
    (search && !choices.length?'<p class="helper">No categories match your search.</p>':'');
  form.querySelector('#transaction-category-hint').textContent=search?`${choices.length} match${choices.length===1?'':'es'}`:`${choices.length} categories · select a group or subcategory`;
}
function quickPanel(form,kind,open=false) {
  const panel=form.querySelector(`#transaction-quick-${kind}`);
  panel.hidden=!open;
  panel.querySelector(`[name="quick_${kind}_name"]`).required=open;
  if(kind==='account')panel.querySelector('[name="quick_account_currency"]').required=open;
  panel.querySelector('.live-error')?.remove();
  if(open)panel.querySelector(`[name="quick_${kind}_name"]`).focus();
}
function openQuickCreate(kind,target='account_id') {
  const form=document.querySelector('#transaction-form');if(!form)return;
  quickPanel(form,kind==='account'?'category':'account');
  form.quickAccountTarget=target;
  if(kind==='account') {
    const source=state.accounts.find(a=>a.id===form.elements.account_id.value);
    form.elements.quick_account_currency.value=source?.currency||state.me.household.base_currency;
  } else {
    const categoryKind=form.elements.event_type.value==='income'?'income':'expense';
    form.elements.quick_category_parent.innerHTML=option('','Top level')+form.categoryChoices.filter(choice=>choice.kind===categoryKind).map(choice=>option(choice.id,choice.path)).join('');
    const source=state.accounts.find(a=>a.id===form.elements.account_id.value);
    form.elements.quick_category_visibility.value=familyMode()||source?.visibility==='shared'||form.elements.scope?.value==='family'?'shared':'private';
  }
  quickPanel(form,kind,true);
}
async function saveQuickCreate(kind) {
  const form=document.querySelector('#transaction-form');if(!form)return;
  const panel=form.querySelector(`#transaction-quick-${kind}`);
  for(const control of panel.querySelectorAll('input,select'))if(!control.checkValidity()) {control.reportValidity();return;}
  if(!panel.querySelector(`[name="quick_${kind}_name"]`).value.trim()) {panel.querySelector(`[name="quick_${kind}_name"]`).setCustomValidity('Enter a name.');panel.querySelector(`[name="quick_${kind}_name"]`).reportValidity();panel.querySelector(`[name="quick_${kind}_name"]`).setCustomValidity('');return;}
  try {
    if(kind==='account') {
      const created=await api.request('accounts',{method:'POST',body:{name:form.elements.quick_account_name.value.trim(),subtype:form.elements.quick_account_subtype.value,currency:form.elements.quick_account_currency.value.trim().toUpperCase(),visibility:form.elements.quick_account_visibility.value}});
      state.accounts.push(created);
      const source=form.elements.account_id.value,destination=form.elements.destination.value;
      form.elements.account_id.innerHTML=accountOptions(form.quickAccountTarget==='account_id'?created.id:source);
      form.elements.destination.innerHTML=accountOptions(form.quickAccountTarget==='destination'?created.id:destination);
      updateCategories();
      if(form.quickAccountTarget==='destination')form.elements.destination.value=created.id;
      form.elements.quick_account_name.value='';
      notify(`${created.name} added and selected.`);
    } else {
      const parentId=form.elements.quick_category_parent.value;
      const kind=form.elements.event_type.value==='income'?'income':'expense';
      const created=await api.request('categories',{method:'POST',body:{name:form.elements.quick_category_name.value.trim(),kind,parent_id:parentId||null,visibility:form.elements.quick_category_visibility.value}});
      state.categories.push(created);
      const parent=form.categoryChoices.find(choice=>choice.id===parentId);
      form.categoryChoices.push({id:created.id,kind,name:created.name,path:parent?`${parent.path} › ${created.name}`:created.name,rootId:parent?.rootId||created.id,rootName:parent?.rootName||created.name,depth:parent?parent.depth+1:0});
      updateCategories();
      form.elements.category_id.value=created.id;
      form.elements.category_id.dataset.manual='true';
      form.elements.quick_category_name.value='';
      renderTransactionCategoryGrid(form);
      notify(`${created.name} added and selected.`);
    }
    quickPanel(form,kind);
    updateTransactionPreview();
  } catch(error) {failure(error,panel);}
}
function updateCategories() {
  const form=document.querySelector('#transaction-form');if(!form)return;
  const kind=form.elements.event_type.value,transfer=kind==='transfer';
  form.querySelector('#transfer-target').hidden=!transfer;
  form.querySelector('#allocation-fields').hidden=transfer;
  form.querySelector('#paid-by-field').hidden=kind==='income'||transfer;
  form.querySelector('#budget-destination-field').hidden=kind==='income'||transfer||form.elements.scope.value!=='family';
  if(transfer) {
    const source=state.accounts.find(a=>a.id===form.elements.account_id.value);
    const old=form.elements.destination.value;
    const targets=state.accounts.filter(a=>a.active!==false && a.id!==source?.id && a.currency===source?.currency);
    form.elements.destination.innerHTML=targets.map(a=>option(a.id,`${a.name} · ${a.currency}`,a.id===old)).join('');
    form.querySelector('#transfer-help').textContent=targets.length?'Move money between your own accounts without counting it as spending.':'Add another active account in this currency to record a transfer.';
    form.elements.destination.required=true;
  } else form.elements.destination.required=false;
  const selected=form.elements.category_id.value;
  const choices=form.categoryChoices.filter(choice=>choice.kind===(kind==='income'?'income':'expense'));
  form.elements.category_id.innerHTML=option('','Uncategorized')+choices.map(choice=>option(choice.id,choice.path,choice.id===selected)).join('');
  if(selected && choices.some(choice=>choice.id===selected))form.elements.category_id.value=selected;
  renderTransactionCategoryGrid(form);
}
function suggestTransactionCategory() {
  const form=document.querySelector('#transaction-form');if(!form || form.elements.category_id.dataset.manual)return;
  const description=form.elements.description.value.trim().toLocaleLowerCase();
  const match=description && form.elements.event_type.value!=='transfer' && recentTransactions.find(t=>t.description?.trim().toLocaleLowerCase()===description && t.event_type===form.elements.event_type.value && t.movements?.[0]?.account_id===form.elements.account_id.value);
  const categoryId=match?.allocations?.[0]?.category_id;
  const select=form.elements.category_id;
  if(categoryId && [...select.options].some(o=>o.value===categoryId)) { select.value=categoryId; select.dataset.suggested=categoryId; renderTransactionCategoryGrid(form); }
  else if(select.dataset.suggested) { select.value=''; delete select.dataset.suggested; renderTransactionCategoryGrid(form); }
}
function updateTransactionPreview() {
  const form=document.querySelector('#transaction-form');if(!form)return;
  const data=Object.fromEntries(new FormData(form));
  const account=state.accounts.find(a=>a.id===data.account_id);
  const pieces=[data.amount?`${account?.currency||''} ${data.amount}`:'Amount',data.event_type[0].toUpperCase()+data.event_type.slice(1),data.description||'Description',account?.name||'Account',data.event_type==='transfer'?`→ ${accountName(data.destination)}`:form.elements.category_id.selectedOptions[0]?.textContent||'Uncategorized',data.effective_date];
  if(data.event_type!=='transfer' && !familyMode())pieces.push(data.scope==='family'?'Family':'Personal');
  if(['expense','refund'].includes(data.event_type)) pieces.push(`Paid by ${state.members.find(m=>m.user_id===data.paid_by_user_id)?.name||'you'}`);
  form.querySelector('#transaction-summary').textContent=pieces.join(' · ');
  const duplicate=recentTransactions.some(t=>!t.voided && t.event_type===data.event_type && t.effective_date===data.effective_date && Number(t.amount)===Number(data.amount) && t.description?.trim().toLocaleLowerCase()===data.description?.trim().toLocaleLowerCase() && t.movements?.[0]?.account_id===data.account_id);
  const warning=form.querySelector('#transaction-duplicate');warning.hidden=!data.amount||!data.description||!duplicate;
  warning.textContent=duplicate?'A matching transaction is already recorded for this date and account. Check before saving.':'';
}
async function transactionDetail(key) {
  const t=await api.request(`transactions/${id(key)}`);
  await loadLedgerBalances([t],true);
  const amendment=t.amendment?`<p class="amendment-note"><strong>Amended in FinWise</strong><br>Money Manager original: ${amount(t.amendment.original_amount,t.currency)} on ${h(t.amendment.original_date)}.<br>Current amount: ${amount(t.amount,t.currency)} on ${h(t.effective_date)}.<br>${h(t.amendment.reason)} · Update the source app using the amendment export.</p>`:t.reconciliation_created?`<p class="amendment-note"><strong>${t.reconciliation_created.action==='update_transfer'?'Converted to an internal transfer':'Created from a bank statement'}</strong><br>${h(t.reconciliation_created.observation_ids?.length||0)} source statement row(s) attached. ${t.reconciliation_created.action==='update_transfer'?'Update':'Add'} this transaction in Money Manager using the changes export in Reconcile.<br>${h(t.reconciliation_created.reason||'')}</p>`:'';
  const evidence=t.reconciliation_evidence||[];
  const source=state.accounts.find(a=>a.id===t.movements[0]?.account_id);
  const canConvert=t.event_type==='expense' && ['bank','cash'].includes(source?.subtype) && state.accounts.some(a=>a.subtype==='credit_card' && a.active!==false && a.currency===t.currency);
  editor('Transaction details',`<p>${h(t.effective_date)} · ${h(t.event_type)} · ${amount(t.amount,t.currency)}</p>${transactionIndicators(t)}`+amendment+table(['Account','Movement','Balance after'],t.movements.map(m=>{const row=state.ledgerBalances.get(`${m.account_id}:${t.id}`);return [h(accountName(m.account_id)),amount(m.amount,t.currency),row?`${amount(row.balance_after,row.currency)}<small>${h(balanceLabel(row))}${groupBalanceLabel(row,m.account_id)}</small>`:'Unknown'];}))+table(['Category','Scope','Budget used by','Amount'],t.allocations.map(a=>[h(categoryName(a.category_id)),h(a.scope),h(a.scope==='personal'?'Personal':a.budget_destination==='shared'?'Shared household pool':!a.budget_destination||a.budget_destination==='unassigned'?'Unassigned':state.members.find(member=>member.user_id===a.budget_destination)?.name||'Archived member'),amount(a.amount,t.currency)]))+`<h3>Reconciliation evidence</h3>`+(evidence.length?table(['Account','Statement date','Statement row','Attached amount'],evidence.map(v=>[h(accountName(v.account_id)),h(v.statement_date),`${h(v.statement_description)}${v.statement_reference?`<small>Ref ${h(v.statement_reference)}</small>`:''}`,amount(v.matched_amount,t.currency)])):empty('No statement rows attached yet.'))+`<p>${['expense','refund'].includes(t.event_type)?`Paid by: ${h(payerName(t))} · `:''}Entered by: ${t.entered_by===state.me.user.id?'You':'Household member'} · Revision ${t.revision}</p><p>${t.source_refs.length} source references preserved.</p>${t.investment_id?button('View investment','investment-transaction',`data-id="${h(t.investment_id)}"`):(canConvert?button('Convert to card payment','convert-card-payment',`data-id="${h(t.id)}"`):'')+button('Edit transaction','edit-transaction',`data-id="${h(t.id)}"`)+button('Delete transaction','delete-transaction',`data-id="${h(t.id)}"`)}`,'transaction-detail-form','Close');
}
async function convertCardPaymentEditor(key) {
  const t=await api.request(`transactions/${id(key)}`);
  const source=state.accounts.find(a=>a.id===t.movements[0]?.account_id);
  const cards=state.accounts.filter(a=>a.subtype==='credit_card' && a.active!==false && a.currency===t.currency);
  if(t.event_type!=='expense' || !['bank','cash'].includes(source?.subtype) || !cards.length)throw new Error('This expense cannot be converted to a card payment.');
  editor('Convert to card payment',input('transaction_id',`type="hidden" value="${h(t.id)}"`)+input('revision',`type="hidden" value="${t.revision}"`)+field('Paying from',`<input value="${h(source.name)} · ${h(source.currency)}" readonly>`)+field('Card paid',`<select name="card_id" required>${cards.map(a=>option(a.id,a.name)).join('')}</select>`)+`<p>${h(t.effective_date)} · ${amount(t.amount,t.currency)} · ${h(t.description||'Transaction')}</p><p class="helper">This changes the existing expense into a transfer. Its expense allocation will be removed, and the card balance will decrease by the payment amount. The original revision remains in history. If this came from Money Manager, update the source entry too.</p>`,'convert-card-payment-form','Convert payment');
}
async function transactionEditEditor(key) {
  const t=await api.request(`transactions/${id(key)}`);
  state.editingTransaction=t;
  const involved=new Set(t.movements.map(m=>m.account_id));
  const eligible=state.accounts.filter(a=>a.currency===t.currency && (a.active!==false || involved.has(a.id)));
  const accounts=selected=>eligible.map(a=>option(a.id,a.name,a.id===selected)).join('');
  const transfer=t.event_type==='transfer';
  const sourceLeg=transfer?t.movements.find(m=>m.amount.startsWith('-')):t.movements[0];
  const destinationLeg=transfer?t.movements.find(m=>!m.amount.startsWith('-')):null;
  const allocationFields=(kind,values)=>values.map((a,i)=>`<div class="form-grid" data-edit-allocation>${field(`Category ${i+1}`,`<select name="category-${i}">${option('','Uncategorized',!a.category_id)}${a.category_id && state.categories.find(c=>c.id===a.category_id)?.archived?option(a.category_id,`${categoryName(a.category_id)} (archived)`,true):''}${categoryOptions(kind,a.category_id)}</select>`)}${field(`Allocation ${i+1} (${t.currency})`,input(`allocation-${i}`,`required inputmode="decimal" value="${h(a.amount)}"`))}${familyMode()?input(`scope-${i}`,'type="hidden" value="family"'):field('Scope',`<select name="scope-${i}">${option('personal','Personal',a.scope==='personal')}${option('family','Family',a.scope==='family')}</select>`)}${kind==='expense'?field('Budget used by (Family scope)',`<select name="budget-destination-${i}">${budgetDestinationOptions(a.budget_destination||'unassigned')}</select>`):''}</div>`).join('');
  const fresh=[{category_id:null,amount:t.amount,scope:defaultTransactionScope()}];
  const expenseAllocations=allocationFields('expense',['expense','refund'].includes(t.event_type)?t.allocations:fresh);
  const incomeAllocations=allocationFields('income',t.event_type==='income'?t.allocations:fresh);
  editor('Edit transaction',input('transaction_id',`type="hidden" value="${h(t.id)}"`)+input('revision',`type="hidden" value="${t.revision}"`)+input('original_date',`type="hidden" value="${h(t.effective_date)}"`)+`<p>${h(t.currency)}. Changing the type updates account movement and budget allocations. Source references and prior revisions are retained; reconciled links will need review.</p>`+field('Type',`<select name="event_type" id="edit-event-type">${['expense','income','refund','transfer'].map(v=>option(v,v[0].toUpperCase()+v.slice(1),v===t.event_type)).join('')}</select>`)+field('Description',input('description',`value="${h(t.description||'')}"`))+field('Date',input('effective_date',`type="date" required value="${h(t.effective_date)}"`))+field('Amount',input('amount',`required inputmode="decimal" value="${h(t.amount)}"`))+field('Account / transfer source',`<select name="source_account" required>${accounts(sourceLeg?.account_id)}</select>`)+`<div data-edit-kind="transfer">${field('Transfer destination',`<select name="destination_account" required>${option('','Choose destination',!destinationLeg)}${accounts(destinationLeg?.account_id)}</select>`)}</div>`+`<div data-edit-kind="expense">${expenseAllocations}${field('Paid by',`<select name="paid_by_user_id">${state.members.map(m=>option(m.user_id,m.name,m.user_id===payerId(t))).join('')}</select>`)}</div>`+`<div data-edit-kind="income">${incomeAllocations}</div>`,'transaction-full-edit-form','Save transaction');
  const form=dialog.querySelector('#transaction-full-edit-form');
  form.dataset.originalEventType=t.event_type;
  updateTransactionEditType(form);
}
function updateTransactionEditType(form) {
  const kind=form.elements.event_type.value;
  const group=kind==='refund'?'expense':kind;
  for(const section of form.querySelectorAll('[data-edit-kind]')) {
    const active=section.dataset.editKind===group;
    section.hidden=!active;
    section.querySelectorAll('input,select').forEach(control=>{control.disabled=!active;});
  }
  const originalGroup=form.dataset.originalEventType==='refund'?'expense':form.dataset.originalEventType;
  if(group!==originalGroup && group!=='transfer') {
    const amount=form.querySelector(`[data-edit-kind="${group}"] [name="allocation-0"]`);
    if(amount) amount.value=form.elements.amount.value;
  }
}
function transactionBalanceEditor() {
  const eligible=state.accounts.filter(a=>a.subtype!=='settle_up');
  if(!eligible.length) { notify('Add a bank, card, or cash account first.'); return; }
  const selected=eligible.find(a=>a.id===state.transactionFilters.account);
  if(selected) { balanceEditor(selected.id); return; }
  if(eligible.length===1) { balanceEditor(eligible[0].id); return; }
  editor('Choose account for balance check',field('Account','<select name="account_id" required>'+eligible.map(a=>option(a.id,a.name+' · '+a.currency)).join('')+'</select>'),'balance-account-form','Continue');
}
function balanceEditor(key,asOf=null) {
  const account=state.accounts.find(a=>a.id===key);
  if(!account || account.subtype==='settle_up') throw new Error('Choose a bank, card, or cash account.');
  editor(`Check ${account.name}`,input('account_id',`type="hidden" value="${h(key)}"`)+input('revision',`type="hidden" value="${account.revision}"`)+field(`Actual balance (${account.currency})`,input('amount','required inputmode="decimal"'))+field('Basis',`<select name="basis">${(account.subtype==='cash'?['cash_count']:['posted','current','statement_closing']).map(v=>option(v,v)).join('')}</select>`)+field(`As of (${Intl.DateTimeFormat().resolvedOptions().timeZone})`,input('as_of',`type="datetime-local" required value="${h(asOf||localDateTime(new Date().toISOString()))}"`))+`<p class="helper">Choose the exact time of the observed balance. Date-only transactions are placed at 10:00 AM in the account timezone. The time above uses your browser timezone; Check after sets it one minute after the chosen transaction. This check does not change transactions.</p><p id="balance-preview" class="helper" role="status"></p>`,'balance-form','Record check');
}
function budgetCategoryAverages(months,scale) {
  const totals=new Map();
  for(const month of months) for(const row of month) {
    if(!row.id) continue;
    const [whole,fraction='']=String(row.amount).split('.');
    const value=BigInt(whole.replace('-','')+fraction)*(whole.startsWith('-')?-1n:1n)*10n**BigInt(scale)/10n**BigInt(fraction.length);
    totals.set(row.id,(totals.get(row.id)||0n)+value);
  }
  const count=BigInt(months.length||1);
  return new Map([...totals].map(([key,total])=>{const average=(total+count/2n)/count;const digits=average.toString().padStart(scale+1,'0');return [key,scale?digits.slice(0,-scale)+'.'+digits.slice(-scale):digits];}));
}
function settlementEditor() {
  editor('Add loan or debt',field('Person',input('person','required maxlength="100"'))+field('Direction',`<select name="direction">${option('owed_to_me','They owe me')}${option('i_owe','I owe them')}</select>`)+field('Type',`<select name="kind">${option('loan','Loan')}${option('other','Other debt')}</select>`)+field('Amount',moneyInput('amount'))+field('Date',input('date',`type="date" required value="${h(householdDate())}"`))+field('What is this for?',input('description','required maxlength="500"')),'settlement-form','Save obligation');
}
async function splitEditor() {
  const expenses=(await api.collection(`transactions?event_type=expense&${new URLSearchParams(period())}`)).data;
  editor('Split a purchase',`<p class="helper">Enter your share and one other person per line as “Name: amount”. All shares must add up to the total. If someone else paid, include that person among the shares.</p>`+field('Who paid?',`<select name="payer_type">${option('me','I paid')}${option('other','Someone else paid')}</select>`)+field('Payer name if someone else paid',input('payer_name','maxlength="100" placeholder="Alex"'))+field('Link recorded expense if you paid (optional)',`<select name="transaction_id">${option('','No linked expense')}${expenses.map(v=>option(v.id,`${v.effective_date} · ${v.description||'Expense'} · ${v.currency} ${v.amount}`)).join('')}</select>`)+field('Description',input('description','required maxlength="500"'))+field('Date',input('date',`type="date" required value="${h(householdDate())}"`))+field('Purchase total',moneyInput('total'))+field('My share',moneyInput('my_share'))+field('Other shares','<textarea name="shares" rows="4" required placeholder="Alex: 500.00&#10;Sam: 500.00"></textarea>'),'split-form','Create split');
}
async function repaymentEditor(key) {
  const v=await api.request(`settle-ups/${id(key)}`);
  editor('Record repayment',input('obligation_id',`type="hidden" value="${h(v.id)}"`)+input('revision',`type="hidden" value="${v.revision}"`)+`<p>${h(v.person)} · ${h(v.direction==='owed_to_me'?'they paid me':'I paid them')} · remaining ${amount(v.remaining,v.currency)}</p>`+field('Amount',moneyInput('amount'))+field('Date',input('date',`type="date" required value="${h(householdDate())}"`))+field('Note (optional)',input('note','maxlength="500"')),'repayment-form','Record repayment');
}
async function settlementEditEditor(key) {
  const v=await api.request(`settle-ups/${id(key)}`);
  editor('Edit obligation',input('obligation_id',`type="hidden" value="${h(v.id)}"`)+input('revision',`type="hidden" value="${v.revision}"`)+field('Person',input('person',`required maxlength="100" value="${h(v.person)}"`))+field('Amount',input('amount',`inputmode="decimal" required value="${h(v.amount)}" ${v.kind==='split'?'readonly':''}`))+field('Date',input('date',`type="date" required value="${h(v.date)}"`))+field('Description',input('description',`required maxlength="500" value="${h(v.description)}"`))+(v.kind==='split'?'<p class="helper">A split amount is locked because all shares must still equal the purchase total.</p>':''),'settlement-edit-form','Save obligation');
}
function investmentEditor() {
  editor('Add investment or emergency fund',field('Name',input('name','required maxlength="100" placeholder="Index fund or rainy-day cash"'))+field('Investment type',`<select name="investment_type" id="investment-type">${option('lumpsum','Mutual fund · lump sum')}${option('sip','Mutual fund · SIP')}${option('stock_market','Stock market')}${option('emergency_fund','Emergency fund')}</select>`)+field('Currency',input('currency',`required pattern="[A-Z]{3}" value="${h(state.me.household.base_currency)}"`))+`<div id="investment-sip-fields" hidden>${field('SIP amount per month',input('sip_amount','inputmode="decimal" pattern="[0-9]+(\\.[0-9]+)?" placeholder="0.00"'))}${field('SIP day of month',input('sip_day','type="number" min="1" max="31" value="1"'))}${field('SIP start month',input('sip_start_month',`type="month" value="${h(state.month)}"`))}${field('SIP end month (optional)',input('sip_end_month','type="month"'))}<p class="helper">A SIP is a schedule. Record actual additions and month-end values separately.</p></div>`+field('Starting portfolio value (existing holdings)',input('opening_value','inputmode="decimal" placeholder="0.00"'))+field('Starting month',input('opening_month',`type="month" value="${h(state.month)}"`))+`<p class="helper">This value is your starting baseline. It does not debit an account or count as a new investment.</p>`+field('New contribution now (optional)',input('principal','inputmode="decimal" pattern="[0-9]+(\\.[0-9]+)?" placeholder="0.00"'))+field('Value after new contribution (optional)',input('current_value','inputmode="decimal" pattern="[0-9]+(\\.[0-9]+)?" placeholder="0.00"'))+field('Valuation month',input('valuation_month',`type="month" required value="${h(state.month)}"`))+field('Paid from account',`<select name="account_id">${option('','Choose an account')}${state.accounts.filter(a=>a.active!==false&&a.subtype!=='settle_up').map(a=>option(a.id,`${a.name} · ${a.currency}`)).join('')}</select>`)+field('Investment date',input('transaction_date',`type="date" value="${h(localDate().startsWith(state.month)?localDate():`${state.month}-01`)}"`))+`<p class="helper">Enter the contribution and its resulting value together only when you are investing new money now. Select the account used for that contribution. Your starting portfolio value is a separate baseline.</p>`+field('Target value (optional)',input('target','inputmode="decimal" pattern="[0-9]+(\\.[0-9]+)?" placeholder="0.00"'))+field('Monthly addition goal (optional)',input('monthly_goal','inputmode="decimal" pattern="[0-9]+(\\.[0-9]+)?" placeholder="0.00"'))+field('Household view',`<select name="visibility">${option('private','Private')}${option('shared','Share monthly invested totals')}</select>`),'investment-form','Create');
}
function syncInvestmentType() {
  const form=dialog.querySelector('#investment-form');if(!form)return;
  const sip=form.elements.investment_type.value==='sip';
  form.querySelector('#investment-sip-fields').hidden=!sip;
  for(const name of ['sip_amount','sip_day','sip_start_month'])form.elements[name].required=sip;
}
async function investmentEditEditor(key) {
  const v=await api.request(`investments/${id(key)}`);
  editor('Edit investment plan',input('investment_id',`type="hidden" value="${h(v.id)}"`)+input('revision',`type="hidden" value="${v.revision}"`)+field('Name',input('name',`required maxlength="100" value="${h(v.name)}"`))+field('Starting portfolio value',input('opening_value',`inputmode="decimal" value="${h(v.opening_value||'')}" placeholder="0.00"`))+field('Starting month',input('opening_month',`type="month" value="${h(v.opening_month||v.records[0]?.month||state.month)}"`))+`<p class="helper">Set the baseline for holdings you already owned. It does not create an account transaction. Use the month of your first recorded value or earlier.</p>`+field('Target value',input('target',`inputmode="decimal" value="${h(v.target||'0')}"`))+field('Monthly addition goal',input('monthly_goal',`inputmode="decimal" value="${h(v.monthly_goal||'0')}"`))+field('Household view',`<select name="visibility">${option('private','Private',v.visibility!=='shared')}${option('shared','Share monthly invested totals',v.visibility==='shared')}</select>`),'investment-edit-form','Save plan');
}
async function investmentSipEditor(key) {
  const v=await api.request(`investments/${id(key)}`), sip=v.sip;
  if(v.type!=='investment') throw new Error('SIPs are available for investments only.');
  editor(`${sip?'Edit':'Set up'} SIP · ${v.name}`,input('investment_id',`type="hidden" value="${h(v.id)}"`)+input('revision',`type="hidden" value="${v.revision}"`)+field(`Monthly amount (${v.currency})`,input('amount',`inputmode="decimal" required pattern="[0-9]+(\\.[0-9]+)?" value="${h(sip?.amount||'')}" placeholder="0.00"`))+field('Day of month',input('day',`type="number" required min="1" max="31" value="${h(sip?.day||1)}"`))+field('Start month',input('start_month',`type="month" required value="${h(sip?.start_month||state.month)}"`))+field('End month (optional)',input('end_month',`type="month" value="${h(sip?.end_month||'')}"`))+field('Status',`<select name="status">${option('active','Active',sip?.status!=='paused')}${option('paused','Paused',sip?.status==='paused')}</select>`)+`<p class="helper">For months shorter than the selected day, the planned date is the last day. Record actual additions through Add or correct month; this SIP does not move money or create a valuation.</p>`+(sip?`<button type="button" class="outline-button danger-button" data-action="investment-sip-remove" data-id="${h(v.id)}">Remove SIP</button>`:''),'investment-sip-form',sip?'Save SIP':'Create SIP');
}
async function investmentProcessSipEditor(key) {
  const holding=await api.request(`investments/${id(key)}`);
  const due=sipDueDate(holding.sip,state.month);
  if(!due) throw new Error('The SIP is not active for this month.');
  const existing=holding.records.find(record=>record.month===state.month);
  if(existing?.sip_processed) throw new Error('This SIP month has already been processed.');
  if(existing && (Number(existing.contribution)>0 || Number(existing.withdrawal)>0)) throw new Error('This month already has activity. Use Add or correct month to review it.');
  const accounts=state.accounts.filter(account=>account.currency===holding.currency&&account.active!==false&&account.subtype!=='settle_up');
  if(!accounts.length) throw new Error(`Add an active ${holding.currency} account before processing this SIP.`);
  editor(`Process SIP · ${holding.name}`,input('investment_id',`type="hidden" value="${h(holding.id)}"`)+input('revision',`type="hidden" value="${holding.revision}"`)+input('month',`type="hidden" value="${h(state.month)}"`)+`<p class="helper">Record ${amount(holding.sip.amount,holding.currency)} for ${h(state.month)}. This debits the chosen account once. ${existing?.value!=null?'Enter an updated portfolio value after this payment.':'You can add a portfolio valuation later.'}</p>`+field('Paid from account',`<select name="account_id" required>${accounts.map(account=>option(account.id,account.name)).join('')}</select>`)+field('Transaction date',input('transaction_date',`type="date" required value="${h(due)}"`))+field(`Portfolio value after SIP${existing?.value!=null?'':' (optional)'}`,input('value',`inputmode="decimal" ${existing?.value!=null?'required':''} placeholder="${existing?.value!=null?`Previously ${h(existing.value)}`:'Add when known'}"`)),'investment-process-sip-form','Process SIP');
}
async function investmentMonthEditor(key) {
  const v=await api.request(`investments/${id(key)}`), existing=v.records.find(r=>r.month===state.month);
  const multiple=(existing?.transaction_ids?.length||0)>1;
  editor(`Monthly value · ${v.name}`,input('investment_id',`type="hidden" value="${h(v.id)}"`)+input('revision',`type="hidden" value="${v.revision}"`)+field('Month',input('month',`type="month" required value="${h(state.month)}"`))+field('Principal added during month',input('contribution',`inputmode="decimal" required value="${h(existing?.contribution||'0')}" ${multiple?'readonly':''}`))+field('Withdrawn during month',input('withdrawal',`inputmode="decimal" required value="${h(existing?.withdrawal||'0')}" ${multiple?'readonly':''}`))+field('Current value at month end (optional)',input('value',`inputmode="decimal" value="${h(existing?.value??'')}" placeholder="Add when known"`))+field('Account for money movement',`<select name="account_id">${option('','No account')}${state.accounts.filter(a=>a.currency===v.currency&&(a.active!==false||a.id===existing?.account_id)&&a.subtype!=='settle_up').map(a=>option(a.id,a.name,a.id===existing?.account_id)).join('')}</select>`)+field('Movement date',input('transaction_date',`type="date" value="${h(existing?.transaction_date||(localDate().startsWith(state.month)?localDate():`${state.month}-01`))}"`))+`<p class="helper">Use Edit plan for a starting portfolio value. Enter only new money under Added or Withdrawn, choose its account, and add a month-end value when known. Investment movements do not count as expenses.${multiple?' This month has separate account movements. Correct their amounts, dates, or accounts from Monthly history; this form changes the valuation only.':''}</p>`,'investment-month-form','Save month');
  if(multiple) {
    const form=dialog.querySelector('#investment-month-form');
    form.dataset.fixedMonth=state.month;
    form.dataset.accountId=existing.account_id;
    form.dataset.transactionDate=existing.transaction_date;
    for(const name of ['month','account_id','transaction_date']) {
      form.elements[name].disabled=true;
      form.elements[name].closest('label').hidden=true;
    }
  }
}
async function investmentMovementEditEditor(holdingId,movementId) {
  const [holding,movement]=await Promise.all([api.request(`investments/${id(holdingId)}`),api.request(`transactions/${id(movementId)}`)]);
  const record=holding.records.find(row=>row.transaction_ids?.includes(movementId));
  if(!record || movement.voided)throw new Error('This investment movement is no longer active.');
  const accounts=state.accounts.filter(account=>account.currency===holding.currency&&(account.active!==false||account.id===movement.movements[0].account_id)&&account.subtype!=='settle_up');
  editor(`Correct ${movement.event_type==='investment'?'addition':'withdrawal'} · ${holding.name}`,input('investment_id',`type="hidden" value="${h(holding.id)}"`)+input('movement_id',`type="hidden" value="${h(movement.id)}"`)+input('revision',`type="hidden" value="${holding.revision}"`)+`<p>${h(record.month)} · This changes one account movement and keeps the other movements in the month.</p>`+field('Amount',input('amount',`required inputmode="decimal" value="${h(movement.amount)}"`))+field('Account',`<select name="account_id" required>${accounts.map(account=>option(account.id,account.name,account.id===movement.movements[0].account_id)).join('')}</select>`)+field('Date',input('transaction_date',`type="date" required value="${h(movement.effective_date)}"`))+dangerButton('Remove this movement','investment-movement-delete',`data-id="${h(holding.id)}" data-movement="${h(movement.id)}" data-revision="${holding.revision}"`),'investment-movement-edit-form','Save movement');
}
async function budgetEditor(key=null,createScope=state.scope) {
  const existing=key?await api.request(`budgets/${id(key)}`):null;
  if(existing?.state==='archived') throw new Error('Archived plans cannot be edited.');
  const budgetMonth=existing?.month||state.month;
  const budgetScope=existing?.scope||(createScope==='combined'?'personal':createScope),budgetCurrency=existing?.currency||state.me.household.base_currency;
  const [year,month]=budgetMonth.split('-').map(Number);
  const months=[3,2,1].map(offset=>new Date(Date.UTC(year,month-1-offset,1)).toISOString().slice(0,7));
  const results=await Promise.all(months.map(month=>api.request(`analytics/categories?${new URLSearchParams({...period(month),scope:budgetScope,currency:budgetCurrency})}`)));
  const scale=new Intl.NumberFormat('en',{style:'currency',currency:budgetCurrency}).resolvedOptions().maximumFractionDigits;
  const averages=(analyticsView.categoryAverages||budgetCategoryAverages)(results.map(result=>result.data),scale);
  const categories=categoryView.ordered(state.categories,'expense').filter(({category})=>category.archived!==true);
  const currentLines=new Map((existing?.lines||[]).map(line=>[line.category_id,line]));
  const archivedLines=(existing?.lines||[]).filter(line=>!categories.some(({category})=>category.id===line.category_id));
  const currentPeopleLimits=new Map((existing?.people_limits||[]).map(line=>[line.destination,line.amount]));
  const peopleChoices=[...state.members.map(member=>({id:member.user_id,name:member.name})),...([...currentPeopleLimits.keys()].filter(key=>!['shared','unassigned'].includes(key)&&!state.members.some(member=>member.user_id===key)).map(key=>({id:key,name:'Archived member'}))),{id:'shared',name:'Shared household pool'},{id:'unassigned',name:'Unassigned allowance'}];
  const peopleLimitsHtml=budgetScope==='family'?`<h3>People allowances</h3><p class="helper">Optional. If set, these amounts must add up to the category limits; Shared and Unassigned are separate. Leave every field blank for no person limits.</p><div class="budget-input-grid">${peopleChoices.map(choice=>field(choice.name,`<input name="person-limit-${h(choice.id)}" data-person-limit="${h(choice.id)}" inputmode="decimal" pattern="[0-9]+(\\.[0-9]+)?" value="${h(currentPeopleLimits.get(choice.id)||'')}" placeholder="No limit">`)).join('')}</div>`:'';
  const lines=categories.map(({category})=>{
    const average=averages.get(category.id);
    const suggested=average && Number(average)>0;
    const mode=currentLines.get(category.id)?.mode||'exact';
    const canPool=mode==='pooled'||state.categories.some(child=>child.parent_id===category.id);
    return `<div class="budget-input-row">${field(categoryName(category.id),input(`category-${category.id}`,`inputmode="decimal" pattern="[0-9]+(\\.[0-9]+)?" placeholder="No limit" value="${h(currentLines.get(category.id)?.amount||'')}"`))}${canPool?field('Limit covers',`<select name="mode-${h(category.id)}">${option('exact','This category only',mode!=='pooled')}${option('pooled','This category and subcategories',mode==='pooled')}</select>`):''}${suggested?`<button type="button" class="quick-chip average-chip" data-action="use-budget-average" data-average-for="${h(category.id)}" data-value="${h(average)}">3-month avg · ${amount(average,budgetCurrency)}</button>`:''}</div>`;
  }).join('');
  editor(existing?'Edit monthly budget':'Create monthly budget',(existing?input('budget_id',`type="hidden" value="${h(existing.id)}"`)+input('revision',`type="hidden" value="${existing.revision}"`):input('scope',`type="hidden" value="${h(budgetScope)}"`))+field('Name',input('name',`required value="${h(existing?.name||`${budgetMonth} budget`)}"`))+field('Expected income',input('expected_income',`inputmode="decimal" pattern="[0-9]+(\\.[0-9]+)?" required value="${h(existing?.expected_income||'')}" placeholder="0.00"`))+field('Monthly savings goal',input('savings_goal',`inputmode="decimal" pattern="[0-9]+(\\.[0-9]+)?" value="${h(existing?.savings_goal||'0')}" placeholder="0.00"`))+`<div class="budget-suggestion"><div><strong>Start from recorded spending</strong><p>Average of ${h(months.join(', '))}. Months with no recorded spending count as zero. Coverage is unconfirmed, so review each limit.</p></div>${[...averages.values()].some(v=>Number(v)>0)?button('Apply averages','apply-budget-averages'):''}</div><p class="helper">${h(budgetMonth)} · ${h(budgetScope)} · ${h(budgetCurrency)}</p>${archivedLines.length?`<p class="helper">${archivedLines.length} archived category limit(s) cannot be revised and will be removed when you save this edit.</p>`:''}<p class="helper">A pooled limit covers its category and descendants; leave descendant limits blank. Three-month averages refer to the exact category.</p><div class="budget-input-grid">${lines}</div>${peopleLimitsHtml}`,existing?'budget-edit-form':'budget-form',existing?'Save budget':'Create draft');
}
function budgetAmendmentPreviewEditor(preview) {
  state.pendingBudgetAmendment=preview;
  const currency=preview.currency;
  const destinationName=key=>state.members.find(member=>member.user_id===key)?.name||(key==='shared'?'Shared pool':key==='unassigned'?'Unassigned':key);
  const changeTable=(title,changes,label)=>`<h3>${h(title)}</h3>${label==='Category'?table([label,'Before','Coverage before','After','Coverage after','Change'],changes.map(row=>[h(categoryName(row.id)),amount(row.before,currency),h(row.before_mode==='pooled'?'Pooled':'Exact'),amount(row.after,currency),h(row.after_mode==='pooled'?'Pooled':'Exact'),amount(row.delta,currency)])):table([label,'Before','After','Change'],changes.map(row=>[h(destinationName(row.id)),amount(row.before,currency),amount(row.after,currency),amount(row.delta,currency)]))}`;
  const body=`<p>Review the plan before saving. This creates an audited revision; recorded transactions stay unchanged.</p>${table(['','Before','After'],[['Plan name',h(preview.before_name||''),h(preview.after_name||'')],['Expense limits',amount(preview.before.total_allowance,currency),amount(preview.after.total_allowance,currency)],['Expected income',amount(preview.before.expected_income,currency),amount(preview.after.expected_income,currency)],['Savings goal',amount(preview.before.savings_goal,currency),amount(preview.after.savings_goal,currency)],['Funding gap',amount(preview.before.funding_gap,currency),amount(preview.after.funding_gap,currency)]])}${changeTable('Category changes',preview.category_changes,'Category')}${changeTable('People allowance changes',preview.people_changes,'Person or pool')}${preview.unfunded_warning?field('I understand this plan has an unfunded increase',input('accept_unfunded','type="checkbox" required')):'<p class="helper">The funding gap has not worsened below zero.</p>'}${field('Reason for this change',input('reason','required maxlength="500"'))}`;
  editor('Review budget change',body,'budget-amendment-form','Save amendment');
}

// Import review state is reconstructed from the server and URL after a reload.
async function importView(parts,generation) {
  state.batch=parts[0] || null; state.file=parts[1] || null;
  if(!state.batch) {
    const history=await api.collection('imports');
    const cleanup=state.cleanupPreview;
    const cleanupPanel=panel('Reimport Money Manager entries',`<form id="cleanup-preview-form" class="form-grid">${field('Period',`<select name="period_type"><option value="month">Month</option><option value="year">Year</option></select>`)}${field('Month',input('month',`type="month" required value="${h(state.month)}"`))}${field('Year',input('year',`type="number" min="1" max="9998" required value="${h(state.month.slice(0,4))}"`))}<button type="submit" class="outline-button">Preview entries</button></form><p class="helper">Only transactions created from your Money Manager imports are included. Manual transactions and bank statement observations remain.</p>${cleanup?`<p><strong>${h(cleanup.count)} transactions</strong> found for ${h(cleanup.period)}.${cleanup.skipped_mixed_sources?` ${h(cleanup.skipped_mixed_sources)} entries with mixed sources were skipped.`:''}</p>${table(['Date','Description','Type','Amount'],cleanup.transactions.slice(0,50).map(t=>[h(t.effective_date),h(t.description),h(t.event_type),amount(t.amount,t.currency)]))}${cleanup.count?`<form id="cleanup-apply-form"><p class="helper">Removing these transactions changes balances and reports. Reconciliation links return to review. Upload the workbook again afterward to recreate its rows.</p><button type="submit" class="primary-button">Remove ${h(cleanup.count)} imported transactions</button></form>`:''}`:''}`);
    return heading('Imports','Upload Money Manager or bank statement CSV/XLSX files.')+panel('Upload files',`<form id="upload-form">${field('Source','<select name="source_kind"><option value="money_manager">Money Manager</option><option value="bank_statement">Bank statement CSV / XLSX</option></select>')}${familyMode()?input('import_scope','type="hidden" value="family"'):field('Scope for all imported transactions',`<select name="import_scope">${option('personal','Personal',defaultTransactionScope()==='personal')}${option('family','Family',defaultTransactionScope()==='family')}</select>`)}${field('Files (up to 4; 8 MiB each by default)',input('files','type="file" accept=".xlsx,.csv" multiple required'))}<p class="helper">Uploads are staged for review. Scope applies to Money Manager transactions; bank statements become reconciliation evidence.</p><button type="submit" class="primary-button">Upload and review</button></form><div class="sample-download"><a class="outline-button" href="/samples/bank-statement.csv" download="bank-statement-sample.csv">Download sample bank statement CSV</a><p class="helper">Replace the example rows with your own statement movements before uploading. Choose Bank statement CSV / XLSX as the source.</p></div>`)+cleanupPanel+panel('Import history',table(['Uploaded','State','Files'],history.data.map(b=>[h(b.created_at.slice(0,10)),h(b.state),b.files.map(f=>button(f.filename,'open-import',`data-batch="${h(b.id)}" data-file="${h(f.id)}"`)).join(' ')])));
  }
  let batch=await api.request(`imports/${id(state.batch)}`);
  const fileId=state.file || batch.files[0]?.id;
  if(!fileId) throw new Error('This batch has no files.');
  state.file=fileId;
  let file=await api.request(`imports/${id(batch.id)}/files/${id(fileId)}`);
  for(let attempt=0;['uploaded','parsing'].includes(file.state) && attempt<60;attempt++) {
    if(generation!==state.generation) return '';
    root.innerHTML=heading('Parsing your file','Your upload is saved. You may return to Imports later.')+'<p role="status">Parsing…</p>';
    await new Promise(resolve=>setTimeout(resolve,500));
    file=await api.request(`imports/${id(batch.id)}/files/${id(fileId)}`);
  }
  if(generation!==state.generation) return '';
  state.fileInfo=file;
  const top=heading('Review import',file.filename,navButton('imports','All imports'))+`<div class="file-tabs">${batch.files.map(f=>button(f.filename,'open-import',`data-batch="${h(batch.id)}" data-file="${h(f.id)}"`)).join('')}</div>`;
  if(['uploaded','parsing','failed','omitted','cancelled'].includes(file.state)) return top+panel('File status',`<p>${h(file.state)} ${h(file.error_code || '')}</p>${button('Refresh','refresh')}${file.state==='failed'?button('Retry parsing','retry-file'):''}`);
  const preview=await api.collection(`imports/${id(batch.id)}/preview?file_id=${id(fileId)}`);
  if(generation!==state.generation) return '';
  state.preview=preview.data; state.metadata=preview.meta;
  batch=await api.request(`imports/${id(batch.id)}`); state.batchInfo=batch;
  const dates=preview.data.map(r=>r.effective_date).filter(Boolean).sort();
  const reusable=preview.data.filter(r=>r.duplicate_candidates?.some(c=>c.reason==='same_account_source_occurrence')).length;
  let html=top+panel('Preview summary',`<p><strong>${preview.meta.row_count} rows</strong> · ${reusable} rows already imported and reusable · ${preview.meta.unresolved_count} unresolved · ${h(file.state)}</p><p>Recorded dates: ${h(dates[0] || 'Unknown')} through ${h(dates.at(-1) || 'Unknown')}.</p>${coverage()}${(preview.meta.warnings || []).map(w=>`<p class="helper">${h(w)}</p>`).join('')}`+table(['Type','Currency','Total'],Object.entries(preview.meta.totals_by_event_type || {}).flatMap(([kind,currencies])=>Object.entries(currencies).map(([currency,total])=>[h(kind),h(currency),amount(total,currency)]))));
  if(file.state!=='committed') html+=mappingForm(file,preview.data);
  const review=r=>h(r.issues?.join(', ') || (r.duplicate_candidates?.some(c=>c.reason==='same_account_source_occurrence')?'Will reuse existing transaction':r.duplicate_candidates?.length?'Needs duplicate review':'Ready'));
  const previewRows=file.source_kind==='bank_statement'
    ?table(['Row','Date','Particulars','Movement','Statement balance','Review'],preview.data.slice(0,200).map(r=>[h(r.raw_row_ref.row_number),h(r.effective_date),h(r.description || '—'),amount(r.signed_movement,r.currency),amount(r.statement_balance,r.currency),review(r)]))
    :table(['Row','Date','Description / Note','Type','Account','Category / counterpart','Amount','Review'],preview.data.slice(0,200).map(r=>[h(r.raw_row_ref.row_number),h(r.effective_date),h(r.description || '—'),h(r.event_type),h(r.source_account || accountName(r.account_id)),h([r.source_category,r.source_subcategory].filter(Boolean).join(' › ')),amount(r.signed_movement,r.currency),review(r)]));
  html+=panel('Source rows (first 200 shown)',previewRows);
  if(file.state!=='committed') html+=panel('Commit selected file',`<form id="commit-form"><label class="confirm-line"><input type="checkbox" required> I reviewed the mappings, amounts, and overlap indicators. Commit ready rows from this file.</label><p class="helper">${file.source_kind==='bank_statement'?'Bank rows become evidence only.':`Expenses and income create ${h(familyMode()?'family':file.mapping.allocation_scope||'personal')} ledger entries; uniquely paired transfers count once.`} Exact repeat rows attach their source references to existing transactions. Changed or ambiguous rows stay in review, and existing edits are preserved. Coverage remains unconfirmed.</p><button type="submit" class="primary-button" ${preview.meta.row_count===preview.meta.unresolved_count?'disabled':''}>Commit ready rows</button></form>`);
  if(state.importResult?.batch===batch.id && state.importResult?.file===fileId) html+=panel('Commit result',table(['Outcome','Count'],Object.entries(state.importResult.value.counts).map(([k,v])=>[h(k.replaceAll('_',' ')),h(v)]))+navButton('transactions','View imported transactions'));
  return html;
}
function mappingKeys(rows) {
  const accounts=new Map(), categories=new Map();
  for(const row of rows) {
    if(row.source_account?.trim()) accounts.set(row.source_account.trim(),row.currency);
    if(row.event_type?.startsWith('transfer') && row.source_category?.trim()) accounts.set(row.source_category.trim(),row.currency);
    if(['expense','income'].includes(row.event_type)) {
      const entry={source_label:row.source_category.trim(),subcategory:row.source_subcategory?.trim() || '',event_kind:row.event_type};
      categories.set(JSON.stringify(entry),entry);
    }
  }
  return {accounts:[...accounts].map(([name,currency])=>({name,currency})),categories:[...categories.values()]};
}
function mappingForm(file,rows) {
  const keys=mappingKeys(rows); state.mappingKeys=keys;
  const matchingAccount=(name,currency)=>state.accounts.find(a=>a.name===name && a.currency===currency && a.active!==false)?.id;
  let content='';
  if(file.source_kind==='bank_statement') content=field('Statement account',`<select name="bank_account" required>${option('','Select an account')}${accountOptions(file.mapping.account_id || file.account_id)}</select>`)+field('Date format',`<select name="date_locale">${option('DMY','Day / month / year',file.mapping.date_locale!=='MDY')}${option('MDY','Month / day / year',file.mapping.date_locale==='MDY')}</select>`)+`<p>Choose the account before previewing amounts. The supplied XLSX layout uses Date, Particulars, Withdrawals, Deposits and Balance; flat CSV can use Date, Description, Debit, Credit and Currency.</p>`;
  else {
    content+=(familyMode()?input('allocation_scope','type="hidden" value="family"'):field('Scope for all imported transactions',`<select name="allocation_scope">${option('personal','Personal',(file.mapping.allocation_scope||defaultTransactionScope())==='personal')}${option('family','Family',(file.mapping.allocation_scope||defaultTransactionScope())==='family')}</select>`));
    content+=table(['Source account','Destination account','Type when creating'],keys.accounts.map((a,i)=>{
      const selected=file.mapping.account_aliases?.[a.name] || rows.find(r=>r.source_account?.trim()===a.name)?.account_id || matchingAccount(a.name,a.currency) || 'new';
      return [h(a.name)+`<small>${h(a.currency)}</small>`,`<select name="account-${i}" aria-label="Map account ${h(a.name)}">${option('new',`Create: ${a.name}`,selected==='new')}${state.accounts.filter(v=>v.currency===a.currency && v.active!==false).map(v=>option(v.id,v.name,v.id===selected)).join('')}</select>`,`<select name="subtype-${i}" aria-label="Type for ${h(a.name)}">${['bank','credit_card','cash','settle_up'].map(v=>option(v,v.replace('_',' '))).join('')}</select>`];
    }))+table(['Source category / subcategory','Event kind','Canonical category'],keys.categories.map((c,i)=>{
      const row=rows.find(r=>r.source_category.trim()===c.source_label && (r.source_subcategory?.trim() || '')===c.subcategory && r.event_type===c.event_kind);
      const saved=file.mapping.category_mappings?.find(m=>m.source_label===c.source_label && m.subcategory===c.subcategory && m.event_kind===c.event_kind)?.category_id;
      const selected=saved || row?.category_id || 'new';
      return [h([c.source_label,c.subcategory].filter(Boolean).join(' › ')),h(c.event_kind),`<select name="category-${i}" aria-label="Map category ${h(c.source_label)} ${h(c.subcategory)} ${c.event_kind}">${option('new','Create / reuse matching category',selected==='new')}${categoryOptions(c.event_kind,selected)}</select>`];
    }));
  }
  return panel('Account and category mappings',`<form id="mapping-form">${content}<p class="helper">New accounts are private with unknown opening balances. Choose each account type before saving. Transfer counterpart labels map to accounts, never spending categories. Income and expense mappings are separate.</p><button class="primary-button" type="submit">Save mappings and preview</button></form>`);
}
async function saveMapping(form) {
  const data=new FormData(form); const file=state.fileInfo; const batchId=state.batch, fileId=state.file, keys=state.mappingKeys; const mapping={...file.mapping};
  if(file.source_kind==='bank_statement') { mapping.account_id=data.get('bank_account'); mapping.currency=state.accounts.find(a=>a.id===mapping.account_id)?.currency; mapping.date_locale=data.get('date_locale'); }
  else {
    mapping.allocation_scope=familyMode()?'family':data.get('allocation_scope');
    mapping.account_aliases={...(mapping.account_aliases || {})}; mapping.category_mappings=[];
    // Reuse names after a partial failure; each successful create is immediately remembered.
    for(const [i,a] of keys.accounts.entries()) {
      let key=data.get(`account-${i}`);
      if(key==='new') {
        const existing=state.accounts.find(v=>v.name===a.name && v.currency===a.currency && v.active!==false);
        if(existing) key=existing.id;
        else { const created=await api.request('accounts',{method:'POST',body:{name:a.name,subtype:data.get(`subtype-${i}`),currency:a.currency,visibility:familyMode()?'shared':'private'}}); state.accounts.push(created); key=created.id; }
      }
      mapping.account_aliases[a.name]=key;
    }
    async function category(name,kind,parent=null) {
      const existing=state.categories.find(v=>v.name===name && v.kind===kind && (v.parent_id || null)===parent && v.archived!==true);
      if(existing) return existing.id;
      const created=await api.request('categories',{method:'POST',body:{name,kind,parent_id:parent}}); state.categories.push(created); return created.id;
    }
    for(const [i,c] of keys.categories.entries()) {
      let key=data.get(`category-${i}`);
      if(key==='new') { key=await category(c.source_label,c.event_kind); if(c.subcategory) key=await category(c.subcategory,c.event_kind,key); }
      mapping.category_mappings.push({...c,category_id:key});
    }
  }
  await api.request(`imports/${id(batchId)}/files/${id(fileId)}/mapping`,{method:'PATCH',revision:file.revision,body:{mapping}});
  notify('Mappings saved. Review the updated preview before committing.'); await renderRoute();
}

const actions = {
  'share-account':async el=>{const account=state.accounts.find(a=>a.id===el.dataset.id);if(!account)return;if(!window.confirm(`Share ${account.name} and its full account history with every household member?`))return;await api.request(`accounts/${id(account.id)}`,{method:'PATCH',revision:account.revision,body:{visibility:'shared'}});await catalogs();notify('Account moved to household access.');await renderRoute();},
  'share-category':async el=>{const category=state.categories.find(c=>c.id===el.dataset.id);if(!category)return;if(!window.confirm(`Share ${category.name} with every household member?`))return;await api.request(`categories/${id(category.id)}`,{method:'PATCH',revision:category.revision,body:{visibility:'shared'}});await catalogs();notify('Category moved to household access.');await renderRoute();},
  'add-plan':()=>planEditor(),
  'edit-plan':el=>planEditor(el.dataset.id),
  'match-plan':el=>matchPlanEditor(el.dataset.id),
  'unmatch-plan':async el=>{const item=state.plannedItems.find(v=>v.id===el.dataset.id);if(!item)return;const reason=window.prompt(`Reason for unmatching ${item.title}?`);if(!reason?.trim())return;await api.request(`planned-items/${id(item.id)}/match`,{method:'DELETE',revision:item.revision,body:{reason:reason.trim()}});notify('Expense unmatched. The commitment is planned again.');await renderRoute();},
  'skip-plan':async el=>{const item=state.plannedItems.find(v=>v.id===el.dataset.id);if(!item)return;await api.request(`planned-items/${id(item.id)}`,{method:'PATCH',revision:item.revision,body:{status:item.status==='skipped'?'planned':'skipped'}});notify('Commitment updated.');await renderRoute();},
  'toggle-plan':async el=>{const item=state.plannedItems.find(v=>v.id===el.dataset.id);if(!item)return;await api.request(`planned-items/${id(item.id)}`,{method:'PATCH',revision:item.revision,body:{status:item.status==='planned'?'done':'planned'}});notify('Plan status updated.');await renderRoute();},
  'delete-plan':async el=>{const item=state.plannedItems.find(v=>v.id===el.dataset.id);if(!item||!window.confirm(`Remove the plan for ${item.title}?`))return;await api.request(`planned-items/${id(item.id)}`,{method:'DELETE',revision:item.revision,body:{}});notify('Plan removed.');await renderRoute();},
  'recurring-filter':el=>{state.recurringFilter=el.dataset.filter;renderRoute();},
  'recurring-status':async el=>{const field=el.dataset.field,value=el.dataset.value==='true';if(!['subscription','ignored'].includes(field))return;await api.request(`recurring-transactions/${id(el.dataset.key)}`,{method:'PUT',body:{[field]:value}});notify(field==='ignored'?(value?'Pattern ignored.':'Pattern restored to review.'):(value?'Marked as subscription.':'Subscription tag removed.'));await renderRoute();},
  'show-bulk-scope':()=>{const panel=document.querySelector('#bulk-scope-panel');if(panel){panel.open=true;loadBulkScopePanel(panel);panel.scrollIntoView({behavior:'smooth',block:'start'});}},
  'transaction-balance':transactionBalanceEditor,
  'transaction-balance-after':el=>{
    const row=state.ledgerBalances.get(el.dataset.account+':'+el.dataset.id);
    if(!row) throw new Error('Reload this transaction before checking its balance.');
    const after=new Date(Date.parse(row.effective_at)+60000);
    balanceEditor(el.dataset.account,localDateTime(after.toISOString()));
  },
  'reopen-money-manager':async el=>{await api.request(`money-manager/changes/${id(el.dataset.id)}/sync`,{method:'POST',revision:Number(el.dataset.revision),body:{synced:false}});notify('Returned to the update list.');await renderRoute();},
  'sync-money-manager':async el=>{await api.request(`money-manager/changes/${id(el.dataset.id)}/sync`,{method:'POST',revision:Number(el.dataset.revision),body:{synced:true}});notify('Marked updated in Money Manager.');await renderRoute();},
  refresh:()=>renderRoute(), 'select-month':el=>{setMonth(el.dataset.month);renderRoute();}, 'transaction-period':()=>navigate('transactions',location.hash.slice(1)==='transactions/all'?[]:['all']), 'account-period':el=>navigate('accounts',el.dataset.all==='true'?[el.dataset.id,'all']:[el.dataset.id]), 'clear-transaction-filters':()=>{state.transactionFilters={account:'',accountType:'',eventType:''};saveView();renderRoute();}, 'copy-invite-link':async()=>{await navigator.clipboard.writeText(state.inviteLink);notify('Invitation link copied.');}, 'copy-widget-calendar-url':async()=>{await navigator.clipboard.writeText(document.querySelector('#widget-calendar-url').textContent);notify('Calendar URL copied.');}, logout:async()=>{await api.request('auth/logout',{method:'POST',body:{}});resetSession();},
  'reset-add-month':async()=>{const month=document.querySelector('#reset-month').value;if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw new Error('Choose a valid month.');if(state.resetMonths.length>=24)throw new Error('Select at most 24 months.');state.resetMonths=[...new Set([...state.resetMonths,month])].sort();state.resetPreview=null;await renderRoute();},
  'reset-remove-month':async el=>{state.resetMonths=state.resetMonths.filter(month=>month!==el.dataset.month);state.resetPreview=null;await renderRoute();},
  'close-editor':()=>dialog.close(), 'close-transaction-drawer':closeTransactionDrawer, 'card-payment':el=>cardPaymentEditor(el.dataset.id), 'add-investment-transaction':investmentTransactionEditor, 'quick-account-open':el=>openQuickCreate('account',el.dataset.target), 'quick-category-open':()=>openQuickCreate('category'), 'quick-create-cancel':el=>quickPanel(document.querySelector('#transaction-form'),el.closest('.transaction-quick-panel').id.endsWith('account')?'account':'category'), 'quick-account-save':()=>saveQuickCreate('account'), 'quick-category-save':()=>saveQuickCreate('category'), 'use-budget-average':el=>{const control=dialog.querySelector(`[name="category-${CSS.escape(el.dataset.averageFor)}"]`);if(control){control.value=el.dataset.value;control.focus();}}, 'apply-budget-averages':()=>{dialog.querySelectorAll('[data-average-for]').forEach(chip=>{const control=dialog.querySelector(`[name="category-${CSS.escape(chip.dataset.averageFor)}"]`);if(control && !control.value)control.value=chip.dataset.value;});}, account:accountEditor, category:()=>categoryEditor(), 'add-subcategory':el=>categoryEditor(null,el.dataset.parent), 'edit-category':el=>categoryEditor(el.dataset.id), transaction:()=>transactionEditor({accountId:state.view==='transactions'?state.transactionFilters.account:null}), 'transaction-account':el=>transactionEditor({accountId:el.dataset.account}), 'transaction-category-context':el=>{dialog.close();transactionEditor({categoryId:el.dataset.category});}, 'choose-transaction-category':el=>{const form=document.querySelector('#transaction-form');if(!form)return;form.elements.category_id.value=el.dataset.category;form.elements.category_id.dataset.manual='true';delete form.elements.category_id.dataset.suggested;renderTransactionCategoryGrid(form);updateTransactionPreview();},
  settlement:settlementEditor, split:splitEditor, repayment:el=>repaymentEditor(el.dataset.id), 'settlement-edit':el=>settlementEditEditor(el.dataset.id),
  'settlement-filter':el=>{state.settlementFilter=el.dataset.filter;renderRoute();}, 'investment-filter':el=>{state.investmentFilter=el.dataset.filter;renderRoute();},
  'analytics-scope':el=>{if(el.dataset.scope===state.scope)return;state.scope=el.dataset.scope;syncScopeControl();saveView();renderRoute();},
  'analytics-tab':el=>{const tab=el.dataset.tab;if(!['summary','trends','planning','detailed'].includes(tab))return;state.analyticsTab=tab;document.querySelectorAll('.analytics-view-tabs [data-tab]').forEach(button=>{const active=button.dataset.tab===tab;button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;});document.querySelectorAll('.analytics-page [role="tabpanel"]').forEach(panel=>{panel.hidden=panel.id!==`analytics-panel-${tab}`;});document.querySelector(`#analytics-tab-${tab}`)?.focus({preventScroll:true});requestAnimationFrame(()=>document.querySelectorAll(`#analytics-panel-${tab} canvas[data-chart]`).forEach(canvas=>window.Chart?.getChart(canvas)?.resize()));},
  'budget-tab':el=>{const tab=el.dataset.tab;if(!['top','people','categories','ahead'].includes(tab))return;state.budgetTab=tab;const url=new URL(location.href);url.searchParams.set('budget_tab',tab);history.replaceState(null,'',url.pathname+url.search+url.hash);document.querySelectorAll('.budget-view-tabs [role="tab"]').forEach(button=>{const active=button.dataset.tab===tab;button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;});document.querySelectorAll('[id^="budget-panel-"]').forEach(panel=>{panel.hidden=panel.id!==`budget-panel-${tab}`;});document.querySelector(`#budget-tab-${tab}`)?.focus({preventScroll:true});requestAnimationFrame(()=>document.querySelectorAll(`#budget-panel-${tab} canvas[data-chart]`).forEach(canvas=>window.Chart?.getChart(canvas)?.resize()));},
  'budget-allocation-detail':budgetAllocationDetail,
  'budget-matrix-detail':budgetMatrixDetail,
  'repayment-remove':async el=>{if(!window.confirm('Remove this payment? The obligation balance will increase.'))return;await api.request(`settle-ups/${id(el.dataset.id)}/repayments/${id(el.dataset.payment)}`,{method:'DELETE',revision:Number(el.dataset.revision),body:{}});notify('Payment removed.');await renderRoute();},
  'settlement-delete':async el=>{const item=await api.request(`settle-ups/${id(el.dataset.id)}`);const group=item.split_id?(await api.collection('settle-ups')).data.filter(v=>v.split_id===item.split_id):[item];const message=item.split_id?`Delete this purchase split and all ${group.length} related balances? Recorded payments will be removed from Settle up. The linked expense will remain.`:`Delete the ${item.currency} ${item.amount} obligation for ${item.person} and its payment history?`;if(!window.confirm(message))return;await api.request(`settle-ups/${id(item.id)}`,{method:'DELETE',revision:item.revision,body:{}});notify(item.split_id?'Split deleted.':'Obligation deleted.');await renderRoute();},
  investment:investmentEditor, 'investment-month':el=>investmentMonthEditor(el.dataset.id), 'investment-movement-edit':el=>investmentMovementEditEditor(el.dataset.id,el.dataset.movement), 'investment-edit':el=>investmentEditEditor(el.dataset.id), 'investment-sip':el=>investmentSipEditor(el.dataset.id),
  'investment-movement-delete':async el=>{if(!window.confirm('Remove this account movement from the investment month? Its account balance and reconciliation will change.'))return;await api.request(`investments/${id(el.dataset.id)}/movements/${id(el.dataset.movement)}`,{method:'DELETE',revision:Number(el.dataset.revision),body:{}});dialog.close();notify('Investment movement removed.');await renderRoute();},
  'investment-sip-remove':async el=>{const v=await api.request(`investments/${id(el.dataset.id)}`);if(!v.sip)return;if(!window.confirm(`Remove the SIP schedule for ${v.name}? Recorded monthly additions will remain.`))return;await api.request(`investments/${id(v.id)}`,{method:'PATCH',revision:v.revision,body:{sip:null}});dialog.close();notify('SIP removed.');await renderRoute();},
  'investment-delete':async el=>{const holding=await api.request(`investments/${id(el.dataset.id)}`);if(!window.confirm(`Delete ${holding.name} and its ${holding.records.length} monthly record${holding.records.length===1?'':'s'} from Investments and Analytics? Linked investment account movements will be removed from active transactions.`))return;await api.request(`investments/${id(holding.id)}`,{method:'DELETE',revision:holding.revision,body:{}});notify('Holding deleted.');await renderRoute();},
  'investment-month-delete':async el=>{const holding=await api.request(`investments/${id(el.dataset.id)}`);const record=holding.records.find(r=>r.month===el.dataset.month);if(!record)throw new Error('This monthly record has changed. Reload the holding.');if(!window.confirm(`Delete ${record.month} for ${holding.name}? Later net additions and value change will be recalculated. Linked account movements for this month will be removed.`))return;await api.request(`investments/${id(holding.id)}/months/${id(record.month)}`,{method:'DELETE',revision:holding.revision,body:{}});notify('Monthly record deleted.');await renderRoute();},
  'analytics-category-detail':el=>analyticsCategoryDetail(el.dataset.category,el.dataset.currency),
  'analytics-investment-detail':el=>analyticsInvestmentDetail(el.dataset.id), 'investment-transaction':el=>{dialog.close();navigate('investments');}, 'investment-process-sip':el=>investmentProcessSipEditor(el.dataset.id),
  'analytics-person-detail':el=>analyticsPersonDetail(el.dataset.person,el.dataset.direction,el.dataset.currency),
  'analytics-open-transaction':async el=>{dialog.close();await transactionDetail(el.dataset.id);},
  'transaction-detail':el=>transactionDetail(el.dataset.id), 'edit-transaction':el=>transactionEditEditor(el.dataset.id), 'convert-card-payment':el=>convertCardPaymentEditor(el.dataset.id), 'delete-transaction':async el=>{const t=await api.request(`transactions/${id(el.dataset.id)}`);if(!window.confirm(`Delete ${t.description || 'this transaction'} (${t.currency} ${t.amount})? Its prior revisions will be retained.`)) return;await api.request(`transactions/${id(t.id)}`,{method:'DELETE',revision:t.revision,body:{reason:'Deleted by user'}});dialog.close();notify('Transaction deleted.');await renderRoute();}, 'account-ledger':el=>navigate('accounts',[el.dataset.id]), 'edit-account':el=>editAccountEditor(el.dataset.id), balance:el=>balanceEditor(el.dataset.id), 'opening-balance':el=>openingBalanceEditor(el.dataset.id), 'edit-balance-check':el=>balanceCheckEditor(el.dataset.account,el.dataset.id), 'remove-balance-check':async el=>{const check=state.selectedChecks?.find(c=>c.id===el.dataset.id);if(!check || !window.confirm(`Remove the balance check from ${check.as_of}? Its audit history will be retained.`)) return;await api.request(`accounts/${id(el.dataset.account)}/balance-checks/${id(check.id)}`,{method:'DELETE',revision:check.revision});notify('Balance check removed.');await renderRoute();}, budget:()=>budgetEditor(), 'budget-personal':()=>budgetEditor(null,'personal'), 'budget-family':()=>budgetEditor(null,'family'), 'edit-budget':el=>budgetEditor(el.dataset.id),
  'activate-budget':async el=>{await api.request(`budgets/${id(el.dataset.id)}/activate`,{method:'POST',revision:el.dataset.revision,body:{}});await renderRoute();},
  'copy-budget':async el=>{const next=new Date(Date.UTC(Number(state.month.slice(0,4)),Number(state.month.slice(5,7)),1)).toISOString().slice(0,7);await api.request(`budgets/${id(el.dataset.id)}/copy`,{method:'POST',revision:el.dataset.revision,body:{month:next}});setMonth(next);navigate('budgets');notify(`Budget copied to ${next} as a draft.`);},
  'open-import':el=>navigate('imports',[el.dataset.batch,el.dataset.file]),
  'retry-file':async()=>{await api.request(`imports/${id(state.batch)}/files/${id(state.file)}/retry`,{method:'POST',revision:state.fileInfo.revision,body:{}});await renderRoute();},
  'open-session':el=>navigate('reconcile',[el.dataset.id]),
  'review-account':el=>editor('Start account review',field('Bank or card account',`<select name="account_id" required>${state.accounts.filter(a=>['bank','credit_card'].includes(a.subtype)).map(a=>option(a.id,a.name,a.id===el.dataset.id)).join('')}</select>`)+`<p>${h(state.month)}</p>`,'session-form','Start review'),
  'review-balance':el=>navigate('reconcile',['balance',el.dataset.account,el.dataset.check]),
  'add-reconcile-transaction':el=>transactionEditor({accountId:el.dataset.account}),
  'auto-match':async el=>{const label=el.textContent;el.textContent='Matching…';el.setAttribute('aria-busy','true');try {const result=await api.request(`reconciliation/sessions/${id(el.dataset.id)}/auto-match`,{method:'POST',revision:state.session.revision,body:{}});notify(`${result.matched_count} exact transaction pairs matched.`);await refreshReconciliationComparison();} finally {el.textContent=label;el.removeAttribute('aria-busy');}},
  'save-amendment':()=>{const selected=selectedComparison();if(selected?.ledger.length && selected.observations.length) openAmendmentGroup(selected);else {const recent=amendmentGroupFromRecent();if(recent)openAmendmentGroup(recent,true);}},
  'create-from-statement':createFromStatementEditor,
  'mark-internal-transfer':()=>internalTransferEditor(),
  'convert-matched-transfer':el=>internalTransferEditor(el.dataset.id),
  'ignore-selected':()=>{const selected=selectedComparison();if(!selected || ![...selected.ledger,...selected.observations].length)return;if([...selected.ledger,...selected.observations].some(v=>v.state!=='unmatched'))throw new Error('Only fully unmatched rows can be ignored.');state.ignoreSelection={ledgerIds:selected.ledger.map(v=>v.id),observationIds:selected.observations.map(v=>v.id)};editor('Ignore selected rows',`<p>${selected.ledger.length} ledger and ${selected.observations.length} statement rows will be excluded from unresolved reconciliation counts. Ledger transactions and balances will remain unchanged.</p>${field('Reason',input('reason','required maxlength="500"'))}`,'ignore-rows-form','Ignore rows');},
  'restore-ignored':async el=>{const row=[...state.ledger,...state.observations].find(v=>v.ignore_id===el.dataset.id);if(!row)return;await api.request(`reconciliation/sessions/${id(state.session.id)}/ignored/${id(row.ignore_id)}/restore`,{method:'POST',revision:state.session.revision,body:{ignore_revision:row.ignore_revision}});notify('Row restored to reconciliation.');await refreshReconciliationComparison();},
  'download-amendments':downloadAmendments,
  'download-created':downloadCreated,
  'cancel-amendment':async el=>{if(!window.confirm('Cancel this amendment proposal? The audit history will remain.'))return;await api.request(`reconciliation/sessions/${id(state.session.id)}/amendments/${id(el.dataset.id)}/cancel`,{method:'POST',revision:state.session.revision,body:{amendment_revision:Number(el.dataset.revision),reason:'Cancelled by user'}});notify('Amendment cancelled.');await refreshReconciliationComparison();},
  'start-session':()=>editor('Start account review',field('Bank or card account',`<select name="account_id" required>${state.accounts.filter(a=>['bank','credit_card'].includes(a.subtype)).map(a=>option(a.id,a.name)).join('')}</select>`)+`<p>${h(state.month)}</p>`,'session-form','Start review')
};
document.addEventListener('click',async event=>{
  const nav=event.target.closest('[data-view]'); if(nav) { navigate(nav.dataset.view,nav.dataset.member?[nav.dataset.member]:[]); return; }
  if(event.target.closest('#menu-button')) {
    if(window.matchMedia('(max-width:760px)').matches) navigate('more');
    else {
      shell.classList.toggle('sidebar-collapsed');
      syncMenuButton();
    }
    return;
  }
  const el=event.target.closest('[data-action]'); if(!el || el.disabled || !state.me) return;
  const action=actions[el.dataset.action]; if(!action) return;
  el.disabled=true;
  try { await action(el); } catch(e) { if(state.me) failure(e,dialog.open?dialog:transactionDrawer.hidden?root:transactionDrawer); } finally { el.disabled=false; }
});
document.addEventListener('change',async event=>{
  if(event.target.id==='edit-event-type') updateTransactionEditType(event.target.form);
  if(event.target.form?.id==='investment-transaction-form' && event.target.name==='holding_id')updateInvestmentTransactionForm();
  if(event.target.form?.id==='card-payment-form' && ['card_id','payment_mode'].includes(event.target.name)) {if(event.target.name==='card_id')event.target.form.elements.amount.value='';updateCardPaymentForm();}
  if(event.target.name==='quick_category_parent') {
    const parent=state.categories.find(category=>category.id===event.target.value);
    if(parent?.visibility==='private')event.target.form.elements.quick_category_visibility.value='private';
  }
  if(event.target.id==='investment-type') syncInvestmentType();
  if(event.target.id==='quick-user-select') { state.quickSettingsUser=event.target.value; await renderRoute(); return; }
  if(event.target.id==='widget-user-select') { state.widgetSettingsUser=event.target.value; state.widgetCalendarAccount=''; await renderRoute(); return; }
  if(['widget-calendar-scope','widget-calendar-account'].includes(event.target.id)) {
    const scope=document.querySelector('#widget-calendar-scope').value;
    const account=document.querySelector('#widget-calendar-account').value;
    state.widgetCalendarScope=scope;state.widgetCalendarAccount=account;
    document.querySelector('#widget-calendar-url').textContent=`${location.origin}/api/v1/widgets/expense-calendar?scope=${encodeURIComponent(scope)}${account?`&account_id=${encodeURIComponent(account)}`:''}`;
    return;
  }
  if(event.target.id==='transfer-destination') updateTransferCounterparts();
  if(event.target.id==='amendment-target' && state.amendmentGroup) {
    const group=state.amendmentGroup;
    const ledger=group.ledgerIds.map(key=>state.ledger.find(v=>v.id===key));
    const observations=group.observationIds.map(key=>state.observations.find(v=>v.id===key));
    const plan=amendmentPlan(ledger,observations,group.attached?'amount':'remaining',Number(event.target.value));
    plan.proposed.forEach((value,i)=>{dialog.querySelector(`[name="proposed_${i}"]`).value=value;});
  }
  if(event.target.form?.id==='match-form' && ['ledger','observation'].includes(event.target.name)) {
    updateMatchComparison();
  }
  if(event.target.id==='report-month' && /^\d{4}-\d{2}$/.test(event.target.value)) { setMonth(event.target.value); if(state.view==='transactions' && location.hash.slice(1)==='transactions/all') navigate('transactions'); else renderRoute(); }
  if(event.target.id==='bulk-scope-all') {
    document.querySelectorAll('#bulk-scope-form [name="transaction_id"]').forEach(box=>{box.checked=event.target.checked;});
  }
  if(event.target.id==='compare-month' && /^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value)) { const chosen=event.target.value;state.compareMonth=chosen===state.month?new Date(Date.UTC(Number(chosen.slice(0,4)),Number(chosen.slice(5,7))-2,1)).toISOString().slice(0,7):chosen;if(chosen===state.month)notify(`Comparison moved to ${state.compareMonth} so the periods differ.`);const url=new URL(location.href);url.searchParams.set('compare',state.compareMonth);history.replaceState(null,'',url.pathname+url.search+url.hash);renderRoute(); }
  if(event.target.id==='event-type' || event.target.form?.id==='transaction-form' && ['account_id','scope'].includes(event.target.name)) updateCategories();
  if(event.target.form?.id==='transaction-form') {
    if(event.target.name==='category_id') {event.target.dataset.manual='true';renderTransactionCategoryGrid(event.target.form);}
    if(['description','account_id','event_type'].includes(event.target.name)) suggestTransactionCategory();
    updateTransactionPreview();
  }
  if(event.target.id==='account-subtype') document.querySelector('#card-due-fields').hidden=event.target.value!=='credit_card';
  if(event.target.id==='category-kind') document.querySelector('#category-parent').innerHTML=option('','Top level',true)+categoryOptions(event.target.value);
  if(event.target.id==='statement-account') navigate('statements',[event.target.value]);
  const transactionFilter={ 'transaction-filter-account':'account', 'transaction-filter-account-type':'accountType', 'transaction-filter-event-type':'eventType' }[event.target.id];
  if(transactionFilter) { transactionFiltersExpanded=true;state.transactionFilters[transactionFilter]=event.target.value; saveView(); renderRoute(); }
  if(event.target.name==='as_of' && event.target.form?.id==='balance-form') {
    const output=document.querySelector('#balance-preview');
    try {
      const at=localTimestamp(event.target.value);
      const accountId=new FormData(event.target.form).get('account_id');
      const value=await api.request(`accounts/${id(accountId)}/balance-at?as_of=${encodeURIComponent(at)}`);
      if(output) output.textContent=`Calculated at this time: ${value.amount==null?'unknown':`${value.currency} ${value.amount}`} · ${value.source.replace('_',' ')}`;
    } catch(e) { if(output) output.textContent=e.message; }
  }
});
document.addEventListener('input',event=>{
  if(event.target.form?.id==='transaction-full-edit-form' && event.target.name==='amount') updateTransactionEditType(event.target.form);
  if(event.target.form?.id!=='transaction-form')return;
  if(event.target.name==='category_search')updateCategories();
  if(event.target.name==='description')suggestTransactionCategory();
  updateTransactionPreview();
});
document.addEventListener('keydown',event=>{
  if(event.key!=='Enter' || !event.target.closest?.('.transaction-quick-panel'))return;
  if(event.target.tagName==='BUTTON')return;
  event.preventDefault();
  event.target.closest('.transaction-quick-panel').querySelector('[data-action$="-save"]').click();
});
document.addEventListener('submit',async event=>{
  const form=event.target; if(!(form instanceof HTMLFormElement)) return;
  event.preventDefault(); if(form.dataset.busy) return;
  form.dataset.busy='true'; const submit=form.querySelector('[type="submit"]'); if(submit) submit.disabled=true;
  const addAnother=form.id==='transaction-form' && event.submitter?.value==='another';
  const formData=new FormData(form);
  const data=Object.fromEntries(formData);
  try {
    if(form.id==='balance-account-form') { dialog.close(); balanceEditor(data.account_id); return; }
    if(form.id==='transaction-detail-form') { dialog.close();return; }
    if(form.id==='reset-preview-form') {
      state.resetPreview=null;
      const months=[...state.resetMonths];
      const preview=await api.request('data/reset-preview',{method:'POST',body:{months}});
      if(JSON.stringify(months)!==JSON.stringify(state.resetMonths)) return;
      state.resetPreview=preview;
      await renderRoute();return;
    }
    if(form.id==='reset-apply-form') {
      const preview=state.resetPreview;
      if(!preview) throw new Error('Preview the reset again.');
      try {
        await api.request('data/reset',{method:'POST',body:{months:preview.months,preview_token:preview.preview_token,confirmation:data.confirmation}});
      } catch(error) {
        if(error.status===409){state.resetPreview=null;await renderRoute();}
        throw error;
      }
      state.resetPreview=null;state.cleanupPreview=null;state.session=null;state.batch=null;state.file=null;state.preview=[];state.selectedChecks=[];state.ledgerBalances.clear();
      notify(`Monthly data reset for ${preview.months.join(', ')}.`);
      await renderRoute();return;
    }
    if(form.id==='cleanup-preview-form') {
      const period=data.period_type==='year'?String(data.year):String(data.month);
      state.cleanupPreview=await api.request('imports/money-manager/cleanup-preview',{method:'POST',body:{period}});
      await renderRoute();return;
    }
    if(form.id==='cleanup-apply-form') {
      const preview=state.cleanupPreview;
      if(!preview) throw new Error('Preview the period again.');
      const result=await api.request('imports/money-manager/cleanup',{method:'POST',body:{period:preview.period,preview_token:preview.preview_token}});
      state.cleanupPreview=null;notify(`${result.removed} Money Manager transactions removed. You can upload the workbook again.`);
      await renderRoute();return;
    }
    if(form.id==='invite-signout-form') { await api.request('auth/logout',{method:'POST',body:{}});api.reset();await inviteView();return; }
    if(['invite-register-form','invite-existing-form','invite-accept-form'].includes(form.id)) {
      const token=inviteToken(); if(!token) throw new Error('This invitation link is invalid.');
      if(form.id==='invite-existing-form') { const login=await api.request('auth/login',{method:'POST',body:{email:data.email,password:data.password}});api.setCsrf(login.csrf_token); }
      const body=form.id==='invite-register-form'?{name:data.name,email:data.email,password:data.password}:{};
      await api.request(`invites/${token}/accept`,{method:'POST',body});
      location.hash='#overview';await signedIn();return;
    }
    if(form.id==='invite-form') {
      const bytes=crypto.getRandomValues(new Uint8Array(32));
      const token=[...bytes].map(v=>v.toString(16).padStart(2,'0')).join('');
      await api.request(`households/${id(state.me.household.id)}/invites`,{method:'POST',body:{email:data.email,role:data.role,token}});
      state.inviteLink=`${location.origin}${location.pathname}#join/${token}`;
      notify('Invitation created. Copy the link and share it with the invited person.');
      await renderRoute();return;
    }
    if(form.id==='auth-form') {
      const bootstrap=form.dataset.bootstrap==='true';
      const body=bootstrap?{owner:{name:data.name,email:data.email,password:data.password},household:{name:data.household,timezone:data.timezone,base_currency:data.currency}}:{email:data.email,password:data.password};
      const value=await api.request(bootstrap?'auth/bootstrap':'auth/login',{method:'POST',body}); api.setCsrf(value.csrf_token); form.reset(); await signedIn(); return;
    }
    if(form.id==='upload-form') {
      const files=[...form.elements.files.files]; if(!files.length || files.length>4) throw new Error('Select between one and four files.');
      const body=new FormData(); body.append('manifest',JSON.stringify({files:files.map(()=>({source_kind:data.source_kind,...(data.source_kind==='money_manager'?{mapping:{allocation_scope:data.import_scope==='family'?'family':'personal'}}:{})}))})); files.forEach(file=>body.append('files[]',file));
      const upload=await api.request('imports',{method:'POST',body}); state.importResult=null; navigate('imports',[upload.id,upload.files[0].id]); return;
    }
    if(form.id==='mapping-form') { await saveMapping(form); return; }
    if(form.id==='default-scope-form') {
      localStorage.setItem(`finwise-default-scope:${state.me.user.id}`,data.scope==='family'?'family':'personal');
      notify('Default transaction scope saved in this browser.');
      await renderRoute();return;
    }
    if(form.id==='quick-expense-settings-form') {
      const account_ids=formData.getAll('quick_account_id');
      const enabled=form.elements.enabled.checked;
      if(enabled && !account_ids.includes(data.default_account_id)) throw new Error('Include the default account in the allowed accounts.');
      if(enabled && !window.confirm('Enable unauthenticated expense entry for anyone on your trusted LAN or private VPN who can reach this server?')) return;
      await api.request('settings/quick-expense',{method:'PATCH',revision:state.quickSettingsRevision,body:enabled?{enabled,user_id:data.user_id,default_account_id:data.default_account_id,account_ids}:{enabled:false}});
      notify(enabled?'Quick expense API enabled.':'Quick expense API disabled.');await renderRoute();return;
    }
    if(form.id==='widget-settings-form') {
      const enabled=form.elements.enabled.checked;
      if(enabled && !window.confirm(`Enable unauthenticated read access to spending${form.elements.accounts_enabled.checked?' and account balances':''} for devices on your trusted LAN or private VPN?`)) return;
      await api.request('settings/widgets',{method:'PATCH',revision:state.widgetSettingsRevision,body:enabled?{enabled:true,user_id:data.user_id,family_enabled:form.elements.family_enabled.checked,accounts_enabled:form.elements.accounts_enabled.checked}:{enabled:false}});
      notify(enabled?'Widget analytics API enabled.':'Widget analytics API disabled.');await renderRoute();return;
    }
    if(form.id==='family-mode-form') {
      const enabled=form.elements.family_only.checked;
      if(enabled===familyMode()) return;
      if(enabled && !window.confirm('Enable Family only mode? This shares all private account history with household members and converts existing personal transactions, categories, plans, and budgets to Family. Turning it off later will not restore their private status.')) return;
      const household=await api.request('settings/household');
      await api.request('settings/household',{method:'PATCH',revision:household.revision,body:{family_only:enabled}});
      state.me=await api.request('me');
      if(enabled) state.scope='family';
      syncScopeControl();saveView();await catalogs();await renderRoute();
      notify(enabled?'Family only mode enabled.':'Family only mode disabled.');
      return;
    }
    if(form.id==='plan-form') {
      const existing=state.plannedItems.find(v=>v.id===data.plan_id);
      const commitment=form.elements.budget_commitment.checked;
      if(commitment && !data.category_id)throw new Error('Choose a category for a budget commitment.');
      const body={title:data.title,due_date:data.due_date,amount:data.amount,currency:existing?.currency||state.me.household.base_currency,visibility:data.visibility,category_id:data.category_id||null,account_id:data.account_id||null,budget_commitment:commitment,budget_destination:commitment&&data.visibility==='shared'?data.budget_destination:commitment?state.me.user.id:null};
      if(existing) await api.request(`planned-items/${id(existing.id)}`,{method:'PATCH',revision:existing.revision,body});
      else await api.request('planned-items',{method:'POST',body});
      dialog.close();notify('Plan saved.');await renderRoute();return;
    }
    if(form.id==='match-plan-form') {
      const item=state.plannedItems.find(v=>v.id===data.plan_id);
      if(!item || !data.transaction_id)throw new Error('Choose a posted expense.');
      await api.request(`planned-items/${id(item.id)}/match`,{method:'POST',revision:item.revision,body:{transaction_id:data.transaction_id,reason:data.reason}});
      dialog.close();notify('Expense matched to commitment.');await renderRoute();return;
    }
    if(form.id==='bulk-scope-form') {
      const ids=formData.getAll('transaction_id');
      if(!ids.length) throw new Error('Select at least one transaction.');
      if(!window.confirm(`Move ${ids.length} selected transaction${ids.length===1?'':'s'} to Family?`)) return;
      let updated=0;
      for(let start=0;start<ids.length;start+=5000) {
        const result=await api.request('transactions/bulk-scope',{method:'POST',body:{ids:ids.slice(start,start+5000),scope:'family'}});
        updated+=result.updated;
      }
      notify(`${updated} transaction${updated===1?'':'s'} moved to Family.`);
      await renderRoute();return;
    }
    if(form.id==='commit-form') {
      const batch=state.batch, file=state.file;
      const value=await api.request(`imports/${id(batch)}/commit`,{method:'POST',revision:state.batchInfo.revision,body:{files:[file]}});
      state.importResult={batch,file,value};
      const first=state.preview.find(r=>r.effective_date)?.effective_date; if(first) setMonth(first.slice(0,7));
      notify('Commit completed. Review the outcome counts below.'); await renderRoute(); return;
    }
    if(form.id==='settlement-form') {
      await api.request('settle-ups',{method:'POST',body:{person:data.person,direction:data.direction,kind:data.kind,amount:data.amount,currency:state.me.household.base_currency,date:data.date,description:data.description}});
      notify('Obligation recorded.');
    } else if(form.id==='split-form') {
      const shares=String(data.shares).split(/\r?\n/).filter(line=>line.trim()).map(line=>{const match=/^(.+):\s*([0-9]+(?:\.[0-9]+)?)$/.exec(line.trim());if(!match)throw new Error('Enter each share as “Name: amount”, one per line.');return {person:match[1].trim(),amount:match[2]};});
      if(data.payer_type==='other' && !String(data.payer_name||'').trim())throw new Error('Enter the name of the person who paid.');
      const paidBy=data.payer_type==='other'?String(data.payer_name).trim():'me';
      await api.request('settle-ups/splits',{method:'POST',body:{description:data.description,date:data.date,currency:state.me.household.base_currency,total:data.total,my_share:data.my_share,paid_by:paidBy,shares,...(data.transaction_id?{transaction_id:data.transaction_id}:{})}});
      notify('Split created. The balance is ready in Settle up.');
    } else if(form.id==='repayment-form') {
      await api.request(`settle-ups/${id(data.obligation_id)}/repayments`,{method:'POST',revision:data.revision,body:{amount:data.amount,date:data.date,note:data.note}});
      notify('Repayment recorded.');
    } else if(form.id==='settlement-edit-form') {
      await api.request(`settle-ups/${id(data.obligation_id)}`,{method:'PATCH',revision:data.revision,body:{person:data.person,amount:data.amount,date:data.date,description:data.description}});notify('Obligation updated.');
    } else if(form.id==='investment-transaction-form') {
      const account=state.accounts.find(a=>a.id===data.account_id);
      if(!account || account.active===false || account.subtype==='settle_up')throw new Error('Choose an active account for this investment.');
      if(!Number.isFinite(Number(data.amount)) || Number(data.amount)<=0)throw new Error('Enter a positive investment amount.');
      if(data.holding_id) {
        const holding=await api.request(`investments/${id(data.holding_id)}`);
        if(holding.type!=='investment' || holding.currency!==account.currency)throw new Error('Choose an account in the holding currency.');
        await api.request(`investments/${id(holding.id)}/contributions`,{method:'POST',revision:holding.revision,body:{amount:data.amount,account_id:account.id,transaction_date:data.transaction_date,...(data.value?{value:data.value}:{})}});
      } else {
        const name=data.investment_name.trim();
        if(!name)throw new Error('Name the new holding.');
        await api.request('investments',{method:'POST',body:{name,type:'investment',asset_class:data.asset_class,currency:account.currency,visibility:'private',initial_record:{month:data.transaction_date.slice(0,7),principal:data.amount,...(data.value?{current_value:data.value}:{}),account_id:account.id,transaction_date:data.transaction_date}}});
      }
      if(form.closest('#transaction-drawer'))closeTransactionDrawer();
      notify('Investment recorded as an account movement, without adding an expense.');
    } else if(form.id==='investment-form') {
      const body={name:data.name,type:data.investment_type==='emergency_fund'?'emergency_fund':'investment',currency:data.currency,visibility:data.visibility};if(body.type==='investment')body.asset_class=data.investment_type==='stock_market'?'stock_market':'mutual_fund';if(data.opening_value){body.opening_value=data.opening_value;body.opening_month=data.opening_month;}if(data.target)body.target=data.target;if(data.monthly_goal)body.monthly_goal=data.monthly_goal;
      if(data.investment_type==='sip') {
        const day=Number(data.sip_day);
        if(!Number.isInteger(day)||day<1||day>31)throw new Error('SIP day must be from 1 to 31.');
        if(!data.sip_amount||Number(data.sip_amount)<=0)throw new Error('Enter a positive SIP amount.');
        if(data.sip_end_month && data.sip_end_month<data.sip_start_month)throw new Error('SIP end month cannot precede start month.');
        body.sip={amount:data.sip_amount,day,start_month:data.sip_start_month,status:'active'};
        if(data.sip_end_month)body.sip.end_month=data.sip_end_month;
      }
      if(Boolean(data.principal)!==Boolean(data.current_value))throw new Error('Enter both principal and current value, or leave both blank.');
      if(data.principal){if(!data.account_id)throw new Error('Choose the account used for this investment.');const account=state.accounts.find(a=>a.id===data.account_id);if(account?.currency!==data.currency)throw new Error('Investment and account currencies must match.');if(!data.transaction_date?.startsWith(data.valuation_month))throw new Error('Investment date must be in the valuation month.');body.initial_record={month:data.valuation_month,principal:data.principal,current_value:data.current_value,account_id:data.account_id,transaction_date:data.transaction_date};}
      await api.request('investments',{method:'POST',body});notify(data.principal?'Investment created with its first contribution.':data.opening_value?'Portfolio starting value saved.':'Investment created. Add a starting value or monthly valuation to begin tracking.');
    } else if(form.id==='investment-edit-form') {
      await api.request(`investments/${id(data.investment_id)}`,{method:'PATCH',revision:data.revision,body:{name:data.name,target:data.target||'0',monthly_goal:data.monthly_goal||'0',visibility:data.visibility,...(data.opening_value?{opening_value:data.opening_value,opening_month:data.opening_month}:{})}});notify('Investment plan updated.');
    } else if(form.id==='investment-sip-form') {
      const day=Number(data.day);
      if(!Number.isInteger(day)||day<1||day>31)throw new Error('SIP day must be from 1 to 31.');
      if(data.end_month && data.end_month<data.start_month)throw new Error('End month cannot precede start month.');
      const sip={amount:data.amount,day,start_month:data.start_month,status:data.status};if(data.end_month)sip.end_month=data.end_month;
      await api.request(`investments/${id(data.investment_id)}`,{method:'PATCH',revision:data.revision,body:{sip}});notify('SIP schedule saved.');
    } else if(form.id==='investment-process-sip-form') {
      if(!data.transaction_date?.startsWith(data.month))throw new Error('Transaction date must be in the selected month.');
      await api.request(`investments/${id(data.investment_id)}/sip/${id(data.month)}/process`,{method:'POST',revision:data.revision,body:{account_id:data.account_id,transaction_date:data.transaction_date,...(data.value?{value:data.value}:{})}});
      notify('SIP processed. The account transaction is recorded; add a valuation when known.');
    } else if(form.id==='investment-month-form') {
      const month=form.dataset.fixedMonth||data.month,accountId=form.dataset.accountId||data.account_id,transactionDate=form.dataset.transactionDate||data.transaction_date;
      if((Number(data.contribution)>0||Number(data.withdrawal)>0)&&!accountId)throw new Error('Choose the account used for this investment movement.');
      if(accountId&&!transactionDate?.startsWith(month))throw new Error('Movement date must be in the selected month.');
      await api.request(`investments/${id(data.investment_id)}/months/${id(month)}`,{method:'PUT',revision:data.revision,body:{contribution:data.contribution,withdrawal:data.withdrawal,value:data.value||null,...(accountId?{account_id:accountId,transaction_date:transactionDate}:{})}});
      notify('Monthly value saved.');
    } else if(form.id==='investment-movement-edit-form') {
      await api.request(`investments/${id(data.investment_id)}/movements/${id(data.movement_id)}`,{method:'PATCH',revision:data.revision,body:{amount:data.amount,account_id:data.account_id,transaction_date:data.transaction_date}});
      notify('Investment movement corrected.');
    } else if(form.id==='account-form') {
      const body={name:data.name,subtype:data.subtype,currency:data.currency,visibility:data.visibility};
      if(data.opening) { if(!data.as_of) throw new Error('Supply an opening balance timestamp.'); body.opening_balance={amount:data.opening,as_of:new Date(data.as_of).toISOString()}; }
      if(data.subtype==='credit_card' && (data.due_amount || data.due_date)) { if(!data.due_date) throw new Error('Add a payment due date when entering a statement payment amount.'); body.card_due={due_date:data.due_date}; if(data.due_amount) body.card_due.amount=data.due_amount; }
      await api.request('accounts',{method:'POST',body});
    } else if(form.id==='account-edit-form') {
      const body={name:data.name,subtype:data.subtype};
      if(data.subtype==='credit_card') { if(data.due_amount && !data.due_date) throw new Error('Add a payment due date when entering a statement payment amount.'); body.card_due=data.due_date?{due_date:data.due_date}:null; if(body.card_due && data.due_amount) body.card_due.amount=data.due_amount; }
      else body.card_due=null;
      await api.request(`accounts/${id(data.account_id)}`,{method:'PATCH',revision:data.revision,body});
      notify('Account details updated.');
    } else if(form.id==='opening-balance-form') {
      await api.request(`accounts/${id(data.account_id)}`,{method:'PATCH',revision:data.revision,body:{opening_balance:{amount:data.amount,as_of:localTimestamp(data.as_of)}}});
      notify('Known balance saved. Earlier and later balances have been recalculated.');
    } else if(form.id==='balance-check-edit-form') {
      await api.request(`accounts/${id(data.account_id)}/balance-checks/${id(data.check_id)}`,{method:'PATCH',revision:data.revision,body:{amount:data.amount,basis:data.basis,as_of:localTimestamp(data.as_of),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone}});
      notify('Balance check corrected.');
    } else if(form.id==='category-form') {
      const body={name:data.name,kind:data.kind,parent_id:data.parent_id || null,visibility:data.visibility||'shared'};
      if(data.category_id) await api.request(`categories/${id(data.category_id)}`,{method:'PATCH',revision:data.revision,body});
      else await api.request('categories',{method:'POST',body});
    }
    else if(form.id==='convert-card-payment-form') {
      const existing=await api.request(`transactions/${id(data.transaction_id)}`);
      const source=state.accounts.find(a=>a.id===existing.movements[0]?.account_id);
      const card=state.accounts.find(a=>a.id===data.card_id);
      if(existing.event_type!=='expense' || !['bank','cash'].includes(source?.subtype) || card?.subtype!=='credit_card' || card.active===false || source.currency!==card.currency)throw new Error('Choose an active card in the payment currency.');
      await api.request(`transactions/${id(existing.id)}`,{method:'PATCH',revision:data.revision,body:{event_type:'transfer',movements:[{account_id:source.id,amount:`-${existing.amount}`},{account_id:card.id,amount:existing.amount}],allocations:[]}});
      notify('Expense converted to a card payment. Spending and card balance have been updated.');
    }
    else if(form.id==='card-payment-form') {
      const card=state.accounts.find(a=>a.id===data.card_id);
      const source=state.accounts.find(a=>a.id===data.source_account);
      if(!card || card.subtype!=='credit_card' || !source || !['bank','cash'].includes(source.subtype) || source.currency!==card.currency)throw new Error('Choose a bank or cash account in the card currency.');
      if(!Number.isFinite(Number(data.amount)) || Number(data.amount)<=0)throw new Error('Enter a positive payment amount.');
      if(data.payment_mode==='full' && data.amount!==card.balance?.amount)throw new Error('The full amount has changed. Review the card balance before saving.');
      if(data.payment_mode==='statement' && data.amount!==card.card_due?.amount)throw new Error('The statement amount has changed. Review the amount due before saving.');
      await api.request('transactions',{method:'POST',body:{event_type:'transfer',amount:data.amount,currency:card.currency,effective_date:data.effective_date,description:data.description,movements:[{account_id:source.id,amount:`-${data.amount}`},{account_id:card.id,amount:data.amount}],allocations:[]}});
      if(form.closest('#transaction-drawer'))closeTransactionDrawer();
      notify('Card payment recorded as a transfer, with no new expense.');
    }
    else if(form.id==='transaction-form') {
      const account=state.accounts.find(a=>a.id===data.account_id); const transfer=data.event_type==='transfer';
      if(transfer && (!data.destination || data.destination===data.account_id)) throw new Error('Choose a different destination account with the same currency.');
      const movements=[{account_id:data.account_id,amount:['expense','transfer'].includes(data.event_type)?`-${data.amount}`:data.amount}];
      if(transfer) movements.push({account_id:data.destination,amount:data.amount});
      const body={event_type:data.event_type,amount:data.amount,currency:account.currency,effective_date:data.effective_date,description:data.description,movements,allocations:transfer?[]:[{category_id:data.category_id || null,amount:data.amount,scope:data.scope}]};
      if(['expense','refund'].includes(data.event_type)) { body.paid_by_user_id=data.paid_by_user_id; if(data.scope==='family')body.allocations[0].budget_destination=data.budget_destination; }
      const created=await api.request('transactions',{method:'POST',body});
      recentTransactions.unshift(created);
      localStorage.setItem(`finwise-last-account:${state.me.user.id}`,data.account_id);
      if(form.closest('#transaction-drawer')) {
        await renderRoute();
        transactionEditor({accountId:data.account_id,date:data.effective_date});
        notify('Transaction saved. The list is up to date.');
        return;
      }
      if(addAnother) {
        dialog.close();
        await renderRoute();
        transactionEditor({accountId:data.account_id,date:data.effective_date});
        notify('Transaction saved. Add the next one.');
        return;
      }
    } else if(form.id==='transaction-full-edit-form') {
      const transfer=data.event_type==='transfer';
      const signed=transfer || data.event_type==='expense'?`-${data.amount}`:data.amount;
      const movements=[{account_id:data.source_account,amount:signed}];
      if(transfer) {
        if(!data.destination_account || data.destination_account===data.source_account)throw new Error('Choose a different destination account in the same currency.');
        movements.push({account_id:data.destination_account,amount:data.amount});
      }
      const original=state.editingTransaction;
      if(!original || original.id!==data.transaction_id || original.revision!==Number(data.revision)) throw new Error('Reload the transaction before editing.');
      const count=transfer?0:form.querySelector(`[data-edit-kind="${data.event_type==='refund'?'expense':data.event_type}"]`).querySelectorAll('[data-edit-allocation]').length;
      const allocations=transfer?[]:Array.from({length:count},(_,i)=>({category_id:data[`category-${i}`]||null,amount:data[`allocation-${i}`],scope:data[`scope-${i}`],...(['expense','refund'].includes(data.event_type)&&data[`scope-${i}`]==='family'?{budget_destination:data[`budget-destination-${i}`]||'unassigned'}:{})}));
      const body={event_type:data.event_type,description:data.description,effective_date:data.effective_date,amount:data.amount,movements,allocations};
      if(['expense','refund'].includes(data.event_type)) body.paid_by_user_id=data.paid_by_user_id;
      if(data.effective_date!==data.original_date) body.effective_at=null;
      await api.request(`transactions/${id(data.transaction_id)}`,{method:'PATCH',revision:data.revision,body});
      notify('Transaction updated. Balance and reconciliation results have been recalculated.');
    }
    else if(form.id==='balance-form') {
      const value=await api.request(`accounts/${id(data.account_id)}/balance-checks`,{method:'POST',revision:data.revision,body:{amount:data.amount,basis:data.basis,as_of:localTimestamp(data.as_of),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone}});
      notify(`Balance check recorded. Variance: ${value.variance ?? 'unknown (no opening balance)'}.`);
    } else if(form.id==='budget-form'||form.id==='budget-edit-form') {
      const people_limits=[...form.querySelectorAll('[data-person-limit]')].filter(control=>control.value.trim()).map(control=>({destination:control.dataset.personLimit,amount:control.value.trim()}));
      const lines=Object.entries(data).filter(([k,v])=>k.startsWith('category-') && v!=='').map(([k,v])=>({category_id:k.slice(9),amount:v,...(data[`mode-${k.slice(9)}`]==='pooled'?{mode:'pooled'}:{})}));
      if(form.id==='budget-edit-form') {
        const preview=await api.request(`budgets/${id(data.budget_id)}/plan-preview`,{method:'POST',revision:data.revision,body:{name:data.name,expected_income:data.expected_income,savings_goal:data.savings_goal||'0',lines,people_limits}});
        dialog.close();budgetAmendmentPreviewEditor(preview);return;
      } else await api.request('budgets',{method:'POST',body:{name:data.name,expected_income:data.expected_income,savings_goal:data.savings_goal||'0',month:state.month,scope:data.scope,currency:state.me.household.base_currency,lines,people_limits}});
    } else if(form.id==='budget-amendment-form') {
      const preview=state.pendingBudgetAmendment;
      if(!preview)throw new Error('Preview the budget change again.');
      await api.request(`budgets/${id(preview.budget_id)}/amendments`,{method:'POST',revision:preview.base_revision,body:{proposal:preview.proposal,preview_hash:preview.preview_hash,reason:data.reason,accept_unfunded:form.elements.accept_unfunded?.checked===true}});
      state.pendingBudgetAmendment=null;
      notify('Budget amendment saved with its reason.');
    } else if(form.id==='session-form') {
      const existing=(await api.collection(`reconciliation/sessions?account_id=${id(data.account_id)}&month=${encodeURIComponent(state.month)}`)).data[0];
      if(existing?.state==='open') { dialog.close(); navigate('reconcile',[existing.id]); return; }
      if(existing?.state==='closed') {
        dialog.close();
        editor('Reopen account review',`<p>${h(accountName(existing.account_id))} · ${h(existing.month)}</p>`+input('session_id',`type="hidden" value="${h(existing.id)}"`)+input('revision',`type="hidden" value="${h(existing.revision)}"`)+field('Reason for reopening',input('reason','required maxlength="500"')),'reopen-session-form','Reopen review');
        return;
      }
      const s=await api.request('reconciliation/sessions',{method:'POST',body:{account_id:data.account_id,month:state.month}}); dialog.close(); navigate('reconcile',[s.id]); return;
    } else if(form.id==='reopen-session-form') {
      const s=await api.request(`reconciliation/sessions/${id(data.session_id)}/reopen`,{method:'POST',revision:Number(data.revision),body:{reason:data.reason}});
      dialog.close(); navigate('reconcile',[s.id]); return;
    } else if(form.id==='ignore-rows-form') {
      const selected=state.ignoreSelection;
      if(!selected) throw new Error('Select the rows again.');
      await api.request(`reconciliation/sessions/${id(state.session.id)}/ignored`,{method:'POST',revision:state.session.revision,body:{ledger_ids:selected.ledgerIds,observation_ids:selected.observationIds,reason:data.reason}});
      state.ignoreSelection=null;dialog.close();notify('Rows ignored for this review. You can restore them from either list.');await refreshReconciliationComparison();return;
    } else if(form.id==='create-statement-form') {
      if(!state.createObservationIds?.length) throw new Error('Select statement rows again.');
      const result=await api.request(`reconciliation/sessions/${id(state.session.id)}/created-ledger-entries`,{method:'POST',revision:state.session.revision,body:{observation_ids:state.createObservationIds,description:data.description,effective_date:data.effective_date,category_id:data.category_id||null,scope:data.scope,reason:data.reason}});
      state.createObservationIds=null;dialog.close();notify(`Created and attached ${result.transaction.description}. It is tagged for the Money Manager export.`);await refreshReconciliationComparison();return;
    } else if(form.id==='internal-transfer-form') {
      const selected=state.transferSelection;if(!selected)throw new Error('Select the transfer row again.');
      const body={counterpart_account_id:data.counterpart_account_id,reason:data.reason};
      if(selected.ledger_id)body.ledger_id=selected.ledger_id;
      if(selected.observation_id)body.observation_id=selected.observation_id;
      if(data.counterpart_observation_id)body.counterpart_observation_id=data.counterpart_observation_id;
      if(!selected.ledger_id)body.description=data.description;
      const result=await api.request(`reconciliation/sessions/${id(state.session.id)}/internal-transfer`,{method:'POST',revision:state.session.revision,body});
      state.transferSelection=null;state.transferCandidates=[];dialog.close();
      notify(result.counterpart_match?'Transfer connected and both statement sides reconciled.':'Transfer connected. The other account leg is ready for reconciliation.');
      await refreshReconciliationComparison();return;
    } else if(form.id==='match-form') {
      updateMatchComparison();
      if(!state.proposedAllocations?.length) throw new Error('Select rows with the same direction on both sides.');
      const selected=selectedComparison();
      const plan=amendmentPlan(selected.ledger,selected.observations);
      await api.request(`reconciliation/sessions/${id(state.session.id)}/matches`,{method:'POST',revision:state.session.revision,body:{decision:'accept',allocations:state.proposedAllocations}});
      state.recentMatch=plan.minor(plan.difference)!==0n?{sessionId:state.session.id,ledgerIds:selected.ledger.map(v=>v.id),observationIds:selected.observations.map(v=>v.id)}:null;
      notify(state.recentMatch?'Match saved. The remaining difference can be amended here.':'Match saved. Your position and next selection are preserved.');
      await refreshReconciliationComparison(); return;
    } else if(form.id==='amendment-form') {
      const group=state.amendmentGroup;
      if(!group) throw new Error('Select the transactions again before amending.');
      const ledger=group.ledgerIds.map(key=>state.ledger.find(v=>v.id===key));
      const observations=group.observationIds.map(key=>state.observations.find(v=>v.id===key));
      if(ledger.some(v=>!v) || observations.some(v=>!v)) throw new Error('The selected rows changed. Reload this comparison.');
      const plan=amendmentPlan(ledger,observations,group.attached?'amount':'remaining');
      const proposed=ledger.map((v,i)=>String(data[`proposed_${i}`]||''));
      const adjustment=proposed.reduce((sum,value,i)=>sum+plan.minor(value)-plan.minor(ledger[i].amount),0n);
      if(adjustment!==plan.minor(plan.difference)) throw new Error(`The amendments must total ${plan.currency} ${plan.difference}.`);
      const changes=ledger.map((v,i)=>({ledger:v,amount:plan.formatted(plan.minor(proposed[i])),date:data[`date_${i}`],observation_id:data[`observation_${i}`]})).filter(v=>v.amount!==v.ledger.amount || v.date!==v.ledger.effective_date);
      if(!changes.length) throw new Error('Change an amount or date before applying an amendment.');
      for(const change of changes) {
        if(plan.minor(change.amount)===0n || (plan.minor(change.amount)>0n)!==(plan.minor(change.ledger.amount)>0n)) throw new Error('Amended movements must keep the original direction and be nonzero.');
        if(!observations.some(v=>v.id===change.observation_id)) throw new Error('Choose statement evidence from this selection.');
      }
      try {
        await api.request(`reconciliation/sessions/${id(state.session.id)}/amendments/batch`,{method:'POST',revision:state.session.revision,body:{amendments:changes.map(change=>({ledger_id:change.ledger.id,ledger_revision:change.ledger.revision,observation_id:change.observation_id,proposed_amount:change.amount,proposed_date:change.date,reason:data.reason}))}});
      } catch(error) {
        dialog.close();await refreshReconciliationComparison({ledger:group.ledgerIds,observation:group.observationIds});
        throw error;
      }
      state.recentMatch=null;state.amendmentGroup=null;
      dialog.close();notify(`${changes.length} amendment${changes.length===1?'':'s'} applied. Attach the refreshed remaining rows.`);await refreshReconciliationComparison({ledger:group.ledgerIds,observation:group.observationIds});return;
    }
    dialog.close(); await renderRoute();
  } catch(e) { if(state.me || form.id==='auth-form' || form.id.startsWith('invite-')) failure(e,form); }
  finally { delete form.dataset.busy; if(submit) submit.disabled=false; }
});
window.addEventListener('hashchange',()=>{if(location.hash.startsWith('#join/')) inviteView().catch(e=>failure(e,authRoot));else renderRoute();});
document.addEventListener('keydown',event=>{const tab=event.target.closest?.('.analytics-view-tabs [role="tab"]');if(!tab || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;const tabs=[...tab.parentElement.querySelectorAll('[role="tab"]')];const index=tabs.indexOf(tab);const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;event.preventDefault();tabs[next].click();});
document.addEventListener('toggle',event=>{if(event.target.id==='bulk-scope-panel') loadBulkScopePanel(event.target);if(event.target.id==='transaction-filters' && window.matchMedia('(max-width:760px)').matches)transactionFiltersExpanded=event.target.open;},true);
window.addEventListener('resize',()=>{syncMenuButton();if(window.innerWidth<1350 && !transactionDrawer.hidden)closeTransactionDrawer();});
window.matchMedia('(max-width:760px)').addEventListener('change',()=>{if(state.view==='transactions')renderRoute();});
syncMenuButton();
syncScopeControl();
setMonth(state.month);
start();
