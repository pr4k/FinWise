const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
function helpers() {
  const context={state:{categories:[{id:'sub',tracking_type:'subscription'},{id:'food',tracking_type:'regular'}],accounts:[{id:'a',currency:'INR'}]},option:(value,label,selected)=>`<option value="${value}"${selected?' selected':''}>${label}</option>`,api:{request:async()=>({data:[]})},failure:()=>{}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function subscriptionAssignmentFields('),source.indexOf('function investmentAssignmentFields(')),context);
  return context;
}
function form() {
  const panel={hidden:false},namePanel={hidden:true};
  const select={value:'',disabled:false,innerHTML:''},name={value:'Music',required:false,disabled:true};
  return {id:'transaction-form',dataset:{},subscriptionItems:[],elements:{event_type:{value:'expense'},category_id:{value:'sub'},account_id:{value:'a'},subscription_key:select,subscription_name:name},querySelector:selector=>selector==='[data-subscription-assignment]'?panel:namePanel,panel,namePanel};
}
test('subscription category offers existing same-account subscriptions and a new subscription',()=>{
  const api=helpers(),f=form();
  const items=[{key:'music',name:'Music',account_id:'a',currency:'INR',subscription:true,occurrences:[]},{key:'private',name:'Other account',account_id:'b',currency:'INR',subscription:true,occurrences:[]},{key:'ignored',name:'Ignored',account_id:'a',currency:'INR',subscription:true,ignored:true,occurrences:[]}];
  f.subscriptionItems=items;
  api.syncSubscriptionAssignment(f);
  assert.equal(f.panel.hidden,false);
  assert.match(f.elements.subscription_key.innerHTML,/Music/);
  assert.match(f.elements.subscription_key.innerHTML,/Create new subscription/);
  assert.doesNotMatch(f.elements.subscription_key.innerHTML,/Other account|Ignored/);
  f.elements.subscription_key.value='music';
  assert.equal(JSON.stringify(api.subscriptionAssignment(f)),JSON.stringify({key:'music'}));
  f.elements.subscription_key.value='__new';api.syncSubscriptionName(f);
  assert.equal(f.namePanel.hidden,false);
  assert.equal(f.elements.subscription_name.required,true);
  assert.equal(JSON.stringify(api.subscriptionAssignment(f)),JSON.stringify({name:'Music'}));
  f.elements.category_id.value='food';api.syncSubscriptionAssignment(f);
  assert.equal(f.panel.hidden,true);
  assert.equal(f.elements.subscription_name.required,false);
  assert.equal(api.subscriptionAssignment(f),undefined);
});
test('changing away from expense disables subscription fields and loading cannot unlink an existing payment',()=>{
  const api=helpers(),f=form();
  f.elements.subscription_key.disabled=true;
  assert.equal(api.subscriptionAssignment(f),undefined);
  f.elements.event_type.value='income';api.syncSubscriptionAssignment(f);
  assert.equal(f.panel.hidden,true);
  assert.equal(f.elements.subscription_name.disabled,true);
});
test('account list hides deleted accounts while retaining them in the history catalog',async()=>{
  const accounts=[{id:'active',name:'Active bank',subtype:'bank',currency:'INR',active:true},{id:'deleted',name:'Deleted card',subtype:'credit_card',currency:'INR',active:false},{id:'settle',name:'Deleted settlement',subtype:'settle_up',currency:'INR',active:false}];
  const context={state:{accounts},api:{request:async()=>({data:[]})},h:String,heading:()=>'',button:()=>'',coverage:()=>'',empty:()=>'',accountBalance:()=>''};
  vm.createContext(context);
  const a=source.indexOf('  async accounts(parts) {'),b=source.indexOf('\n  async changes()',a);
  vm.runInContext('var view={'+source.slice(a,b)+'};',context);
  const html=await context.view.accounts([]);
  assert.match(html,/Active bank/);
  assert.doesNotMatch(html,/Deleted card|Deleted settlement|Settlements/);
  assert.equal(accounts.length,3);
});
test('linked subscription payments appear once across category and subscription summaries',()=>{
  const context={trackedCategoryRows:transactions=>transactions.map(transaction=>({transaction}))};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function unlinkedSubscriptionRows('),source.indexOf('function subscriptionAssignmentFields(')),context);
  const payments=[{id:'linked'},{id:'unlinked'}];
  const recurring=[{subscription:true,occurrences:[{id:'linked',source:'money_manager_or_ledger'}]}];
  const result=context.unlinkedSubscriptionRows(payments,recurring);
  assert.deepEqual(result.map(row=>row.transaction.id),['unlinked']);
});
