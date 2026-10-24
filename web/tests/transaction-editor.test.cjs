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
    state:{view:'transactions',accounts:[{id:'cash',subtype:'cash'}],categories:[],members:[],me:{user:{id:'me'}},ledgerBalances:new Map()},
    api:{request:async()=>transaction},id:encodeURIComponent,h:String,
    loadLedgerBalances:async()=>{},transactionKindLabel:()=> 'Expense',transactionIndicators:()=>'',
    accountName:()=> 'Cash',categoryName:()=> 'Food',payerName:()=> 'You',
    amount:(value,currency)=>`${currency} ${value}`,table:(headers,rows)=>JSON.stringify({headers,rows}),
    empty:String,button:(label,action)=>`${label}:${action}`,
    window:{matchMedia:()=>({matches:desktop})},dialog:{},transactionDrawer:{},
    editor:(...args)=>rendered.push(args)
  });
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
      assert.match(rendered.at(-1)[1],/Budget used by/);
      assert.match(rendered.at(-1)[1],/Reconciliation evidence/);
    }
  }
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
