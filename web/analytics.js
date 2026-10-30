(() => {
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function minor(value) { const [whole,fraction='']=String(value).split('.'); return {value:BigInt(whole.replace('-','')+fraction)*(whole.startsWith('-')?-1n:1n),scale:fraction.length}; }
  function decimal(value,scale) { const negative=value<0n;const digits=(negative?-value:value).toString().padStart(scale+1,'0');return (negative?'-':'')+(scale?digits.slice(0,-scale)+'.'+digits.slice(-scale):digits); }
  function difference(left,right) { const a=minor(left),b=minor(right),scale=Math.max(a.scale,b.scale);return decimal(a.value*10n**BigInt(scale-a.scale)-b.value*10n**BigInt(scale-b.scale),scale); }
  const palette=['#16795d','#d27b4f','#6554c9','#4287a8','#bd6480','#8c78b6'];
  function chart(spec,title,details,className='') {
    return `<div class="finwise-chart ${className}"><div class="finwise-chart-canvas"><canvas role="img" aria-label="${escape(title)}" data-chart="${escape(JSON.stringify(spec))}"></canvas></div><div class="sr-only">${details}</div></div>`;
  }
  function hydrateCharts(host) {
    if(!window.Chart) return;
    host.querySelectorAll('canvas[data-chart]').forEach(canvas=>{
      const existing=window.Chart.getChart?.(canvas);
      if(existing?.finwiseSpec===canvas.dataset.chart) return;
      existing?.destroy();
      const spec=JSON.parse(canvas.dataset.chart);
      const horizontal=spec.horizontal;
      const compact=value=>new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1}).format(value);
      const chart=new window.Chart(canvas,{
        type:spec.type,
        data:{labels:spec.labels,datasets:spec.datasets.map(dataset=>({
          ...dataset,backgroundColor:dataset.backgroundColor||dataset.borderColor,
          borderWidth:spec.type==='line'?2.5:0,borderRadius:spec.type==='bar'?5:0,
          maxBarThickness:spec.type==='bar'?24:undefined,
          pointRadius:spec.type==='line'?0:undefined,pointHoverRadius:spec.type==='line'?5:undefined,
          pointHitRadius:spec.type==='line'?12:undefined,spanGaps:false,tension:0.28,
          fill:false
        }))},
        options:{responsive:true,maintainAspectRatio:false,indexAxis:horizontal?'y':'x',animation:false,
          interaction:{mode:'index',intersect:false},
          plugins:{legend:{display:spec.datasets.length>1,position:'bottom',align:'start',labels:{usePointStyle:true,pointStyle:'circle',boxWidth:8,boxHeight:8,padding:18,color:'#566579',font:{size:11,weight:'600'}}},
            tooltip:{backgroundColor:'#182534',padding:11,cornerRadius:8,displayColors:spec.datasets.length>1,
              callbacks:{label:context=>`${context.dataset.label}: ${spec.currency} ${context.dataset.exact[context.dataIndex]}`}}},
          scales:{x:{stacked:Boolean(spec.stacked),grid:{display:horizontal,color:'#edf0f3'},border:{display:false},ticks:{color:'#8290a0',maxTicksLimit:spec.type==='line'?7:undefined,callback:horizontal?value=>compact(value):value=>spec.labels[value]??value,font:{size:11}}},
            y:{stacked:Boolean(spec.stacked),beginAtZero:spec.type==='bar',grid:{display:!horizontal,color:'#edf0f3'},border:{display:false},ticks:{color:'#8290a0',maxTicksLimit:horizontal?undefined:5,callback:horizontal?value=>{const label=spec.labels[value]||'';return label.length>22?`${label.slice(0,21)}…`:label;}:value=>compact(value),font:{size:11}}}}
        }
      });
      chart.finwiseSpec=canvas.dataset.chart;
    });
  }
  function sankey(rows,poolLabel,direction) {
    const positive=rows.filter(row=>Number(row.amount)>0).sort((a,b)=>Number(b.amount)-Number(a.amount));
    if(!positive.length) return '<p class="empty-state">No recorded flow for this month.</p>';
    const top=positive.slice(0,7),rest=positive.slice(7);
    if(rest.length) top.push({label:'Other categories',amount:sumMoney(rest.map(row=>row.amount)),currency:rest[0].currency});
    const labels=top.map(row=>row.label),values=top.map(row=>Number(row.amount));
    const currency=top[0].currency;
    const details=top.map(row=>`<p>${escape(row.label)} · ${escape(row.currency)} ${escape(row.amount)}</p>`).join('');
    return chart({type:'bar',horizontal:true,labels,currency,datasets:[{label:poolLabel,data:values,exact:top.map(row=>row.amount),backgroundColor:labels.map((_,index)=>palette[index%palette.length])}]},`${poolLabel} flow by category`,details,'category-chart');
  }
  function groupedBars(rows,currency) {
    if(!rows.length) return '<p class="empty-state">No monthly data yet.</p>';
    const labels=rows.map(row=>row.period);
    const datasets=[['Income','income',palette[0]],['Net spending','net_spending',palette[1]]].map(([label,key,color])=>({label,data:rows.map(row=>Number(row[key])),exact:rows.map(row=>row[key]),backgroundColor:color}));
    const details=rows.map(row=>`<p>${escape(row.period)} income ${escape(currency)} ${escape(row.income)}; ${escape(row.period)} spending ${escape(currency)} ${escape(row.net_spending)}</p>`).join('');
    return chart({type:'bar',labels,currency,datasets},'Monthly income and net spending chart',details);
  }
  function negate(value) { const item=minor(value); return decimal(-item.value,item.scale); }
  function categoryAverages(months,scale=2) {
    const totals=new Map();
    for(const month of months) for(const row of month) {
      if(!row.id) continue;
      const value=minor(row.amount);
      const scaled=value.value*10n**BigInt(scale)/10n**BigInt(value.scale);
      totals.set(row.id,(totals.get(row.id)||0n)+scaled);
    }
    const count=BigInt(months.length || 1);
    return new Map([...totals].map(([key,total])=>[key,decimal((total+count/2n)/count,scale)]));
  }
  function cumulativeSpending(current,previous,currency,currentLabel,previousLabel) {
    const accumulate=rows=>{let total=0;return rows.map(row=>{total+=Number(row.net_spending)||0;return {day:Number(row.period.slice(-2)),total,exact:total.toFixed(new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits)};});};
    const now=accumulate(current),before=accumulate(previous);
    if(!now.length && !before.length) return '<p class="empty-state">No daily data yet.</p>';
    const labels=Array.from({length:Math.max(31,...now.map(row=>row.day),...before.map(row=>row.day))},(_,index)=>String(index+1));
    const dataset=(name,rows,color,dashed=false)=>({label:name,data:labels.map((_,index)=>rows.find(row=>row.day===index+1)?.total??null),exact:labels.map((_,index)=>rows.find(row=>row.day===index+1)?.exact??null),borderColor:color,borderDash:dashed?[6,5]:undefined});
    const details=[...now.map(row=>`<p>${escape(currentLabel)} day ${row.day}: ${escape(currency)} ${row.exact} cumulative net spending</p>`),...before.map(row=>`<p>${escape(previousLabel)} day ${row.day}: ${escape(currency)} ${row.exact} cumulative net spending</p>`)].join('');
    return chart({type:'line',labels,currency,datasets:[dataset(currentLabel,now,palette[2]),dataset(previousLabel,before,'#9baac0',true)]},`Cumulative recorded net spending for ${currentLabel} and ${previousLabel}`,details);
  }
  function sumMoney(values,scale=2) {
    const total=values.reduce((sum,value)=>{const part=minor(value);return sum+part.value*10n**BigInt(scale-part.scale);},0n);
    return decimal(total,scale);
  }
  function subscriptionMonth(items,month) {
    const subscriptions=items.filter(item=>item.subscription&&!item.ignored);
    const rows=subscriptions.map(item=>{
      const occurrences=(item.occurrences||[]).filter(payment=>payment.date.slice(0,7)===month);
      const scale=new Intl.NumberFormat('en',{style:'currency',currency:item.currency}).resolvedOptions().maximumFractionDigits;
      return {...item,monthAmount:sumMoney(occurrences.map(payment=>payment.amount),scale),monthCount:occurrences.length,statementCount:occurrences.filter(payment=>payment.source==='bank_statement').length};
    });
    const byCurrency=new Map();
    for(const row of rows.filter(item=>item.monthCount)) {
      const group=byCurrency.get(row.currency)||{currency:row.currency,amounts:[],count:0,statementCount:0};
      group.amounts.push(row.monthAmount);
      group.count+=row.monthCount;
      group.statementCount+=row.statementCount;
      byCurrency.set(row.currency,group);
    }
    const totals=[...byCurrency.values()].map(group=>({currency:group.currency,amount:sumMoney(group.amounts,new Intl.NumberFormat('en',{style:'currency',currency:group.currency}).resolvedOptions().maximumFractionDigits),count:group.count,statementCount:group.statementCount})).sort((a,b)=>a.currency.localeCompare(b.currency));
    return {rows,totals};
  }
  function planningSummary(investments,obligations,month,currency,scale=2) {
    const holdings=investments.filter(item=>!item.archived||month<item.archived_at?.slice(0,7)).map(item=>{
      const records=(item.records||[]).filter(record=>record.month<=month).sort((a,b)=>a.month.localeCompare(b.month));
      const opening=item.opening_value!=null&&item.opening_month<=month?{month:item.opening_month,value:item.opening_value,net_contributions:item.opening_value,gain_loss:'0'}:null;
      const valuedIndex=records.findLastIndex(record=>record.value!=null);
      const pending=records.slice(valuedIndex+1).some(record=>record.value==null&&(Number(record.contribution)>0||Number(record.withdrawal)>0));
      const observed=valuedIndex>=0?records[valuedIndex]:opening;
      const snapshot=pending&&observed?{...observed,gain_loss:null}:observed;
      return {...item,snapshot,monthRecord:records.find(record=>record.month===month)||null};
    });
    const valued=holdings.filter(item=>item.currency===currency&&item.snapshot?.value!=null);
    const covered=valued.filter(item=>item.snapshot.gain_loss!=null);
    const selected=holdings.filter(item=>item.currency===currency&&item.monthRecord);
    const settlementRows=obligations.filter(item=>!item.reversed&&item.date.slice(0,7)<=month).map(item=>{
      const paid=sumMoney((item.repayments||[]).filter(payment=>!payment.reversed&&payment.date.slice(0,7)<=month).map(payment=>payment.amount),new Intl.NumberFormat('en',{style:'currency',currency:item.currency}).resolvedOptions().maximumFractionDigits);
      return {...item,asOfRemaining:difference(item.amount,paid)};
    }).filter(item=>minor(item.asOfRemaining).value>0n);
    return {
      holdings,settlementRows,
      value:sumMoney(valued.map(item=>item.snapshot.value),scale),
      invested:sumMoney(covered.map(item=>item.snapshot.net_contributions),scale),
      gain:sumMoney(covered.map(item=>item.snapshot.gain_loss),scale),
      added:sumMoney(selected.map(item=>item.monthRecord.contribution),scale),
      withdrawn:sumMoney(selected.map(item=>item.monthRecord.withdrawal),scale),
      valuedCount:valued.length,gainCount:covered.length,holdingCount:holdings.filter(item=>item.currency===currency).length,
      owedToMe:sumMoney(settlementRows.filter(item=>item.currency===currency&&item.direction==='owed_to_me').map(item=>item.asOfRemaining),scale),
      iOwe:sumMoney(settlementRows.filter(item=>item.currency===currency&&item.direction==='i_owe').map(item=>item.asOfRemaining),scale)
    };
  }
  function cumulativeMoney(rows,key,scale=2) {
    let total=0n;
    return rows.map(row=>{const part=minor(row[key]);total+=part.value*10n**BigInt(scale-part.scale);return decimal(total,scale);});
  }
  function pacedBudget(limit,days,scale=2) {
    if(days<=0) return [];
    const part=minor(limit),total=part.value*10n**BigInt(scale-part.scale),count=BigInt(days);
    return Array.from({length:days},(_,index)=>decimal((total*BigInt(index+1)+count/2n)/count,scale));
  }
  function moneyLines(labels,series,currency,title) {
    if(!labels.length || !series.length) return '<p class="empty-state">No chart data yet.</p>';
    const datasets=series.map((item,index)=>({label:item.name,data:item.values.map(value=>value==null?null:Number(value)),exact:item.values,borderColor:item.color||palette[index%palette.length],borderDash:item.dashed?[6,5]:undefined}));
    const details=series.flatMap(item=>item.values.map((value,index)=>value==null?'':`<p>${escape(item.name)} · ${escape(labels[index])}: ${escape(currency)} ${escape(value)}</p>`)).join('');
    return chart({type:'line',labels,currency,datasets},title,details);
  }
  const dashboardPalette=['#63845b','#91aa7c','#bdca9d','#d7be85','#dbe1cc','#9ebdb2'];
  function categoryRing(rows,currency) {
    const positive=rows.filter(row=>Number(row.amount)>0),total=positive.reduce((n,row)=>n+Number(row.amount),0);
    if(!positive.length)return '<p class="empty-state">No positive category spending this month.</p>';
    const net=sumMoney(rows.map(row=>row.amount),new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits);
    const formatted=new Intl.NumberFormat(currency==='INR'?'en-IN':'en',{style:'currency',currency,maximumFractionDigits:0}).format(Number(net));
    let offset=0;
    const segments=positive.map((row,i)=>{const start=offset;offset+=Number(row.amount)/total*100;return `${dashboardPalette[i%dashboardPalette.length]} ${start}% ${offset}%`;});
    const legend=rows.map((row,i)=>`<li><span class="dashboard-dot" style="background:${dashboardPalette[i%dashboardPalette.length]}"></span><span>${escape(row.label)}</span><b>${escape(currency)} ${escape(row.amount)}</b><small>${Number(row.amount)>0?Math.round(Number(row.amount)/total*100)+'%':'Refund'}</small></li>`).join('');
    return `<div class="dashboard-category-split"><div class="dashboard-ring" role="img" aria-label="Positive category spending ${escape(currency)} ${escape(sumMoney(positive.map(row=>row.amount),new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits))}" style="background:conic-gradient(${segments.join(',')})"><div><span>NET SPENDING</span><strong title="${escape(currency)} ${escape(net)}">${escape(formatted)}</strong><small>${positive.length} categories</small></div></div><ul class="dashboard-category-legend">${legend}</ul></div>`;
  }
  function categoryHistory(rollups,months,categories,currency) {
    const maps=rollups.map(rows=>new Map(rows));
    const ids=[...new Set(rollups.flatMap(rows=>rows.map(([key])=>key)))];
    const series=ids.map(key=>({id:key,label:key==='uncategorized'?'Uncategorized':categories.find(c=>c.id===key)?.name||'Category',values:maps.map(map=>map.get(key)?.amount||'0')}));
    if(!series.length)return '<p class="empty-state">No category history recorded.</p>';
    const datasets=series.map((item,i)=>({label:item.label,data:item.values.map(Number),exact:item.values,backgroundColor:dashboardPalette[i%dashboardPalette.length]}));
    return chart({type:'bar',stacked:true,labels:months,currency,datasets},'Six-month spending by category',series.map(item=>`<p>${escape(item.label)}: ${item.values.map((value,i)=>`${escape(months[i])} ${escape(currency)} ${escape(value)}`).join('; ')}</p>`).join(''));
  }
  function metricBreakdown(summary,transactions,key,currency) {
    const definitions={
      earned_income:{title:'Earned income',formula:'Eligible ordinary income',description:'Ordinary income allocations only. Transfers and linked reimbursement credits do not contribute.',field:'income',fallback:'income'},
      actual_spending:{title:'Net consumption spending',formula:'Consumption allocations − eligible refunds',description:'Eligible consumption spending, including your retained paid-on-behalf share, less eligible refunds. Transfers, card repayments and investment funding are excluded.',field:'spending',fallback:'net_spending'},
      net_invested:{title:'Net invested',formula:'Investment contributions − withdrawals',description:'Recorded investment contributions less capital withdrawals. Linked funding is counted once; security purchases do not create a second contribution.',field:'net_invested'},
      economic_surplus:{title:'Recorded surplus',formula:'Earned income − net consumption spending',description:'What you earned less what you consumed. This is a flow for the selected period, separate from account balances.',fallback:'recorded_surplus'}
    };
    const definition=definitions[key];
    if(!definition)throw new Error('Unknown dashboard metric.');
    const scale=new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits;
    const sum=values=>sumMoney(values,scale),byId=new Map();
    for(const line of summary.breakdown||[]) {
      const effects=key==='economic_surplus'?[line.income||'0',negate(line.spending||'0')]:[line[definition.field]||'0'];
      const group=byId.get(line.transaction_id)||{effects:[],types:new Set(),categories:new Set()};
      group.effects.push(...effects);group.types.add(line.transaction_type);
      if(line.category_id)group.categories.add(line.category_id);
      byId.set(line.transaction_id,group);
    }
    const rows=new Map(transactions.map(transaction=>[transaction.id,transaction]));
    // Keep every authoritative effect even if source metadata is no longer available.
    for(const transactionId of byId.keys())if(!rows.has(transactionId))rows.set(transactionId,{id:transactionId,description:'Recorded allocation',unavailable:true});
    const contributors=[],excluded=[];
    for(const transaction of rows.values()) {
      const group=byId.get(transaction.id),effects=group?.effects||[];
      const row={transaction,effect:sum(effects),types:[...(group?.types||[])].filter(Boolean),categories:[...(group?.categories||[])]};
      if(effects.some(value=>Number(value)!==0))contributors.push(row);
      else {
        const types=new Set(row.types.length?row.types:[transaction.event_type]);
        row.reason=types.has('transfer')?'Transfers and card repayments move money without creating income or consumption.':types.has('reimbursement')?'Reimbursement credits are separate from earned income; only eligible expense offsets affect consumption.':types.has('investment')||transaction.event_type==='investment_withdrawal'?'Investment funding and withdrawals affect net investment, separately from income and consumption.':types.has('paid_on_behalf')?'The share paid for someone else is separate from your consumption.':'No eligible allocation affects this metric in the selected scope.';
        excluded.push(row);
      }
    }
    contributors.sort((a,b)=>Math.abs(Number(b.effect))-Math.abs(Number(a.effect))||String(b.transaction.effective_date||'').localeCompare(a.transaction.effective_date||'')||String(a.transaction.id).localeCompare(String(b.transaction.id)));
    const effects=[...byId.values()].flatMap(group=>group.effects);
    const positive=sum(effects.filter(value=>Number(value)>0)),offsets=negate(sum(effects.filter(value=>Number(value)<0)));
    return {...definition,key,total:summary[key]??summary[definition.fallback]??'0',positive,offsets,explained:sum(effects),contributors,excluded};
  }
  window.finwiseAnalytics={metricBreakdown,categoryRing,categoryHistory,difference,negate,sankey,groupedBars,categoryAverages,cumulativeSpending,sumMoney,subscriptionMonth,planningSummary,cumulativeMoney,pacedBudget,moneyLines,hydrateCharts};
})();
