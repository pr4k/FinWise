const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
function helpers() {
  const context=vm.createContext({
    h:String,Intl,Set,Number,amount:(value,currency)=>value==null?'Unknown':`${currency} ${value}`,
    moneyFigure:(value,currency)=>value==null?'Unknown':`${currency} ${value}`,
    panel:(title,body)=>title+body,table:(headers,rows)=>JSON.stringify({headers,rows}),
    analyticsView:{sumMoney:values=>values.reduce((sum,value)=>sum+Number(value),0).toFixed(2)},
    householdDate:()=> '2026-10-24',investmentSnapshot:holding=>holding
  });
  vm.runInContext(source.slice(source.indexOf('const accountAvailable ='),source.indexOf('const field =')),context);
  return context;
}
const account={id:'bank',name:'Savings',subtype:'bank',currency:'INR',balance:{amount:'100000.00'},funds:{available:'71538.00',reserved:'28462.00',emergency_reserved:'18462.00',other_reserved:'10000.00',reservation_shortfall:'0.00',goals:[{name:'CC emergency',requested:'18462.00',reserved:'18462.00'},{name:'Holiday',requested:'10000.00',reserved:'10000.00'}]}};
test('account cards show available funds and account details retain the full recorded balance',()=>{
  const context=helpers();
  const card=vm.runInContext('accountBalance',context)(account);
  assert.match(card,/71538.00/);
  assert.match(card,/Available after reservations/);
  assert.doesNotMatch(card,/100000.00/);
  const detail=context.accountReservationPanel(account);
  assert.match(detail,/100000.00/);
  assert.match(detail,/71538.00/);
  assert.match(detail,/CC emergency/);
  assert.match(detail,/18462.00/);
  assert.match(detail,/Other earmarked money/);
});
test('summary reserves keep currencies, liabilities and separate emergency holdings apart',()=>{
  const context=helpers();
  const usd={...account,id:'usd',currency:'USD',balance:{amount:'100.00'},funds:{available:'60.00',reserved:'40.00',emergency_reserved:'40.00',other_reserved:'0.00'}};
  const card={id:'card',subtype:'credit_card',currency:'INR',balance:{amount:'5000.00'}};
  const emergency={id:'emergency',type:'emergency_fund',name:'Separate fund',currency:'INR',valued:{value:'900.00',month:'2026-10'}};
  const html=context.accountFundsPanel([account,usd,card],[emergency]);
  assert.match(html,/INR 71538.00/);
  assert.match(html,/USD 60.00/);
  assert.match(html,/Emergency reserves in accounts/);
  assert.match(html,/Separate emergency fund holdings/);
  assert.match(html,/INR 900.00/);
  assert.doesNotMatch(html,/5000.00/);
});
test('unknown balances stay unknown and shortfalls are shown in account details',()=>{
  const context=helpers();
  const unknown={...account,balance:{amount:null},funds:{available:null,reserved:null,emergency_reserved:null,other_reserved:null,goals:[]}};
  assert.match(vm.runInContext('accountBalance',context)(unknown),/Unknown/);
  const shortfall={...account,funds:{...account.funds,available:'0.00',reservation_shortfall:'500.00'}};
  assert.match(context.accountReservationPanel(shortfall),/INR 500.00 of requested reserves is no longer covered/);
});

