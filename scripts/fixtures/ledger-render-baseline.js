// Frozen pre-optimization ledger renderer, used only for the synthetic benchmark.
// Keep the baseline independent from future commits to the application's renderer.
(() => {
  const money=(value,currency=state.overviewCurrency||state.me.household.base_currency)=>value==null?'Unknown':new Intl.NumberFormat(currency==='INR'?'en-IN':'en',{style:'currency',currency,maximumFractionDigits:2}).format(Number(value));
  const add=(values,currency=state.overviewCurrency||state.me.household.base_currency)=>analyticsView.sumMoney(values,new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits);
  const control=(label,action,extra='',primary=false)=>`<button type="button" class="button${primary?' primary':''}" data-action="${action}" ${extra}>${label}</button>`;
  window.finwiseLedgerBaseline=function transactions(values,balanceEvents=[],accountFilter='') {
    const filtered=values.filter(t=>!t.voided);
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
      const accountDetails=t.movements.map(m=>{const row=state.ledgerBalances.get(`${m.account_id}:${t.id}`);return `<div class="tx-effect-row"><span>${h(accountName(m.account_id))}<small>${row?h(balanceLabel(row)):'Balance unknown'}</small></span><b>${money(m.amount,t.currency)}<small>After ${money(row?.balance_after,t.currency)}</small></b></div>`;}).join('');
      const allocations=t.allocations.map(a=>`<div class="tx-effect-row"><span>${h(categoryName(a.category_id))}<small>${h(a.scope)} · ${h(a.transaction_type||t.event_type)}</small></span><b>${money(a.amount,t.currency)}</b></div>`).join('');
      return `<details class="tx-record tx-${h(t.event_type)}" data-live-key="transaction-${h(t.id)}"><summary class="tx-summary" aria-label="Expand ${h(t.description||'Untitled')} · ${h(kind)} · ${h(money(amountValue,t.currency))}"><span class="tx-date">${h(new Date(t.effective_date+'T12:00:00Z').toLocaleDateString('en',{day:'numeric',month:'short',timeZone:'UTC'}))}<small>${h(names)}</small></span><span class="tx-title"><b>${h(t.description||'Untitled')}</b><small>${h(category||kind)} · ${h(payerName(t))}</small></span><span class="tx-type-cell"><span class="tx-type-pill">${h(kind)}</span><small>${['transfer','investment','investment_withdrawal'].includes(t.event_type)?'Not an expense':''}</small></span><span class="tx-amount num">${sign}${money(amountValue,t.currency)}<small>${h(t.currency)}</small></span><span class="tx-chevron" aria-hidden="true">⌄</span></summary><div class="tx-details"><div class="tx-detail-intro"><h3>${h(t.description||'Untitled')}</h3><p>${h(t.effective_date)} · ${h(kind)} · ${h(names)}</p></div><div class="tx-impact-grid"><section><h4>Account movements</h4>${accountDetails}</section><section><h4>Allocations</h4>${allocations||'<p>No spending allocation. This movement stays separate from consumption.</p>'}</section></div><div class="form-actions">${canManageTransaction(t)?control('Edit transaction','edit-transaction',`data-id="${h(t.id)}"`):''}${control('Full details & edit','transaction-detail',`data-id="${h(t.id)}"`,true)}</div></div></details>`;
    }).join('');
    return `<div class="ledger-header"><span>${filtered.length} money movements · ${balanceEvents.length} balance records</span><span>Filters applied before sorting</span></div>${totals}<div class="tx-column-head"><span>DATE / ACCOUNT</span><span>RECORD / DETAILS</span><span>TYPE</span><span>AMOUNT / BALANCE</span><span></span></div><div class="reference-records">${rows||'<p class="note">No records match this context.</p>'}</div>`;
  };
})();
