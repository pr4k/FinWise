/* Convert authorized API records to the planner's projection contract. */
(() => {
  function prepare({accounts,categories,members,transactions,user,scope,currency}) {
    const family=scope==='family';
    const visible=accounts.filter(a=>a.active!==false&&a.currency===currency&&['bank','cash','credit_card'].includes(a.subtype)&&(family?a.visibility==='shared':a.owner_id===user.id&&a.visibility!=='shared'));
    const accountLabel=a=>accounts.filter(other=>other.name===a.name).length>1?`${a.name} · ${a.id.slice(0,8)}`:a.name;
    const label=id=>{const account=accounts.find(a=>a.id===id);return account?accountLabel(account):'Manual opening pool';};
    const adapted=visible.map(a=>({id:a.id,name:accountLabel(a),type:a.subtype==='credit_card'?'card':'bank',balance:a.balance?.amount==null?null:Number(a.balance.amount),reserve:Number(a.funds?.reserved||0),observed:a.balance?.as_of||'Unknown',due:a.card_due?.amount==null?null:Number(a.card_due.amount),dueDate:a.card_due?.due_date||null}));
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
        records.push({...base,id:`${t.id}:${index}`,amount:Number(a.amount),type,offsetExpense:a.offset_expense===true,category:category?.name||'Uncategorized',subscription:category?.tracking_type==='subscription',recurring:!!t.recurring_id});
      }
    }
    return {accounts:adapted,categories:colors,records,person:family?'Shared pool':user.name,people:family?['Shared pool',...members.map(m=>m.name)]:[user.name]};
  }
  window.finwisePlannerData={prepare};
})();
