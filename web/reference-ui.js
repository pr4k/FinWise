/* The supplied FinWise layouts, connected to the application's real records.
   This module only renders UI; existing app actions own validation and writes. */
(() => {
  'use strict';
  const titles={overview:'Overview',planner:'Planner',transactions:'Transactions',subscriptions:'Subscriptions',recurring:'Recurring',accounts:'Accounts',budgets:'Budgets',investments:'Investments',household:'Household 360',settlements:'Settle up',categories:'Categories',statements:'Statements',reconcile:'Reconcile',imports:'Imports',settings:'Settings',more:'More',changes:'Money Manager changes'};
  const currencyFormats=new Map(),currencyScales=new Map();
  function moneyFormat(currency,digits){const key=currency+':'+digits;if(!currencyFormats.has(key))currencyFormats.set(key,new Intl.NumberFormat(currency==='INR'?'en-IN':'en',{style:'currency',currency,maximumFractionDigits:digits}));return currencyFormats.get(key);}
  const money=(value,currency=state.overviewCurrency||state.me.household.base_currency)=>value==null?'Unknown':moneyFormat(currency,2).format(Number(value));
  const wholeMoney=(value,currency=state.overviewCurrency||state.me.household.base_currency)=>value==null?'Unknown':moneyFormat(currency,0).format(Number(value));
  const month=(value=state.month)=>new Date(value+'-01T12:00:00Z').toLocaleDateString('en',{month:'long',year:'numeric',timeZone:'UTC'});
  const add=(values,currency=state.overviewCurrency||state.me.household.base_currency)=>{if(!currencyScales.has(currency))currencyScales.set(currency,new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits);return analyticsView.sumMoney(values,currencyScales.get(currency));};
  const difference=(a,b)=>analyticsView.difference(a,b);
  const control=(label,action,extra='',primary=false)=>`<button type="button" class="button${primary?' primary':''}" data-action="${action}" ${extra}>${label}</button>`;
  const go=(label,view,extra='')=>`<button type="button" class="button" data-view="${view}" ${extra}>${label}</button>`;
  const head=(title,subtitle='',action='')=>`<div class="section-label"><div><h2>${h(title)}</h2>${subtitle?`<p>${h(subtitle)}</p>`:''}</div>${action}</div>`;
  const intro=(eyebrow,title,subtitle,actions='')=>`<div class="cm-head"><div><div class="eyebrow">${h(eyebrow)}</div><h2>${h(title)}</h2><p>${h(subtitle)}</p></div><div class="cm-actions">${actions}</div></div>`;
  const emptyPanel=(title,copy,actions='')=>`<section class="panel empty standalone"><h3>${h(title)}</h3><p>${h(copy)}</p>${actions}</section>`;
  const template=html=>{const t=document.createElement('template');t.innerHTML=html;return t.content;};
  const serialize=node=>node?.outerHTML||'';
  const body=node=>{if(node?.nodeType===11){const container=document.createElement('div');container.append(node.cloneNode(true));return container.innerHTML;}return node?.innerHTML||'';};
  const firstHeading=fragment=>fragment.querySelector('.page-heading');
  const removeHeading=fragment=>{const heading=firstHeading(fragment);const actions=body(heading?.querySelector('.heading-actions'));heading?.remove();return actions;};
  const panelFrom=node=>{
    if(!node)return '';
    node.classList.remove('dashboard-panel');
    node.querySelector('.dashboard-panel-head')?.classList.replace('dashboard-panel-head','section-label');
    return serialize(node);
  };
  function recordRow(t,value=t.amount) {
    const account=t.movements?.map(m=>accountName(m.account_id)).join(' → ')||'';
    return `<button type="button" class="contributor" data-action="transaction-detail" data-id="${h(t.id)}"><span class="merchant">${h((t.description||'•').slice(0,1))}</span><span><b>${h(t.description||'Untitled')}</b><small>${h(t.effective_date)} · ${h(account)}</small></span><span class="amount"><b>${money(value,t.currency)}</b><small><span class="tag">${h(transactionKindLabel(t))}</span></small></span></button>`;
  }
  function accountCards(accounts,limit=Infinity) {
    return accounts.slice(0,limit).map(a=>{
      const card=a.subtype==='credit_card',known=a.balance?.amount!=null,reserved=a.funds?.reserved||'0';
      return `<article class="panel cm-account ${card?'cm-credit':''}"><div class="cm-account-top"><span class="bank-icon">${h(a.name.slice(0,2).toUpperCase())}</span><span class="tag ${card?'amber':''}">${card?'Credit card':h(a.subtype.replaceAll('_',' '))}</span></div><h3>${h(a.name)}</h3><small>${card?'Outstanding owed':'Recorded bank balance'} · ${h(a.currency)} · ${h(a.visibility)}</small><strong>${money(a.balance?.amount,a.currency)}</strong>${card?`<p>Recorded statement due ${a.card_due?money(a.card_due.amount,a.currency)+' · '+h(a.card_due.due_date):'Not available'}</p>`:`<div class="cm-account-breakdown"><span>Reserved<b>${money(reserved,a.currency)}</b></span><span>Available<b>${money(accountAvailable(a),a.currency)}</b></span></div>`}<p>${known?'Evidence / position: '+h(a.balance.as_of?.slice(0,10)||'Recorded balance'):'No starting balance / check recorded'}</p><div class="cm-actions">${`<button type="button" class="button primary" data-reference-account="${h(a.id)}">Open account ↗</button>`}${card&&canManageFinance(a)?control('Record payment','card-payment',`data-id="${h(a.id)}"`):''}</div></article>`;
    }).join('');
  }
  function accountsPage(fragment,parts) {
    if(parts[0]){fragment.querySelector('.account-detail-hero h1')?.remove();return fragment;}
    const currency=state.overviewCurrency||state.me.household.base_currency;
    const accounts=state.accounts.filter(a=>a.active!==false&&!a.archived&&a.currency===currency);
    return template(intro('YOUR MONEY, ACCOUNT BY ACCOUNT','Open an account. See the whole story.','Bank funds, card liabilities and dated balance evidence stay distinct.',control('＋ Add account','account','',true))+`<div class="cm-card-grid">${accountCards(accounts)||emptyPanel('No accounts recorded in this currency','Add an account to start tracking its balance.',control('Add account','account','',true))}</div>`);
  }
  function cashGroups(transactions,accounts) {
    const bankIds=new Set(accounts.filter(a=>['bank','cash','investment_cash'].includes(a.subtype)).map(a=>a.id));
    const cardIds=new Set(accounts.filter(a=>a.subtype==='credit_card').map(a=>a.id));
    const groups={income:[],otherReceipts:[],purchases:[],cardPayments:[],investments:[],behalf:[],poolIn:[],poolOut:[]};
    const mapped=[];
    for(const t of transactions.filter(t=>!t.voided)) {
      const bank=(t.movements||[]).filter(m=>bankIds.has(m.account_id));
      const positive=add(bank.filter(m=>Number(m.amount)>0).map(m=>m.amount),t.currency);
      const negative=add(bank.filter(m=>Number(m.amount)<0).map(m=>analyticsView.negate(m.amount)),t.currency);
      if(!bank.length)continue;
      const net=difference(positive,negative);
      let group;
      if(t.event_type==='transfer') {
        if(Number(net)===0)continue;
        group=(t.movements||[]).some(m=>cardIds.has(m.account_id)&&Number(m.amount)>0)?'cardPayments':Number(net)>0?'poolIn':'poolOut';
      } else group=Number(net)>0?(t.event_type==='income'&&!(t.allocations||[]).some(a=>a.transaction_type==='reimbursement')?'income':'otherReceipts'):(t.event_type==='investment'||((t.allocations||[]).length&&(t.allocations||[]).every(a=>state.categories.find(c=>c.id===a.category_id)?.tracking_type==='investment')))?'investments':(t.allocations||[]).some(a=>a.transaction_type==='paid_on_behalf')?'behalf':'purchases';
      const item={transaction:t,amount:Number(net)>0?net:analyticsView.negate(net),net};
      groups[group].push(item);mapped.push(item);
    }
    const totals=Object.fromEntries(Object.entries(groups).map(([key,rows])=>[key,add(rows.map(r=>r.amount))]));
    const inflow=add(mapped.filter(r=>Number(r.net)>0).map(r=>r.net));
    const outflow=add(mapped.filter(r=>Number(r.net)<0).map(r=>analyticsView.negate(r.net)));
    return {groups,totals,mapped,inflow,outflow,net:difference(inflow,outflow)};
  }
  function cashButton(label,value,key,note) {
    return `<button type="button" class="dc-breakdown-row" data-reference-cash="${key}"><span><b>${h(label)}</b>${note?`<small>${h(note)}</small>`:''}</span><strong class="num">${money(value)}<i>↗</i></strong></button>`;
  }
  function overviewPage(fragment) {
    const data=state.referenceDashboard;
    if(!data)return fragment;
    const {summary,transactions,currency,nextMonth,previous}=data;
    const accounts=state.accounts.filter(a=>a.active!==false&&!a.archived&&a.currency===currency);
    const cash=cashGroups(transactions.filter(t=>t.currency===currency),accounts);
    const earned=summary.earned_income??summary.income,spent=summary.actual_spending??summary.net_spending,invested=summary.net_invested||'0',surplus=summary.economic_surplus??summary.recorded_surplus;
    const after=summary.after_investment_cash_flow??difference(surplus,invested);
    const bills=accounts.filter(a=>a.subtype==='credit_card'&&a.card_due?.amount!=null&&a.card_due?.due_date?.startsWith(nextMonth));
    state.referenceCash={...cash,currency,bills};
    const equation=`<section class="dc-equation-panel"><div class="dc-section-label"><h3>Your month, in one equation</h3><p>${h(month())} · ${h(currency)} · Purchases recorded this month</p></div><div class="dc-equation">${[['earned_income','Income',earned],['actual_spending','Expenses',spent],['net_invested','Net investments',invested],['after_investment_cash_flow','Surplus after investments',after]].map(([key,label,value],i)=>`${i?`<span class="dc-operator" aria-hidden="true">${i===3?'=':'−'}</span>`:''}<button type="button" ${i===3?'data-reference-equation="true"':'data-action="metric-detail" data-metric="'+key+'"'} class="${i===3?'dc-equation-result':''}"><strong class="num" title="${h(money(value))}">${wholeMoney(value)}</strong><span>${label} ↗</span></button>`).join('')}</div><p class="dc-equation-help">Income − expenses − net investments = surplus after investments. Expenses include bank and card purchases, less refunds. Card bill payments are excluded here. This surplus is an allocation measure; actual bank cash flow appears below.</p>${bills.length?`<button type="button" class="dc-next-card" data-reference-cash="bills"><span><b>Credit card payments due next month</b><small>${h(month(nextMonth))} · ${bills.length} recorded bills · click for card-wise split</small></span><strong class="num">${money(add(bills.map(a=>a.card_due.amount)))} ↗</strong></button><p class="dc-equation-help">Recorded statement dues, separate from total card debt and this month’s spending.</p>`:''}</section>`;
    const cards=accounts.filter(a=>a.subtype==='credit_card');
    const knownCards=cards.filter(a=>a.balance?.amount!=null),knownDues=cards.filter(a=>a.card_due?.amount!=null);
    const cardPanel=`<section class="panel dashboard-credit-cards" aria-label="Credit cards"><div class="section-label"><div><h2>Credit cards</h2><p>Payments recorded in ${h(month())} · Balances and statement dues stay separate</p></div>${go('All cards ↗','accounts')}</div><div class="credit-card-summary"><button type="button" data-reference-cash="cardPayments" data-live-key="metric-card-payments"><span>Paid this month</span><strong class="metric-number">${money(data.cardPayments??cash.totals.cardPayments)}</strong><small>${data.cardPaymentTransactions?.length??cash.groups.cardPayments.length} payments recorded · not new spending</small></button><div><span>Recorded amount owed</span><strong>${knownCards.length?money(add(knownCards.map(a=>a.balance.amount))):'Unknown'}</strong><small>${knownCards.length} of ${cards.length} card balances known</small></div><div><span>Recorded statement dues</span><strong>${knownDues.length?money(add(knownDues.map(a=>a.card_due.amount))):'Not recorded'}</strong><small>${knownDues.length} of ${cards.length} cards with a statement amount · dates below</small></div></div><div class="credit-card-rows">${cards.map(a=>`<button type="button" class="credit-card-row" data-reference-account="${h(a.id)}"><span><b>${h(a.name)}</b><small>${a.card_due?.amount!=null?'Statement '+money(a.card_due.amount)+' · '+(a.card_due.due_date?'Due '+h(a.card_due.due_date):'Due date not recorded'):'Statement amount not recorded'}</small></span><span><b>${money(a.balance?.amount)}</b><small>Recorded amount owed ↗</small></span></button>`).join('')||'<p class="helper">No credit card accounts in this currency.</p>'}</div></section>`;
    const hero=`<section class="dc-hero"><div class="dc-hero-main"><div class="eyebrow">WHAT ACTUALLY MOVED THROUGH YOUR BANK</div><div class="dc-hero-title"><h2>Net bank cash flow</h2><span class="dc-period">${h(month())} · ${h(currency)}</span></div><button type="button" class="dc-net ${Number(cash.net)<0?'dc-negative':''}" data-reference-cash="net"><strong class="num">${money(cash.net)}</strong><span>${Number(cash.net)>0?'More cash received than paid out':Number(cash.net)<0?'More cash paid out than received':'Recorded cash in equals cash out'} ↗</span></button><p>Card bills paid this month count here. New card purchases count when paid.<br>This is a change from recorded activity, separate from your account balance.</p><div class="dc-comparison">Recorded bank and cash movements · selected scope and currency</div></div><div class="dc-hero-side"><button type="button" data-reference-cash="inflow"><small>Cash received</small><strong class="num">${money(cash.inflow)}</strong><span>Income + refunds, reimbursements & other bank receipts ↗</span></button><div class="dc-minus">minus</div><button type="button" data-reference-cash="outflow"><small>Cash paid</small><strong class="num">${money(cash.outflow)}</strong><span>Bank purchases + card repayments + investments & other outflows ↗</span></button></div></section>`;
    const kpis=`<div class="dc-section-label"><h3>Spending & earning, by purchase month</h3><p>Card purchases are included here when incurred. Repayments are excluded from spending.</p></div><section class="kpis dc-kpis" aria-label="Monthly financial summary">${[['earned_income','Earned income',earned,'Ordinary income · separate from other cash receipts'],['actual_spending','Monthly spending',spent,'Bank and card consumption, less refunds'],['net_invested','Net invested',invested,'Contributions less withdrawals · bank and card funding'],['economic_surplus','Spending surplus',surplus,'Earned income − consumption · before investments']].map(([key,label,value,note])=>`<button type="button" class="kpi" data-action="metric-detail" data-metric="${key}" data-live-key="metric-${key}"><div class="label">${label}<span class="symbol">↗</span></div><div class="value num" title="${h(money(value))}">${wholeMoney(value)}</div><div class="change">${note}<small class="dc-metric-compare">Previous month ${money(previous[key]??previous[{earned_income:'income',actual_spending:'net_spending',economic_surplus:'recorded_surplus'}[key]]??'0')}</small></div></button>`).join('')}</section>`;
    const t=cash.totals;
    const payments=`<div class="dc-payment-grid"><section class="panel">${head('This month’s cash payments','Actual bank / cash outflows · payment dates')}${cashButton('Purchases paid directly',t.purchases,'purchases','Gross bank-paid purchases; cash refunds appear in receipts')}${cashButton('Credit card bills paid',t.cardPayments,'cardPayments','Settles card liability · no additional consumption')}${cashButton('Investment contributions paid',t.investments,'investments','Cash funded this month · separate from spending')}${cashButton('Paid on behalf of others',t.behalf,'behalf','Full bank payment; only your own share is consumption')}${Number(t.poolOut)?cashButton('Transfers leaving this account pool',t.poolOut,'poolOut','Separate from expenses'):''}<button type="button" class="dc-panel-total" data-reference-cash="outflow"><span>Total cash paid</span><strong class="num">${money(cash.outflow)} ↗</strong></button></section><section class="panel">${head('What funded the month?','Actual bank / cash receipts · receipt dates')}${cashButton('Earned income received in bank',t.income,'income','Only receipts into accounts included in this view')}${cashButton('Other cash receipts',t.otherReceipts,'otherReceipts','Refunds, reimbursements and investment withdrawals')}${Number(t.poolIn)?cashButton('Transfers entering this account pool',t.poolIn,'poolIn','Separate from earned income'):''}<button type="button" class="dc-panel-total" data-reference-cash="inflow"><span>Total cash received</span><strong class="num">${money(cash.inflow)} ↗</strong></button><div class="dc-card-note"><b>Card-funded consumption stays in Monthly spending</b><p>Bank cash changes on repayment, according to the actual billing and payment cycle.</p>${go('View card purchases & refunds ↗','transactions')}</div></section></div><div class="dc-balance-note">Bank balances include money carried from earlier months. Internal transfers between accounts in this view cancel out. Balance checks and starting balances never enter cash flow.</div>`;
    const panels=[...fragment.querySelectorAll('.dashboard-panel')];
    const find=text=>panels.find(p=>p.querySelector('h2')?.textContent===text);
    const snapshot=find('Account snapshot');
    const snapshotHtml=`<section class="snapshot">${head('Account snapshot','',go('All accounts ↗','accounts'))}${body(snapshot?.querySelector('.dashboard-snapshot'))?`<div class="balance-grid">${[...snapshot.querySelector('.dashboard-snapshot').children].map(node=>`<div class="balance-cell">${node.innerHTML.replace('<span>','<small>').replace('</span>','</small>')}</div>`).join('')}</div>`:''}<div class="account-rows">${accounts.slice(0,4).map(a=>`<button type="button" class="account-row" data-action="account-ledger" data-id="${h(a.id)}"><span class="bank-icon">${h(a.name.slice(0,2).toUpperCase())}</span><span><b>${h(a.name)}</b><small>${a.subtype==='credit_card'?(a.card_due?'Due '+money(a.card_due.amount,a.currency)+' · '+h(a.card_due.due_date):'Statement due unknown'):a.balance?.amount!=null?'Checked '+h(a.balance.as_of?.slice(0,10)||''):'Unknown · add a balance anchor'}</small></span><span class="money">${money(a.balance?.amount,a.currency)}</span><span class="chevron">›</span></button>`).join('')}</div></section>`;
    const pair=(a,b)=>`<div class="grid-two">${panelFrom(find(a))}${panelFrom(find(b))}</div>`;
    const closer=find('A closer look');
    if(closer){closer.innerHTML=head('A closer look','The transactions with the biggest impact')+`<div class="tabs"><button type="button" class="active" data-reference-top="contributors">Top contributors</button><button type="button" data-reference-top="review">To review</button></div><div id="reference-top-records">${transactions.filter(t=>!t.voided).sort((a,b)=>Number(b.amount)-Number(a.amount)).slice(0,5).map(t=>recordRow(t)).join('')||'<p class="note">No recorded transactions this month.</p>'}</div>`+go('See all transactions ↗','transactions');}
    const investmentPanel=find('Growing your tomorrow');
    if(investmentPanel){const holdings=(data.holdings||[]).filter(v=>v.currency===currency&&v.type!=='emergency_fund'&&!v.archived);investmentPanel.innerHTML=head('Investment holdings','Linked contributions, principal and dated values',go('Investment workspace ↗','investments'))+holdingCards(holdings,currency);if(!holdings.length)investmentPanel.innerHTML+='<p class="note">No holdings recorded yet.</p>';}
    const subscriptionPanel=find('Small charges. Clear picture.');if(subscriptionPanel){subscriptionPanel.querySelector('h2').textContent='Subscriptions';subscriptionPanel.querySelector('.dashboard-panel-head p').textContent='Connected to recorded transactions';}
    const bottom=['Budget pulse','On the horizon','Worth a moment'].map(name=>panelFrom(find(name)));
    if(!bottom[0])bottom[0]=`<section class="panel">${head('Budget','Choose categories and set limits',go('Create budget ↗','budgets'))}<p class="note">Start from recent spending averages or set your own category limits.</p>${go('＋ Create a budget for '+month(),'budgets')}</section>`;
    const reports=fragment.querySelector('#dashboard-reports');
    return template(`<div class="dashboard-page reference-overview">${equation}${cardPanel}${hero}${kpis}${payments}${snapshotHtml}${pair('How your month is shaping up','Other money movements')}${pair('Where your money went','A closer look')}<div class="sub-grid">${panelFrom(investmentPanel)}${panelFrom(subscriptionPanel)}</div><div class="bottom-grid">${bottom.join('')}</div>${reports?`<details class="reference-reports" ${location.hash.includes('/reports')?'open':''}><summary>Detailed reports & comparisons</summary>${serialize(reports)}</details>`:''}</div>`);
  }
  document.addEventListener('toggle',async event=>{
    const details=event.target;
    if(details.matches?.('details[data-reference-transaction]')&&details.open){hydrateTransactionDetail(details);return;}
    if(!details.matches?.('details.reference-reports')||!details.open)return;
    const placeholder=details.querySelector('[data-reports-lazy]');
    if(!placeholder||placeholder.dataset.loading==='true')return;
    const generation=state.generation;placeholder.dataset.loading='true';placeholder.setAttribute('aria-busy','true');placeholder.innerHTML='<p role="status">Loading detailed reports…</p>';
    try {
      const html=await views.dashboardReports();
      if(!details.isConnected||generation!==state.generation||state.view!=='overview')return;
      placeholder.replaceWith(template(html));analyticsView.hydrateCharts(details);subscriptionBrands.hydrate(details);
    } catch(error){if(placeholder.isConnected){placeholder.innerHTML='<p class="helper">Detailed reports could not load. Close and reopen this section to retry.</p>';failure(error,placeholder);}}
    finally {placeholder.removeAttribute('aria-busy');delete placeholder.dataset.loading;}
  },true);
  function transactionsPage(fragment) {
    const workspace=fragment.querySelector('.ledger-workspace');
    if(!workspace)return fragment;
    const filters=workspace.querySelector('.ledger-filter-disclosure');
    if(filters)filters.open=true;
    workspace.className='panel standalone reference-ledger';
    workspace.querySelector('.ledger-heading')?.remove();
    workspace.querySelector('.ledger-mobile-toolbar')?.remove();
    workspace.querySelector('.ledger-caption')?.remove();
    workspace.insertAdjacentHTML('afterbegin',`<div class="tx-workspace-head"><div><h2>Every record has a meaning.</h2><p>Click a row to expand. Amount and type come first.</p></div><div class="cm-actions">${control('◉ Add balance check','transaction-balance')}${control('Pay card','card-payment')}</div></div><div class="tx-record-key"><span><i></i>Money movement</span><span><i class="key-check"></i>Balance check</span><span><i class="key-known"></i>Known balance</span><em>Balance rows never count toward income or expenses.</em></div>`);
    const filterBox=workspace.querySelector('.ledger-filters');
    if(filterBox){
      const visible=['search','eventType','account','person','category','from','to'];
      const primary=document.createElement('div');primary.className='filters tx-filters reference-primary-filters';
      for(const key of visible){const input=filterBox.querySelector('#transaction-filter-'+key);const field=input?.closest('.field');if(field){input.setAttribute('aria-label',field.textContent.trim());field.querySelector(':scope>span')?.remove();primary.append(field);}}
      const sorts=workspace.querySelector('.classification-sort');
      const secondary=sorts?.querySelector('.field');
      const select=document.createElement('label');select.className='field';select.innerHTML=`<select id="transaction-filter-sort" aria-label="Primary sort">${[['-effective_date','Date · newest first'],['effective_date','Date · oldest first'],['-amount','Amount · largest first'],['amount','Amount · smallest first'],['merchant','Description · A–Z'],['account','Account · A–Z']].map(([value,label])=>`<option value="${value}" ${value===(state.transactionFilters.sort||'-effective_date')?'selected':''}>${label}</option>`).join('')}</select>`;primary.append(select);if(secondary)primary.append(secondary);sorts?.remove();
      filterBox.before(primary);
      const advanced=document.createElement('details');advanced.className='reference-advanced-filters';advanced.innerHTML='<summary>More filters & actions</summary>';filterBox.before(advanced);advanced.append(filterBox);
    }
    const periodButton=fragment.querySelector('[data-action="transaction-period"]');
    if(periodButton)workspace.querySelector('.tx-workspace-head .cm-actions').append(periodButton);
    return template('<div class="transaction-page">'+serialize(workspace)+serialize(fragment.querySelector('#bulk-scope-panel'))+'</div>');
  }
  function holdingCards(holdings,currency) {
    return holdings.map(holding=>{
      const snap=investmentSnapshot(holding,state.month),valued=snap.valued;
      const principal=valued?.net_contributions;
      const asOf=state.month<householdDate().slice(0,7)?state.month+'-31':householdDate();
      const attributed=value=>state.scope==='personal'?investmentWeighted(value,currency,investmentOwnerPercent(holding,asOf,state.me.user.id)):value;
      return `<article class="panel cm-holding"><div class="eyebrow">${h((holding.asset_class||holding.type).replaceAll('_',' '))}</div><h3>${h(holding.name)}</h3><small>Last observed value · ${h(valued?.valuation_date||valued?.month||'not recorded')}</small><strong>${valued?money(attributed(valued.value),currency):'Unknown'}</strong><div class="cm-account-breakdown"><span>Principal<b>${principal!=null?money(attributed(principal),currency):'Baseline needed'}</b></span><span>Added · ${h(month())}<b>${money(attributed(snap.current?.contribution||'0'),currency)}</b></span></div><p>${snap.pending?'Valuation needs refresh after funding.':'Linked to ledger contributions.'}</p><div class="cm-actions">${canManageFinance(holding)&&holding.tracking_mode!=='full_history'?control('Record investment','investment-add-money',`data-id="${h(holding.id)}"`,true):''}${control('View holding','investment-detail',`data-id="${h(holding.id)}"`)}${canManageFinance(holding)?control('Baseline / valuation','investment-update-values',`data-id="${h(holding.id)}"`):''}</div></article>`;
    }).join('');
  }
  function investmentsPage(fragment) {
    const data=state.investmentViewData;
    if(!data)return fragment;
    const currency=state.overviewCurrency||state.me.household.base_currency,report=data.report;
    const holdings=data.holdings.filter(v=>v.currency===currency&&v.type!=='emergency_fund'&&(!v.archived||state.month<v.archived_at?.slice(0,7))&&(state.scope==='family'?v.visibility==='shared':state.scope==='personal'?Number(investmentOwnerPercent(v,state.month<householdDate().slice(0,7)?state.month+'-31':householdDate(),state.me.user.id))>0:true));
    const tabs=fragment.querySelector('.investment-tabs');
    const nonOverview=state.investmentTab!=='overview';
    if(nonOverview)return template(intro('FROM PAYMENT TO PORTFOLIO','See where your investments are growing.','Linked contributions, principal and dated values.',go('Category configuration','categories')+control('＋ Create holding','investment','',true))+body(fragment));
    const chart=fragment.querySelector('.investment-overview-grid>section:first-child');
    chart?.querySelector('h2')?.remove();chart?.querySelector(':scope>p.helper')?.remove();
    const metrics=fragment.querySelectorAll('.investment-stat');
    const values=[...metrics].map(node=>node.querySelector('.investment-stat-value')?.innerHTML||'Unknown');
    const gain=values[2]||'Unavailable';
    const cards=holdingCards(holdings,currency);
    const activity=data.taggedTransactions.filter(t=>['investment','investment_withdrawal'].includes(t.event_type)&&t.currency===currency);
    return template(intro('FROM PAYMENT TO PORTFOLIO','See where your investments are growing.','Category-routed payments join the same ledger. Allocate them to holdings or review unlinked investments.',go('Category configuration','categories')+control('Link transaction','investment-link-picker')+control('＋ Create holding','investment','',true))+`<section class="panel cm-growth"><div class="cm-head"><div><h3>Principal & valuation, together.</h3><p>Recorded funding and dated valuations. Missing baselines stay unknown.</p></div>${control('Review holdings ↗','investment-tab','data-tab="holdings"')}</div><div class="cm-summary"><div><small>Recorded net contributions · ${h(month())}</small><strong>${report?.net_invested!=null?money(report.net_invested,currency):values[1]||money('0',currency)}</strong></div><div><small>Last observed value</small><strong>${values[0]||'Incomplete'}</strong></div><div><small>Gain / loss</small><strong>${gain}</strong></div></div><div class="cm-chart-legend"><span>● Recorded net contributions</span><span>● Dated / carried valuation</span></div>${body(chart)||'<p class="note">Add dated valuations to build your portfolio history.</p>'}<p class="note">Valuations carry forward only from dated observations; missing holding values are not treated as zero. No live prices or invented historical valuations.</p></section><div class="cm-card-grid">${cards||emptyPanel('No holdings yet','Create a holding or configure an investment category.',control('Create holding','investment','',true))}</div><section class="panel cm-space"><h3>Recorded investment activity · ${h(month())}</h3>${activity.map(t=>recordRow(t)).join('')||'<p class="note">No activity this month.</p>'}</section><details class="reference-investment-tools"><summary>Holdings, SIPs, goals & review</summary>${serialize(tabs)}${serialize(fragment.querySelector('.investment-calculation-details'))}${serialize(fragment.querySelector('.investment-tagged-details'))}</details>`);
  }
  function subscriptionsPage(fragment) {
    const currency=state.overviewCurrency||state.me.household.base_currency;
    const allServices=(state.referenceRecurring?.data||[]).filter(item=>item.subscription&&!item.ignored);
    const selected=analyticsView.subscriptionMonth(allServices,state.month).rows.filter(item=>item.currency===currency);
    const rows=[...fragment.querySelectorAll('.recurring-card')];
    const cards=selected.map(item=>{
      const index=allServices.findIndex(s=>s.key===item.key),node=rows[index];
      return `<article class="panel cm-service"><span class="cm-icon">${h(item.name.slice(0,1))}</span><h3>${h(item.name)}</h3><p>${h(item.frequency)} · Connected payment records</p><strong>${money(item.monthAmount,currency)}</strong><small>${item.monthCount} payments in ${h(month())} · ${h(item.count)} linked across history</small><div class="cm-actions">${body(node?.querySelector('.recurring-card-actions'))}</div>${serialize(node?.querySelector('.recurring-history'))}</article>`;
    }).join('');
    const categoryPanels=[...fragment.querySelectorAll('.live-panel')].filter(node=>!node.classList.contains('recurring-card')).map(serialize).join('');
    return template(intro('LINKED TO YOUR LEDGER','Subscriptions, without the guesswork.','Label recorded payments or route a category to your subscriptions.',go('Category configuration ↗','categories')+control('＋ Connect subscription','subscription-link','',true))+`<div class="cm-summary"><div><small>Net subscription charges · ${h(month())}</small><strong>${money(add(selected.map(item=>item.monthAmount),currency),currency)}</strong></div><div><small>Linked payment records</small><strong>${selected.reduce((count,item)=>count+item.monthCount,0)}</strong></div><div><small>Services</small><strong>${selected.length}</strong></div></div><div class="cm-card-grid">${cards||emptyPanel('No subscriptions yet','Connect a payment or mark a category as Subscription.',control('Connect subscription','subscription-link','',true))}</div>`+categoryPanels);
  }
  function budgetsPage(fragment) {
    const plans=state.scope==='family'?(state.referenceBudgets||[]):[];
    const introHtml=intro('DECIDE WHAT YOUR MONEY IS FOR','A budget you can actually shape.','Use recent averages, set category limits, and skip categories you do not want to budget.',state.scope==='family'&&['owner','admin'].includes(state.me.membership.role)?control('＋ Create budget','budget','',true):control('Open Family budget','budget-family-view'));
    const active=plans.find(p=>p.state==='active');
    const primary=active?`<section class="panel">${head(active.name||'Active category budget','Consumption spending and category allowances')}${serialize(fragment.querySelector('.budget-summary-grid'))}${serialize(fragment.querySelector('.budget-progress-list'))}</section>`:emptyPanel('No active budget for '+month(),state.scope==='family'?'Create a draft, review it, then activate it. Budgets stay separate by month and currency.':'Shared category budgets are managed in Household / Family view.',state.scope==='family'?control('Build my budget','budget','',true):control('Open Household budget','budget-family-view','',true));
    return template(introHtml+primary+`<section class="panel cm-space"><h3>Saved budgets · ${h(month())}</h3>${plans.map(p=>`<div class="cm-line"><span><b>${h(p.name||p.month)}</b><small>${h(p.state)} · ${h(p.currency)}</small></span>${control('Inspect','edit-budget',`data-id="${h(p.id)}"`)}${p.state==='draft'?control('Activate','activate-budget',`data-id="${h(p.id)}" data-revision="${h(p.revision)}"`,true):''}</div>`).join('')||'<p class="note">No drafts saved yet.</p>'}</section>${plans.length?`<details class="reference-investment-tools"><summary>Budget detail, forecasts & commitments</summary>${body(fragment)}</details>`:''}`);
  }
  function recurringPage(fragment) {
    const tabs=fragment.querySelector('.recurring-tabs'),list=fragment.querySelector('.recurring-list');
    return template(`<section class="panel standalone">${head('Recurring patterns','Repeating activity may be income, transfer, investment or expense',control('Connect payment','subscription-link'))}${serialize(tabs)}${serialize(fragment.querySelector('.quiet-details'))}${body(list)||'<p class="note">No patterns need review.</p>'}</section>`);
  }
  function householdPage(fragment) {
    if(state.scope==='personal')return template(emptyPanel('A shared view of your household','Switch to Household to see authorized Family allocations. Personal account details remain private.',control('Open Household view','analytics-scope','data-scope="family"',true)));
    const grid=fragment.querySelector('.household-grid');
    return template(`<section class="panel">${head('Your household, together','Shared contributions · authorized Family records')}${serialize(grid)}</section>`+serialize(fragment.querySelector('.household-detail'))+serialize(fragment.querySelector('.household-note')));
  }
  function statementsPage(fragment,parts) {
    if(parts[0]||fragment.querySelector('.statement-month-card'))return fragment;
    return template(emptyPanel('No statement files imported','Imported statement files and dated balance evidence appear here. Use Imports to add a bank or card statement.',go('Import statements','imports'))+`<details class="reference-investment-tools"><summary>View recorded account activity</summary>${body(fragment)}</details>`);
  }
  function reconcilePage(fragment,parts) {
    const data=state.referenceReconcile;
    if(parts.length||!data||data.sessions.length||data.differences.length)return fragment;
    return template(emptyPanel('No reconciliation sessions yet','A bank statement and a balance anchor help verify account coverage. Import a statement or start an account review.',go('Import statements','imports'))+`<details class="reference-investment-tools"><summary>Start an account review & inspect balance checks</summary>${body(fragment)}</details>`);
  }
  function settlementsPage(fragment) {
    const cards=[...fragment.querySelectorAll('.settlement-card')];
    const paid=cards.filter(node=>node.querySelector('.finance-eyebrow')?.textContent==='PAID ON BEHALF');
    return template(`<section class="panel standalone">${head('Paid on behalf & reimbursements','Receivables are not consumption spending',control('Paid on Behalf','paid-on-behalf'))}${paid.map(serialize).join('')||'<p class="note">No paid-on-behalf receivables recorded in this view.</p>'}</section><details class="reference-investment-tools" ${cards.length>paid.length?'open':''}><summary>Loans, debts, purchase splits & payment history</summary>${body(fragment)}</details>`);
  }
  function categoriesPage(fragment) {
    const categories=state.categories.filter(c=>c.kind==='expense'&&!c.archived);
    return template(intro('ONE CATEGORY. CONSISTENT BEHAVIOR.','Tell each category where it belongs.','Subscription categories feed Subscriptions. Investment categories feed Investments and holding allocation.',control('＋ Add category','category','',true))+`<section class="panel"><form id="reference-category-routing"><div class="info-strip">Category routing changes how existing allocations appear in reports. Income, transfers, card repayments and reimbursements keep their financial meaning. No new transaction or bank debit is created.</div>${categories.map(c=>`<div class="cm-rule-row"><label for="reference-category-${h(c.id)}"><b>${h(categoryName(c.id))}</b><small>${h(c.visibility==='private'?'Personal':'Household')} category</small></label><select id="reference-category-${h(c.id)}" name="${h(c.id)}" aria-label="${h(c.name)} category behavior">${[['regular','Standard category'],['subscription','Subscription category'],['investment','Investment category']].map(([key,label])=>`<option value="${key}" ${key===(c.tracking_type||'regular')?'selected':''}>${label}</option>`).join('')}</select></div>`).join('')||'<p class="note">No expense categories yet. Add a category to configure its behavior.</p>'}<div class="form-actions"><button class="button primary" type="submit">Save category configuration</button></div></form></section><details class="reference-investment-tools"><summary>Manage category names, income categories & subcategories</summary>${body(fragment)}</details>`);
  }
  let transactionRecords=new Map();
  const transactionDateFormat=new Intl.DateTimeFormat('en',{day:'numeric',month:'short',timeZone:'UTC'});
  function transactionDetail(t) {
    const kind=transactionKindLabel(t),names=t.movements.map(m=>accountName(m.account_id)).join(' → ');
    const accountDetails=t.movements.map(m=>{const row=state.ledgerBalances.get(`${m.account_id}:${t.id}`);return `<div class="tx-effect-row"><span>${h(accountName(m.account_id))}<small>${row?h(balanceLabel(row)):'Balance unknown'}</small></span><b>${money(m.amount,t.currency)}<small>After ${money(row?.balance_after,t.currency)}</small></b></div>`;}).join('');
    const allocations=t.allocations.map(a=>`<div class="tx-effect-row"><span>${h(categoryName(a.category_id))}<small>${h(a.scope)} · ${h(a.transaction_type||t.event_type)}</small></span><b>${money(a.amount,t.currency)}</b></div>`).join('');
    return `<div class="tx-detail-intro"><h3>${h(t.description||'Untitled')}</h3><p>${h(t.effective_date)} · ${h(kind)} · ${h(names)}</p></div><div class="tx-impact-grid"><section><h4>Account movements</h4>${accountDetails}</section><section><h4>Allocations</h4>${allocations||'<p>No spending allocation. This movement stays separate from consumption.</p>'}</section></div><div class="form-actions">${canManageTransaction(t)?control('Edit transaction','edit-transaction',`data-id="${h(t.id)}"`):''}${control('Full details & edit','transaction-detail',`data-id="${h(t.id)}"`,true)}</div>`;
  }
  function hydrateTransactionDetail(details) {
    if(state.view!=='transactions'||!details.isConnected)return;
    const record=transactionRecords.get(details.dataset.referenceTransaction),target=details.querySelector('.tx-details');
    if(record&&target&&!target.children.length)target.innerHTML=transactionDetail(record);
  }
  function transactions(values,balanceEvents=[],accountFilter='') {
    const filtered=values.filter(t=>!t.voided);
    transactionRecords=new Map(filtered.map(t=>[t.id,t]));
    const groups=new Map();
    for(const t of filtered){if(!groups.has(t.currency))groups.set(t.currency,{income:[],spending:[],invested:[]});const totals=groups.get(t.currency);
      for(const allocation of t.allocations||[]){const investment=state.categories.find(c=>c.id===allocation.category_id)?.tracking_type==='investment';const value=allocation.amount;
        if(t.event_type==='income')totals.income.push(value);
        else if(['expense','refund'].includes(t.event_type)){const signed=t.event_type==='refund'?analyticsView.negate(value):value;(investment?totals.invested:totals.spending).push(signed);}
      }
      if(['investment','investment_withdrawal'].includes(t.event_type))totals.invested.push(t.event_type==='investment_withdrawal'?analyticsView.negate(t.amount):t.amount);
    }
    const totals=[...groups].map(([currency,g])=>`<div class="tx-ledger-totals"><div><small>Earned income · ${h(currency)}</small><strong>${responsiveAmount(add(g.income,currency),currency,money(add(g.income,currency),currency))}</strong></div><div><small>Consumption</small><strong>${responsiveAmount(add(g.spending,currency),currency,money(add(g.spending,currency),currency))}</strong></div><div><small>Net invested</small><strong>${responsiveAmount(add(g.invested,currency),currency,money(add(g.invested,currency),currency))}</strong></div><p>Balance observations excluded.<br>Transfers and card payments stay separate.</p></div>`).join('');
    let entries=activityView.timeline(filtered,balanceEvents,state.ledgerBalances,accountFilter);
    const sort=state.transactionFilters.sort||'-effective_date';
    if(sort!=='-effective_date'&&sort!=='effective_date'){
      const order=new Map(filtered.map((t,i)=>[t.id,i]));entries.sort((a,b)=>(order.get(a.transaction?.id)??filtered.length)-(order.get(b.transaction?.id)??filtered.length));
    } else if(sort==='effective_date')entries.reverse();
    const rows=entries.map((entry,i)=>{
      if(entry.kind!=='transaction'){
        const {account,row}=entry,opening=entry.kind==='opening_balance';const value=opening?account.opening_balance?.amount:row.observed_amount;
        return `<details class="tx-record tx-evidence ${opening?'tx-known':'tx-check'}" data-live-key="evidence-${h(account.id)}-${h(row.effective_at)}"><summary class="tx-summary"><span class="tx-date">${h(row.effective_date||row.effective_at?.slice(0,10))}<small>Evidence</small></span><span class="tx-title"><b>${opening?'Known balance':'Balance check'} · ${h(account.name)}</b><small>Dated balance evidence · no money movement</small></span><span class="tx-type-cell"><span class="tx-type-pill">◉ ${opening?'Known balance':'Balance check'}</span><small>No money movement</small></span><span class="tx-amount num">${money(value,account.currency)}<small>Observed balance</small></span><span class="tx-chevron" aria-hidden="true">⌄</span></summary><div class="tx-details"><p>Observed ${h(row.effective_at)}. This anchors the account balance and does not enter income or spending.</p>${control('Open account ledger','account-ledger',`data-id="${h(account.id)}"`)}</div></details>`;
      }
      const t=entry.transaction,kind=transactionKindLabel(t);const names=t.movements.map(m=>accountName(m.account_id)).join(' → ');
      const amountValue=['transfer','investment','investment_withdrawal'].includes(t.event_type)?t.amount:add(t.allocations.map(a=>a.amount),t.currency);
      const sign=['income','refund','investment_withdrawal'].includes(t.event_type)?'+ ':['expense','investment'].includes(t.event_type)?'− ':'';
      const category=[...new Set(t.allocations.map(a=>categoryName(a.category_id)))].join(', ');
      return `<details class="tx-record tx-${h(t.event_type)}" data-live-key="transaction-${h(t.id)}" data-reference-transaction="${h(t.id)}"><summary class="tx-summary" aria-label="Expand ${h(t.description||'Untitled')} · ${h(kind)} · ${h(money(amountValue,t.currency))}"><span class="tx-date">${h(transactionDateFormat.format(new Date(t.effective_date+'T12:00:00Z')))}<small>${h(names)}</small></span><span class="tx-title"><b>${h(t.description||'Untitled')}</b><small>${h(category||kind)} · ${h(payerName(t))}</small></span><span class="tx-type-cell"><span class="tx-type-pill">${h(kind)}</span><small>${['transfer','investment','investment_withdrawal'].includes(t.event_type)?'Not an expense':''}</small></span><span class="tx-amount num">${sign}${money(amountValue,t.currency)}<small>${h(t.currency)}</small></span><span class="tx-chevron" aria-hidden="true">⌄</span></summary><div class="tx-details"></div></details>`;
    }).join('');
    return `<div class="ledger-header"><span>${filtered.length} money movements · ${balanceEvents.length} balance records</span><span>Filters applied before sorting</span></div>${totals}<div class="tx-column-head"><span>DATE / ACCOUNT</span><span>RECORD / DETAILS</span><span>TYPE</span><span>AMOUNT / BALANCE</span><span></span></div><div class="reference-records">${rows||'<p class="note">No records match this context.</p>'}</div>`;
  }
  function page(html,view,parts=[]) {
    let fragment=template(html);
    const oldActions=removeHeading(fragment);
    fragment.querySelectorAll('.analytics-scope-tabs,.analytics-scope-note,.dashboard-toolbar').forEach(node=>node.remove());
    if(view==='overview'&&fragment.querySelector('.dashboard-page'))fragment=overviewPage(fragment);
    else if(view==='accounts')fragment=accountsPage(fragment,parts);
    else if(view==='transactions')fragment=transactionsPage(fragment);
    else if(view==='investments')fragment=investmentsPage(fragment);
    else if(view==='subscriptions')fragment=subscriptionsPage(fragment);
    else if(view==='budgets')fragment=budgetsPage(fragment);
    else if(view==='recurring')fragment=recurringPage(fragment);
    else if(view==='household')fragment=householdPage(fragment);
    else if(view==='categories')fragment=categoriesPage(fragment);
    else if(view==='statements')fragment=statementsPage(fragment,parts);
    else if(view==='settlements')fragment=settlementsPage(fragment);
    else if(view==='reconcile')fragment=reconcilePage(fragment,parts);
    const customActions=['settlements','statements','reconcile','imports','settings','changes'].includes(view)?`<div class="reference-module-tools">${oldActions}</div>`:'';
    const title=parts[0]&&view==='accounts'?state.accounts.find(a=>a.id===parts[0])?.name||titles[view]:titles[view]||labels[view];
    const currencies=[...new Set([state.me.household.base_currency,...state.accounts.map(a=>a.currency)])];
    const displayMonth=view==='planner'?planningMonth():state.month;
    const accountDetail=view==='accounts'&&!!parts[0];
    const subtitle=accountDetail?'Balances, payments and activity for this account.':view==='overview'?'A little clarity. A lot more confidence.':view==='planner'?'A thoughtful plan for the month ahead.':'Follow the details. Understand the bigger picture.';
    const result=document.createElement('div');result.append(fragment);
    return `<div class="reference-page" data-reference-page="${h(view)}"><div class="page-heading"><div><div class="eyebrow">${view==='planner'?'PLAN YOUR INCOME. MAKE ROOM FOR LIFE.':'YOUR MONEY, IN FOCUS'}</div><h1>${h(title)}<span class="heading-dot" aria-hidden="true">.</span></h1><p>${subtitle}</p></div><div class="heading-actions"><div class="heading-month-slot"></div><select id="overview-currency" aria-label="Report currency">${currencies.map(c=>`<option value="${h(c)}" ${c===(state.overviewCurrency||state.me.household.base_currency)?'selected':''}>${h(c)} ${h(new Intl.NumberFormat('en',{style:'currency',currency:c,currencyDisplay:'narrowSymbol'}).formatToParts(0).find(p=>p.type==='currency')?.value||'')}</option>`).join('')}</select>${go('↥ Import','imports')} ${accountDetail?control('＋ Add transaction','transaction-account',`data-account="${h(parts[0])}"`,true):control('＋ Add transaction','transaction','',true)}</div></div><div class="context-bar"><div class="reference-context-slot"></div></div><p class="coverage-note reference-coverage"><span>◉ ${accountDetail?'This account’s accessible activity · Account visibility applies independently of report scope.':state.scope==='family'?'Shared Family records only · Private member accounts are excluded.':state.scope==='combined'?'Your personal and shared Family records · Each movement counted once.':'Your personal records · Transfers, investments and reimbursements are kept separate.'}</span><span>${h(month(displayMonth))} · ${h(state.overviewCurrency||state.me.household.base_currency)}</span></p>${customActions}${result.innerHTML}</div>`;
  }
  function parkControls(){const controls=document.querySelector('.topbar-actions'),month=document.querySelector('.month-filter');if(controls){if(month)controls.append(month);document.querySelector('#context-parking').append(controls);}}
  function mountControls(){root.querySelectorAll('details[data-reference-transaction][open]').forEach(hydrateTransactionDetail);const controls=document.querySelector('.topbar-actions'),slot=root.querySelector('.reference-context-slot');if(controls&&slot)slot.append(controls);const month=controls?.querySelector('.month-filter'),monthSlot=root.querySelector('.heading-month-slot');if(month&&monthSlot)monthSlot.append(month);const picker=document.querySelector('#report-month');if(picker)picker.value=state.view==='planner'?planningMonth():state.month;document.querySelectorAll('.sidebar .nav-item').forEach(node=>node.setAttribute('aria-label',node.textContent.trim()));const avatar=document.querySelector('.header-avatar');if(avatar)avatar.textContent=state.me.user.name.split(' ').map(v=>v[0]).slice(0,2).join('');syncScopeControl();}
  document.addEventListener('click',async event=>{
    const b=event.target.closest('button');if(!b)return;
    if(b.dataset.referenceMonth){const date=new Date((state.view==='planner'?planningMonth():state.month)+'-02T12:00:00Z');date.setUTCMonth(date.getUTCMonth()+Number(b.dataset.referenceMonth));const next=date.toISOString().slice(0,7);if(state.view==='planner'){plannerSelectedMonth=next;sessionStorage.setItem('fw-planner-selected:'+state.me.household.id+':'+state.me.user.id,next);}else setMonth(next);await renderRoute();}
    if(b.dataset.referenceAccount){
      const account=state.accounts.find(a=>a.id===b.dataset.referenceAccount);if(!account)return;
      if(dialog.open)dialog.close();navigate('accounts',[account.id]);return;
    }
    if(b.dataset.referenceEquation){const d=state.referenceDashboard;detailDialog('Surplus after investments',`<p>Earned income − net consumption spending − net investment allocations</p><strong>${money(d.summary.after_investment_cash_flow)}</strong><p>This is an allocation measure. Actual bank cash flow follows payment dates and appears separately.</p>`);return;}
    if(b.dataset.referenceCash){const data=state.referenceCash;if(!data)return;const key=b.dataset.referenceCash;
      if(key==='bills'){detailDialog('Credit card payments due next month',data.bills.length?data.bills.map(a=>`<article class="drawer-card"><h3>${h(a.name)}</h3><p>${h(a.card_due.due_date)}</p><strong>${money(a.card_due.amount,a.currency)}</strong>${control('Open account','account-ledger',`data-id="${h(a.id)}"`)}</article>`).join(''):'<p>No recorded bills for next month. The amount is unknown.</p>');return;}
      const rows=key==='net'?data.mapped:key==='inflow'?data.mapped.filter(r=>Number(r.net)>0):key==='outflow'?data.mapped.filter(r=>Number(r.net)<0):data.groups[key]||[];
      detailDialog(b.querySelector('b')?.textContent||b.querySelector('span')?.textContent||'Recorded cash movements',`<p>Recorded bank and cash movements · ${h(month())}</p>${rows.map(r=>recordRow(r.transaction,r.amount)).join('')||'<p>No recorded movements in this group.</p>'}`);
    }
    if(b.dataset.referenceTop){const review=b.dataset.referenceTop==='review';const rows=state.referenceDashboard?.transactions||[];root.querySelectorAll('[data-reference-top]').forEach(n=>n.classList.toggle('active',n===b));const result=root.querySelector('#reference-top-records');if(result)result.innerHTML=rows.filter(t=>!t.voided&&(!review||!t.reconciliation_state||t.reconciliation_state!=='matched')).sort((a,b)=>Number(b.amount)-Number(a.amount)).slice(0,5).map(t=>recordRow(t)).join('')||'<p class="note">Nothing to review.</p>';}
  });
  document.addEventListener('submit',async event=>{
    const form=event.target;if(form.id!=='reference-category-routing')return;
    event.preventDefault();event.stopImmediatePropagation();const submit=form.querySelector('[type="submit"]');submit.disabled=true;
    try {
      for(const [key,tracking_type] of new FormData(form)){
        const category=state.categories.find(c=>c.id===key);if(!category||category.tracking_type===tracking_type||(!category.tracking_type&&tracking_type==='regular'))continue;
        const updated=await api.request(`categories/${encodeURIComponent(key)}`,{method:'PATCH',revision:category.revision,body:{name:category.name,kind:category.kind,parent_id:category.parent_id||null,visibility:category.visibility,tracking_type}});
        Object.assign(category,updated);
      }
      notify('Category configuration saved. Connected views use the same records.');await renderRoute();
    } catch(error){await catalogs();failure(error,form);}finally{submit.disabled=false;}
  });
  let menuReturnFocus=null;
  function closeMenu(){const shell=document.querySelector('.app-shell');shell.classList.remove('mobile-nav-open');document.querySelector('.mobile-nav-scrim').hidden=true;document.querySelector('.sidebar').inert=matchMedia('(max-width:760px)').matches;document.querySelector('#menu-button').setAttribute('aria-expanded','false');if(menuReturnFocus?.isConnected)menuReturnFocus.focus();}
  function openMenu(){menuReturnFocus=document.activeElement;document.querySelector('.app-shell').classList.add('mobile-nav-open');document.querySelector('.mobile-nav-scrim').hidden=false;document.querySelector('.sidebar').inert=false;document.querySelector('#menu-button').setAttribute('aria-expanded','true');document.querySelector('.sidebar .nav-item.active')?.focus();}
  document.addEventListener('click',event=>{
    if(!matchMedia('(max-width:760px)').matches)return;
    if(event.target.closest('#menu-button,.bottom-nav [data-view="more"]')){event.preventDefault();event.stopImmediatePropagation();document.querySelector('.app-shell').classList.contains('mobile-nav-open')?closeMenu():openMenu();}
    else if(event.target.closest('.mobile-nav-scrim')){event.preventDefault();closeMenu();}
    else if(event.target.closest('.sidebar [data-view],.sidebar [data-action="logout"],.sidebar [data-action="analytics-scope"]'))closeMenu();
  },true);
  document.addEventListener('keydown',event=>{
    if(!document.querySelector('.app-shell.mobile-nav-open'))return;
    if(event.key==='Escape'){event.preventDefault();closeMenu();}
    if(event.key==='Tab'){const items=[...document.querySelectorAll('.sidebar a,.sidebar button,.sidebar summary')].filter(el=>el.getClientRects().length);const first=items[0],last=items.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
  });
  matchMedia('(max-width:760px)').addEventListener('change',()=>{if(document.querySelector('.app-shell.mobile-nav-open'))closeMenu();});
  window.finwiseReference={page,parkControls,mountControls,transactions,reset(){transactionRecords.clear();}};
})();
