const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
function load(scope,plans=[]) {
  const calls=[],window={};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../analytics.js'),'utf8'),{window,BigInt});
  const context=vm.createContext({state:{scope,month:'2026-10',budgetTab:'top',categories:[],members:[],me:{user:{id:'me'},membership:{role:'owner'},household:{base_currency:'INR'}}},
    api:{collection:async path=>{calls.push(path);return {data:plans};},request:async path=>{calls.push(path);return path.includes('/tracking')?{data:[],unbudgeted:'0.00',total_committed:'0.00',available_after_commitments:'0.00'}:path.includes('/forecast')?{quality_flags:[],status:'unavailable',reason:'No history'}:path.startsWith('analytics/summary')?{income:'0.00'}:{data:[]};}},
    h:String,id:encodeURIComponent,URLSearchParams,Date,Map,Number,Intl,analyticsView:window.finwiseAnalytics,
    heading:(title,desc,actions='')=>`<h1>${title}</h1>${desc}${actions}`,panel:(title,body)=>`<h2>${title}</h2>${body}`,coverage:()=>'',empty:String,
    button:(title,action)=>`<button data-action="${action}">${title}</button>`,table:(headers,rows)=>JSON.stringify({headers,rows}),
    amount:(n,c)=>`${c} ${n}`,responsiveAmount:String,householdDate:()=> '2026-10-30',period:month=>({from:`${month}-01`,to:'2026-11-01'}),categoryName:String,
    categoryView:{ordered:()=>[]},input:(name,attrs)=>`<input name="${name}" ${attrs}>`,field:(name,control)=>`${name}${control}`,editor:(...args)=>{context.rendered=args;}});
  let a=source.indexOf('  async budgets() {'),b=source.indexOf('\n  async settlements()',a);
  vm.runInContext('var views={'+source.slice(a,b)+'};',context);
  a=source.indexOf('async function budgetEditor(');b=source.indexOf('function budgetAmendmentPreviewEditor(',a);
  vm.runInContext(source.slice(a,b),context);
  return {context,calls};
}
test('Personal and Combined views do not request or display budgets',async()=>{
  for(const scope of ['personal','combined']) {
    const {context,calls}=load(scope);const html=await context.views.budgets();
    assert.match(html,/Switch to Family/);assert.equal(calls.length,0);
    await assert.rejects(context.budgetEditor(),/Switch to Family/);
  }
});
test('Family budget has category and planning sections without person allowances or people requests',async()=>{
  const {context,calls}=load('family',[{id:'family',scope:'family',currency:'INR',state:'active',name:'Household',month:'2026-10',expected_income:'1000.00',savings_goal:'0.00'}]);
  const html=await context.views.budgets();
  assert.equal(calls[0],'budgets?month=2026-10&scope=family');
  assert.equal(calls.some(path=>path.includes('/people')),false);
  assert.doesNotMatch(html,/People summary|Person or pool|budget-panel-people|budget-matrix-detail/);
  assert.match(html,/budget-panel-categories/);assert.match(html,/budget-panel-ahead/);
});
test('new budget editor always creates a family plan with no person limit inputs',async()=>{
  const {context,calls}=load('family');await context.budgetEditor();
  assert.match(context.rendered[1],/name="scope" type="hidden" value="family"/);
  assert.doesNotMatch(context.rendered[1],/People allowances|person-limit/);
  assert.ok(calls.every(path=>path.includes('scope=family')));
});
