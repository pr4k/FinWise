const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
function workspace() {
  const calls={charts:0,activity:0,network:[]};
  const state={month:'2026-10',scope:'combined',view:'investments',investmentTab:'holdings',investmentFilter:'all',me:{user:{id:'u'},household:{base_currency:'INR'}},categories:[],accounts:[],members:[]};
  const holding={id:'h',name:'Fund',owner_id:'u',currency:'INR',type:'investment',records:[{month:'2026-10',contribution:'7.77',withdrawal:'0',value:'100.00',net_contributions:'90.00',gain_loss:'10.00'}]};
  state.investmentViewData={holdings:[holding],taggedTransactions:[],goals:[],report:{}};
  const root={innerHTML:'',querySelectorAll:()=>[],getAttribute:()=> 'false'};
  const context={state,root,Intl,URLSearchParams,Date,Map,Set,Number,BigInt,
    h:String,id:encodeURIComponent,householdDate:()=> '2026-10-24',
    amount:value=>{if(value==='7.77')calls.activity++;return String(value);},responsiveAmount:String,
    button:()=>'',heading:()=>'',table:(_headers,rows)=>JSON.stringify(rows),
    trackedCategoryRows:()=>[],investmentGainTone:()=>'',investmentSipForMonth:()=>null,sipDueDate:()=>null,
    subscriptionBrands:{hydrate:()=>{}},window:{},
    analyticsView:{sumMoney:values=>values.reduce((sum,value)=>sum+Number(value),0).toFixed(2),difference:(a,b)=>(Number(a)-Number(b)).toFixed(2),moneyLines:()=>{calls.charts++;return '<chart>';},hydrateCharts:()=>{}},
    api:{collection:async path=>{calls.network.push(path);return {data:[{id:path}]};}}
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function investmentSnapshot('),source.indexOf('function updateLinkedInvestmentView(')),context);
  return {context,state,calls,root};
}
test('investment tabs render loaded data without requests or building hidden activity/charts',()=>{
  const {context,state,calls,root}=workspace();
  context.renderInvestmentTab();
  assert.match(root.innerHTML,/Holdings/);
  assert.equal(calls.activity,0);
  assert.equal(calls.charts,0);
  state.investmentTab='activity';
  context.renderInvestmentTab();
  assert.match(root.innerHTML,/Monthly activity/);
  assert.equal(calls.activity,1);
  assert.equal(calls.charts,0);
  state.investmentTab='overview';
  context.renderInvestmentTab();
  assert.equal(calls.charts,1);
  assert.equal(calls.network.length,0);
});
test('historical funding stays available on demand outside the selected month',async()=>{
  const {context,calls}=workspace();
  const transactions=await context.investmentFundingHistory();
  assert.deepEqual(calls.network,['transactions?event_type=expense','transactions?event_type=refund']);
  assert.equal(transactions.length,2);
});
test('investment workspace initially requests the selected month',async()=>{
  const calls=[];
  const context={state:{month:'2026-10',scope:'personal',me:{household:{base_currency:'INR'}}},
    period:()=>({from:'2026-10-01',to:'2026-11-01'}),URLSearchParams,
    allInvestments:async()=>[],api:{collection:async path=>{calls.push(path);return {data:[]};},request:async()=>({data:[]})},investmentContent:()=> 'workspace'};
  vm.createContext(context);
  const start=source.indexOf('  async investments() {');
  const end=source.indexOf('\n  async imports(',start);
  vm.runInContext('var view={'+source.slice(start,end)+'};',context);
  assert.equal(await context.view.investments(),'workspace');
  assert.deepEqual(calls,['transactions?from=2026-10-01&to=2026-11-01']);
});

test('standalone and split tagged investments appear in overview and activity',()=>{
  const {context,state,root}=workspace();
  state.categories=[{id:'invest',tracking_type:'investment'}];
  const transaction={id:'tagged',description:'Independent fund',event_type:'expense',currency:'INR',effective_date:'2026-10-12',amount:'150.00',allocations:[{category_id:'invest',scope:'personal',amount:'100.00'},{category_id:'food',scope:'personal',amount:'50.00'}]};
  state.investmentViewData.taggedTransactions=[transaction];
  context.trackedCategoryRows=()=>[{transaction,allocation:transaction.allocations[0]}];
  context.trackedCategoryPanel=(rows,title)=>title+rows.map(row=>row.transaction.description).join('');
  const funding=context.investmentFunding([], [transaction], [], state.month,'INR');
  assert.equal(funding.pending[0].amount,'100.00');
  for(const tab of ['overview','activity']) {
    state.investmentTab=tab;
    context.renderInvestmentTab();
    assert.match(root.innerHTML,/Tagged investment transactions · Combined householdIndependent fund/);
  }
  state.investmentTab='overview';
  context.renderInvestmentTab();
  assert.match(root.innerHTML,/tagged, unassigned net 100.00/);
});

test('monthly investment headline uses the shared report total and breakdown',()=>{
  const {context,state,root}=workspace();
  state.investmentTab='overview';
  state.investmentViewData.report={contributed:'65768.00',withdrawn:'0.00',unassigned_net:'27430.54',net_invested:'93198.54'};
  context.renderInvestmentTab();
  assert.match(root.innerHTML,/Net invested in 2026-10 · Combined household<\/span><strong>93198.54<\/strong>/);
  assert.match(root.innerHTML,/Recorded contributions 65768.00 · withdrawn 0.00 · tagged, unassigned net 27430.54/);
});

test('personal investment activity uses payer, including family-scoped payments',()=>{
  const {context,state,root}=workspace();
  state.categories=[{id:'invest',tracking_type:'investment'}];
  state.accounts=[{id:'bank',owner_id:'u'}];
  const entries=[['other','25000.00','personal'],['u','2430.54','family']].map(([payer,value,scope])=>({id:payer,event_type:'expense',description:payer==='u'?'My payment':'Other member payment',paid_by_user_id:payer,entered_by:'u',movements:[{account_id:'bank'}],effective_date:'2026-10-03',currency:'INR',amount:value,allocations:[{category_id:'invest',scope,amount:value}]}));
  state.investmentViewData.taggedTransactions=entries;
  context.trackedCategoryRows=()=>entries.map(transaction=>({transaction,allocation:transaction.allocations[0]}));
  context.trackedCategoryPanel=(rows,title)=>title+rows.map(row=>row.transaction.description).join(' ');
  state.investmentTab='activity';
  state.scope='personal';
  context.renderInvestmentTab();
  assert.match(root.innerHTML,/My payment/);
  assert.doesNotMatch(root.innerHTML,/Other member payment/);
  assert.equal(context.investmentFunding([],entries,state.accounts,state.month,'INR').pending[0].amount,'2430.54');
  assert.equal(context.investmentFunding([],entries,state.accounts,state.month,'INR').pending.length,1);
  state.scope='combined';
  context.renderInvestmentTab();
  assert.match(root.innerHTML,/Other member payment/);
  state.investmentTab='overview';
  state.investmentViewData.report={net_invested:'27430.54',unassigned_net:'27430.54',personal_net_invested:'2430.54',personal_unassigned_net:'2430.54'};
  context.renderInvestmentTab();
  assert.match(root.innerHTML,/Combined household<\/span><strong>27430.54/);
  assert.match(root.innerHTML,/Paid by you \(net\) 2430.54 · your unassigned net 2430.54/);
});

test('tagged investment table identifies the payer',()=>{
  const {context,state}=workspace();
  context.payerName=()=> 'Other member';
  context.payerId=()=> 'other';
  context.categoryName=()=> 'Investing';
  context.panel=(title,body)=>title+body;
  context.table=(headers,rows)=>JSON.stringify({headers,rows});
  vm.runInContext(source.slice(source.indexOf('function trackedCategoryPanel('),source.indexOf('function unlinkedSubscriptionRows(')),context);
  const row={transaction:{effective_date:'2026-10-03',event_type:'expense',currency:'INR',description:'Payment'},category:{id:'invest'},allocation:{amount:'25000.00'}};
  const html=context.trackedCategoryPanel([row],'Tagged',state.month,null,true);
  assert.match(html,/Paid by/);
  assert.match(html,/Other member/);
  assert.doesNotMatch(html,/Other member · You/);
});

test('Add money preselects an emergency fund and limits the source account currency',async()=>{
  const fund={id:'cc',name:'CC emergency',type:'emergency_fund',owner_id:'u',currency:'INR'};
  const panels={'#investment-transaction-new':{},'#investment-transaction-hint':{}};
  const form={elements:{holding_id:{value:''},investment_name:{},account_id:{value:''},amount:{focus:()=>{}}},querySelector:selector=>panels[selector]};
  const rendered=[];
  const context=vm.createContext({
    state:{view:'investments',month:'2026-10',me:{user:{id:'u'}},transactionFilters:{},accounts:[{id:'bank',name:'Bank',currency:'INR'},{id:'usd',name:'Dollar bank',currency:'USD'}]},
    allInvestments:async()=>[fund,{...fund,id:'archived',archived:true},{...fund,id:'other',owner_id:'someone-else'}],
    dialog:{querySelector:()=>form},document:{querySelector:()=>form},
    h:String,option:(value,label)=>`<option value="${value}">${label}</option>`,field:(_label,html)=>html,input:()=>'',moneyInput:()=>'',
    localDate:()=> '2026-10-24',lastTransactionAccount:()=>'',editor:(...args)=>rendered.push(args)
  });
  vm.runInContext(source.slice(source.indexOf('async function investmentTransactionEditor('),source.indexOf('function planEditor(')),context);
  await context.investmentTransactionEditor('cc');
  assert.equal(rendered[0][0],'Add money to emergency fund');
  assert.equal(form.elements.holding_id.value,'cc');
  assert.equal(panels['#investment-transaction-new'].hidden,true);
  assert.equal(form.elements.investment_name.required,false);
  assert.match(form.elements.account_id.innerHTML,/Bank/);
  assert.doesNotMatch(form.elements.account_id.innerHTML,/Dollar bank/);
  assert.match(panels['#investment-transaction-hint'].textContent,/without counting as an expense/);
  assert.equal(form.investmentHoldings.length,1);
});

test('emergency fund submission posts a contribution rather than an expense',async()=>{
  const requests=[];
  const context=vm.createContext({
    state:{accounts:[{id:'bank',currency:'INR'}]},
    form:{closest:()=>null},data:{holding_id:'cc',account_id:'bank',amount:'2000.00',transaction_date:'2026-10-24',value:'3000.00'},
    id:encodeURIComponent,notify:()=>{},
    api:{request:async(path,options)=>{requests.push({path,options});return {id:'cc',type:'emergency_fund',currency:'INR',revision:3};}}
  });
  const start=source.indexOf("    } else if(form.id==='investment-transaction-form') {")+"    } else if(form.id==='investment-transaction-form') {".length;
  const end=source.indexOf("    } else if(form.id==='investment-goal-form') {",start);
  await vm.runInContext('(async()=>{'+source.slice(start,end)+'})()',context);
  assert.equal(requests.length,2);
  assert.equal(requests[1].path,'investments/cc/contributions');
  assert.equal(requests[1].options.body.account_id,'bank');
  assert.equal(requests[1].options.body.amount,'2000.00');
  assert.equal(requests[1].options.body.value,'3000.00');
});

test('emergency fund holdings are separate from the regular investment value',()=>{
  const {context,state,root}=workspace();
  state.investmentTab='overview';
  state.investmentViewData.holdings.push({id:'emergency',name:'CC emergency',owner_id:'u',type:'emergency_fund',currency:'INR',records:[{month:'2026-10',contribution:'5000.00',withdrawal:'0',value:'5000.00',net_contributions:'5000.00',gain_loss:'0'}]});
  context.renderInvestmentTab();
  assert.match(root.innerHTML,/Investment value \(excluding emergency funds\)<\/span><strong>100.00<\/strong>/);
  assert.match(root.innerHTML,/Separate emergency funds/);
  assert.match(root.innerHTML,/CC emergency/);
});
