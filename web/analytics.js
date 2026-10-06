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
      const spec=JSON.parse(canvas.dataset.chart);
      const horizontal=spec.horizontal;
      const compact=value=>new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1}).format(value);
      new window.Chart(canvas,{
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
          scales:{x:{grid:{display:horizontal,color:'#edf0f3'},border:{display:false},ticks:{color:'#8290a0',maxTicksLimit:spec.type==='line'?7:undefined,callback:horizontal?value=>compact(value):undefined,font:{size:11}}},
            y:{beginAtZero:spec.type==='bar',grid:{display:!horizontal,color:'#edf0f3'},border:{display:false},ticks:{color:'#8290a0',maxTicksLimit:horizontal?undefined:5,callback:horizontal?value=>{const label=spec.labels[value]||'';return label.length>22?`${label.slice(0,21)}…`:label;}:value=>compact(value),font:{size:11}}}}
        }
      });
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
  window.finwiseAnalytics={difference,negate,sankey,groupedBars,categoryAverages,cumulativeSpending,sumMoney,cumulativeMoney,pacedBudget,moneyLines,hydrateCharts};
})();
