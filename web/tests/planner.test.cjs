const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const source=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');
function load({accounts=[],records=[],saved=null,currency='INR',scope='personal',month='2026-11',workflow=false,suggestions=[],categoryRows=[]}={}) {
  const storage=new Map(saved?[['test-planner',JSON.stringify(saved)]]:[]),listeners=[];
  const document={querySelector:()=>null,querySelectorAll:()=>[],createElement:()=>({innerHTML:'',textContent:''}),addEventListener:(...args)=>listeners.push(args)};
  const window={document,localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)}};
  vm.runInNewContext(source('planner.js'),{window,AbortController,Intl,Date,structuredClone,console});
  const host={workflow,suggestions,categoryRows,accounts,records,scope,currency,month,categories:{Food:'#387554'},storageKey:'test-planner',person:'Test User',people:['Test User'],escape:String,toast:()=>{},active:()=>true};
  const instance=window.finwisePlanner.create(host);
  return {instance,storage,host};
}
const bank={id:'bank',name:'Savings',type:'bank',balance:50000,reserve:0};
const card={id:'card',name:'Test Card',type:'card',balance:999999,due:null};
const item=(id,kind,amount,account='Savings',extra={})=>({id,title:id,kind,amount,account,enabled:true,lane:kind==='income'?'income':'must',day:1,timing:'once',category:'Food',person:'Test User',source:'Test estimate',matchIds:[],...extra});
function stored(items,balance=50000,buckets={}) {return {plans:{'personal:INR:2026-11':{name:'November plan',status:'draft',revision:1,opening:balance,partial:false,cashFloor:0,items,scenarios:[],history:[],ritual:{},activeLinks:null,reserveModel:{version:1,scope:'personal',currency:'INR',month:'2026-11',banks:{Savings:{balance,other:0}},openingBuckets:buckets,source:'Test opening'}}},funds:{},cardBills:[],cardCycles:{'personal:INR':[{card:'Test Card',closeDay:28,dueDay:5,dueOffset:1,bank:'Savings'}]}};}
test('starter plans use real records without fictional statements, funds or amounts',()=>{
 const {instance,storage}=load({accounts:[bank,card]});
 const html=instance.html(),snapshot=instance.snapshot();
 assert.equal(snapshot.plan.items.length,0);assert.equal(snapshot.totals.card,0);
 assert.equal(snapshot.forecast.start.bank,50000);
 assert.doesNotMatch(html,/Kiwi|SBI|HDFC|Prakhar|Fictional/);
 assert.equal(JSON.parse(storage.get('test-planner')).cardBills.length,0);
});
test('card consumption reserves cash, and paying a fully reserved bill never deducts available cash twice',()=>{
 const saved=stored([item('Salary','income',100000),item('Bank expense','expense',30000),item('Card purchase','expense',10000,'Test Card',{day:10}),item('Prior bill','card',20000,'Savings',{destination:'Test Card',statementMonth:'2026-10',statementId:'prior-statement',day:5})],50000,{'Test Card::2026-10':{key:'Test Card::2026-10',card:'Test Card',statementMonth:'2026-10',required:20000,amount:20000,bank:'Savings'}});
 saved.cardBills=[{id:'prior-statement',scope:'personal',currency:'INR',card:'Test Card',statementMonth:'2026-10',dueDate:'2026-11-05',statementAmount:20000,paid:0,status:'confirmed',account:'Savings',evidence:'Synthetic statement'}];
 const {instance}=load({accounts:[bank,card],saved});
 const {totals,forecast}=instance.snapshot();
 assert.equal(totals.spend,40000);assert.equal(totals.surplus,60000);
 assert.equal(forecast.closing.bank,100000);assert.equal(forecast.closing.reserved,10000);assert.equal(forecast.end,90000);
 const payment=forecast.events.find(e=>e.type==='cardPayment');assert.equal(payment.amount,0);assert.equal(payment.released,20000);
});
test('unknown and insufficient cash produce unfunded obligations rather than fictitious funded reserves',()=>{
 for(const balance of [null,500]){
  const {instance}=load({accounts:[{...bank,balance},card],saved:stored([item('Purchase','expense',1000,'Test Card')],balance)});
  const {forecast}=instance.snapshot();assert.equal(forecast.closing.reserved,balance||0);assert.equal(forecast.shortfall,1000-(balance||0));
 }
});
test('manual plans and known balances work for other currencies',()=>{
 const {instance}=load({currency:'USD',accounts:[{...bank,balance:1200}]});
 const snapshot=instance.snapshot();assert.equal(snapshot.forecast.start.bank,1200);assert.match(instance.html(),/\$1,200/);
});
test('month and scope changes isolate drafts and preserve the actual ledger',()=>{
 const records=[{id:'tx',date:'2026-10-05',currency:'INR',type:'income',amount:70000,description:'Real salary',account:'Savings',category:'Salary',person:'Test User'}];
 const original=JSON.stringify(records);const {instance,host}=load({accounts:[bank],records});
 assert.equal(instance.snapshot().totals.income,70000);
 instance.update({...host,month:'2026-12',records:[]});assert.equal(instance.snapshot().totals.income,0);
 instance.update({...host,scope:'household',accounts:[],records:[]});assert.equal(instance.snapshot().forecast.start.bank,0);
 assert.equal(JSON.stringify(records),original);
});
function prepare(values) {const window={};vm.runInNewContext(source('planner-data.js'),{window});return window.finwisePlannerData.prepare(values);}
const apiAccounts=[{id:'bank',name:'Savings',owner_id:'me',visibility:'private',subtype:'bank',currency:'INR',balance:{amount:'100.00'}},{id:'card',name:'Card',owner_id:'me',visibility:'private',subtype:'credit_card',currency:'INR',balance:{amount:'900.00'}},{id:'shared',name:'Family',owner_id:'me',visibility:'shared',subtype:'bank',currency:'INR',balance:{amount:'200.00'}}];
const defaults={accounts:apiAccounts,categories:[{id:'food',name:'Food'}],members:[],user:{id:'me',name:'Test User'},scope:'personal',currency:'INR'};
test('API mapping separates scopes, refunds, investment classifications and card settlements',()=>{
 const transactions=[{id:'purchase',event_type:'expense',currency:'INR',effective_date:'2026-11-01',amount:'100',movements:[{account_id:'bank',amount:'-100'}],allocations:[{scope:'personal',category_id:'food',amount:'40'},{scope:'family',category_id:'food',amount:'60'}]}, {id:'refund',event_type:'refund',currency:'INR',effective_date:'2026-11-02',movements:[],allocations:[{scope:'personal',amount:'10',category_id:'food'}]}, {id:'payment',event_type:'transfer',amount:'90',currency:'INR',effective_date:'2026-11-03',movements:[{account_id:'bank',amount:'-90'},{account_id:'card',amount:'90'}]}];
 const personal=prepare({...defaults,transactions});assert.equal(personal.accounts.length,2);assert.equal(personal.records[0].amount,40);assert.equal(personal.records[1].type,'refund');assert.equal(personal.records[2].type,'card');
 const family=prepare({...defaults,transactions,scope:'family'});assert.equal(family.accounts.length,1);assert.equal(family.accounts[0].name,'Family');assert.equal(family.records.length,1);assert.equal(family.records[0].amount,60);
});
test('actual totals respect reporting corrections and exclude paid-on-behalf shares and card settlement categories',()=>{
 const tx=(id,type,value,extra={})=>({id,event_type:'expense',currency:'INR',effective_date:'2026-11-02',movements:[{account_id:'bank',amount:type==='investment'?'100':'-100'}],allocations:[{scope:'personal',category_id:'food',amount:String(value),transaction_type:type,...extra}]});
 const mapped=prepare({...defaults,transactions:[tx('own','expense',40),tx('others','paid_on_behalf',60),tx('card-settlement','transfer',90),tx('investment-return','investment',20),tx('repaid','reimbursement',10),tx('offset','reimbursement',5,{offset_expense:true})]});
 assert.deepEqual(Array.from(mapped.records,r=>r.type),['expense','behalf','transfer','withdrawal','reimbursement','reimbursement']);
 const {instance}=load({accounts:[bank],records:mapped.records});
 const html=instance.html();assert.doesNotMatch(html,/Fictional/);
 // The actual comparison uses the same reporting effects as the backend.
 // Feed prior month to exercise category suggestions, which exclude non-consumption.
 const previous=mapped.records.map(r=>({...r,date:'2026-10-02'}));
 const planned=load({accounts:[bank],records:previous}).instance.snapshot();assert.equal(planned.totals.spend,35);
});
test('income envelope stays independent from an older bank balance and excludes received income from future cash',()=>{
 const saved=stored([item('Received salary','income',100000,'Savings',{cashIncluded:true}),item('SIP','investment',10000),item('Rent','expense',20000)],200000);
 const {instance}=load({accounts:[{...bank,balance:200000}],saved,workflow:true});
 const {workflow,totals,forecast}=instance.snapshot();
 assert.equal(workflow.remainingIncome,70000);assert.equal(workflow.bankCash,170000);assert.equal(forecast.end,170000);
 assert.equal(totals.bankCashflow,-30000);assert.equal(totals.cashReceipts,0);
 assert.equal(totals.income,100000);
});
test('partial card plans retain the unpaid obligation without changing paid evidence',()=>{
 const saved=stored([item('Salary','income',50000)]);
 saved.cardBills=[{id:'statement',scope:'personal',currency:'INR',card:'Test Card',statementMonth:'2026-10',dueDate:'2026-11-05',statementAmount:20000,paid:5000,plannedPayment:6000,status:'confirmed',account:'Savings',evidence:'Test'}];
 const {instance,storage}=load({accounts:[bank,card],saved,workflow:true});
 assert.equal(instance.snapshot().totals.card,6000);assert.equal(instance.snapshot().workflow.remainingIncome,44000);
 const bill=JSON.parse(storage.get('test-planner')).cardBills.find(b=>b.id==='statement');assert.equal(bill.paid,5000);assert.equal(bill.statementAmount-bill.paid-bill.plannedPayment,9000);
});
test('guided plans pull confirmed schedules once, preserve monthly exclusions, and do not preallocate historic category spending',()=>{
 const suggestions=[{id:'sub-1',title:'Streaming',amount:500,kind:'expense',lane:'must',category:'Food',account:'Savings',subscriptionKey:'service',enabled:false,day:5,source:'Confirmed subscription'}, {id:'sip-1',title:'Index fund',amount:5000,kind:'investment',lane:'future',account:'Savings',sip:true,holding:'holding',enabled:true,day:5,source:'Active SIP'}];
 const records=[{id:'old',date:'2026-10-01',currency:'INR',type:'expense',category:'Food',amount:9000}];
 const {instance}=load({accounts:[bank],workflow:true,suggestions,records});const first=instance.snapshot(),second=instance.snapshot();
 assert.equal(first.plan.items.length,2);assert.equal(second.plan.items.length,2);assert.equal(first.totals.spend,0);assert.equal(first.totals.invested,5000);
});
test('schedule adapter includes subscriptions and date-effective SIPs without needing last-month investment transactions',()=>{
 const input={...defaults,month:'2026-11',transactions:[],subscriptions:[{key:'streaming',name:'Streaming',subscription:true,account_id:'bank',currency:'INR',frequency:'monthly',last_date:'2026-10-31',max_amount:'499'}],investments:[{id:'fund',name:'Index',currency:'INR',owner_id:'me',visibility:'private',sip:{status:'active',amount:'5000',day:31,start_month:'2026-10'}}]};
 const mapped=prepare(input);assert.equal(mapped.suggestions.length,2);assert.equal(mapped.suggestions[1].day,30);assert.equal(mapped.suggestions[0].day,30);
 const paused=prepare({...input,investments:[{...input.investments[0],plannerSip:null}]});assert.equal(paused.suggestions.length,1);
});
test('next planning month handles year rollover without depending on the selected report month',()=>{
 const window={};vm.runInNewContext(source('planner-data.js'),{window});
 assert.equal(window.finwisePlannerData.nextMonth('2026-11-02'),'2026-12');assert.equal(window.finwisePlannerData.nextMonth('2026-12-31'),'2027-01');
});
test('recorded account dues refresh while a higher monthly planning due stays local and independent',()=>{
 const saved=stored([]);const dueCard={...card,due:2000,dueDate:'2026-11-05'};
 const id='account-due-card-2026-11-05';saved.plans['personal:INR:2026-11'].cardDueOverrides={[id]:5000};saved.plans['personal:INR:2026-11'].cardPaymentOverrides={[id]:'full'};
 const accounts=[bank,dueCard],before=JSON.stringify(accounts);const {instance,host,storage}=load({accounts,saved,workflow:true});
 assert.equal(instance.snapshot().totals.card,5000);
 instance.update({...host,accounts:[bank,{...dueCard,due:3000,dueDate:'2026-11-08'}]});
 const bills=JSON.parse(storage.get('test-planner')).cardBills;assert.equal(bills.length,1);assert.equal(bills[0].recordedDue,3000);assert.equal(bills[0].recordedDueDate,'2026-11-08');
 assert.equal(instance.snapshot().totals.card,5000);assert.equal(JSON.stringify(accounts),before);
 assert.equal(instance.snapshot().plan.items.find(x=>x.statementId===id).day,8);
 instance.update({...host,month:'2026-12',accounts:[bank,{...dueCard,due:3000}]});
 assert.equal(instance.snapshot().plan.cardDueOverrides,undefined);
});
test('a reset full-payment plan follows a refreshed actual due and never substitutes outstanding debt',()=>{
 const saved=stored([]),id='account-due-card-2026-11-05';saved.plans['personal:INR:2026-11'].cardPaymentOverrides={[id]:'full'};
 const dueCard={...card,due:1200,dueDate:'2026-11-05'}, {instance,host}=load({accounts:[bank,dueCard],saved,workflow:true});
 assert.equal(instance.snapshot().totals.card,1200);
 instance.update({...host,accounts:[bank,{...dueCard,due:1800}]});assert.equal(instance.snapshot().totals.card,1800);
 instance.update({...host,accounts:[bank,{...dueCard,due:0}]});assert.equal(instance.snapshot().totals.card,0);
});
test('closed plans keep saved card dues and planning overrides when the account due changes',()=>{
 const dueCard={...card,due:2000,dueDate:'2026-11-05'}, {instance,host,storage}=load({accounts:[bank,dueCard],workflow:true});
 const snapshot=instance.snapshot(),saved=JSON.parse(storage.get('test-planner'));
 saved.plans['personal:INR:2026-11']={...snapshot.plan,status:'closed'};
 const closed=load({accounts:[bank,{...dueCard,due:3000}],saved,workflow:true}).instance;
 assert.equal(closed.snapshot().totals.card,2000);assert.equal(closed.snapshot().plan.items[0].statementSnapshot.recordedDue,2000);
});
test('a new recorded billing cycle supersedes the earlier account snapshot in the new planning month',()=>{
 const first={...card,due:2000,dueDate:'2026-11-05'}, {instance,host}=load({accounts:[bank,first],workflow:true});
 assert.equal(instance.snapshot().totals.card,2000);
 instance.update({...host,month:'2026-12',accounts:[bank,{...first,due:3000,dueDate:'2026-12-05'}]});
 const current=instance.snapshot();assert.equal(current.totals.card,3000);assert.equal(current.plan.items.filter(x=>x.kind==='card').length,1);
});
test('cards with balances but no statement metadata stay visible without automatically counting debt as a bill',()=>{
 const accounts=[bank,{...card,name:'Kiwi card',balance:18709},{...card,id:'icici',name:'ICICI cc',balance:20308},{...card,id:'unknown',name:'Unknown balance card',balance:null}];
 const original=JSON.stringify(accounts);const {instance,storage}=load({accounts,workflow:true});const html=instance.html();
 assert.match(html,/Kiwi card/);assert.match(html,/ICICI cc/);assert.match(html,/Unknown balance card/);
 assert.match(html,/Amount owed in Accounts/);assert.match(html,/Statement due not recorded/);
 assert.equal((html.match(/data-workflow-account-card=/g)||[]).length,3);
 assert.equal(instance.snapshot().totals.card,0);assert.equal(JSON.parse(storage.get('test-planner')).cardBills.length,0);assert.equal(JSON.stringify(accounts),original);
});
test('an older manually saved bill estimate is not mislabeled as the current account due',()=>{
 const saved=stored([]);saved.cardBills=[{id:'manual',scope:'personal',currency:'INR',card:'SBI cc',statementMonth:'2026-10',dueDate:'2026-11-05',statementAmount:3600,paid:0,status:'estimated',account:'Savings'}];
 const {instance}=load({accounts:[bank,{...card,name:'SBI cc',balance:35107}],saved,workflow:true});const html=instance.html();
 assert.match(html,/Saved bill estimate/);assert.match(html,/35,107/);assert.doesNotMatch(html,/Recorded due ₹3,600/);
 assert.equal((html.match(/<h4>SBI cc<\/h4>/g)||[]).length,1);
});
test('missing due date still exposes the recorded amount and allows a planning estimate',()=>{
 const {instance}=load({accounts:[bank,{...card,due:1200,dueDate:null}],workflow:true});const html=instance.html();
 assert.match(html,/Recorded statement due/);assert.match(html,/Due date not recorded/);assert.match(html,/Set planning estimate/);assert.equal(instance.snapshot().totals.card,0);
});
test('recorded income pulled into Planner keeps the selected earner separately from its recorder',()=>{
 const input={...defaults,scope:'family',members:[{user_id:'me',name:'Recorder'},{user_id:'partner',name:'Earner'}],transactions:[{id:'salary',entered_by:'me',event_type:'income',currency:'INR',effective_date:'2026-11-01',movements:[{account_id:'shared',amount:'50000'}],allocations:[{scope:'family',category_id:'salary',amount:'50000',member_id:'partner'}]}]};
 const prepared=prepare(input);assert.equal(prepared.records[0].personId,'partner');assert.equal(prepared.records[0].person,'Earner');
 assert.equal(prepared.currentUserId,'me');assert.equal(prepared.members.length,2);
});
