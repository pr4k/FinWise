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