test('dashboard separates recorded balances, available funds, reserves, currencies and card repayments',async()=>{
  const context=helpers();
  const card={id:'card',name:'Card',currency:'INR',subtype:'credit_card',balance:{amount:'5000.00'}};
  const usd={...account,id:'usd',currency:'USD',balance:{amount:'999.00'}};
  const transfers=[{id:'payment',event_type:'transfer',amount:'20.00',movements:[{account_id:'bank',amount:'-20.00'},{account_id:'card',amount:'20.00'}]}];
  Object.assign(context,{
    state:{members:[],month:'2026-10',scope:'combined',me:{household:{base_currency:'INR'}},accounts:[account,card,usd],categories:[]},
    reportQuery:()=>'',period:()=>({from:'2026-10-01',to:'2026-11-01'}),Date,Map,URLSearchParams,smartReviewPanel:()=>'',
    api:{request:async path=>path.startsWith('analytics/dashboard')?{summary:{recorded_surplus:'0.00',income:'0.00',net_spending:'0.00',after_investment_cash_flow:'0.00',transfer_volume:'100.00'},series:{data:[]},categories:{data:[]},accounts:{data:[account,card,usd]}}:{data:[]},collection:async path=>({data:path.startsWith('analytics/transactions')?transfers:[]})},
    views:{dashboardReports:async()=>''},scopeTabs:()=>'',allInvestments:async()=>[],categoryView:{rollup:()=>new Map()},moneyTone:()=>'',
    responsiveAmount:(value,currency)=>value==null?'Unknown':`${currency} ${value}`,field:(_label,control)=>control,option:(value,label)=>`<option value="${value}">${label}</option>`,heading:()=>'',button:()=>'',navButton:()=>'',empty:()=>'',coverage:()=>''
  });
  context.analyticsView.difference=(a,b)=>(Number(a)-Number(b)).toFixed(2);
  context.analyticsView.categoryRing=()=>'';
  context.analyticsView.categoryHistory=()=>'';
  context.analyticsView.cumulativeMoney=()=>[];
  context.analyticsView.moneyLines=()=>'';
  context.analyticsView.subscriptionMonth=()=>({rows:[]});
  const start=source.indexOf('  async overview() {');
  const end=source.indexOf('\n  async analytics()',start);
  vm.runInContext('var view={'+source.slice(start,end)+'};',context);
  const html=await context.view.overview();
  assert.match(html,/Available money and reserves/);
  assert.match(html,/INR 71538.00/);
  assert.match(html,/Account snapshot/);
  assert.match(html,/Reserved funds/);
  assert.match(html,/INR 28462.00/);
  assert.match(html,/100000.00/);
  assert.match(html,/Bank & cash recorded/);
  assert.match(html,/After reserves/);
  assert.match(html,/Internal transfers[\s\S]*?INR 80.00/);
  assert.match(html,/Card payments[\s\S]*?INR 20.00/);
  assert.doesNotMatch(html,/999.00/);
  assert.match(html,/Credit card owed[\s\S]*?INR 5000.00/);
});

test('opened account leads with the reduced available balance and retains the recorded breakdown',async()=>{
  const context=helpers();
  const selected={...account,owner_id:'u',visibility:'private',balance:{...account.balance,source:'opening_balance',as_of:'2026-10-25T00:00:00Z'}};
  Object.assign(context,{
    state:{accounts:[selected],month:'2026-10',categories:[],me:{user:{id:'u'}}},
    Date,Map,URLSearchParams,period:()=>({from:'2026-10-01',to:'2026-11-01'}),
    id:encodeURIComponent,viewState:{transactionsPath:()=> 'transactions'},
    api:{collection:async()=>({data:[]}),request:async()=>({data:[]})},
    button:(title,action)=>`<button data-action="${action}">${title}</button>`,dangerButton:()=>'',navButton:()=>'',empty:()=>'',coverage:()=>'',moneyTone:()=>''
  });
  context.analyticsView.difference=(a,b)=>(Number(a)-Number(b)).toFixed(2);
  context.analyticsView.negate=value=>String(-Number(value));
  context.analyticsView.subscriptionMonth=()=>({rows:[]});
  const start=source.indexOf('  async accounts(parts) {');
  const end=source.indexOf('\n  async changes()',start);
  vm.runInContext('var view={'+source.slice(start,end)+'};',context);
  const html=await context.view.accounts(['bank']);
  assert.match(html,/My account · bank/);
  assert.match(html,/<span>Available to use<\/span>INR 71538.00/);
  assert.match(html,/Recorded balance INR 100000.00 · earmarked INR 28462.00/);
  assert.match(html,/Available and earmarked money/);
  selected.subtype='credit_card';
  delete selected.funds;
  const card=await context.view.accounts(['bank']);
  assert.match(card,/<span>Amount owed<\/span>INR 100000.00/);
  selected.owner_id='family-member';
  selected.visibility='shared';
  const sharedCard=await context.view.accounts(['bank']);
  assert.match(sharedCard,/data-action="opening-balance">Set known balance/);
  assert.doesNotMatch(sharedCard,/data-action="edit-account"/);
  selected.opening_balance={amount:'2000.00',as_of:'2026-10-01T00:00:00Z'};
  assert.match(await context.view.accounts(['bank']),/data-action="opening-balance">Edit known balance/);
  selected.visibility='private';
  assert.doesNotMatch(await context.view.accounts(['bank']),/data-action="opening-balance"/);
});

