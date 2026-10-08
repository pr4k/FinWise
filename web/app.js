'use strict';
const api = window.finwiseAPI;
const viewState = window.finwiseViewState;
const categoryView = window.finwiseCategories;
const analyticsView = window.finwiseAnalytics;
const activityView = window.finwiseActivity;
const { matchAllocations, amendmentPlan, sumSignedRows } = window.finwiseReconciliation;
const localTimestamp = window.finwiseTime.localTimestamp;
const savedView = viewState.read(location.search, localDate().slice(0,7));
const root = document.querySelector('#view-root');
const authRoot = document.querySelector('#auth-root');
const shell = document.querySelector('.app-shell');
const dialog = document.querySelector('#editor');
const menuButton = document.querySelector('#menu-button');
function syncMenuButton() {
  const mobile=window.matchMedia('(max-width:760px)').matches;
  menuButton.setAttribute('aria-label',mobile?'Open navigation':shell.classList.contains('sidebar-collapsed')?'Expand navigation':'Collapse navigation');
  menuButton.setAttribute('aria-expanded',String(!mobile && !shell.classList.contains('sidebar-collapsed')));
  document.querySelector('.sidebar').inert=mobile || shell.classList.contains('sidebar-collapsed');
}
const labels = { overview:'Overview', analytics:'Analytics', transactions:'Transactions', accounts:'Accounts', categories:'Categories', statements:'Statements', budgets:'Budgets', reconcile:'Reconcile', imports:'Imports', settings:'Settings', changes:'Money Manager changes', more:'More' };
const previousMonth=new Date(`${savedView.month}-01T00:00:00Z`); previousMonth.setUTCMonth(previousMonth.getUTCMonth()-1);
const compareParam=new URLSearchParams(location.search).get('compare');
const state = { me:null, accounts:[], categories:[], ledgerBalances:new Map(), transactionFilters:viewState.readFilters(location.search), compareMonth:/^\d{4}-(0[1-9]|1[0-2])$/.test(compareParam||'')?compareParam:previousMonth.toISOString().slice(0,7), inviteLink:null, view:'overview', month:savedView.month, scope:savedView.scope, batch:null, file:null, preview:[], cleanupPreview:null, metadata:null, fileInfo:null, importResult:null, session:null, generation:0 };
let toastTimer;
const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const id = value => encodeURIComponent(value);
const button = (title,action,extra='') => `<button type="button" class="outline-button" data-action="${action}" ${extra}>${h(title)}</button>`;
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
const moneyTone = (value,kind='asset') => value == null ? 'unknown' : Number(value)===0?'neutral':kind==='debt'?(Number(value)>0?'debt':'positive'):Number(value)<0?'negative':'positive';
const moneyFigure = (value,currency,kind='asset') => `<strong class="money-figure ${moneyTone(value,kind)}">${amount(value,currency)}</strong>`;
const accountBalance = a => moneyFigure(a.balance?.amount,a.currency,a.subtype==='credit_card'?'debt':'asset')+'<small>'+h(a.subtype==='credit_card'?'Amount owed':a.balance?.source==='balance_check'?'From observed check':a.balance?.source==='opening_balance'?'From known balance':'No balance anchor')+'</small>'+(a.subtype==='credit_card' && a.card_due?'<small class="due-line">Payment due '+(a.card_due.amount==null?'amount not entered':amount(a.card_due.amount,a.currency))+' · '+h(a.card_due.due_date)+'</small>':'');
const field = (label,input) => `<label class="field">${h(label)}${input.replace(/<(input|select|textarea)(?=[ >])/, `<$1 aria-label="${h(label)}"`)}</label>`;
const input = (name,extras='') => `<input name="${name}" ${extras}>`;
const moneyInput = name => input(name,'inputmode="decimal" pattern="[0-9]+(\\.[0-9]+)?" required placeholder="0.00"');
const option = (value,label,selected=false) => `<option value="${h(value)}"${selected?' selected':''}>${h(label)}</option>`;
const accountOptions = selected => state.accounts.filter(a=>a.active!==false).map(a=>option(a.id,`${a.name} · ${a.currency}`,a.id===selected)).join('');
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
function reportQuery(month=state.month) { return new URLSearchParams({...period(month),scope:state.scope,currency:state.me.household.base_currency}).toString(); }
function heading(title,description,actions='') { return `<div class="page-heading"><div><span class="eyebrow">YOUR WORKSPACE</span><h1>${h(title)}</h1><p>${h(description)}</p></div><div class="heading-actions">${actions}</div></div>`; }
function panel(title,body) { return `<section class="panel live-panel"><h2>${h(title)}</h2>${body}</section>`; }
function table(headers,rows) { return rows.length ? `<div class="table-scroll"><table class="live-table"><thead><tr>${headers.map(v=>`<th>${h(v)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map((v,i)=>`<td data-label="${h(headers[i])}">${v}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : empty('No records yet.'); }
function notify(message) { const toast=document.querySelector('#toast'); toast.textContent=message; toast.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>toast.classList.remove('show'),6000); }
function failure(error,target=root) { const p=document.createElement('p'); p.className='live-error'; p.setAttribute('role','alert'); p.textContent=error.message || 'Could not reach the server. Please retry.'; target.querySelector('.live-error')?.remove(); target.prepend(p); }
function coverage() { return '<p class="helper coverage-note">Recorded data only. Source coverage is unconfirmed; transfers do not count as spending.</p>'; }
async function catalogs() { const [accounts,categories]=await Promise.all([api.collection('accounts?include_archived=true'),api.collection('categories?include_archived=true')]); state.accounts=accounts.data; state.categories=categories.data; }
function saveView() { viewState.save(state.month,state.scope,location.href,path=>history.replaceState(null,'',path),state.transactionFilters); }
function setMonth(value) { state.month=value; if(state.compareMonth===value) { const previous=new Date(`${value}-01T00:00:00Z`);previous.setUTCMonth(previous.getUTCMonth()-1);state.compareMonth=previous.toISOString().slice(0,7);const url=new URL(location.href);url.searchParams.set('compare',state.compareMonth);history.replaceState(null,'',url.pathname+url.search+url.hash); } document.querySelector('#report-month').value=value; saveView(); }
function authForm(bootstrap=false) {
  shell.hidden=true; authRoot.hidden=false; dialog.close();
  authRoot.innerHTML=`<section class="panel auth-card"><a class="brand" href="#overview">finwise.</a><h1>${bootstrap?'Set up your household':'Welcome back'}</h1><p>${bootstrap?'Create the first owner account. Your data stays on this server.':'Sign in to your FinWise account.'}</p><form id="auth-form" data-bootstrap="${bootstrap}">${bootstrap?field('Your name',input('name','required autocomplete="name"')):''}${field('Email',input('email','type="email" required autocomplete="username"'))}${field('Password',input('password',`type="password" required minlength="12" maxlength="1024" autocomplete="${bootstrap?'new-password':'current-password'}"`))}${bootstrap?field('Household name',input('household','required value="My household"'))+field('Timezone',input('timezone',`required value="${h(Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata')}"`))+field('Base currency',input('currency','required value="INR" pattern="[A-Z]{3}"')):''}<button class="primary-button" type="submit">${bootstrap?'Create household':'Sign in'}</button></form></section>`;
}
function inviteToken() { const token=location.hash.startsWith('#join/')?location.hash.slice(6):''; return /^[a-fA-F0-9]{64}$/.test(token)?token:null; }
async function inviteView() {
  shell.hidden=true; authRoot.hidden=false; dialog.close();
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
  await catalogs();
  authRoot.hidden=true; shell.hidden=false;
  document.querySelector('#user-name').textContent=state.me.user.name;
  document.querySelector('#household-name').textContent=state.me.household.name;
  document.querySelector('#household-currency').textContent=state.me.household.base_currency;
  document.querySelectorAll('.avatar').forEach(el=>el.textContent=state.me.user.name.slice(0,1));
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
function resetSession() { state.generation++; state.me=null; state.accounts=[]; state.categories=[]; state.selectedChecks=[]; state.editingTransaction=null; state.preview=[]; state.cleanupPreview=null; state.resetPreview=null; state.resetMonths=null; state.fileInfo=null; state.metadata=null; state.importResult=null; state.session=null; state.ledger=[]; state.observations=[]; state.amendments=[]; state.createdEntries=[]; state.ignoreSelection=null; state.createObservationIds=null; state.transferSelection=null; state.transferCandidates=[]; state.recentMatch=null; state.amendmentGroup=null; state.inviteLink=null; api.reset(); root.replaceChildren(); authForm(); }
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
function transactionTable(values,balanceEvents=[],accountFilter='') {
  const entries=activityView.timeline(values,balanceEvents,state.ledgerBalances,accountFilter);
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
    return [
      '<time datetime="'+h(t.effective_date)+'">'+h(t.effective_date)+'</time><small>'+when+'</small>',
      '<div class="activity-title"><strong>'+h(t.description || 'Untitled')+'</strong><span class="activity-type">'+h(t.event_type)+'</span></div><div class="activity-meta"><small>'+(category||'Uncategorized')+' · '+(t.entered_by===state.me.user.id?'You':'Household member')+'</small>'+transactionIndicators(t)+'</div>',
      accounts,
      '<span class="activity-amount">'+(t.event_type==='income'||t.event_type==='refund'?'+ ':t.event_type==='expense'?'− ':t.event_type==='transfer'?'↔ ':'')+amount(t.amount,t.currency)+'</span>',
      button('Details','transaction-detail','data-id="'+h(t.id)+'"')
    ];
  });
  return rows.length?'<div class="table-scroll activity-table-wrap"><table class="live-table activity-table"><thead><tr><th>Date</th><th>Activity</th><th>Account</th><th>Amount</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>'+rows.map((row,i)=>'<tr class="'+(entries[i].kind==='transaction'?'activity-'+(['income','expense','refund','transfer'].includes(entries[i].transaction.event_type)?entries[i].transaction.event_type:'other'):'activity-marker-row')+'">'+row.map((cell,j)=>'<td data-label="'+['Date','Activity','Account','Amount','Actions'][j]+'">'+cell+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>':empty('No activity yet.');
}
async function renderRoute() {
  if(!state.me) return;
  const generation=++state.generation;
  const parts=location.hash.slice(1).split('/').map(v=>decodeURIComponent(v));
  const view=labels[parts[0]]?parts[0]:'overview'; state.view=view;
  shell.dataset.activeView=view;
  document.querySelector('#breadcrumb-current').textContent=labels[view];
  document.querySelectorAll('[data-view]').forEach(el=>el.classList.toggle('active',el.dataset.view===view));
  root.querySelectorAll('canvas[data-chart]').forEach(canvas=>window.Chart?.getChart(canvas)?.destroy());
  root.innerHTML='<p role="status">Loading your data…</p>';
  try {
    await catalogs();
    const html=await views[view](parts.slice(1),generation);
    if(generation!==state.generation || !state.me) return;
    root.innerHTML=html; analyticsView.hydrateCharts(root); root.focus({preventScroll:true});
    if(view==='reconcile') updateMatchComparison();
  } catch(e) { if(generation===state.generation && state.me) { root.innerHTML=heading(labels[view],'Could not load this view.',button('Retry','refresh')); failure(e); } }
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
  const marked=(items,side)=>items.filter(v=>v.state==='matched').map(v=>`<li>${h(v.effective_date)} · ${h(v.description || 'Entry')} · ${amount(v.amount,v.currency)} <strong>Matched</strong>${side==='ledger' && v.event_type!=='transfer' && session.state==='open'?button('Make internal transfer','convert-matched-transfer',`data-id="${h(v.id)}"`):''}</li>`).join('');
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
  const data=new FormData(form);
  return {ledger:data.getAll('ledger').map(key=>state.ledger.find(v=>v.id===key)).filter(Boolean),observations:data.getAll('observation').map(key=>state.observations.find(v=>v.id===key)).filter(Boolean)};
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
  editor('Create transaction from statement',`<p>${selected.observations.length} statement row${selected.observations.length===1?'':'s'} → one ${h(total.eventType)} of ${amount(total.total,total.currency)}. The rows will be attached to the new transaction.</p>${field('Description',input('description',`required maxlength="300" value="${h(description)}"`))}${field('Date',input('effective_date',`type="date" required value="${h(first.effective_date)}"`))}${field('Category',`<select name="category_id">${option('','Uncategorized')}${categoryOptions(total.eventType)}</select>`)}${field('Scope',`<select name="scope">${option('personal','Personal')}${option('family','Family')}</select>`)}${field('Why is this missing from Money Manager?',input('reason','required maxlength="500"'))}<p class="helper">FinWise balances and analytics will include the new transaction. It will be tagged for the Money Manager additions export.</p>`,'create-statement-form','Create and attach');
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
const views = {
  async overview() {
    const query=reportQuery();
    const [summary,transactions,categories,accounts,daily]=await Promise.all([
      api.request(`analytics/summary?${query}`),api.request(`analytics/transactions?${query}&limit=10`),
      api.request(`analytics/categories?${query}`),api.request(`analytics/accounts?${query}`),
      api.request(`analytics/series?${query}&grain=day`)
    ]);
    const currency=state.me.household.base_currency;
    const monthLabel=new Intl.DateTimeFormat('en',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(`${state.month}-01T00:00:00Z`));
    const surplus=Number(summary.recorded_surplus);
    const metrics=[
      [surplus<0?'Recorded shortfall':'Recorded surplus',summary.recorded_surplus,moneyTone(summary.recorded_surplus),'Income minus net spending',surplus<0?'↘':'↗','position-card'],
      ['Income',summary.income,moneyTone(summary.income),'Recorded money in','↓',''],
      ['Net spending',summary.net_spending,moneyTone(summary.net_spending,'debt'),'Expenses minus refunds','↑',''],
      ['Transfers',summary.transfer_volume,'neutral','Between accounts · not spending','↔','']
    ];
    const metricCard=([label,value,tone,description,icon,extra])=>`<article class="overview-metric ${extra} ${tone}"><div class="metric-label">${label}<span class="metric-icon" aria-hidden="true">${icon}</span></div><strong class="metric-number"><span class="metric-currency">${h(currency)}</span> ${displayMoney(value,currency)}</strong><span class="metric-caption">${description}</span></article>`;
    const scale=new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits;
    const cashflow=analyticsView.moneyLines(daily.data.map(row=>row.period.slice(-2)),[
      {name:'Income',color:'#137653',values:analyticsView.cumulativeMoney(daily.data,'income',scale)},
      {name:'Spending',color:'#ba4250',values:analyticsView.cumulativeMoney(daily.data,'net_spending',scale)}
    ],currency,`Cumulative recorded income and spending for ${monthLabel}`);
    const cards=`<div class="overview-hero"><div class="position-summary"><span class="section-kicker">YOUR MONTH AT A GLANCE</span>${metricCard(metrics[0])}<div class="position-note"><span aria-hidden="true">${surplus<0?'↘':surplus>0?'↗':'−'}</span><p>${surplus<0?'Recorded spending is higher than income.':surplus>0?'Recorded income is ahead of spending.':'Recorded income and spending are equal.'}<small>Based on entries for this month.</small></p></div></div><section class="cashflow-panel"><div class="overview-panel-heading"><div><h2>Money in, money out</h2><p class="helper">Cumulative cash flow · ${h(currency)}</p></div>${navButton('analytics','View analytics ↗')}</div>${cashflow}</section></div><div class="overview-metrics">${metrics.slice(1).map(metricCard).join('')}</div>`;
    const roots=[...categoryView.rollup(categories.data,state.categories)].filter(([key,row])=>(key==='uncategorized'||state.categories.find(c=>c.id===key)?.parent_id==null) && Number(row.amount)!==0).sort((a,b)=>Number(b[1].amount)-Number(a[1].amount));
    const largest=Math.max(1,...roots.map(([,row])=>Math.abs(Number(row.amount))));
    const spending=roots.slice(0,4).map(([key,row])=>`<li><div><span>${h(key==='uncategorized'?'Uncategorized':state.categories.find(c=>c.id===key)?.name||'Category')}</span><strong class="${moneyTone(row.amount,'debt')}">${amount(row.amount,currency)}</strong></div><div class="overview-track" aria-hidden="true"><span class="${Number(row.amount)<0?'refund':''}" style="width:${Math.abs(Number(row.amount))/largest*100}%"></span></div></li>`).join('');
    const activeAccounts=accounts.data.filter(a=>a.active!==false).sort((a,b)=>Number(b.balance?.amount!=null)-Number(a.balance?.amount!=null));
    const balances=activeAccounts.slice(0,4).map(a=>`<li><span class="overview-account-icon" aria-hidden="true"><svg class="icon"><use href="#i-wallet"/></svg></span><div><strong>${h(a.name)}</strong><small>${a.subtype==='credit_card'?'Amount owed':a.balance?.source==='balance_check'?'Observed balance':a.balance?.source==='opening_balance'?'Starting balance':'Balance not set'}</small></div>${moneyFigure(a.balance?.amount,a.currency,a.subtype==='credit_card'?'debt':'asset')}</li>`).join('');
    const snapshot=`<div class="overview-details"><section class="panel overview-panel"><div class="overview-panel-heading"><div><span class="section-kicker">THIS MONTH</span><h2>Where your money goes</h2></div>${navButton('analytics','Explore analytics →')}</div>${spending?`<ul class="overview-spending">${spending}</ul><p class="helper">${roots.length>4?'Top 4 categories. ':''}Net of refunds. Negative amounts are net refunds.</p>`:empty('No spending recorded for this month.')}<div class="overview-panel-footer">${navButton('budgets','Manage monthly budget →')}</div></section><section class="panel overview-panel"><div class="overview-panel-heading"><div><span class="section-kicker">CURRENT SNAPSHOT</span><h2>Your accounts</h2></div>${navButton('accounts','View all →')}</div>${balances?`<ul class="overview-balances">${balances}</ul>`:empty('Add an account or import a statement to get started.')}<p class="helper">${activeAccounts.length>4?`Showing 4 of ${activeAccounts.length} accounts. `:''}${h(currency)} accounts · latest known balances, not month-end totals.</p><div class="overview-panel-footer">${navButton('reconcile','Reconcile balances →')}</div></section></div>`;
    const recent=transactions.data.map(t=>{
      const incoming=['income','refund'].includes(t.event_type),outgoing=t.event_type==='expense';
      const tone=incoming?'positive':outgoing?'negative':'neutral';
      return `<li><button type="button" class="recent-item ${tone}" data-action="transaction-detail" data-id="${h(t.id)}"><span class="recent-icon" aria-hidden="true">${incoming?'↙':outgoing?'↗':'⇄'}</span><span class="recent-copy"><strong>${h(t.description||'Untitled')}</strong><small>${h(t.effective_date)} · ${h([...new Set(t.movements.map(m=>accountName(m.account_id)))].join(' → '))}</small></span><span class="recent-value">${incoming?'+ ':outgoing?'− ':''}${amount(t.amount,t.currency)}<small>${h(t.event_type)}</small></span></button></li>`;
    }).join('');
    return heading('Your finances',`${monthLabel} · ${state.scope==='family'?'Family':'Personal'} overview`,navButton('imports','Import statements')+'<button type="button" class="primary-button" data-action="transaction"><span aria-hidden="true">+</span> Add transaction</button>')+
      cards+coverage()+`<div class="overview-workspace"><section class="panel live-panel overview-activity"><div class="overview-panel-heading"><div><span class="section-kicker">THE LATEST MOVEMENTS</span><h2>Recent activity</h2></div>${navButton('transactions','View all activity →')}</div>${recent?`<ul class="recent-list">${recent}</ul>`:empty('Your activity will appear here when you add a transaction.')}</section>${snapshot}</div>`+
      (!state.accounts.length?panel('Get started',`<p>Import your Money Manager workbook, map the account and category labels, then review before committing.</p>${navButton('imports','Start an import')}`):'');
  },
  async analytics() {
    const query=reportQuery();
    const [year,month]=state.month.split('-').map(Number);
    const trendFrom=new Date(Date.UTC(year,month-6,1)).toISOString().slice(0,10);
    const trendQuery=new URLSearchParams({from:trendFrom,to:period().to,scope:state.scope,currency:state.me.household.base_currency,grain:'month'});
    const [summary,categories,incomeCategories,merchants,series,trend,types,accounts,transfers,activity,comparison,comparisonCategories,comparisonSeries]=await Promise.all([
      api.request(`analytics/summary?${query}`),api.request(`analytics/categories?${query}`),
      api.request(`analytics/income-categories?${query}`),
      api.request(`analytics/merchants?${query}`),api.request(`analytics/series?${query}&grain=day`),
      api.request(`analytics/series?${trendQuery}`),api.request(`analytics/types?${query}`),
      api.request(`analytics/accounts?${query}`),api.collection(`analytics/transfers?${query}`),
      api.request(`analytics/transactions?${query}&limit=1`),
      api.request(`analytics/summary?${reportQuery(state.compareMonth)}`),
      api.request(`analytics/categories?${reportQuery(state.compareMonth)}`),
      api.request(`analytics/series?${reportQuery(state.compareMonth)}&grain=day`)
    ]);
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
      {name:'Cumulative income',color:'#137653',values:analyticsView.cumulativeMoney(series.data,'income',currencyScale)},
      {name:'Cumulative net spending',color:'#b83e4c',values:analyticsView.cumulativeMoney(series.data,'net_spending',currencyScale)},
      {name:'Recorded surplus',values:analyticsView.cumulativeMoney(series.data,'recorded_surplus',currencyScale),dashed:true}
    ],currency,`Income, spending and surplus through ${state.month}`);
    const trendMonths=trend.data.map(row=>row.period);
    const monthlyCashflowChart=analyticsView.moneyLines(trendMonths,[
      {name:'Income',color:'#137653',values:trend.data.map(row=>row.income)},
      {name:'Net spending',color:'#b83e4c',values:trend.data.map(row=>row.net_spending)},
      {name:'Recorded surplus',values:trend.data.map(row=>row.recorded_surplus),dashed:true}
    ],currency,'Monthly recorded income, net spending and surplus');
    const categoryMonths=await Promise.all(trendMonths.map(month=>month===state.month?Promise.resolve(categories):api.request(`analytics/categories?${reportQuery(month)}`)));
    const categoryRollups=categoryMonths.map(response=>categoryView.rollup(response.data,state.categories));
    const rootCategories=categoryView.ordered(state.categories,'expense').filter(({category,depth})=>depth===0).map(({category})=>({id:category.id,name:category.name}));
    rootCategories.push({id:'uncategorized',name:'Uncategorized'});
    const allCategoryTrends=rootCategories.map(category=>({...category,values:categoryRollups.map(rollup=>rollup.get(category.id)?.amount||zero)})).filter(category=>category.values.some(value=>Number(value)!==0)).sort((a,b)=>b.values.reduce((sum,value)=>sum+Math.max(0,Number(value)),0)-a.values.reduce((sum,value)=>sum+Math.max(0,Number(value)),0));
    const categoryTrends=allCategoryTrends.slice(0,4);
    const rest=allCategoryTrends.slice(4);
    if(rest.length)categoryTrends.push({name:'Other categories',values:trendMonths.map((_,index)=>analyticsView.sumMoney(rest.map(category=>category.values[index]),currencyScale))});
    const categoryTrendChart=categoryTrends.length?analyticsView.moneyLines(trendMonths,categoryTrends.map(category=>({name:category.name,values:category.values})),currency,'Recorded spending by category across months'):empty('No recorded category spending in this period.');
    const categoryTrendTable=categoryTrends.length?table(['Category',...trendMonths],categoryTrends.map(category=>[h(category.name),...category.values.map(value=>amount(value,currency))])):'';
    const gap=analyticsView.difference(summary.net_spending,summary.income);
    const overIncome=Number(gap)>0;
    const expenseDrivers=expenseRoots.slice(0,4).map(([key,row])=>`<li><span>${h(key==='uncategorized'?'Uncategorized':state.categories.find(c=>c.id===key)?.name||'Category')}</span><strong>${amount(row.amount,currency)}</strong></li>`).join('');
    const remainingDrivers=expenseRoots.slice(4).map(([,row])=>row.amount);
    const visibleAccounts=accounts.data.filter(a=>a.active!==false);
    const balanceItem=a=>{
      const card=a.subtype==='credit_card';
      const basis=a.balance?.source==='balance_check'?'checked balance':a.balance?.source==='opening_balance'?'starting balance':'no balance anchor';
      return `<li><span><strong>${h(a.name)}</strong><small>${h(card?'Card · amount owed':a.subtype==='settle_up'?'Settlement balance':'Bank / cash balance')} · ${h(basis)}</small></span>${moneyFigure(a.balance?.amount,a.currency,card?'debt':'asset')}</li>`;
    };
    const knownBalances=visibleAccounts.filter(a=>a.balance?.amount!=null);
    const unknownBalances=visibleAccounts.filter(a=>a.balance?.amount==null);
    const balanceRows=knownBalances.map(balanceItem).join('');
    const missingBalances=unknownBalances.length?`<details class="glance-missing"><summary>${unknownBalances.length} ${unknownBalances.length===1?'account needs':'accounts need'} a balance anchor</summary><ul>${unknownBalances.map(balanceItem).join('')}</ul></details>`:'';
    const glance=`<div class="analytics-glance"><section class="panel glance-story"><span class="glance-eyebrow">${h(state.month)} · ${h(state.scope)} · recorded</span><h2>${overIncome?'Spending exceeded income by':Number(gap)<0?'Income exceeded spending by':'Income and spending matched'}</h2><strong class="glance-figure ${overIncome?'negative':'positive'}">${amount(overIncome?gap:Number(gap)<0?analyticsView.negate(gap):gap,currency)}</strong><div class="glance-equation"><span>Income <strong>${amount(summary.income,currency)}</strong></span><span>Net spending <strong>${amount(summary.net_spending,currency)}</strong></span></div><p>${overIncome?'This month’s spending may have used earlier balances, credit, or income missing from the records. Review the categories and account activity to find the cause.':'This compares recorded income and expenses for the selected month.'}</p><small>Transfers: ${amount(summary.transfer_volume,currency)} between accounts; excluded from spending. Coverage unconfirmed.</small><div class="glance-actions">${navButton('transactions','Review transactions')}</div></section><section class="panel glance-drivers"><h2>Where spending went</h2>${expenseDrivers?`<ul>${expenseDrivers}${remainingDrivers.length?`<li><span>Other categories</span><strong>${amount(analyticsView.sumMoney(remainingDrivers,currencyScale),currency)}</strong></li>`:''}</ul>`:empty('No recorded expense categories for this month.')}<small>Category amounts are net of refunds; positive categories may not add up to net spending when refunds exceed purchases in another category.</small></section><section class="panel glance-balances"><h2>Account balances now</h2>${balanceRows?`<ul>${balanceRows}</ul>`:visibleAccounts.length?'':'<p class="empty-state">No accounts available.</p>'}${missingBalances}<small>Current account estimates, not month-end balances. Card amounts owed are liabilities.</small><div class="glance-actions">${navButton('accounts','View accounts')}</div></section></div>`;
    return heading('Analytics',`${state.month} · ${state.scope} allocations`)+
      glance+recent+
      panel('Income, expenses and surplus over the month',`${cashflowChart}<p class="helper">Each line accumulates recorded entries from the first day of the selected month. Transfers are excluded; missing source coverage can make a line appear flat.</p>`)+
      panel('Where expenses changed over six months',`${categoryTrendChart}<p class="helper">Top four expense categories plus all remaining categories. Refunds stay in net spending; source coverage is unconfirmed.</p>${categoryTrendTable}`)+
      `<div class="analytics-lead">${panel('Six-month income and spending',monthlyCashflowChart)}${panel('Spending by category',categoryBars(categories.data,'expense'))}</div>`+
      panel('How spending builds through the month',`${analyticsView.cumulativeSpending?.(series.data,comparisonSeries.data,currency,state.month,state.compareMonth)||empty('Daily chart unavailable.')}<p class="helper">Lines compare recorded cumulative net spending by calendar day. The months can have different lengths and source coverage is unconfirmed.</p>`)+
      panel('Compare months',field('Compare with month',input('compare_month',`id="compare-month" type="month" value="${h(state.compareMonth)}" required`))+table(['Measure',state.month,state.compareMonth,'Difference'],comparisonRows)+`<h3>Expense category changes</h3>`+table(['Category',state.month,state.compareMonth,'Difference'],categoryCompare)+`<p class="helper">Differences are recorded amounts in the selected scope and currency. Source coverage may differ by month.</p>`)+
      panel('Income flow',analyticsView.sankey(flowRows(incomeCategories.data),'Recorded income','income'))+
      panel('Spending flow',analyticsView.sankey(flowRows(categories.data),'Recorded spending','expense'))+
      panel('Income by category and subcategory',categoryBars(incomeCategories.data,'income'))+
      panel('Last six months',table(['Month','Income','Net spending','Recorded surplus'],trend.data.map(r=>[h(r.period),`<span class="metric-value good">${amount(r.income)}</span>`,`<span class="metric-value spend">${amount(r.net_spending)}</span>`,`<span class="metric-value ${Number(r.recorded_surplus)>=0?'good':'bad'}">${amount(r.recorded_surplus)}</span>`])))+
      panel('Daily trend',table(['Date','Income','Net spending','Recorded surplus'],series.data.filter(r=>Number(r.income)!==0||Number(r.net_spending)!==0).map(r=>[h(r.period),`<span class="metric-value good">${amount(r.income)}</span>`,`<span class="metric-value spend">${amount(r.net_spending)}</span>`,`<span class="metric-value ${Number(r.recorded_surplus)>=0?'good':'bad'}">${amount(r.recorded_surplus)}</span>`])))+
      panel('Transaction mix',table(['Type','Transactions','Recorded amount'],types.data.map(r=>[h(r.event_type),h(r.count),amount(r.amount,r.currency)])))+
      panel('Merchants',table(['Merchant','Net spending','Transactions'],merchants.data.map(m=>[h(m.id==='unknown'?'Unspecified':m.id),amount(m.amount,m.currency),h(m.count)])))+
      panel('Account activity',table(['Account','Movement / debt change','Current balance / amount owed'],accounts.data.map(a=>[h(a.name),moneyFigure(state.accounts.find(v=>v.id===a.id)?.subtype==='credit_card'?analyticsView.negate(a.signed_movements):a.signed_movements,a.currency),`${moneyFigure(a.balance?.amount,a.currency,state.accounts.find(v=>v.id===a.id)?.subtype==='credit_card'?'debt':'asset')}<small>${state.accounts.find(v=>v.id===a.id)?.subtype==='credit_card'?'Amount owed':'Available balance'}</small>`])))+
      panel('Transfers',`<p>${h(transfers.data.length)} recorded transfers in this period.</p>`);
  },
  async transactions(parts) {
    const allDates=parts[0]==='all';
    if(state.transactionFilters.account && !state.accounts.some(a=>a.id===state.transactionFilters.account)) {
      state.transactionFilters.account=''; saveView();
    }
    const filters=state.transactionFilters;
    const values=await api.collection(viewState.transactionsPath(state.month,!allDates,filters));
    const eventAccounts=state.accounts.filter(a=>(!filters.account || a.id===filters.account) && (!filters.accountType || a.subtype===filters.accountType));
    const ledgers=await loadLedgerBalances(values.data,allDates,eventAccounts.map(a=>a.id));
    const balanceEvents=eventAccounts.flatMap(account=>(ledgers.get(account.id)||[]).filter(row=>['opening_balance','balance_check'].includes(row.event_type)).map(row=>({account,row})));
    const picker=`<div class="ledger-filters" role="group" aria-label="Filter transactions">${field('Account',`<select id="transaction-filter-account">${option('','All accounts',!filters.account)}${state.accounts.map(a=>option(a.id,`${a.name} · ${a.currency}`,a.id===filters.account)).join('')}</select>`)}${field('Account type',`<select id="transaction-filter-account-type">${option('','All types',!filters.accountType)}${['bank','credit_card','cash','settle_up'].map(v=>option(v,v.replace('_',' '),v===filters.accountType)).join('')}</select>`)}${field('Transaction type',`<select id="transaction-filter-event-type">${option('','All types',!filters.eventType)}${['expense','income','refund','transfer'].map(v=>option(v,v,v===filters.eventType)).join('')}</select>`)}${button('Clear filters','clear-transaction-filters')}</div>`;
    const legend='<div class="activity-legend" aria-label="Transaction amount key"><span class="income">+ Income</span><span class="expense">− Expense</span><span class="refund">+ Refund</span><span class="transfer">↔ Transfer</span></div>';
    const monthLabel=new Intl.DateTimeFormat('en',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(`${state.month}-01T00:00:00Z`));
    return heading('Transactions',allDates?'Your complete transaction history':`${monthLabel} · Your money in and out`,button('Add balance check','transaction-balance')+'<button type="button" class="primary-button" data-action="transaction"><span aria-hidden="true">+</span> Add transaction</button>')+
      `<section class="panel ledger-workspace" aria-label="Transaction ledger"><div class="ledger-heading"><div><h2>Recorded activity <span class="record-count">${values.data.length}</span></h2><p>${balanceEvents.length} balance ${balanceEvents.length===1?'marker':'markers'}${filters.account||filters.accountType||filters.eventType?' · Filters applied':''}</p></div><div class="ledger-view-actions">${button(allDates?`Show ${state.month}`:'Show all dates','transaction-period')}${navButton('changes','Money Manager changes ↗')}</div></div>${picker}<div class="ledger-caption"><span>Latest first</span>${legend}</div>${transactionTable(values.data,balanceEvents,filters.account)}<div class="ledger-footer"><span>${values.data.length} transactions shown</span><span>Transfers match either participating account.</span></div></section>`+coverage();
  },
  async accounts(parts) {
    const selected=state.accounts.find(a=>a.id===parts[0]);
    const accountCard=a=>`<article class="account-card ${h(a.subtype)} ${selected?.id===a.id?'selected':''}"><div class="account-card-top"><span class="account-symbol" aria-hidden="true">${a.subtype==='credit_card'?'▤':a.subtype==='cash'?'¤':a.subtype==='settle_up'?'↔':'⌂'}</span><span class="account-visibility">${h(a.visibility)}</span></div><div class="account-card-name"><h3>${h(a.name)}</h3><small>${h(a.subtype.replace('_',' '))} · ${h(a.currency)}</small></div><div class="account-card-balance">${accountBalance(a)}</div><div class="account-card-actions">${button('View ledger','account-ledger',`data-id="${h(a.id)}"`)}${a.owner_id===state.me.user.id?button('Edit','edit-account',`data-id="${h(a.id)}"`)+button(a.opening_balance?'Edit balance':'Set balance','opening-balance',`data-id="${h(a.id)}"`):''}${a.subtype==='settle_up'?'':button('Check balance','balance',`data-id="${h(a.id)}"`)}</div></article>`;
    const accountSection=(title,values,description)=>`<section class="account-section"><div class="section-heading"><div><h2>${h(title)}</h2><p>${h(description)}</p></div><span>${values.length} ${values.length===1?'account':'accounts'}</span></div>${values.length?`<div class="account-grid">${values.map(accountCard).join('')}</div>`:empty('No accounts in this group.')}</section>`;
    let content=heading('Accounts','Bank balances, card debt and dated balance checks.',button('Add account','account'))+
      accountSection('Bank and cash',state.accounts.filter(a=>['bank','cash'].includes(a.subtype)),'Money held in bank and cash accounts.')+
      accountSection('Credit cards',state.accounts.filter(a=>a.subtype==='credit_card'),'Amount owed is a liability. The payment due is tracked separately from total card debt. Record a card payment as a transfer from a bank account.')+
      (state.accounts.some(a=>a.subtype==='settle_up')?accountSection('Settlements',state.accounts.filter(a=>a.subtype==='settle_up'),'Amounts to settle with other people.'): '');
    if(selected) {
      const [ledger,checks]=await Promise.all([api.collection(`accounts/${id(selected.id)}/ledger?${new URLSearchParams(period())}`),api.collection(`accounts/${id(selected.id)}/balance-checks`)]);
      state.selectedChecks=checks.data;
      const opening=selected.opening_balance;
      content+=panel('Known balance',`<p>${opening?`${amount(opening.amount,selected.currency)} as of ${h(opening.as_of)}`:'No known balance recorded.'}</p>${selected.owner_id===state.me.user.id?button(opening?'Edit known balance':'Set known balance','opening-balance',`data-id="${h(selected.id)}"`):''}<p class="helper">Enter a balance for today or any known date and time. Recorded transactions calculate balances backward for earlier dates and forward for later dates.</p>`)+panel(`${selected.name} · ${state.month} ledger`,table(['Date / time','Description','Movement','Computed from anchor','Displayed balance'],ledger.data.map(r=>[h(r.effective_at),h(r.description)+(r.same_time_count>1?'<small>'+groupBalanceLabel(r,selected.id).replace(/^ · /,'')+'</small>':''),r.movement==null?'—':amount(r.movement,r.currency),amount(r.computed_from_start,r.currency),`${amount(r.balance_after,r.currency)}<small>${h(balanceLabel(r))}</small>`])))+panel('Manual balance checks',table(['As of','Entered balance','Computed from anchor','Difference now','Status',''],checks.data.map(c=>[h(c.as_of),amount(c.amount,c.currency),amount(c.current_calculated,c.currency),amount(c.current_variance,c.currency),h(c.voided?'Removed':c.stale?'Ledger changed':'Current'),c.voided?'':button('Edit','edit-balance-check',`data-account="${h(selected.id)}" data-id="${h(c.id)}"`)+button('Remove','remove-balance-check',`data-account="${h(selected.id)}" data-id="${h(c.id)}"`)])))+`<p class="helper">Difference = entered balance minus the current ledger calculation. Removed checks stay in history but no longer anchor balances.</p>`;
    }
    return content+coverage();
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
      `<div class="category-tree">${categoryView.ordered(state.categories,kind).map(({category,depth})=>`<div class="category-tree-row" style="--depth:${depth}"><div class="category-tree-name"><span class="category-branch">${depth?'↳':'●'}</span><strong>${h(category.name)}</strong><small>${h(categoryName(category.id))}${category.archived?' · archived':''}</small></div><div>${category.archived?'':button('Add subcategory','add-subcategory',`data-parent="${h(category.id)}"`)}${category.archived?'':button('Edit','edit-category',`data-id="${h(category.id)}"`)}</div></div>`).join('') || empty('No categories yet.')}</div>`);
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
    const plans=await api.collection(`budgets?month=${state.month}&scope=${state.scope}`);
    if(!plans.data.length) return heading('Monthly budgets',`${state.month} · ${state.scope}`,button('Create budget','budget'))+coverage()+panel('Plan this month',`<p>No budget exists for this month and scope. Create a plan with category limits, then compare recorded spending with those limits over time.</p>${button('Create budget','budget')}`);
    const tracking=await Promise.all(plans.data.map(b=>api.request(`budgets/${id(b.id)}/tracking`)));
    const previous=new Date(Date.UTC(Number(state.month.slice(0,4)),Number(state.month.slice(5,7))-2,1)).toISOString().slice(0,7);
    const dailyReports=await Promise.all(plans.data.map(async b=>{const query=month=>new URLSearchParams({...period(month),scope:b.scope,currency:b.currency,grain:'day'});const [daily,prior]=await Promise.all([api.request(`analytics/series?${query(state.month)}`),api.request(`analytics/series?${query(previous)}`)]);return {daily,prior};}));
    const today=householdDate();
    return heading('Monthly budgets',`${state.month} · ${state.scope}`)+coverage()+plans.data.map((b,i)=>{
      const {daily,prior}=dailyReports[i],cutoff=state.month<today.slice(0,7)?daily.data.length:state.month===today.slice(0,7)?Number(today.slice(-2)):0;
      const lines=tracking[i].data,scale=new Intl.NumberFormat('en',{style:'currency',currency:b.currency}).resolvedOptions().maximumFractionDigits;
      const planned=analyticsView.sumMoney(lines.map(line=>line.planned),scale);
      const actual=analyticsView.sumMoney([...lines.map(line=>line.actual),tracking[i].unbudgeted],scale);
      const remaining=analyticsView.difference(planned,actual);
      const incomeGap=analyticsView.difference(b.expected_income,planned);
      const labels=daily.data.map(row=>row.period.slice(-2));
      const actualLine=analyticsView.cumulativeMoney(daily.data,'net_spending',scale).map((value,day)=>day<cutoff?value:null);
      const priorLine=analyticsView.cumulativeMoney(prior.data,'net_spending',scale);
      const guide=analyticsView.pacedBudget(planned,labels.length,scale);
      const chart=analyticsView.moneyLines(labels,[{name:'Recorded spending',values:actualLine,color:'#b83e4c'},{name:'Even budget guide',values:guide,dashed:true,color:'#6958d5'},{name:`${previous} recorded`,values:labels.map((_,day)=>priorLine[day]??null),dashed:true,color:'#9fb3cc'}],b.currency,`${b.name||b.month} spending against plan`);
      const dailyDetails=table(['Day','Net spending','Cumulative spending','Even guide'],daily.data.slice(0,cutoff).map((row,day)=>[h(row.period),amount(row.net_spending,b.currency),amount(actualLine[day],b.currency),amount(guide[day],b.currency)]));
      const canManage=b.owner_id===state.me.user.id||(b.scope==='family'&&['owner','admin'].includes(state.me.membership.role));
      const actions=canManage?`<div class="budget-plan-actions">${b.state==='archived'?'':button('Edit plan','edit-budget',`data-id="${h(b.id)}"`)}${b.state==='draft'?button('Activate','activate-budget',`data-id="${h(b.id)}" data-revision="${b.revision}"`):''}${button('Copy to next month','copy-budget',`data-id="${h(b.id)}" data-revision="${b.revision}"`)}</div>`:'';
      const summary=`<div class="budget-summary-grid"><article><span>Planned limits</span><strong>${amount(planned,b.currency)}</strong></article><article><span>Recorded spending</span><strong class="${Number(actual)>Number(planned)?'bad':'spend'}">${amount(actual,b.currency)}</strong></article><article><span>${Number(remaining)<0?'Over plan':'Remaining'}</span><strong class="${Number(remaining)<0?'bad':'good'}">${amount(Number(remaining)<0?analyticsView.negate(remaining):remaining,b.currency)}</strong></article><article><span>Expected income</span><strong>${amount(b.expected_income,b.currency)}</strong></article></div>`;
      const incomeNote=`<p class="budget-income-gap ${Number(incomeGap)<0?'bad':'good'}">${Number(incomeGap)<0?'Planned limits exceed expected income by':'Expected income after planned limits'} <strong>${amount(Number(incomeGap)<0?analyticsView.negate(incomeGap):incomeGap,b.currency)}</strong></p>`;
      const categoryCards=`<div class="budget-progress-list">${lines.map(l=>{const percent=Number(l.planned)>0?Math.max(0,Math.min(100,Number(l.actual)/Number(l.planned)*100)):0;return `<article class="budget-progress"><div><strong>${h(categoryName(l.category_id))}</strong><span>${amount(l.actual,b.currency)} of ${amount(l.planned,b.currency)}</span></div><div class="budget-track" role="progressbar" aria-label="${h(categoryName(l.category_id))} budget used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(percent)}"><span class="budget-fill ${Number(l.remaining)<0?'red':percent>=80?'orange':'green'}" style="width:${percent}%"></span></div><small class="${Number(l.remaining)<0?'negative':''}">${Number(l.remaining)<0?'Over by':'Remaining'} ${amount(Number(l.remaining)<0?analyticsView.negate(l.remaining):l.remaining,b.currency)}</small></article>`;}).join('')||empty('No category limits yet.')}</div><p class="budget-unbudgeted">Unbudgeted spending <strong>${amount(tracking[i].unbudgeted,b.currency)}</strong></p>`;
      return panel(`${b.name || b.month} · ${b.state}`,actions+summary+incomeNote+`<h3>Spending through the month</h3>${chart}<p class="helper">The guide divides the full monthly limit evenly across days; it is a reference, not a forecast. Recorded values include unbudgeted spending. The prior month may end on an earlier calendar day. Flat lines do not confirm complete coverage.</p><details class="budget-day-details"><summary>Show daily amounts</summary>${dailyDetails}</details><h3>Category limits</h3>${categoryCards}`);
    }).join('');
  },
  async imports(parts,generation) { return importView(parts,generation); },
  async reconcile(parts) {
    const [sessions,checkLists]=await Promise.all([api.collection(`reconciliation/sessions?month=${state.month}`),Promise.all(state.accounts.filter(a=>a.subtype!=='settle_up').map(async account=>({account,checks:(await api.collection(`accounts/${id(account.id)}/balance-checks?${new URLSearchParams(period())}`)).data})))]);
    const selected=sessions.data.find(s=>s.id===parts[0]); state.session=selected || null;
    const checks=checkLists.flatMap(({account,checks})=>checks.filter(c=>!c.voided).map(c=>({account,check:c}))).sort((a,b)=>b.check.as_of.localeCompare(a.check.as_of));
    const differences=checks.filter(({check})=>check.current_variance==null || Number(check.current_variance)!==0);
    let content=heading('Reconciliation','Review bank evidence and dated balance differences.',button('Start account review','start-session'));
    if(selected) content+=`<div id="reconcile-comparison">${await reconciliationComparison(selected)}</div>`;
    content+=panel('Balance differences',`<p>${differences.length} checks need review in ${h(state.month)}. Difference = entered balance minus the balance computed from the starting balance and transactions.</p>`+table(['Account','As of','Entered','Computed','Difference',''],differences.map(({account,check})=>[h(account.name),h(check.as_of),amount(check.amount,account.currency),amount(check.current_calculated,account.currency),check.current_variance==null?'Starting balance needed':amount(check.current_variance,account.currency),button('Compare balances','review-balance',`data-account="${h(account.id)}" data-check="${h(check.id)}"`)]))+`<p class="helper">Correct a mistaken check in Accounts. If the check is right, review missing or incorrect transactions; changing a check does not create a transaction.</p>`)+panel('Sessions',table(['Account','Month','State','Unresolved','Balance checks',''],sessions.data.map(s=>[h(accountName(s.account_id)),h(s.month),h(s.state)+(s.stale?' · stale':''),h(s.current?.unresolved_count),h(s.current?.balance_check_unresolved_count),button('Open','open-session',`data-id="${h(s.id)}"`)])));
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
    const invite=canInvite?panel('Add a member',`<form id="invite-form">${field('Email address',input('email','type="email" required autocomplete="email"'))}${field('Role',`<select name="role">${option('member','Member')}${state.me.membership.role==='owner'?option('admin','Admin'):''}</select>`)}<p class="helper">Create a one-day invitation link and share it with the intended person. FinWise does not send email. Private accounts stay private unless you grant access.</p><button type="submit" class="primary-button">Create invitation link</button></form>${state.inviteLink?`<div class="invite-link">${field('Share this link now',input('link',`readonly value="${h(state.inviteLink)}"`))}${button('Copy link','copy-invite-link')}</div>`:''}`):'';
    return heading('Settings','Your connected household.')+panel('Household',table(['Setting','Value'],[['Name',h(state.me.household.name)],['Timezone',h(state.me.household.timezone)],['Currency',h(state.me.household.base_currency)],['Signed in as',h(state.me.user.email)],['Role',h(state.me.membership.role)]]))+panel('Members',table(['Name','Email','Role'],members.data.map(m=>[h(m.name),h(m.email),h(m.role)])))+invite+(canInvite?monthResetPanel():'')+panel('AI providers','<p>AI provider configuration is not available in this backend release.</p>')+button('Sign out','logout');
  },
  async more() { return heading('Workspace','Choose a view.')+`<div class="mobile-more">${Object.entries(labels).filter(([v])=>v!=='more').map(([v,name])=>navButton(v,name)).join('')}${button('Sign out','logout')}</div>`; }
};

function editor(title,fields,formId,submit='Save') {
  dialog.innerHTML=`<div class="dialog-head"><h2 id="editor-title">${h(title)}</h2><button type="button" class="icon-button" data-action="close-editor" aria-label="Close">×</button></div><form id="${formId}">${fields}<div class="dialog-actions">${button('Cancel','close-editor')}<button class="primary-button" type="submit">${h(submit)}</button></div></form>`;
  addModalChips();
  dialog.showModal();
}

function monthResetPanel() {
  state.resetMonths ??= [state.month];
  const preview=state.resetPreview;
  const names={transactions:'Transactions',statement_entries:'Statement entries',reconciliation_sessions:'Reconciliation sessions',balance_checks:'Balance checks',budgets:'Budgets',import_rows:'Imported rows'};
  const total=preview?Object.values(preview.counts).reduce((sum,n)=>sum+n,0):0;
  return panel('Reset monthly data',`<p>Clear one or more months from accounts you can access, including shared activity, and your personal and family budgets. Other members’ private accounts and budgets are excluded.</p><p class="helper">Account setup, starting balances, categories, original uploaded files, and audit history are retained. Transactions and balance checks are voided. Reopen closed reconciliation sessions first. Removing activity may change later balances. Upload files again to reimport cleared months.</p><div class="reset-month-picker">${field('Month to add',input('reset_month','id="reset-month" type="month" value="'+h(state.month)+'"'))}${button('Add month','reset-add-month')}</div><ul class="reset-months" aria-label="Months to reset">${state.resetMonths.map(month=>`<li><span>${h(month)}</span>${button('Remove','reset-remove-month',`data-month="${h(month)}" aria-label="Remove ${h(month)}"`)}</li>`).join('')}</ul><form id="reset-preview-form"><button type="submit" class="outline-button" ${state.resetMonths.length?'':'disabled'}>Preview reset</button></form>${preview?`<div class="reset-preview"><h3>Reset preview · ${h(preview.months.join(', '))}</h3>${table(['Activity','Records to clear'],Object.entries(preview.counts).map(([kind,count])=>[h(names[kind]||kind),h(count)]))}${total?`<form id="reset-apply-form"><p>This cannot be undone in the app. Review the months and counts before continuing.</p>${field('Type RESET to confirm',input('confirmation','required pattern="RESET" autocomplete="off"'))}<button type="submit" class="primary-button reset-danger">Reset selected months</button></form>`:'<p role="status">No activity found in these months.</p>'}</div>`:''}`);
}
function addModalChips() {
  const formId=dialog.querySelector('form')?.id;
  const namePresets=formId==='account-form'||formId==='account-edit-form'?['Savings','Cash','Credit card']:formId==='category-form'?['Groceries','Transport','Utilities']:['budget-form','budget-edit-form'].includes(formId)?[`${state.month} budget`]:[];
  const presets={name:namePresets,description:['Groceries','Dining out','Transfer'],reason:['Correction','Statement review'],amount:['100','500','1000'],opening:['0','1000'],due_amount:['0','500'],expected_income:['25000','50000','100000'],currency:['INR','USD','EUR']};
  for(const control of dialog.querySelectorAll('input')) {
    if(control.type==='hidden' || control.type==='date' || control.type==='datetime-local' || control.type==='file') continue;
    const values=presets[control.name] || (control.name.startsWith('allocation-')?presets.amount:null);
    if(!values?.length || !control.closest('.field')) continue;
    const chips=document.createElement('span');chips.className='quick-chips';chips.setAttribute('aria-label',`Quick values for ${control.getAttribute('aria-label')||control.name}`);
    for(const value of values) { const chip=document.createElement('button');chip.type='button';chip.className='quick-chip';chip.textContent=value;chip.addEventListener('click',()=>{control.value=value;control.dispatchEvent(new Event('input',{bubbles:true}));control.focus();});chips.append(chip); }
    control.after(chips);
  }
}
function accountEditor() {
  editor('Add account',field('Name',input('name','required maxlength="100"'))+field('Type',`<select name="subtype" id="account-subtype">${['bank','credit_card','cash','settle_up'].map(v=>option(v,v.replace('_',' '))).join('')}</select>`)+field('Currency',input('currency',`required value="${h(state.me.household.base_currency)}" pattern="[A-Z]{3}"`))+field('Visibility','<select name="visibility"><option value="private">Private</option><option value="shared">Shared household</option></select>')+field('Known balance (optional, card: amount owed)',input('opening','inputmode="decimal" placeholder="Unknown"'))+field('Balance as of (your browser timezone)',input('as_of',`type="datetime-local" value="${h(localDateTime(new Date().toISOString()))}"`))+`<p class="helper">Today is prefilled. The balance anchors earlier and later transactions.</p><div id="card-due-fields" hidden>${field('Statement payment amount (optional)',input('due_amount','inputmode="decimal" placeholder="0.00"'))}${field('Payment due date',input('due_date','type="date"'))}</div>`,'account-form');
}
function editAccountEditor(key) {
  const account=state.accounts.find(a=>a.id===key);
  if(!account || account.owner_id!==state.me.user.id) return;
  editor('Edit account',input('account_id',`type="hidden" value="${h(key)}"`)+input('revision',`type="hidden" value="${account.revision}"`)+field('Name',input('name',`required maxlength="100" value="${h(account.name)}"`))+field('Account type',`<select name="subtype" id="account-subtype">${['bank','credit_card','cash','settle_up'].map(v=>option(v,v.replace('_',' '),v===account.subtype)).join('')}</select>`)+`<div id="card-due-fields" ${account.subtype==='credit_card'?'':'hidden'}>${field('Statement payment amount (optional)',input('due_amount',`inputmode="decimal" value="${h(account.card_due?.amount||'')}" placeholder="0.00"`))}${field('Payment due date',input('due_date',`type="date" value="${h(account.card_due?.due_date||'')}"`))}</div>`+`<p class="helper">Amount owed comes from the balance anchor and transactions. A statement payment amount is optional and can be added later. Record a card payment as a transfer from a bank account.</p>`,'account-edit-form','Save account');
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
  const kindField=current || parent
    ?input('kind',`type="hidden" value="${h(kind)}"`)+`<p class="helper">Type: ${h(kind)}</p>`
    :field('Type',`<select name="kind" id="category-kind">${option('expense','Expense',kind==='expense')}${option('income','Income',kind==='income')}</select>`);
  editor(current?'Edit category':parent?'Add subcategory':'Add category',
    input('category_id',`type="hidden" value="${h(key||'')}"`)+input('revision',`type="hidden" value="${current?.revision||''}"`)+
    field('Name',input('name',`required maxlength="100" value="${h(current?.name||'')}"`))+kindField+
    field('Parent category',`<select name="parent_id" id="category-parent">${option('','Top level',!parentId)}${categoryOptions(kind,parentId,key||'')}</select>`),
    'category-form',current?'Save category':'Create category');
}
function transactionEditor() {
  if(!state.accounts.some(a=>a.active!==false)) { notify('Add an active account first.'); return; }
  editor('Add transaction',field('Description',input('description','required maxlength="240"'))+field('Type','<select name="event_type" id="event-type"><option value="expense">Expense</option><option value="income">Income</option><option value="refund">Refund</option><option value="transfer">Transfer</option></select>')+field('Amount',moneyInput('amount'))+field('Date',input('effective_date',`type="date" required value="${localDate()}"`))+field('Account / transfer source',`<select name="account_id" required>${accountOptions()}</select>`)+`<div id="transfer-target" hidden>${field('Transfer destination',`<select name="destination">${accountOptions()}</select>`)}</div><div id="allocation-fields">${field('Category','<select name="category_id" id="transaction-category"></select>')}${field('Scope',`<select name="scope">${option('personal','Personal',state.scope==='personal')}${option('family','Family',state.scope==='family')}</select>`)}</div>`,'transaction-form');
  updateCategories();
}
function updateCategories() { const kind=document.querySelector('#event-type').value; const transfer=kind==='transfer'; document.querySelector('#transfer-target').hidden=!transfer; document.querySelector('#allocation-fields').hidden=transfer; document.querySelector('#transaction-category').innerHTML=option('','Uncategorized')+categoryOptions(kind==='income'?'income':'expense'); }
async function transactionDetail(key) {
  const t=await api.request(`transactions/${id(key)}`);
  await loadLedgerBalances([t],true);
  const amendment=t.amendment?`<p class="amendment-note"><strong>Amended in FinWise</strong><br>Money Manager original: ${amount(t.amendment.original_amount,t.currency)} on ${h(t.amendment.original_date)}.<br>Current amount: ${amount(t.amount,t.currency)} on ${h(t.effective_date)}.<br>${h(t.amendment.reason)} · Update the source app using the amendment export.</p>`:t.reconciliation_created?`<p class="amendment-note"><strong>${t.reconciliation_created.action==='update_transfer'?'Converted to an internal transfer':'Created from a bank statement'}</strong><br>${h(t.reconciliation_created.observation_ids?.length||0)} source statement row(s) attached. ${t.reconciliation_created.action==='update_transfer'?'Update':'Add'} this transaction in Money Manager using the changes export in Reconcile.<br>${h(t.reconciliation_created.reason||'')}</p>`:'';
  const evidence=t.reconciliation_evidence||[];
  editor('Transaction details',`<p>${h(t.effective_date)} · ${h(t.event_type)} · ${amount(t.amount,t.currency)}</p>${transactionIndicators(t)}`+amendment+table(['Account','Movement','Balance after'],t.movements.map(m=>{const row=state.ledgerBalances.get(`${m.account_id}:${t.id}`);return [h(accountName(m.account_id)),amount(m.amount,t.currency),row?`${amount(row.balance_after,row.currency)}<small>${h(balanceLabel(row))}${groupBalanceLabel(row,m.account_id)}</small>`:'Unknown'];}))+table(['Category','Scope','Amount'],t.allocations.map(a=>[h(categoryName(a.category_id)),h(a.scope),amount(a.amount,t.currency)]))+`<h3>Reconciliation evidence</h3>`+(evidence.length?table(['Account','Statement date','Statement row','Attached amount'],evidence.map(v=>[h(accountName(v.account_id)),h(v.statement_date),`${h(v.statement_description)}${v.statement_reference?`<small>Ref ${h(v.statement_reference)}</small>`:''}`,amount(v.matched_amount,t.currency)])):empty('No statement rows attached yet.'))+`<p>Entered by: ${t.entered_by===state.me.user.id?'You':'Household member'} · Revision ${t.revision}</p><p>${t.source_refs.length} source references preserved.</p>${button('Edit transaction','edit-transaction',`data-id="${h(t.id)}"`)}${button('Delete transaction','delete-transaction',`data-id="${h(t.id)}"`)}`,'transaction-detail-form','Close');
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
  const allocations=transfer?'':t.allocations.map((a,i)=>`<div class="form-grid">${field(`Category ${i+1}`,`<select name="category-${i}">${option('','Uncategorized',!a.category_id)}${a.category_id && state.categories.find(c=>c.id===a.category_id)?.archived?option(a.category_id,`${categoryName(a.category_id)} (archived)`,true):''}${categoryOptions(t.event_type==='income'?'income':'expense',a.category_id)}</select>`)}${field(`Allocation ${i+1} (${t.currency})`,input(`allocation-${i}`,`required inputmode="decimal" value="${h(a.amount)}"`))}${field('Scope',`<select name="scope-${i}">${option('personal','Personal',a.scope==='personal')}${option('family','Family',a.scope==='family')}</select>`)}</div>`).join('');
  editor('Edit transaction',input('transaction_id',`type="hidden" value="${h(t.id)}"`)+input('revision',`type="hidden" value="${t.revision}"`)+input('original_date',`type="hidden" value="${h(t.effective_date)}"`)+input('event_type',`type="hidden" value="${h(t.event_type)}"`)+input('currency',`type="hidden" value="${h(t.currency)}"`)+input('allocation_count',`type="hidden" value="${t.allocations.length}"`)+`<p>${h(t.event_type)} · ${h(t.currency)}. Source references and prior revisions are retained.</p>`+field('Description',input('description',`value="${h(t.description||'')}"`))+field('Date',input('effective_date',`type="date" required value="${h(t.effective_date)}"`))+field('Amount',input('amount',`required inputmode="decimal" value="${h(t.amount)}"`))+field(transfer?'From account':'Account',`<select name="source_account" required>${accounts(sourceLeg?.account_id)}</select>`)+(transfer?field('To account',`<select name="destination_account" required>${accounts(destinationLeg?.account_id)}</select>`):allocations),'transaction-full-edit-form','Save transaction');
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
async function budgetEditor(key=null) {
  const existing=key?await api.request(`budgets/${id(key)}`):null;
  if(existing?.state==='archived') throw new Error('Archived plans cannot be edited.');
  const budgetMonth=existing?.month||state.month;
  const budgetScope=existing?.scope||state.scope,budgetCurrency=existing?.currency||state.me.household.base_currency;
  const [year,month]=budgetMonth.split('-').map(Number);
  const months=[3,2,1].map(offset=>new Date(Date.UTC(year,month-1-offset,1)).toISOString().slice(0,7));
  const results=await Promise.all(months.map(month=>api.request(`analytics/categories?${new URLSearchParams({...period(month),scope:budgetScope,currency:budgetCurrency})}`)));
  const scale=new Intl.NumberFormat('en',{style:'currency',currency:budgetCurrency}).resolvedOptions().maximumFractionDigits;
  const averages=(analyticsView.categoryAverages||budgetCategoryAverages)(results.map(result=>result.data),scale);
  const categories=categoryView.ordered(state.categories,'expense').filter(({category})=>category.archived!==true);
  const currentLines=new Map((existing?.lines||[]).map(line=>[line.category_id,line.amount]));
  const archivedLines=(existing?.lines||[]).filter(line=>!categories.some(({category})=>category.id===line.category_id));
  const lines=categories.map(({category})=>{
    const average=averages.get(category.id);
    const suggested=average && Number(average)>0;
    return `<div class="budget-input-row">${field(categoryName(category.id),input(`category-${category.id}`,`inputmode="decimal" pattern="[0-9]+(\\.[0-9]+)?" placeholder="No limit" value="${h(currentLines.get(category.id)||'')}"`))}${suggested?`<button type="button" class="quick-chip average-chip" data-action="use-budget-average" data-average-for="${h(category.id)}" data-value="${h(average)}">3-month avg · ${amount(average,budgetCurrency)}</button>`:''}</div>`;
  }).join('');
  editor(existing?'Edit monthly budget':'Create monthly budget',(existing?input('budget_id',`type="hidden" value="${h(existing.id)}"`)+input('revision',`type="hidden" value="${existing.revision}"`):'')+field('Name',input('name',`required value="${h(existing?.name||`${budgetMonth} budget`)}"`))+field('Expected income',input('expected_income',`inputmode="decimal" pattern="[0-9]+(\\.[0-9]+)?" required value="${h(existing?.expected_income||'')}" placeholder="0.00"`))+`<div class="budget-suggestion"><div><strong>Start from recorded spending</strong><p>Average of ${h(months.join(', '))}. Months with no recorded spending count as zero. Coverage is unconfirmed, so review each limit.</p></div>${[...averages.values()].some(v=>Number(v)>0)?button('Apply averages','apply-budget-averages'):''}</div><p class="helper">${h(budgetMonth)} · ${h(budgetScope)} · ${h(budgetCurrency)}</p>${archivedLines.length?`<p class="helper">${archivedLines.length} archived category limit(s) cannot be revised and will be removed when you save this edit.</p>`:''}<div class="budget-input-grid">${lines}</div>`,existing?'budget-edit-form':'budget-form',existing?'Save budget':'Create draft');
}

// Import review state is reconstructed from the server and URL after a reload.
async function importView(parts,generation) {
  state.batch=parts[0] || null; state.file=parts[1] || null;
  if(!state.batch) {
    const history=await api.collection('imports');
    const cleanup=state.cleanupPreview;
    const cleanupPanel=panel('Reimport Money Manager entries',`<form id="cleanup-preview-form" class="form-grid">${field('Period',`<select name="period_type"><option value="month">Month</option><option value="year">Year</option></select>`)}${field('Month',input('month',`type="month" required value="${h(state.month)}"`))}${field('Year',input('year',`type="number" min="1" max="9998" required value="${h(state.month.slice(0,4))}"`))}<button type="submit" class="outline-button">Preview entries</button></form><p class="helper">Only transactions created from your Money Manager imports are included. Manual transactions and bank statement observations remain.</p>${cleanup?`<p><strong>${h(cleanup.count)} transactions</strong> found for ${h(cleanup.period)}.${cleanup.skipped_mixed_sources?` ${h(cleanup.skipped_mixed_sources)} entries with mixed sources were skipped.`:''}</p>${table(['Date','Description','Type','Amount'],cleanup.transactions.slice(0,50).map(t=>[h(t.effective_date),h(t.description),h(t.event_type),amount(t.amount,t.currency)]))}${cleanup.count?`<form id="cleanup-apply-form"><p class="helper">Removing these transactions changes balances and reports. Reconciliation links return to review. Upload the workbook again afterward to recreate its rows.</p><button type="submit" class="primary-button">Remove ${h(cleanup.count)} imported transactions</button></form>`:''}`:''}`);
    return heading('Imports','Upload Money Manager or bank statement CSV/XLSX files.')+panel('Upload files',`<form id="upload-form">${field('Source','<select name="source_kind"><option value="money_manager">Money Manager</option><option value="bank_statement">Bank statement CSV / XLSX</option></select>')}${field('Files (up to 4; 8 MiB each by default)',input('files','type="file" accept=".xlsx,.csv" multiple required'))}<p class="helper">Uploads are staged for review. Bank statements become reconciliation evidence, not ledger transactions.</p><button type="submit" class="primary-button">Upload and review</button></form><div class="sample-download"><a class="outline-button" href="/samples/bank-statement.csv" download="bank-statement-sample.csv">Download sample bank statement CSV</a><p class="helper">Replace the example rows with your own statement movements before uploading. Choose Bank statement CSV / XLSX as the source.</p></div>`)+cleanupPanel+panel('Import history',table(['Uploaded','State','Files'],history.data.map(b=>[h(b.created_at.slice(0,10)),h(b.state),b.files.map(f=>button(f.filename,'open-import',`data-batch="${h(b.id)}" data-file="${h(f.id)}"`)).join(' ')])));
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
  if(file.state!=='committed') html+=panel('Commit selected file',`<form id="commit-form"><label class="confirm-line"><input type="checkbox" required> I reviewed the mappings, amounts, and overlap indicators. Commit ready rows from this file.</label><p class="helper">${file.source_kind==='bank_statement'?'Bank rows become evidence only.':'Expenses and income create personal ledger entries; uniquely paired transfers count once.'} Exact repeat rows attach their source references to existing transactions. Changed or ambiguous rows stay in review, and existing edits are preserved. Coverage remains unconfirmed.</p><button type="submit" class="primary-button" ${preview.meta.row_count===preview.meta.unresolved_count?'disabled':''}>Commit ready rows</button></form>`);
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
    content=table(['Source account','Destination account','Type when creating'],keys.accounts.map((a,i)=>{
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
    mapping.account_aliases={...(mapping.account_aliases || {})}; mapping.category_mappings=[];
    // Reuse names after a partial failure; each successful create is immediately remembered.
    for(const [i,a] of keys.accounts.entries()) {
      let key=data.get(`account-${i}`);
      if(key==='new') {
        const existing=state.accounts.find(v=>v.name===a.name && v.currency===a.currency && v.active!==false);
        if(existing) key=existing.id;
        else { const created=await api.request('accounts',{method:'POST',body:{name:a.name,subtype:data.get(`subtype-${i}`),currency:a.currency,visibility:'private'}}); state.accounts.push(created); key=created.id; }
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
  'transaction-balance':transactionBalanceEditor,
  'transaction-balance-after':el=>{
    const row=state.ledgerBalances.get(el.dataset.account+':'+el.dataset.id);
    if(!row) throw new Error('Reload this transaction before checking its balance.');
    const after=new Date(Date.parse(row.effective_at)+60000);
    balanceEditor(el.dataset.account,localDateTime(after.toISOString()));
  },
  'reopen-money-manager':async el=>{await api.request(`money-manager/changes/${id(el.dataset.id)}/sync`,{method:'POST',revision:Number(el.dataset.revision),body:{synced:false}});notify('Returned to the update list.');await renderRoute();},
  'sync-money-manager':async el=>{await api.request(`money-manager/changes/${id(el.dataset.id)}/sync`,{method:'POST',revision:Number(el.dataset.revision),body:{synced:true}});notify('Marked updated in Money Manager.');await renderRoute();},
  refresh:()=>renderRoute(), 'select-month':el=>{setMonth(el.dataset.month);renderRoute();}, 'transaction-period':()=>navigate('transactions',location.hash.slice(1)==='transactions/all'?[]:['all']), 'clear-transaction-filters':()=>{state.transactionFilters={account:'',accountType:'',eventType:''};saveView();renderRoute();}, 'copy-invite-link':async()=>{await navigator.clipboard.writeText(state.inviteLink);notify('Invitation link copied.');}, logout:async()=>{await api.request('auth/logout',{method:'POST',body:{}});resetSession();},
  'reset-add-month':async()=>{const month=document.querySelector('#reset-month').value;if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw new Error('Choose a valid month.');if(state.resetMonths.length>=24)throw new Error('Select at most 24 months.');state.resetMonths=[...new Set([...state.resetMonths,month])].sort();state.resetPreview=null;await renderRoute();},
  'reset-remove-month':async el=>{state.resetMonths=state.resetMonths.filter(month=>month!==el.dataset.month);state.resetPreview=null;await renderRoute();},
  'close-editor':()=>dialog.close(), 'use-budget-average':el=>{const control=dialog.querySelector(`[name="category-${CSS.escape(el.dataset.averageFor)}"]`);if(control){control.value=el.dataset.value;control.focus();}}, 'apply-budget-averages':()=>{dialog.querySelectorAll('[data-average-for]').forEach(chip=>{const control=dialog.querySelector(`[name="category-${CSS.escape(chip.dataset.averageFor)}"]`);if(control && !control.value)control.value=chip.dataset.value;});}, account:accountEditor, category:()=>categoryEditor(), 'add-subcategory':el=>categoryEditor(null,el.dataset.parent), 'edit-category':el=>categoryEditor(el.dataset.id), transaction:transactionEditor,
  'transaction-detail':el=>transactionDetail(el.dataset.id), 'edit-transaction':el=>transactionEditEditor(el.dataset.id), 'delete-transaction':async el=>{const t=await api.request(`transactions/${id(el.dataset.id)}`);if(!window.confirm(`Delete ${t.description || 'this transaction'} (${t.currency} ${t.amount})? Its prior revisions will be retained.`)) return;await api.request(`transactions/${id(t.id)}`,{method:'DELETE',revision:t.revision,body:{reason:'Deleted by user'}});dialog.close();notify('Transaction deleted.');await renderRoute();}, 'account-ledger':el=>navigate('accounts',[el.dataset.id]), 'edit-account':el=>editAccountEditor(el.dataset.id), balance:el=>balanceEditor(el.dataset.id), 'opening-balance':el=>openingBalanceEditor(el.dataset.id), 'edit-balance-check':el=>balanceCheckEditor(el.dataset.account,el.dataset.id), 'remove-balance-check':async el=>{const check=state.selectedChecks?.find(c=>c.id===el.dataset.id);if(!check || !window.confirm(`Remove the balance check from ${check.as_of}? Its audit history will be retained.`)) return;await api.request(`accounts/${id(el.dataset.account)}/balance-checks/${id(check.id)}`,{method:'DELETE',revision:check.revision});notify('Balance check removed.');await renderRoute();}, budget:()=>budgetEditor(), 'edit-budget':el=>budgetEditor(el.dataset.id),
  'activate-budget':async el=>{await api.request(`budgets/${id(el.dataset.id)}/activate`,{method:'POST',revision:el.dataset.revision,body:{}});await renderRoute();},
  'copy-budget':async el=>{const next=new Date(Date.UTC(Number(state.month.slice(0,4)),Number(state.month.slice(5,7)),1)).toISOString().slice(0,7);await api.request(`budgets/${id(el.dataset.id)}/copy`,{method:'POST',revision:el.dataset.revision,body:{month:next}});setMonth(next);navigate('budgets');notify(`Budget copied to ${next} as a draft.`);},
  'open-import':el=>navigate('imports',[el.dataset.batch,el.dataset.file]),
  'retry-file':async()=>{await api.request(`imports/${id(state.batch)}/files/${id(state.file)}/retry`,{method:'POST',revision:state.fileInfo.revision,body:{}});await renderRoute();},
  'open-session':el=>navigate('reconcile',[el.dataset.id]),
  'review-balance':el=>navigate('reconcile',['balance',el.dataset.account,el.dataset.check]),
  'add-reconcile-transaction':el=>{transactionEditor();const select=dialog.querySelector('[name="account_id"]');if(select)select.value=el.dataset.account;},
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
  const nav=event.target.closest('[data-view]'); if(nav) { navigate(nav.dataset.view); return; }
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
  try { await action(el); } catch(e) { if(state.me) failure(e,dialog.open?dialog:root); } finally { el.disabled=false; }
});
document.addEventListener('change',async event=>{
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
  if(event.target.id==='report-scope') { state.scope=event.target.value; saveView(); renderRoute(); }
  if(event.target.id==='compare-month' && /^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value)) { const chosen=event.target.value;state.compareMonth=chosen===state.month?new Date(Date.UTC(Number(chosen.slice(0,4)),Number(chosen.slice(5,7))-2,1)).toISOString().slice(0,7):chosen;if(chosen===state.month)notify(`Comparison moved to ${state.compareMonth} so the periods differ.`);const url=new URL(location.href);url.searchParams.set('compare',state.compareMonth);history.replaceState(null,'',url.pathname+url.search+url.hash);renderRoute(); }
  if(event.target.id==='event-type') updateCategories();
  if(event.target.id==='account-subtype') document.querySelector('#card-due-fields').hidden=event.target.value!=='credit_card';
  if(event.target.id==='category-kind') document.querySelector('#category-parent').innerHTML=option('','Top level',true)+categoryOptions(event.target.value);
  if(event.target.id==='statement-account') navigate('statements',[event.target.value]);
  const transactionFilter={ 'transaction-filter-account':'account', 'transaction-filter-account-type':'accountType', 'transaction-filter-event-type':'eventType' }[event.target.id];
  if(transactionFilter) { state.transactionFilters[transactionFilter]=event.target.value; saveView(); renderRoute(); }
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
document.addEventListener('submit',async event=>{
  const form=event.target; if(!(form instanceof HTMLFormElement)) return;
  event.preventDefault(); if(form.dataset.busy) return;
  form.dataset.busy='true'; const submit=form.querySelector('[type="submit"]'); if(submit) submit.disabled=true;
  const data=Object.fromEntries(new FormData(form));
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
      const body=new FormData(); body.append('manifest',JSON.stringify({files:files.map(()=>({source_kind:data.source_kind}))})); files.forEach(file=>body.append('files[]',file));
      const upload=await api.request('imports',{method:'POST',body}); state.importResult=null; navigate('imports',[upload.id,upload.files[0].id]); return;
    }
    if(form.id==='mapping-form') { await saveMapping(form); return; }
    if(form.id==='commit-form') {
      const batch=state.batch, file=state.file;
      const value=await api.request(`imports/${id(batch)}/commit`,{method:'POST',revision:state.batchInfo.revision,body:{files:[file]}});
      state.importResult={batch,file,value};
      const first=state.preview.find(r=>r.effective_date)?.effective_date; if(first) setMonth(first.slice(0,7));
      notify('Commit completed. Review the outcome counts below.'); await renderRoute(); return;
    }
    if(form.id==='account-form') {
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
      const body={name:data.name,kind:data.kind,parent_id:data.parent_id || null};
      if(data.category_id) await api.request(`categories/${id(data.category_id)}`,{method:'PATCH',revision:data.revision,body});
      else await api.request('categories',{method:'POST',body});
    }
    else if(form.id==='transaction-form') {
      const account=state.accounts.find(a=>a.id===data.account_id); const transfer=data.event_type==='transfer';
      const movements=[{account_id:data.account_id,amount:['expense','transfer'].includes(data.event_type)?`-${data.amount}`:data.amount}];
      if(transfer) movements.push({account_id:data.destination,amount:data.amount});
      const body={event_type:data.event_type,amount:data.amount,currency:account.currency,effective_date:data.effective_date,description:data.description,movements,allocations:transfer?[]:[{category_id:data.category_id || null,amount:data.amount,scope:data.scope}]};
      await api.request('transactions',{method:'POST',body});
    } else if(form.id==='transaction-full-edit-form') {
      const transfer=data.event_type==='transfer';
      const signed=transfer || data.event_type==='expense'?`-${data.amount}`:data.amount;
      const movements=[{account_id:data.source_account,amount:signed}];
      if(transfer) movements.push({account_id:data.destination_account,amount:data.amount});
      const original=state.editingTransaction;
      if(!original || original.id!==data.transaction_id || original.revision!==Number(data.revision)) throw new Error('Reload the transaction before editing.');
      const allocations=transfer?[]:original.allocations.map((allocation,i)=>({...allocation,category_id:data[`category-${i}`]||null,amount:data[`allocation-${i}`],scope:data[`scope-${i}`]}));
      const body={description:data.description,effective_date:data.effective_date,amount:data.amount,movements,allocations};
      if(data.effective_date!==data.original_date) body.effective_at=null;
      await api.request(`transactions/${id(data.transaction_id)}`,{method:'PATCH',revision:data.revision,body});
      notify('Transaction updated. Balance and reconciliation results have been recalculated.');
    }
    else if(form.id==='balance-form') {
      const value=await api.request(`accounts/${id(data.account_id)}/balance-checks`,{method:'POST',revision:data.revision,body:{amount:data.amount,basis:data.basis,as_of:localTimestamp(data.as_of),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone}});
      notify(`Balance check recorded. Variance: ${value.variance ?? 'unknown (no opening balance)'}.`);
    } else if(form.id==='budget-form'||form.id==='budget-edit-form') {
      const lines=Object.entries(data).filter(([k,v])=>k.startsWith('category-') && v!=='').map(([k,v])=>({category_id:k.slice(9),amount:v}));
      if(form.id==='budget-edit-form') {
        await api.request(`budgets/${id(data.budget_id)}`,{method:'PATCH',revision:data.revision,body:{name:data.name,expected_income:data.expected_income,lines}});
        notify('Budget limits updated. Actual spending has been recalculated.');
      } else await api.request('budgets',{method:'POST',body:{name:data.name,expected_income:data.expected_income,month:state.month,scope:state.scope,currency:state.me.household.base_currency,lines}});
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
window.addEventListener('resize',syncMenuButton);
syncMenuButton();
document.querySelector('#report-scope').value=state.scope;
setMonth(state.month);
start();
