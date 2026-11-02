/* Host adapter. The build script inserts the module sources at the marker below. */
(() => {
  'use strict';
  window.finwisePlanner = { create(host) {
    const nativeDocument=window.document;
    const state={scope:host.scope,currency:host.currency,month:host.month,page:'Planner'};
    const controller=new AbortController();
    let ready=false, storageFailed=false, composing=false;
    const placeholders=Object.fromEntries(['content','page-subtitle','page-title','greeting','coverage'].map(key=>[key,nativeDocument.createElement('div')]));
    const $=selector=>composing?(placeholders[selector.slice(1)]||placeholders.content.querySelector?.(selector)):(nativeDocument.querySelector('.planner-module '+selector)||nativeDocument.querySelector('#planner-dialog '+selector)||placeholders[selector.slice(1)]);
    const $$=selector=>Array.from(nativeDocument.querySelectorAll('.planner-module '+selector));
    const esc=host.escape,toast=host.toast;
    const localStorage={getItem:()=>window.localStorage.getItem(host.storageKey),setItem:(_key,value)=>{try{window.localStorage.setItem(host.storageKey,value);}catch{if(!storageFailed){toast('Planner changes could not be saved. Browser storage is unavailable or full.');storageFailed=true;}}}};
    const sessionStorage={setItem(){}};
    // Module listeners are scoped and disposed with the signed-in session.
    const document={createElement:tag=>nativeDocument.createElement(tag),addEventListener(type,listener){nativeDocument.addEventListener(type,event=>{if(host.active()&&event.target.closest('.planner-module')){try{Promise.resolve(listener(event)).catch(error=>toast('Planner: '+error.message));}catch(error){toast('Planner: '+error.message);}}},{signal:controller.signal});}};
    const sum=(rows,fn=x=>x.amount)=>rows.reduce((total,row)=>total+(Number(fn(row))||0),0);
    const money=value=>new Intl.NumberFormat('en-IN',{style:'currency',currency:state.currency,maximumFractionDigits:2}).format(value);
    const monthName=(month=state.month)=>new Date(month+'-02T12:00:00').toLocaleDateString('en-IN',{month:'long',year:'numeric'});
    const dateLabel=date=>new Date(date+'T12:00:00').toLocaleDateString('en-IN',{day:'numeric',month:'short'});
    const scopeName=()=>state.scope==='household'?'Family':'Personal';
    const accounts=()=>host.accounts;
    const categories=host.categories;
    const types={income:'Income',expense:'Expense',investment:'Investment',withdrawal:'Withdrawal',transfer:'Transfer',card:'Card payment',refund:'Refund',behalf:'Paid on behalf',reimbursement:'Reimbursement'};
    const data=(month=state.month)=>host.records.filter(t=>t.date.slice(0,7)===month&&t.currency===state.currency);
    const effect=(t,kind)=>kind==='income'?(t.type==='income'?t.amount:0):kind==='spending'?(t.type==='expense'?t.amount:(t.type==='refund'||(t.type==='reimbursement'&&t.offsetExpense))?-t.amount:0):kind==='invested'?(t.type==='investment'?t.amount:t.type==='withdrawal'?-t.amount:0):0;
    const metrics=(records=data())=>{const income=sum(records,t=>effect(t,'income')),spending=sum(records,t=>effect(t,'spending')),invested=sum(records,t=>effect(t,'invested'));return {income,spending,invested,surplus:income-spending,cashflow:income-spending-invested};};
    const byCategory=(records=data())=>{const totals=new Map();for(const t of records)totals.set(t.category,(totals.get(t.category)||0)+effect(t,'spending'));return [...totals].map(([name,amount])=>({name,amount,color:categories[name]||'#387554'})).filter(c=>c.amount>0).sort((a,b)=>b.amount-a.amount);};
    const sectionHead=(title,subtitle='')=>`<div class="section-head"><h3>${esc(title)}</h3><p class="note">${esc(subtitle)}</p></div>`;
    const row=t=>`<button type="button" class="holding-row" data-planner-transaction="${esc(t.transactionId||t.id)}"><span><b>${esc(t.description)}</b><small>${esc(t.date)} · ${esc(t.category)}</small></span><span class="money">${money(t.amount)}</span></button>`;
    function closeDrawer(){nativeDocument.querySelector('#planner-dialog')?.close();}
    function openDrawer(title,subtitle,html){let dialog=nativeDocument.querySelector('#planner-dialog');if(!dialog){dialog=nativeDocument.createElement('dialog');dialog.id='planner-dialog';dialog.className='planner-module planner-dialog';dialog.setAttribute('aria-labelledby','planner-dialog-title');nativeDocument.body.append(dialog);}dialog.innerHTML=`<div class="dialog-head"><div><h2 id="planner-dialog-title">${esc(title)}</h2><p class="note">${esc(subtitle)}</p></div><button type="button" class="icon-button" data-action="close" aria-label="Close planner dialog">×</button></div><div class="planner-dialog-body">${html}</div>`;if(!dialog.open)dialog.showModal();}
    const openLedger=(title,records)=>openDrawer(title,monthName(),records.map(row).join('')||'<p class="empty">No recorded transactions.</p>');
    function render(){if(!ready)return;if(state.page==='Budgets')renderPlannerBudget();else renderPlanner();}

    /* PLANNER_MODULES */

    // Refresh recorded account dues independently from monthly planning overrides.
    function syncHostBills(){
      for(const account of accounts().filter(a=>a.type==='card'&&a.due!=null&&a.dueDate)){
        const billId='account-due-'+account.id+'-'+account.dueDate;
        const statementMonth=shiftMonth(account.dueDate.slice(0,7),-1);
        let bill=plannerStore.cardBills.find(b=>b.scope===state.scope&&b.currency===state.currency&&(b.id===billId||(b.hostAccountId===account.id&&b.recordedDueDate?.slice(0,7)===account.dueDate.slice(0,7))||(b.card===account.name&&b.statementMonth===statementMonth)));
        if(!bill){bill={id:billId,scope:state.scope,currency:state.currency,card:account.name,statementMonth,dueDate:account.dueDate,statementAmount:account.due,paid:0,status:'estimated',account:planBanks()[0]?.name||'Manual opening pool',evidence:'Recorded remaining payment due; statement month is estimated. Verify against your statement.'};plannerStore.cardBills.push(bill);}
        for(const old of plannerStore.cardBills.filter(b=>b.id!==bill.id&&b.hostAccountId===account.id&&b.scope===state.scope&&b.currency===state.currency))old.supersededFrom=account.dueDate.slice(0,7);
        delete bill.supersededFrom;
        Object.assign(bill,{hostAccountId:account.id,recordedDue:account.due,recordedDueDate:account.dueDate,card:account.name,dueDate:account.dueDate,autoForecast:false});
      }
      planSave();
    }
    syncHostBills();
    document.addEventListener('click',event=>{
      const button=event.target.closest('button');if(!button)return;
      if(button.dataset.action==='close')closeDrawer();
      if(button.dataset.plannerTransaction){closeDrawer();host.inspect(button.dataset.plannerTransaction);}
      if(button.dataset.category)openLedger(button.dataset.category,data().filter(t=>t.category===button.dataset.category));
    });
    ready=true;
    return {
      html(){composing=true;render();composing=false;return `<div class="planner-module"><div id="coverage">${placeholders.coverage.innerHTML}</div><div id="content">${placeholders.content.innerHTML}</div></div>`;},
      update(next){Object.assign(host,next);Object.assign(state,{scope:next.scope,currency:next.currency,month:next.month,page:'Planner'});syncHostBills();},
      dispose(){controller.abort();nativeDocument.querySelector('#planner-dialog')?.remove();},
      // Read-only snapshots for financial regression checks.
      snapshot(){return structuredClone({plan:currentPlan(),totals:planTotals(),forecast:reserveForecast(),workflow:workflowTotals()});}
    };
  }};
})();
