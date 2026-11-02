// Guided income → commitments → category budget workflow, sharing the reservation engine.
const workflowScale=()=>10**new Intl.NumberFormat('en',{style:'currency',currency:state.currency}).resolvedOptions().maximumFractionDigits;
const workflowRound=value=>Math.round((Number(value)||0)*workflowScale())/workflowScale();
const workflowSum=(items,fn=x=>x.amount)=>items.reduce((n,x)=>n+Math.round((Number(fn(x))||0)*workflowScale()),0)/workflowScale();
const workflowCurrentBefore=currentPlan;
currentPlan=function(){
 const p=workflowCurrentBefore();
 if(!host.workflow||p.status==='closed')return p;
 p.workflowSuggestions=p.workflowSuggestions||[];
 let changed=false;
 for(const suggestion of host.suggestions||[]){
  if(p.workflowSuggestions.includes(suggestion.id))continue;
  const existing=p.items.find(x=>x.subscriptionKey&&x.subscriptionKey===suggestion.subscriptionKey||x.sip&&x.holding===suggestion.holding)||p.items.find(x=>x.title===suggestion.title&&x.kind===suggestion.kind&&x.account===suggestion.account&&x.source.includes('observed'));
  if(existing){Object.assign(existing,{subscriptionKey:suggestion.subscriptionKey,sip:suggestion.sip,holding:suggestion.holding});}
  else p.items.push({...suggestion,person:host.person,matchIds:[]});
  p.workflowSuggestions.push(suggestion.id);changed=true;
 }
 if(changed){p.revision++;p.history.push({revision:p.revision,date:new Date().toLocaleString('en-IN'),reason:'Subscription and SIP suggestions loaded'});if(p.status==='active'){p.status='draft';p.activeLinks=null;}planSave();}
 return p;
};
function workflowTotals(p=currentPlan()){
 const enabled=p.items.filter(x=>x.enabled),income=workflowSum(enabled.filter(x=>x.kind==='income'||x.kind==='funding'));
 const allocations=enabled.filter(x=>x.categoryAllowance),allocated=workflowSum(allocations);
 const commitments=workflowSum(enabled.filter(x=>!x.categoryAllowance&&['expense','investment','card','reserve'].includes(x.kind)));
 const beforeCategories=workflowRound(income-commitments),remainingIncome=workflowRound(beforeCategories-allocated),forecast=reserveForecast(p);
 return {income,commitments,beforeCategories,allocated,remainingIncome,bankCash:forecast.closing.bank,availableCash:forecast.end,partial:p.partial||forecast.unknownFunding,forecast};
}
function workflowRows(items,emptyText){
 const p=currentPlan();return items.map(x=>`<div class="workflow-row"><label class="workflow-choice"><input type="checkbox" data-plan-toggle="${esc(x.id)}" ${x.enabled?'checked':''} ${p.status==='closed'?'disabled':''}><span><b>${esc(x.title)}</b><small>${esc(x.account)} · ${x.day} ${plannerMonth(state.month)}${x.cashIncluded?' · Already included in starting bank funds':''}</small></span></label><strong>${money(x.amount)}</strong><button type="button" class="button" data-plan-edit="${esc(x.id)}">Edit</button></div>`).join('')||`<p class="note">${emptyText}</p>`;
}
function workflowSavedBudget(){const p=currentPlan();return (host.savedBudgets||[]).find(b=>b.id===p.serverBudget?.id)||(host.savedBudgets||[])[0]||p.serverBudget;}
function workflowCategoryLines(p=currentPlan()){
 const totals=new Map();
 for(const item of p.items.filter(x=>x.enabled&&x.kind==='expense')){
  const category=(host.categoryRows||[]).find(c=>c.id===item.categoryId&&c.name===item.category)||(host.categoryRows||[]).find(c=>c.name===item.category);
  if(!category)throw new Error('Choose an active expense category for “'+item.title+'” before creating the budget.');
  totals.set(category.id,workflowRound((totals.get(category.id)||0)+item.amount));
 }
 const digits=new Intl.NumberFormat('en',{style:'currency',currency:state.currency}).resolvedOptions().maximumFractionDigits;
 return [...totals].map(([category_id,amount])=>({category_id,amount:amount.toFixed(digits)}));
}
function plannerWorkflow(){
 const p=currentPlan(),m=workflowTotals(p),disabled=p.status==='closed'?'disabled':'',bills=(p.status==='closed'?billsForPlan(p):scopedBills()).filter(b=>billRemaining(b)>0&&(b.paymentMonth||b.dueDate.slice(0,7))<=state.month),saved=workflowSavedBudget();
 const step=(number,title,subtitle,html)=>`<section class="panel workflow-step"><header><span class="workflow-number">${number}</span><div><h3>${title}</h3><p class="note">${subtitle}</p></div></header>${html}</section>`;
 const cards=`<div class="workflow-summary"><article><small>Income left to allocate</small><strong class="${m.remainingIncome<0?'negative':''}">${money(m.remainingIncome)}</strong><p>Income ${money(m.income)} − commitments ${money(m.commitments)} − category allocations ${money(m.allocated)}</p></article><article><small>Projected bank cash</small><strong>${money(m.bankCash)}</strong><p>Known starting cash + future receipts − bank payments</p></article><article><small>Available bank cash after earmarks</small><strong>${money(m.availableCash)}</strong><p>${m.partial?'Partial estimate · verify dated balances':'Based on confirmed opening assumptions'} · card and other earmarks excluded</p><button type="button" class="view-all" data-reserve-action="opening">Review starting balances & dates ↗</button></article></div>`;
 const bankBasis=`<details class="workflow-bank-basis"><summary>Starting bank funds & recorded dates</summary>${planBanks().map(a=>`<p><b>${esc(a.name)}</b> · ${a.balance===null?'Unknown':money(a.balance)} · Last balance anchor: ${esc(a.observed||'Unknown')}</p>`).join('')||'<p>No eligible bank accounts have recorded balances.</p>'}<p class="note">${p.openingAsOf?'Manual opening date: '+esc(p.openingAsOf)+'. ':''}Bank figures roll recorded movements forward from these anchors. Missing imports or old anchors can make the projection incomplete. The income envelope does not use old bank cash.</p></details>`;
 const income=step(1,'Set this month’s income','Enter expected income, or pull recorded income for this planning month. Already received income is counted in your budget, but is not added to bank cash a second time.',workflowRows(p.items.filter(x=>['income','funding'].includes(x.kind)),'No income set yet.')+`<div class="workflow-actions"><button type="button" class="button primary" data-plan-action="add-income" ${disabled}>Add expected income</button><button type="button" class="button" data-workflow="import-income" ${disabled}>Pull recorded income</button></div>`);
 const cardRows=bills.map(b=>{const x=p.items.find(x=>x.statementId===b.id),planned=x?.enabled?x.amount:0;return `<div class="workflow-bill"><div><h4>${esc(b.card)}</h4><p class="note">Due ${esc(b.dueDate)}${b.dueDate.slice(0,7)<state.month?' · Overdue':''} · ${b.status==='estimated'?'Estimate — verify statement':'Confirmed statement'}</p><p>Statement ${money(b.statementAmount)} · Already paid ${money(b.paid)} · <b>Open ${money(billRemaining(b))}</b></p><small>Planned here: ${money(planned)} · Left unpaid after plan: ${money(Math.max(0,billRemaining(b)-planned))}</small></div><div class="workflow-actions"><button type="button" class="button" data-workflow-bill="${esc(b.id)}" ${disabled}>Plan full / partial payment</button><button type="button" class="view-all" data-bill-id="${esc(b.id)}">Update already-paid evidence ↗</button></div></div>`;}).join('');
 const cc=step(2,'Choose card bill payments','Plan a full or partial payment. This models a future payment; already-paid evidence is a separate field. Outstanding card debt is never substituted for a statement bill.',cardRows||'<p class="note">No open statement bill is recorded for this month or earlier.</p>')+`<div class="workflow-actions"><button type="button" class="button" data-bill-new ${disabled}>Add a statement / estimate</button></div>`;
 const subscriptions=step(3,'Choose subscriptions','Confirmed subscriptions are suggested from Recurring. Tick or untick them for this month only; this does not cancel the service.',workflowRows(p.items.filter(x=>x.subscriptionKey||x.kind==='expense'&&x.source.includes('Confirmed service')),'No confirmed subscriptions found. Mark them in Recurring, then refresh Planner.'));
 const sips=step(4,'Choose investments & SIPs','Active SIP schedules appear even when no contribution was recorded last month. Unticking one skips only this plan; the investment schedule is unchanged.',workflowRows(p.items.filter(x=>x.kind==='investment'),'No active SIPs or planned investment contributions found.')+`<button type="button" class="button" data-plan-add="future" ${disabled}>Add planned investment</button>`);
 const other=step(5,'Add anything else this month','Add rent, insurance, travel, one-off purchases or a cash buffer before splitting the remaining income.',workflowRows(p.items.filter(x=>!x.categoryAllowance&&!x.subscriptionKey&&!['income','funding','investment','card'].includes(x.kind)),'No other commitments yet.')+`<div class="workflow-actions"><button type="button" class="button" data-plan-add="extras" ${disabled}>Add planned expense</button><button type="button" class="button" data-plan-add="buffer" ${disabled}>Add cash buffer</button></div>`);
 const categoryForm=`<p><b>${money(m.beforeCategories)}</b> of income remains after commitments, before category allocations.</p>${m.beforeCategories<0?'<p class="negative">Commitments exceed the month’s income. Adjust them before creating a budget.</p>':''}<form id="workflow-category-form"><div class="workflow-category-grid">${(host.categoryRows||[]).map(c=>{const item=p.items.find(x=>x.categoryAllowance&&x.categoryId===c.id);return `<div class="field"><label for="workflow-category-${esc(c.id)}">${esc(c.name)}</label><input id="workflow-category-${esc(c.id)}" name="category-${esc(c.id)}" type="number" min="0" step="${1/workflowScale()}" value="${item?.enabled?item.amount:''}" placeholder="0" ${disabled}></div>`;}).join('')}</div><p class="note">Amounts here are additional flexible allowances. Selected subscriptions and other consumption expenses are included in their categories once. Card repayments, SIPs and earmarks are excluded from consumption budgets.</p><button type="submit" class="button primary" ${disabled}>Save category split</button></form>`;
 const server=saved?`<div class="info-strip"><b>Saved budget: ${esc(saved.name)} · ${esc(saved.state)}</b><p>This is a server-saved budget. Further local planning edits do not overwrite it.</p><button type="button" class="button" data-workflow="inspect-budget">View budget & actuals</button>${saved.state==='draft'&&host.canPublish?'<button type="button" class="button" data-workflow="activate-budget">Activate saved budget</button>':''}</div>`:`<button type="button" class="button primary" data-workflow="review-budget" ${disabled||!host.canPublish?'disabled':''}>Review & create budget</button>${!host.canPublish?'<p class="note">A household owner or admin can create the Family budget.</p>':''}`;
 const budget=step(6,'Split the rest into your category budget','Use income left after commitments as your spending envelope. The bank forecast is a separate check, especially when balances are old.',categoryForm+server);
 return `<div class="workflow-intro"><div><h3>Give your income a job, one step at a time.</h3><p class="note">Start at the top. The totals update as you choose commitments and category allowances.</p></div>${planStatus(p)}</div>${cards}${bankBasis}${income}${cc}${subscriptions}${sips}${other}${budget}<p class="note">Planning changes never move money. Record or import actual payments in Transactions; use the calendar to check timing and cash coverage.</p>`;
}
function workflowIncomeForm(){
 const p=currentPlan(),rows=data().filter(t=>t.type==='income');
 openDrawer('Pull this month’s income',monthName()+' · '+scopeName(),`<form id="workflow-income-form">${rows.map(t=>{const linked=p.items.some(x=>x.incomeRecordId===t.id||(x.matchIds||[]).includes(t.id)),account=planBanks().find(a=>a.name===t.account),asOf=p.openingAsOf||account?.projectedAsOf?.slice(0,10),included=asOf&&asOf!=='Unknown'&&asOf>=t.date;return `<div class="workflow-income-row"><label class="workflow-row"><input type="checkbox" name="income" value="${esc(t.id)}" ${linked?'disabled':'checked'}><span><b>${esc(t.description)}</b><small>${esc(t.date)} · ${esc(t.account)}${linked?' · Already linked':''}</small></span><strong>${money(t.amount)}</strong></label><label class="workflow-received"><input type="checkbox" name="included" value="${esc(t.id)}" ${included?'checked':''} ${linked?'disabled':''}> Already included in my starting bank funds</label></div>`;}).join('')||'<p class="note">No recorded income exists in this planning month, scope and currency. Enter expected income manually or select a month with recorded income.</p>'}<label class="workflow-row"><input type="checkbox" name="replace" checked> Replace existing unlinked expected income with these recorded amounts</label><p class="note">For each receipt, verify whether your starting funds already include it. Checked receipts count toward income but are not added to bank cash again. Leave this unchecked if your opening funds predate that receipt.</p><div class="form-actions"><button type="button" class="button" data-action="close">Cancel</button><button class="button primary" ${!rows.length?'disabled':''}>Use selected income</button></div></form>`);
}
function workflowBillForm(id){const b=scopedBills().find(b=>b.id===id);if(!b||currentPlan().status==='closed')return;const remaining=billRemaining(b);openDrawer('Plan a card payment',b.card+' · '+monthName(),`<form id="workflow-payment-form" data-bill="${esc(b.id)}"><p>Open bill ${money(remaining)}. This schedules a payment in the plan; it does not mark the bank payment as made.</p><div class="field"><label for="workflow-payment-mode">Payment choice</label><select id="workflow-payment-mode" name="mode"><option value="full">Full remaining bill</option><option value="partial" ${b.plannedPayment!=null&&b.plannedPayment<remaining?'selected':''}>Partial payment</option><option value="skip">Do not include this month</option></select></div><div class="field"><label for="workflow-payment-amount">Partial amount · ${state.currency}</label><input id="workflow-payment-amount" type="number" name="amount" min="0" max="${remaining}" step="${1/workflowScale()}" value="${b.plannedPayment??remaining}"></div><p class="note">Any unpaid remainder stays visible as an open obligation. This forecast does not estimate interest or fees. To record money already paid, update the bill’s evidence and verify starting funds.</p><div class="form-actions"><button type="button" class="button" data-action="close">Cancel</button><button class="button primary">Save payment plan</button></div></form>`);}
function workflowReviewBudget(){
 const p=currentPlan(),m=workflowTotals(p);if(p.status==='closed')return;
 if(m.remainingIncome<0)return toast('Category allocations and commitments exceed this month’s income. Adjust the plan first.');
 let lines;try{lines=workflowCategoryLines(p);}catch(error){return toast(error.message);}
 if(!lines.length)return toast('Add at least one expense category allowance before creating a budget.');
 openDrawer('Create your category budget',monthName()+' · '+scopeName()+' · '+state.currency,`<p>Income ${money(m.income)} · Commitments ${money(m.commitments)} · Income still unallocated ${money(m.remainingIncome)}</p><div class="formula">${lines.map(line=>`<p>${esc(host.categoryRows.find(c=>c.id===line.category_id).name)} <b>${money(Number(line.amount))}</b></p>`).join('')}</div><p class="note">Create a draft budget on the server with these consumption limits. Activate it afterwards when ready. No transactions, card payments or investment movements will be created.</p>${m.partial?'<p class="note">Bank coverage is partial. The category budget is based on income; verify bank timing in the calendar.</p>':''}<form id="workflow-publish-form"><div class="field"><label for="workflow-budget-name">Budget name</label><input id="workflow-budget-name" name="name" required maxlength="100" value="${esc(p.name)} budget"></div><div class="form-actions"><button type="button" class="button" data-action="close">Back</button><button class="button primary" type="submit">Create budget draft</button></div></form>`);
}
document.addEventListener('click',async event=>{
 const button=event.target.closest('button');if(!button)return;
 if(button.dataset.workflowBill)return workflowBillForm(button.dataset.workflowBill);
 const action=button.dataset.workflow;if(!action)return;
 if(action==='import-income')return workflowIncomeForm();
 if(action==='review-budget')return workflowReviewBudget();
 const saved=workflowSavedBudget();
 if(action==='inspect-budget'&&saved){closeDrawer();return host.inspectBudget(saved);}
 if(action==='activate-budget'&&saved){const p=currentPlan(),month=state.month,scope=state.scope,currency=state.currency;button.disabled=true;try{const activated=await host.activateBudget(saved);p.serverBudget=activated;planSave();if(host.active()&&state.month===month&&state.scope===scope&&state.currency===currency){host.savedBudgets=(host.savedBudgets||[]).filter(b=>b.id!==saved.id).concat(activated);renderPlanner();toast('Budget activated. Actual transactions are unchanged.');}}finally{button.disabled=false;}}
});
document.addEventListener('submit',async event=>{
 const form=event.target;if(!form.id.startsWith('workflow-'))return;event.preventDefault();
 const p=currentPlan();if(p.status==='closed')return;const values=new FormData(form);
 if(form.id==='workflow-income-form'){
  const selected=new Set(values.getAll('income')),records=data().filter(t=>t.type==='income'&&selected.has(t.id)&&!p.items.some(x=>x.incomeRecordId===t.id||(x.matchIds||[]).includes(t.id)));
  if(!records.length)return toast('Choose income that is not already linked.');
  if(values.has('replace'))p.items=p.items.filter(x=>x.kind!=='income'||x.incomeRecordId||(x.matchIds||[]).length);
  for(const t of records)p.items.push({id:'income-'+t.id,title:t.description,kind:'income',lane:'income',amount:t.amount,day:+t.date.slice(8),category:t.category,account:t.account,person:t.person,source:'Recorded income · '+t.date,enabled:true,timing:'once',matchIds:[t.id],incomeRecordId:t.id,cashIncluded:values.getAll('included').includes(t.id)});
  planRevise('Recorded income pulled into the plan; bank inclusion explicitly chosen');closeDrawer();renderPlanner();return;
 }
 if(form.id==='workflow-payment-form'){
  const bill=scopedBills().find(b=>b.id===form.dataset.bill);if(!bill)return;
  const mode=values.get('mode'),amount=mode==='full'?billRemaining(bill):mode==='skip'?0:Number(values.get('amount'));
  if(!Number.isFinite(amount)||amount<0||amount>billRemaining(bill))return toast('Payment must be between zero and the remaining bill.');
  bill.plannedPayment=workflowRound(amount);bill.paymentMonth=state.month;syncAllCardPlans();planRevise('Card payment plan updated; payment evidence unchanged');closeDrawer();renderPlanner();return;
 }
 if(form.id==='workflow-category-form'){
  const next=[];for(const c of host.categoryRows||[]){const raw=values.get('category-'+c.id);if(raw==null||raw==='')continue;const amount=Number(raw);if(!Number.isFinite(amount)||amount<0)return toast('Enter a nonnegative amount for each category.');if(amount>0)next.push({id:'allowance-'+c.id,title:c.name+' allowance',category:c.name,categoryId:c.id,categoryAllowance:true,kind:'expense',lane:'everyday',amount:workflowRound(amount),day:7,timing:'weekly',account:planBanks()[0]?.name||'Manual opening pool',person:host.person,source:'Income allocated to category budget',enabled:true,matchIds:[]});}
  if(workflowSum(next)>Math.max(0,workflowTotals(p).beforeCategories))return toast('Category allocations exceed income left after commitments. Reduce the split or revise income.');
  p.items=p.items.filter(x=>!x.categoryAllowance).concat(next);planRevise('Remaining income split across expense categories');renderPlanner();toast('Category split saved. Review it to create your budget.');return;
 }
 if(form.id==='workflow-publish-form'){
  if(form.dataset.busy)return;form.dataset.busy='true';const submit=form.querySelector('[type="submit"]');submit.disabled=true;
  const month=state.month,scope=state.scope,currency=state.currency,revision=p.revision;
  try{
   const m=workflowTotals(p);if(m.remainingIncome<0)throw new Error('The plan exceeds income; revise it before publishing.');
   const digits=new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits;
   const body={name:String(values.get('name')).trim(),month,scope:scope==='household'?'family':'personal',currency,expected_income:m.income.toFixed(digits),savings_goal:workflowSum(p.items.filter(x=>x.enabled&&['investment','reserve'].includes(x.kind))).toFixed(digits),lines:workflowCategoryLines(p),people_limits:[]};
   const budget=await host.publishBudget(body);p.serverBudget=budget;p.serverBudgetRevision=revision;planSave();if(host.active()&&state.month===month&&state.scope===scope&&state.currency===currency){host.savedBudgets=(host.savedBudgets||[]).concat(budget);closeDrawer();renderPlanner();toast('Budget draft created on the server.');}
  }finally{delete form.dataset.busy;submit.disabled=false;}
 }
});
