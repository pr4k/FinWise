(() => {
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const filters={all:'All expenses',credit_card:'Credit card expenses',cash:'Cash expenses',investments:'Investments'};
  function calendar({summary,transactions,accounts,month,currency,today,filter='all'}) {
    if(!filters[filter])filter='all';
    const scale=new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits;
    const sum=values=>window.finwiseAnalytics.sumMoney(values,scale);
    const byId=new Map(transactions.filter(t=>!t.voided&&t.currency===currency&&t.effective_date?.startsWith(month)&&t.effective_date<=today).map(t=>[t.id,t]));
    const accountTypes=new Map(accounts.map(a=>[a.id,a.subtype]));
    const effects=new Map();
    for(const line of summary.breakdown||[]) {
      const transaction=byId.get(line.transaction_id);
      if(!transaction)continue;
      const types=(transaction.movements||[]).map(m=>accountTypes.get(m.account_id));
      if(filter==='credit_card'&&!types.includes('credit_card'))continue;
      if(filter==='cash'&&(types.includes('credit_card')||!types.some(type=>['bank','cash','investment_cash'].includes(type))))continue;
      const value=line[filter==='investments'?'net_invested':'spending']||'0';
      if(Number(value)===0)continue;
      const entry=effects.get(transaction.id)||{transaction,values:[]};
      entry.values.push(value);effects.set(transaction.id,entry);
    }
    const [year,number]=month.split('-').map(Number);
    const count=new Date(Date.UTC(year,number,0)).getUTCDate();
    const offset=(new Date(Date.UTC(year,number-1,1)).getUTCDay()+6)%7;
    const days=Array.from({length:count},(_,index)=>{
      const date=`${month}-${String(index+1).padStart(2,'0')}`;
      const rows=[...effects.values()].filter(row=>row.transaction.effective_date===date).map(row=>({transaction:row.transaction,amount:sum(row.values)}));
      return {date,day:index+1,amount:sum(rows.map(row=>row.amount)),rows,future:date>today};
    });
    return {filter,days,offset,total:sum(days.map(day=>day.amount)),max:days.reduce((max,day)=>Number(day.amount)>Number(max)?day.amount:max,sum([]))};
  }
  function render(options,selectedDate='') {
    const data=calendar(options),{currency,month,today}=options;
    const money=value=>new Intl.NumberFormat(currency==='INR'?'en-IN':'en',{style:'currency',currency}).format(value);
    const dateLabel=date=>new Intl.DateTimeFormat('en',{dateStyle:'long',timeZone:'UTC'}).format(new Date(`${date}T00:00:00Z`));
    const selected=data.days.find(day=>day.date===selectedDate);
    const monthLabel=new Intl.DateTimeFormat('en',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(`${month}-01T00:00:00Z`));
    const cells=data.days.map(day=>{
      const level=Number(day.amount)<0?'refund':Number(day.amount)===0?'0':String(Math.min(4,Math.ceil(Number(day.amount)/Number(data.max)*4)));
      const label=`${dateLabel(day.date)}: ${day.future?'Future date':`${filters[data.filter]}, ${money(day.amount)}, ${day.rows.length} transactions`}`;
      return `<button type="button" class="daily-activity-day" data-level="${level}" data-action="daily-activity-day" data-date="${day.date}" aria-label="${escape(label)}" title="${escape(label)}" aria-pressed="${selectedDate===day.date}" ${day.date===today?'aria-current="date"':''} ${day.future?'disabled':''}>${day.day}</button>`;
    }).join('');
    const negativeLabel=data.filter==='investments'?'Net withdrawals':'Net refunds';
    const detail=selected?`<div class="daily-activity-detail"><div><strong>${escape(dateLabel(selected.date))}</strong><b>${escape(money(selected.amount))}</b></div>${selected.rows.length?`<ul>${selected.rows.map(row=>`<li><button type="button" data-action="transaction-detail" data-id="${escape(row.transaction.id)}"><span>${escape(row.transaction.description||'Transaction')}</span><b>${escape(money(row.amount))}</b></button></li>`).join('')}</ul>`:'<p>No recorded activity for this view.</p>'}</div>`:'';
    return `<div class="daily-activity-head"><div><h2>Daily activity</h2><p>${escape(monthLabel)} · ${escape(money(data.total))} ${data.filter==='investments'?'net invested':'net spending'}</p></div><label><span class="sr-only">Daily activity view</span><select id="daily-activity-filter">${Object.entries(filters).map(([key,label])=>`<option value="${key}" ${data.filter===key?'selected':''}>${label}</option>`).join('')}</select></label></div><div class="daily-activity-week" aria-hidden="true">${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(day=>`<span>${day}</span>`).join('')}</div><div class="daily-activity-grid" role="group" aria-label="${escape(monthLabel)} daily amounts">${Array.from({length:data.offset},()=>'<span aria-hidden="true"></span>').join('')}${cells}</div><div class="daily-activity-legend"><span>${escape(money(0))}</span><span class="daily-activity-scale" aria-hidden="true">${[0,1,2,3,4].map(level=>`<i data-level="${level}"></i>`).join('')}</span><span>${escape(money(data.max))}</span><span class="daily-activity-negative"><i data-level="refund" aria-hidden="true"></i>${negativeLabel}</span></div><p class="daily-activity-hint">${data.filter==='cash'?'Bank and cash account expenses, less refunds. ':data.filter==='investments'?'Contributions less withdrawals. ':'Consumption spending, less refunds. '}Card repayments and transfers are excluded. Select a day to see its transactions. Recorded data only.</p><div aria-live="polite">${detail}</div>`;
  }
  window.finwiseDailyActivity={calendar,render};
})();
