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

test('dashboard renders available account balances and reserves separately',async()=>{
  const context=helpers();
  Object.assign(context,{
    state:{month:'2026-10',scope:'combined',me:{household:{base_currency:'INR'}},accounts:[account],categories:[]},
    reportQuery:()=>'',Date,Map,
    api:{request:async path=>path.startsWith('analytics/dashboard')?{summary:{recorded_surplus:'0.00',income:'0.00',net_spending:'0.00'},categories:{data:[]},accounts:{data:[account]}}:{data:[]},collection:async()=>({data:[]})},
    allInvestments:async()=>[],categoryView:{rollup:()=>new Map()},moneyTone:()=>'',
    responsiveAmount:String,heading:()=>'',button:()=>'',navButton:()=>'',empty:()=>'',coverage:()=>''
  });
  const start=source.indexOf('  async overview() {');
  const end=source.indexOf('\n  async analytics()',start);
  vm.runInContext('var view={'+source.slice(start,end)+'};',context);
  const html=await context.view.overview();
  assert.match(html,/Available money and reserves/);
  assert.match(html,/INR 71538.00/);
  assert.match(html,/Emergency reserves in accounts/);
  assert.match(html,/INR 18462.00/);
  assert.doesNotMatch(html,/100000.00/);
});
