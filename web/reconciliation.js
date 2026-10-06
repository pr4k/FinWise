(() => {
function exactPairAvailable(ledger,statement) {
  const available=v=>v.state==='unmatched' && v.amount===v.remaining;
  return ledger.some(l=>available(l) && statement.filter(o=>available(o) && o.effective_date===l.effective_date && o.amount===l.amount).length===1 && ledger.filter(other=>available(other) && other.effective_date===l.effective_date && other.amount===l.amount).length===1);
}
function matchAllocations(ledger,observations) {
  if(!ledger.length || !observations.length) return null;
  const minor=value=>BigInt(value.replace('.',''));
  const scale=(ledger[0].remaining.split('.')[1]||'').length;
  const formatted=value=>{const negative=value<0n,digits=(negative?-value:value).toString().padStart(scale+1,'0');return `${negative?'-':''}${scale?digits.slice(0,-scale)+'.'+digits.slice(-scale):digits}`;};
  const sign=value=>value<0n?-1n:value>0n?1n:0n;
  const entries=[...ledger,...observations],direction=sign(minor(entries[0].remaining));
  if(!direction || entries.some(v=>sign(minor(v.remaining))!==direction)) return {error:'Select rows with the same transaction direction.'};
  const left=ledger.map(v=>{const n=minor(v.remaining);return {item:v,remaining:n<0n?-n:n};});
  const right=observations.map(v=>{const n=minor(v.remaining);return {item:v,remaining:n<0n?-n:n};});
  const ledgerTotal=left.reduce((n,v)=>n+v.remaining,0n),statementTotal=right.reduce((n,v)=>n+v.remaining,0n);
  const allocations=[];let i=0,j=0;
  while(i<left.length && j<right.length) {
    const matched=left[i].remaining<right[j].remaining?left[i].remaining:right[j].remaining;
    allocations.push({ledger_id:left[i].item.id,ledger_revision:left[i].item.revision,observation_id:right[j].item.id,amount:formatted(direction*matched)});
    left[i].remaining-=matched;right[j].remaining-=matched;
    if(!left[i].remaining)i++;if(!right[j].remaining)j++;
  }
  return {allocations,ledgerTotal:formatted(direction*ledgerTotal),statementTotal:formatted(direction*statementTotal),matchedTotal:formatted(direction*(ledgerTotal<statementTotal?ledgerTotal:statementTotal)),difference:formatted(direction*(statementTotal-ledgerTotal)),hasDifference:ledgerTotal!==statementTotal,currency:ledger[0].currency};
}
function amendmentPlan(ledger,observations,field='remaining',target=0) {
  if(!ledger.length || !observations.length) return {error:'Select transactions on both sides.'};
  const values=[...ledger,...observations];
  const scale=(ledger[0].amount.split('.')[1]||'').length;
  const minor=value=>{
    if(!/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error('Enter a valid signed amount.');
    const [whole,fraction='']=value.split('.');
    if(fraction.length>scale) throw new Error('Use the account currency precision.');
    return BigInt(whole)*(10n**BigInt(scale))+(whole.startsWith('-')?-1n:1n)*BigInt(fraction.padEnd(scale,'0')||'0');
  };
  const formatted=value=>{const negative=value<0n,digits=(negative?-value:value).toString().padStart(scale+1,'0');return `${negative?'-':''}${scale?digits.slice(0,-scale)+'.'+digits.slice(-scale):digits}`;};
  if(values.some(v=>v.currency!==ledger[0].currency)) return {error:'Selected rows must use the same currency.'};
  const ledgerTotal=ledger.reduce((sum,v)=>sum+minor(v[field]),0n);
  const statementTotal=observations.reduce((sum,v)=>sum+minor(v[field]),0n);
  const difference=statementTotal-ledgerTotal;
  const proposed=ledger.map((v,i)=>formatted(minor(v.amount)+(i===target?difference:0n)));
  return {difference:formatted(difference),proposed,currency:ledger[0].currency,valid:proposed.every((v,i)=>minor(v)!==0n && (minor(v)>0n)===(minor(ledger[i].amount)>0n)),minor,formatted};
}
function sumSignedRows(rows) {
  if(!rows.length) return {error:'Select statement rows.'};
  const currency=rows[0].currency,scale=(rows[0].remaining.split('.')[1]||'').length;
  const factor=10n**BigInt(scale);
  let total=0n;
  for(const row of rows) {
    if(row.currency!==currency || !/^-?\d+(?:\.\d+)?$/.test(row.remaining)) return {error:'Rows must use the same currency.'};
    const [whole,fraction='']=row.remaining.split('.');
    if(fraction.length>scale) return {error:'Rows have different currency precision.'};
    const value=BigInt(whole)*factor+(whole.startsWith('-')?-1n:1n)*BigInt(fraction.padEnd(scale,'0')||'0');
    if(!value || (total && (value<0n)!==(total<0n))) return {error:'Select rows with the same direction.'};
    total+=value;
  }
  const digits=(total<0n?-total:total).toString().padStart(scale+1,'0');
  return {currency,total:`${total<0n?'-':''}${scale?digits.slice(0,-scale)+'.'+digits.slice(-scale):digits}`,eventType:total<0n?'expense':'income'};
}
  window.finwiseReconciliation = { exactPairAvailable, matchAllocations, amendmentPlan, sumSignedRows };
})();
