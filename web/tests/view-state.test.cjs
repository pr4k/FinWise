const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../view-state.js'),'utf8');
function state() { const context={window:{},URL,URLSearchParams};vm.runInNewContext(code,context);return context.window.finwiseViewState; }
test('selected import month survives refresh without saving transactions',()=>{
  const view=state(); let next;
  view.save('2026-09','personal','http://127.0.0.1:3000/#transactions',path=>next=path);
  assert.equal(next,'/?month=2026-09&scope=personal#transactions');
  assert.deepEqual({...view.read(new URL(next,'http://localhost').search,'2026-10')},{month:'2026-09',scope:'personal'});
  assert.equal(next.includes('transaction_id'),false);
});
test('invalid or missing view preferences use safe defaults',()=>{
  const view=state();
  assert.deepEqual({...view.read('?month=2026-13&scope=admin','2026-10')},{month:'2026-10',scope:'personal'});
  assert.deepEqual({...view.read('','2026-10')},{month:'2026-10',scope:'personal'});
  assert.throws(()=>view.save('2026-00','personal','http://localhost/',()=>{}));
});
test('combined scope survives refresh and scopes the transaction list',()=>{
  const view=state(); let next;
  view.save('2026-09','combined','http://localhost/#analytics',path=>next=path);
  assert.equal(view.read(new URL(next,'http://localhost').search,'2026-10').scope,'combined');
  assert.equal(view.transactionsPath('2026-09',true,{},'combined'),'transactions?scope=combined&from=2026-09-01&to=2026-10-01');
  assert.throws(()=>view.transactionsPath('2026-09',true,{},'invalid'));
});

test('transaction history can use the selected month or explicit all dates',()=>{
  const view=state();
  assert.equal(view.transactionsPath('2026-10',false),'transactions');
  assert.equal(view.transactionsPath('2026-09',true),'transactions?from=2026-09-01&to=2026-10-01');
  assert.equal(view.transactionsPath('2026-12',true),'transactions?from=2026-12-01&to=2027-01-01');
});
test('account, account type, and transaction type filters combine and survive refresh',()=>{
  const view=state(); let next;
  const filters={account:'account-1',accountType:'bank',eventType:'expense'};
  view.save('2026-09','personal','http://localhost/#transactions',path=>next=path,filters);
  assert.deepEqual({...view.readFilters(new URL(next,'http://localhost').search)},filters);
  assert.equal(view.transactionsPath('2026-09',true,filters),'transactions?from=2026-09-01&to=2026-10-01&account_id=account-1&account_type=bank&event_type=expense');
  assert.equal(view.transactionsPath('2026-09',false,filters),'transactions?account_id=account-1&account_type=bank&event_type=expense');
});

test('category filters, date bounds and secondary sorting compose and persist in the URL',()=>{
  const view=state();let next;
  const filters={account:'a',accountType:'bank',eventType:'expense',category:'sip',person:'u',direction:'debit',minAmount:'0.01',maxAmount:'10000.01',search:'Fund & broker',from:'2026-08-15',to:'2026-10-02',currency:'INR',sort:'amount',secondarySort:'-amount'};
  view.save('2026-09','combined','http://localhost/#transactions/all',value=>next=value,filters);
  const restored=view.readFilters(new URL(next,'http://localhost').search);
  assert.deepEqual({...restored},filters);
  const query=new URL(view.transactionsPath('2026-09',true,restored,'combined'),'http://localhost').searchParams;
  assert.equal(query.get('scope'),'combined');assert.equal(query.get('from'),'2026-08-15');assert.equal(query.get('to'),'2026-10-02');assert.equal(query.get('q'),'Fund & broker');assert.equal(query.get('sort'),'amount');assert.equal(query.get('secondary_sort'),'-amount');assert.equal(query.has('classification_status'),false);
  view.save('2026-09','combined','http://localhost'+next,value=>next=value,{account:'',accountType:'',eventType:''});
  const cleared=new URL(next,'http://localhost').searchParams;assert.equal(cleared.has('sort'),false);assert.equal(cleared.has('classification_status'),false);assert.equal(cleared.has('from'),false);
});

test('Investment filter includes category-assigned investments for all family members',()=>{
  const view=state();
  const params=new URL(view.transactionsPath('2026-09',false,{eventType:'investment'},'family'),'http://localhost').searchParams;
  assert.equal(params.get('transaction_type'),'investment');assert.equal(params.has('event_type'),false);assert.equal(params.get('scope'),'family');assert.equal(params.has('member_id'),false);
  const restored=view.readFilters('?scope=family&event_type=investment');
  assert.equal(restored.eventType,'investment');assert.equal(restored.transactionType,undefined);
  const memberQuery=new URL(view.transactionsPath('2026-09',false,{...restored,person:'partner'},'family'),'http://localhost').searchParams;
  assert.equal(memberQuery.get('transaction_type'),'investment');assert.equal(memberQuery.get('member_id'),'partner');
});

test('old classification bookmarks discard review filters and preserve the transaction type',()=>{
  const view=state();let next;
  const filters=view.readFilters('?transaction_type=expense&classification_status=pending&sort=-confidence&secondary_sort=review_status');
  assert.equal(filters.eventType,'expense');
  assert.equal(filters.status,undefined);assert.equal(filters.sort,undefined);assert.equal(filters.secondarySort,undefined);
  const query=new URL(view.transactionsPath('2026-09',false,filters),'http://localhost').searchParams;
  assert.equal(query.get('event_type'),'expense');assert.equal(query.has('classification_status'),false);
  view.save('2026-09','personal','http://localhost/?transaction_type=expense&classification_status=pending',value=>next=value,filters);
  const saved=new URL(next,'http://localhost').searchParams;
  assert.equal(saved.has('transaction_type'),false);assert.equal(saved.has('classification_status'),false);
});
