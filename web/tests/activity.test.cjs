const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../activity.js'),'utf8');
function activity(){const context={window:{},Date};vm.runInNewContext(code,context);return context.window.finwiseActivity;}

test('balance checks are interleaved between transactions by instant',()=>{
  const t1={id:'one',effective_date:'2026-09-03',movements:[{account_id:'bank'}]};
  const t2={id:'two',effective_date:'2026-09-07',movements:[{account_id:'bank'}]};
  const ledgers=new Map([
    ['bank:one',{effective_at:'2026-09-03T10:00:00+05:30'}],
    ['bank:two',{effective_at:'2026-09-07T10:00:00+05:30'}]
  ]);
  const markers=[
    {account:{id:'bank'},row:{event_type:'balance_check',check_id:'first',effective_at:'2026-09-04T12:00:00+05:30'}},
    {account:{id:'bank'},row:{event_type:'balance_check',check_id:'second',effective_at:'2026-09-08T12:00:00+05:30'}}
  ];
  const result=activity().timeline([t1,t2],markers,ledgers,'bank');
  assert.deepEqual(Array.from(result,v=>v.transaction?.id||v.row.check_id),['second','two','first','one']);
});

test('checks sort after transactions and starting balances before them at one instant',()=>{
  const instant='2026-09-03T10:00:00+05:30';
  const transaction={id:'one',effective_date:'2026-09-03',movements:[{account_id:'bank'}]};
  const ledgers=new Map([['bank:one',{effective_at:instant}]]);
  const markers=[
    {account:{id:'bank'},row:{event_type:'opening_balance',effective_at:instant}},
    {account:{id:'bank'},row:{event_type:'balance_check',effective_at:instant}}
  ];
  const result=activity().timeline([transaction],markers,ledgers,'bank');
  assert.deepEqual(Array.from(result,v=>v.kind),['balance_check','transaction','opening_balance']);
});

test('date-only ten am movement sits between morning balance checks',()=>{
  const transaction={id:'date-only',effective_date:'2026-05-01',movements:[{account_id:'bank'}]};
  const ledger=new Map([['bank:date-only',{effective_at:'2026-05-01T04:30:00+00:00'}]]);
  const markers=[
    {account:{id:'bank'},row:{event_type:'balance_check',check_id:'before',effective_at:'2026-05-01T09:59:00+05:30'}},
    {account:{id:'bank'},row:{event_type:'balance_check',check_id:'after',effective_at:'2026-05-01T10:01:00+05:30'}}
  ];
  const result=activity().timeline([transaction],markers,ledger,'bank');
  assert.deepEqual(Array.from(result,v=>v.transaction?.id||v.row.check_id),['after','date-only','before']);
});
