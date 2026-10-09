const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../analytics.js'),'utf8');
function analytics(){const context={window:{},BigInt};vm.runInNewContext(code,context);return context.window.finwiseAnalytics;}

test('month comparison preserves exact decimal differences',()=>{
  const view=analytics();
  assert.equal(view.difference('100.01','99.99'),'0.02');
  assert.equal(view.difference('90.00','100.00'),'-10.00');
});
test('flow chart labels escaped categories and reports exact amounts',()=>{
  const view=analytics();
  const svg=view.sankey([{label:'Food <script>',amount:'12.50',currency:'INR'}],'Recorded spending','expense');
  assert.match(svg,/role="img"/);
  assert.match(svg,/Food &lt;script&gt;/);
  assert.match(svg,/INR 12.50/);
  assert.doesNotMatch(svg,/<script>/);
});
test('card debt direction and monthly chart retain exact display values',()=>{
  const view=analytics();
  assert.equal(view.negate('-125.40'),'125.40');
  const chart=view.groupedBars([{period:'2026-09',income:'1000.00',net_spending:'125.40'}],'INR');
  assert.match(chart,/role="img"/);
  assert.match(chart,/data-chart=/);
  assert.match(chart,/2026-09 income INR 1000.00/);
  assert.match(chart,/2026-09 spending INR 125.40/);
});
test('category averages include quiet months and keep currency precision',()=>{
  const view=analytics();
  const averages=view.categoryAverages([
    [{id:'groceries',amount:'90.00'},{id:'rent',amount:'1000.00'}],
    [{id:'groceries',amount:'30.00'}],
    [{id:'groceries',amount:'0.00'}]
  ]);
  assert.equal(averages.get('groceries'),'40.00');
  assert.equal(averages.get('rent'),'333.33');
});
test('cumulative spending graph compares days and escapes labels',()=>{
  const view=analytics();
  const graph=view.cumulativeSpending(
    [{period:'2026-08-01',net_spending:'10.00'},{period:'2026-08-02',net_spending:'5.00'}],
    [{period:'2026-07-01',net_spending:'8.00'}],
    'INR','August <current>','July'
  );
  assert.match(graph,/role="img"/);
  assert.match(graph,/INR 15.00 cumulative net spending/);
  assert.match(graph,/August &lt;current&gt;/);
  assert.doesNotMatch(graph,/<current>/);
});
test('budget pace and cumulative amounts keep exact money values',()=>{
  const view=analytics();
  assert.equal(view.sumMoney(['10.10','2.05','-1.00']), '11.15');
  assert.deepEqual(Array.from(view.cumulativeMoney([{net_spending:'10.10'},{net_spending:'-2.05'}],'net_spending')),['10.10','8.05']);
  const pace=Array.from(view.pacedBudget('100.01',3));
  assert.deepEqual(pace,['33.34','66.67','100.01']);
});
test('subscription month totals use tagged payments in the selected month and keep currencies separate',()=>{
  const view=analytics();
  const result=view.subscriptionMonth([
    {key:'a',currency:'INR',subscription:true,ignored:false,occurrences:[{date:'2026-09-05',amount:'499.00',source:'money_manager_or_ledger'},{date:'2026-09-20',amount:'99.50',source:'bank_statement'},{date:'2026-08-05',amount:'499.00',source:'bank_statement'}]},
    {key:'b',currency:'INR',subscription:true,ignored:false,occurrences:[{date:'2026-09-10',amount:'250.25',source:'money_manager_or_ledger'}]},
    {key:'c',currency:'USD',subscription:true,ignored:false,occurrences:[{date:'2026-09-11',amount:'8.99',source:'bank_statement'}]},
    {key:'d',currency:'INR',subscription:true,ignored:true,occurrences:[{date:'2026-09-12',amount:'1000.00',source:'bank_statement'}]},
    {key:'e',currency:'INR',subscription:false,ignored:false,occurrences:[{date:'2026-09-13',amount:'300.00',source:'bank_statement'}]}
  ],'2026-09');
  assert.equal(result.rows.length,3);
  assert.equal(result.rows[0].monthAmount,'598.50');
  assert.equal(result.rows[0].monthCount,2);
  assert.equal(result.rows[0].statementCount,1);
  assert.deepEqual(Array.from(result.totals,({currency,amount,count,statementCount})=>({currency,amount,count,statementCount})),[
    {currency:'INR',amount:'848.75',count:3,statementCount:1},
    {currency:'USD',amount:'8.99',count:1,statementCount:1}
  ]);
});
test('multi-line chart separates series, shows exact values, and leaves gaps',()=>{
  const view=analytics();
  const chart=view.moneyLines(['01','02'],[
    {name:'Income <source>',values:['100.00','110.00']},
    {name:'Expense',values:['20.00',null],dashed:true}
  ],'INR','Cash flow');
  assert.match(chart,/aria-label="Cash flow"/);
  assert.match(chart,/data-chart=/);
  assert.match(chart,/Income &lt;source&gt;/);
  assert.match(chart,/INR 110.00/);
  assert.doesNotMatch(chart,/<source>/);
  assert.doesNotMatch(chart,/Expense · 02/);
});
test('planning analytics uses selected-month valuations and repayments without mixing currencies',()=>{
  const view=analytics();
  const result=view.planningSummary([
    {currency:'INR',records:[{month:'2026-09',value:'1010.00',net_contributions:'1000.00',gain_loss:'10.00',contribution:'1000.00',withdrawal:'0.00'},{month:'2026-11',value:'1500.00',net_contributions:'1200.00',gain_loss:'300.00',contribution:'200.00',withdrawal:'0.00'}]},
    {currency:'USD',records:[{month:'2026-10',value:'50.00',net_contributions:'40.00',gain_loss:'10.00',contribution:'40.00',withdrawal:'0.00'}]}
  ],[
    {currency:'INR',date:'2026-09-05',direction:'owed_to_me',amount:'100.00',repayments:[{date:'2026-10-12',amount:'30.00'},{date:'2026-11-02',amount:'20.00'}]},
    {currency:'USD',date:'2026-10-01',direction:'i_owe',amount:'20.00',repayments:[]}
  ],'2026-10','INR');
  assert.equal(result.value,'1010.00');
  assert.equal(result.gain,'10.00');
  assert.equal(result.added,'0.00');
  assert.equal(result.owedToMe,'70.00');
  assert.equal(result.iOwe,'0.00');
  assert.equal(result.valuedCount,1);
  assert.equal(result.settlementRows.length,2);
});
