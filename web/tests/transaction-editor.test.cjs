const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
function load(context,start,end) {
  vm.runInContext(source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start))),context);
}

test('transaction details show the same content and host from every page',async()=>{
  const transaction={id:'tx',event_type:'expense',currency:'INR',amount:'50.00',effective_date:'2026-10-24',revision:2,entered_by:'me',movements:[{account_id:'cash',amount:'-50.00'}],allocations:[{category_id:'food',scope:'personal',amount:'50.00'}],source_refs:[]};
  const rendered=[];
  let desktop=true;
  const context=vm.createContext({
    state:{view:'transactions',accounts:[{id:'cash',subtype:'cash',owner_id:'me'}],categories:[],members:[],me:{user:{id:'me'}},ledgerBalances:new Map()},
    api:{request:async()=>transaction},id:encodeURIComponent,h:String,
    transactionDetailBalances:async()=>({balances:new Map(),unavailable:false}),transactionKindLabel:()=> 'Expense',transactionIndicators:()=>'',
    accountName:()=> 'Cash',categoryName:()=> 'Food',payerName:()=> 'You',
    amount:(value,currency)=>`${currency} ${value}`,table:(headers,rows)=>JSON.stringify({headers,rows}),
    empty:String,button:(label,action)=>`${label}:${action}`,
    window:{matchMedia:()=>({matches:desktop})},dialog:{},transactionDrawer:{},
    editor:(...args)=>rendered.push(args)
  });
  load(context,'const familyControlsEnabled =','const accountOptions =');
  load(context,'async function transactionDetail(','async function convertCardPaymentEditor(');
  for(const wide of [true,false]) {
    desktop=wide;
    rendered.length=0;
    for(const view of ['transactions','accounts','overview','analytics','categories','investments']) {
      context.state.view=view;
      await context.transactionDetail('tx');
      assert.equal(rendered.at(-1)[4],wide?context.transactionDrawer:context.dialog);
      assert.equal(rendered.at(-1)[1],rendered[0][1]);
      assert.match(rendered.at(-1)[1],/Edit transaction:edit-transaction/);
      assert.doesNotMatch(rendered.at(-1)[1],/Budget used by/);
      assert.match(rendered.at(-1)[1],/Reconciliation evidence/);
    }
  }
  context.state.accounts[0].owner_id='other';
  await context.transactionDetail('tx');
  assert.match(rendered.at(-1)[1],/View only/);
  assert.doesNotMatch(rendered.at(-1)[1],/Edit transaction:edit-transaction|Delete transaction:delete-transaction/);
  context.state.me.household={family_member_controls:true};
  await context.transactionDetail('tx');
  assert.match(rendered.at(-1)[1],/Edit transaction:edit-transaction/);

});

test('opening the edit modal clears the details drawer and its layout state',()=>{
  const classes=new Set(['transaction-drawer-open']);
  const drawer={hidden:false,innerHTML:'Transaction details',replaceChildren(){this.innerHTML='';}};
  const dialog={open:false,showModal(){this.open=true;}};
  const context=vm.createContext({transactionDrawer:drawer,dialog,
    document:{body:{classList:{remove:name=>classes.delete(name),add:name=>classes.add(name)}}},
    h:String,button:()=>'',addModalChips:()=>{}
  });
  load(context,'function closeTransactionDrawer()','const menuButton');
  load(context,'function editor(','function detailDialog(');
  context.editor('Edit transaction','<input name="amount">','transaction-full-edit-form','Save transaction');
  assert.equal(drawer.hidden,true);
  assert.equal(drawer.innerHTML,'');
  assert.equal(classes.has('transaction-drawer-open'),false);
  assert.equal(dialog.open,true);
  assert.match(dialog.innerHTML,/transaction-full-edit-form/);
});

function balanceContext(collection) {
  const context=vm.createContext({api:{collection},id:encodeURIComponent,URLSearchParams});
  load(context,'async function transactionDetailBalances(','async function transactionDetail(');
  return context;
}
test('transaction details load only their date, including month and year boundaries',async()=>{
  for(const [date,to] of [['2026-10-31','2026-11-01'],['2026-12-31','2027-01-01']]) {
    const calls=[];
    const row={transaction_id:'tx',balance_after:'10.00'};
    const context=balanceContext(async path=>{calls.push(path);return {data:[row]};});
    const result=await context.transactionDetailBalances({id:'tx',effective_date:date,movements:[{account_id:'cash'},{account_id:'cash'}]});
    assert.deepEqual(calls,[`accounts/cash/ledger?from=${date}&to=${to}`]);
    assert.equal(result.balances.get('cash:tx'),row);
    assert.equal(result.unavailable,false);
  }
});
test('a failed transfer account balance does not block transaction details or reuse stale balances',async()=>{
  const context=balanceContext(async path=>{
    if(path.includes('/bank/'))throw new TypeError('Load failed');
    return {data:[{transaction_id:'tx',balance_after:'50.00'}]};
  });
  const result=await context.transactionDetailBalances({id:'tx',effective_date:'2026-11-02',movements:[{account_id:'bank'},{account_id:'card'}]});
  assert.equal(result.unavailable,true);
  assert.equal(result.balances.has('bank:tx'),false);
  assert.equal(result.balances.get('card:tx').balance_after,'50.00');
});
test('expired sessions still stop opening transaction details',async()=>{
  const context=balanceContext(async()=>{throw Object.assign(new Error('Sign in'),{status:401});});
  await assert.rejects(context.transactionDetailBalances({id:'tx',effective_date:'2026-11-02',movements:[{account_id:'bank'}]}),{status:401});
});

test('income earner options use member IDs and allow other members only in Family scope',()=>{
 const context=vm.createContext({state:{me:{user:{id:'me'}},members:[{user_id:'me',name:'Alex'},{user_id:'partner',name:'Alex'},{user_id:'inactive',name:'Inactive',active:false}]},option:(id,label,selected)=>`<option value="${id}"${selected?' selected':''}>${label}</option>`});
 load(context,'const incomeMemberId =','function syncIncomeMemberChoices(');
 assert.equal(vm.runInContext("incomeMemberName({entered_by:'me'},{member_id:'partner'})",context),'Alex');
 const personal=context.incomeMemberOptions('partner','personal');assert.match(personal,/value="me" selected/);assert.doesNotMatch(personal,/value="partner"/);
 const family=context.incomeMemberOptions('partner','family');assert.match(family,/value="partner" selected/);assert.doesNotMatch(family,/inactive/);
});
