const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const context={window:{}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../reconciliation.js'),'utf8'),context);
const {matchAllocations,exactPairAvailable,amendmentPlan,sumSignedRows}=context.window.finwiseReconciliation;
const item=(id,remaining,description=id)=>({id,remaining,amount:remaining,currency:'INR',revision:1,effective_date:'2026-09-15',state:'unmatched',description});

test('grouped reconciliation conserves two ledger and two statement rows',()=>{
  const result=matchAllocations([item('a','-80.00'),item('b','-40.00')],[item('x','-70.00'),item('y','-50.00')]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.allocations)),[
    {ledger_id:'a',ledger_revision:1,observation_id:'x',amount:'-70.00'},
    {ledger_id:'a',ledger_revision:1,observation_id:'y',amount:'-10.00'},
    {ledger_id:'b',ledger_revision:1,observation_id:'y',amount:'-40.00'}
  ]);
  assert.equal(result.hasDifference,false);
  assert.equal(result.matchedTotal,'-120.00');
});

test('grouped reconciliation leaves an explicit remainder and rejects opposite signs',()=>{
  const partial=matchAllocations([item('a','100.00')],[item('x','70.00')]);
  assert.equal(partial.matchedTotal,'70.00');
  assert.equal(partial.difference,'-30.00');
  assert.equal(partial.hasDifference,true);
  assert.match(matchAllocations([item('a','-100.00')],[item('x','100.00')]).error,/same transaction direction/);
});

test('automatic exact match requires a unique full pair',()=>{
  assert.equal(exactPairAvailable([item('a','-50.00')],[item('x','-50.00')]),true);
  assert.equal(exactPairAvailable([item('a','-50.00'),item('b','-50.00')],[item('x','-50.00')]),false);
  assert.equal(exactPairAvailable([item('a','-50.00')],[{...item('x','-50.00'),effective_date:'2026-09-16'}]),false);
});

test('group difference can go to one transaction or be split exactly',()=>{
  const ledger=[item('a','-52564.00'),item('b','-22908.00')];
  const statement=[item('x','-75473.00')];
  const first=amendmentPlan(ledger,statement);
  assert.equal(first.difference,'-1.00');
  assert.deepEqual(first.proposed,['-52565.00','-22908.00']);
  const second=amendmentPlan(ledger,statement,'remaining',1);
  assert.deepEqual(second.proposed,['-52564.00','-22909.00']);
  assert.equal(first.minor('-0.25')+first.minor('-0.75'),first.minor(first.difference));
});

test('selected statement rows total exactly for grouped creation',()=>{
  assert.deepEqual(JSON.parse(JSON.stringify(sumSignedRows([item('a','-70.25'),item('b','-50.75')]))),{currency:'INR',total:'-121.00',eventType:'expense'});
  assert.equal(sumSignedRows([item('a','-70.00'),item('b','50.00')]).error,'Select rows with the same direction.');
});
