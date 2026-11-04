/* Convert authorized API records to the planner's projection contract. */
(() => {
  function prepare({accounts,categories,members,transactions,user,scope,currency,subscriptions=[],investments=[],month}) {
    const family=scope==='family';
    const visible=accounts.filter(a=>a.active!==false&&a.currency===currency&&['bank','cash','credit_card'].includes(a.subtype)&&(family?a.visibility==='shared':a.owner_id===user.id&&a.visibility!=='shared'));
    const accountLabel=a=>accounts.filter(other=>other.name===a.name).length>1?`${a.name} · ${a.id.slice(0,8)}`:a.name;
    const label=id=>{const account=accounts.find(a=>a.id===id);return account?accountLabel(account):'Manual opening pool';};
    const adapted=visible.map(a=>({id:a.id,name:accountLabel(a),type:a.subtype==='credit_card'?'card':'bank',balance:a.balance?.amount==null?null:Number(a.balance.amount),reserve:Number(a.funds?.reserved||0),observed:a.balance?.anchor_at||a.opening_balance?.as_of||'Unknown',projectedAsOf:a.balance?.as_of||'Unknown',due:a.card_due?.amount==null?null:Number(a.card_due.amount),dueDate:a.card_due?.due_date||null}));
    const colors=Object.fromEntries(categories.map(c=>[c.name,c.color||'#387554']));
    const records=[];
    for(const t of transactions.filter(t=>!t.voided&&t.currency===currency)) {
      const movements=t.movements||[],debit=movements.find(m=>Number(m.amount)<0),credit=movements.find(m=>Number(m.amount)>0);
      const base={transactionId:t.id,date:t.effective_date.slice(0,10),description:t.description||t.merchant||'Transaction',currency:t.currency,account:label((debit||credit)?.account_id),person:members.find(m=>m.user_id===t.entered_by)?.name||user.name,scope:family?'household':'personal'};
      if(['transfer','investment','investment_withdrawal'].includes(t.event_type)) {
        // Transfers do not have allocations; include only this planning scope's accounts.
        if(!movements.some(m=>visible.some(a=>a.id===m.account_id)))continue;
        const cardPayment=t.event_type==='transfer'&&accounts.find(a=>a.id===credit?.account_id)?.subtype==='credit_card';
        records.push({...base,id:t.id,amount:Number(t.amount),type:cardPayment?'card':t.event_type==='investment_withdrawal'?'withdrawal':t.event_type,category:cardPayment?'Card payment':t.event_type==='transfer'?'Transfer':'Investment',destination:label(credit?.account_id)});
        continue;
      }
      for(const [index,a] of (t.allocations||[]).entries()) {
        if(a.scope!==scope)continue;
        const category=categories.find(c=>c.id===a.category_id);
        const classification=a.transaction_type||t.classification?.transaction_type||t.event_type;
        const type=classification==='investment'?(Number(movements[0]?.amount)>0?'withdrawal':'investment'):classification==='paid_on_behalf'?'behalf':classification;
        records.push({...base,id:`${t.id}:${index}`,amount:Number(a.amount),type,...(t.event_type==='income'?{personId:a.member_id||t.entered_by,person:members.find(m=>m.user_id===(a.member_id||t.entered_by))?.name||user.name}:{}),categoryId:a.category_id,offsetExpense:a.offset_expense===true,category:category?.name||'Uncategorized',subscription:category?.tracking_type==='subscription',recurring:!!t.recurring_id});
      }
    }
    const categoryRows=categories.filter(c=>c.kind==='expense'&&c.archived!==true&&(scope!=='family'||c.visibility!=='private'));
    const suggestions=[];
    const day=date=>Math.min(Number(String(date||'').slice(-2))||1,new Date(Number(month?.slice(0,4)||2026),Number(month?.slice(5)||1),0).getDate());
    for(const sub of subscriptions.filter(s=>s.subscription&&!s.ignored&&s.currency===currency&&visible.some(a=>a.id===s.account_id))){
      const last=[...(sub.occurrences||[])].sort((a,b)=>a.date.localeCompare(b.date)).at(-1),frequency=sub.frequency||'monthly';
      const elapsed=month&&sub.last_date?(Number(month.slice(0,4))-Number(sub.last_date.slice(0,4)))*12+Number(month.slice(5))-Number(sub.last_date.slice(5,7)):0;
      const due=frequency==='annual'||frequency==='yearly'?elapsed>=0&&elapsed%12===0:frequency==='quarterly'?elapsed>=0&&elapsed%3===0:true;
      const historical=records.find(t=>t.subscription&&t.account===label(sub.account_id)&&t.description.toLowerCase()===sub.name.toLowerCase());
      suggestions.push({id:'subscription-'+sub.key,title:sub.name,kind:'expense',lane:'must',amount:Number(last?.amount||sub.max_amount)*(frequency==='weekly'?4:1),day:day(sub.last_date),timing:frequency==='weekly'?'weekly':'once',account:label(sub.account_id),category:historical?.category||categoryRows.find(c=>c.tracking_type==='subscription')?.name||'Subscriptions',categoryId:historical?.categoryId||categoryRows.find(c=>c.tracking_type==='subscription')?.id,subscriptionKey:sub.key,source:'Confirmed subscription · '+frequency+' estimate',enabled:due});
    }
    for(const holding of investments.filter(h=>!h.archived&&h.currency===currency&&(family?h.visibility==='shared':h.owner_id===user.id))){
      const sip=Object.prototype.hasOwnProperty.call(holding,'plannerSip')?holding.plannerSip:holding.sip;
      if(!sip||sip.status!=='active'||(month&&month<sip.start_month)||(sip.end_month&&month>sip.end_month))continue;
      suggestions.push({id:'sip-'+holding.id,title:holding.name,kind:'investment',lane:'future',amount:Number(sip.amount),day:Math.min(Number(sip.day)||1,new Date(Number(month?.slice(0,4)||2026),Number(month?.slice(5)||1),0).getDate()),timing:'once',account:adapted.find(a=>a.id===holding.account_id)?.name||adapted.find(a=>a.type==='bank')?.name||'Manual opening pool',category:'Investment',holding:holding.id,sip:true,source:'Active SIP schedule · planned contribution',enabled:true});
    }
    return {members:members.filter(m=>m.active!==false),currentUserId:user.id,accounts:adapted,categories:colors,categoryRows,suggestions,records,person:family?'Shared pool':user.name,people:family?['Shared pool',...members.map(m=>m.name)]:[user.name]};
  }
  window.finwisePlannerData={prepare,nextMonth(today){const [year,month]=today.slice(0,7).split('-').map(Number);return `${month===12?year+1:year}-${String(month===12?1:month+1).padStart(2,'0')}`;}};
})();
