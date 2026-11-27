(function(root){
  function schedule(terms, transactions, today) {
    const precision=new Intl.NumberFormat('en',{style:'currency',currency:terms.currency}).resolvedOptions().maximumFractionDigits;
    const factor=10**precision, toMinor=value=>Math.round(Number(value)*factor);
    const principal=toMinor(terms.principal), payment=toMinor(terms.monthly_payment), rate=Number(terms.annual_rate)/1200;
    const payments=new Map();
    for(const t of transactions) {
      if(t.voided || t.event_type!=='expense' || t.currency!==terms.currency || t.effective_date<terms.start_date || t.effective_date>today) continue;
      for(const a of t.allocations||[]) if(a.category_id===terms.category_id) {
        const month=t.effective_date.slice(0,7);payments.set(month,(payments.get(month)||0)+toMinor(a.amount));
      }
    }
    let balance=principal, interestTotal=0; const rows=[];
    const paid=[...payments.values()].reduce((sum,value)=>sum+value,0);
    const [year,month]=terms.start_date.slice(0,7).split('-').map(Number);
    for(let i=0;i<600 && balance>0;i++) {
      const date=new Date(Date.UTC(year,month-1+i,1)), key=date.toISOString().slice(0,7);
      const recorded=payments.get(key)||0, dueDay=Math.min(Number(terms.start_date.slice(8,10)),new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate());
      const due=`${key}-${String(dueDay).padStart(2,'0')}`;
      const actual=due<=today || recorded>0, interest=Math.round(balance*rate);
      const amount=actual?recorded:Math.min(payment,balance+interest);
      const applied=Math.min(amount,balance+interest); balance=balance+interest-applied;
      interestTotal+=interest;
      rows.push({month:key,interest:interest/factor,payment:amount/factor,balance:balance/factor,actual});
    }
    const current=rows.filter(r=>r.actual).at(-1);
    return {rows,paid:paid/factor,remaining:current?current.balance:principal/factor,interest:interestTotal/factor,incomplete:balance>0};
  }
  root.finwiseEmi={schedule};
  if(typeof module!=='undefined')module.exports=root.finwiseEmi;
})(typeof window==='undefined'?globalThis:window);