test('account history preserves newest-first ledger order and balances, including same-time entries',async()=>{
  const context=helpers();
  const ledger=[
    {event_type:'balance_check',description:'Latest check',effective_at:'2026-10-25T00:14:00+05:30',movement:null,balance_after:'337410.00'},
    {event_type:'transfer',description:'Recent transfer',effective_at:'2026-10-23T10:00:00+05:30',movement:'25000.00',balance_after:'226267.00'},
    {event_type:'transfer',description:'Same-time incoming',effective_at:'2026-10-17T10:00:00+05:30',movement:'9941.00',balance_after:'201267.00'},
    {event_type:'transfer',description:'Same-time payment',effective_at:'2026-10-17T10:00:00+05:30',movement:'-11000.00',balance_after:'201267.00'},
    {event_type:'opening_balance',description:'Starting balance',effective_at:'2026-10-09T22:22:00+05:30',movement:null,balance_after:'140864.00'}
  ];
  Object.assign(context,{
    state:{accounts:[{...account,owner_id:'u',visibility:'private'}],month:'2026-10',categories:[],me:{user:{id:'u'}}},
    Date,Map,URLSearchParams,period:()=>({from:'2026-10-01',to:'2026-11-01'}),
    id:encodeURIComponent,viewState:{transactionsPath:()=> 'transactions'},
    api:{collection:async path=>({data:path.includes('/ledger')?ledger:[]}),request:async()=>({data:[]})},
    button:()=>'',dangerButton:()=>'',navButton:()=>'',empty:()=>'',coverage:()=>'',moneyTone:()=>'',balanceLabel:()=> 'from known balance'
  });
  context.analyticsView.difference=(a,b)=>(Number(a)-Number(b)).toFixed(2);
  context.analyticsView.negate=value=>String(-Number(value));
  context.analyticsView.subscriptionMonth=()=>({rows:[]});
  const start=source.indexOf('  async accounts(parts) {');
  const end=source.indexOf('\n  async changes()',start);
  vm.runInContext('var view={'+source.slice(start,end)+'};',context);
  for(const route of [['bank'],['bank','all']]) {
    const html=await context.view.accounts(route);
    const history=html.slice(html.indexOf('<div class="account-ledger-list">'));
    const dates=[...history.matchAll(/<time datetime="([^"]+)"/g)].map(match=>match[1]);
    assert.deepEqual(dates,ledger.map(row=>row.effective_at));
    const descriptions=[...history.matchAll(/account-ledger-copy"><strong>([^<]+)<\/strong>/g)].map(match=>match[1]);
    assert.deepEqual(descriptions,ledger.map(row=>row.description));
    const balances=[...history.matchAll(/Balance after · INR ([\d.]+)/g)].map(match=>match[1]);
    assert.deepEqual(balances,ledger.map(row=>row.balance_after));
  }
});

test('accounts page shows balances for every family owner regardless of selected scope',async()=>{
  const context=helpers();
  const accounts=[
    {...account,owner_id:'u',visibility:'private'},
    {...account,id:'family-bank',name:'Family savings',owner_id:'member',visibility:'shared',funds:{...account.funds,available:'42000.00'}},
    {id:'family-card',name:'Family card',owner_id:'member',visibility:'shared',subtype:'credit_card',currency:'INR',balance:{amount:'2500.00'}},
    {...account,id:'former-member',owner_id:'former',visibility:'shared'},
    {...account,id:'archived',name:'Archived savings',archived:true}
  ];
  Object.assign(context,{
    state:{accounts,members:[{user_id:'member',name:'Priya'}],scope:'personal',me:{user:{id:'u'}}},
    Map,encodeURIComponent,api:{request:async()=>({data:[]})},
    heading:(title,description)=>title+description,button:()=>'',empty:()=>'',coverage:()=>''
  });
  const start=source.indexOf('  async accounts(parts) {');
  const end=source.indexOf('\n  async changes()',start);
  vm.runInContext('var view={'+source.slice(start,end)+'};',context);
  for(const scope of ['personal','family','combined']) {
    context.state.scope=scope;
    const html=await context.view.accounts([]);
    assert.match(html,/My account/);
    assert.match(html,/Priya’s account/);
    assert.match(html,/Family member’s account/);
    assert.match(html,/Family savings/);
    assert.match(html,/INR 42000.00/);
    assert.match(html,/Family card/);
    assert.match(html,/INR 2500.00/);
    assert.doesNotMatch(html,/Archived savings/);
  }
  context.state.accounts=[accounts[1]];
  context.state.members=[];
  const html=await context.view.accounts([]);
  assert.match(html,/Family member’s account/);
});
