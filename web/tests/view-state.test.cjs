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
