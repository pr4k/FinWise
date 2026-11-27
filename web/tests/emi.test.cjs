const test=require('node:test');
const assert=require('node:assert/strict');
const {schedule}=require('../emi.js');
test('EMI schedule applies recorded allocations and projects a reducing balance',()=>{
  const terms={category_id:'loan',currency:'INR',principal:'1000',annual_rate:'12',monthly_payment:'300',start_date:'2026-01-01'};
  const transactions=[{event_type:'expense',currency:'INR',effective_date:'2026-01-05',allocations:[{category_id:'loan',amount:'300'},{category_id:'other',amount:'50'}]}];
  const result=schedule(terms,transactions,'2026-01-31');
  assert.equal(result.paid,300);assert.equal(result.remaining,710);
  assert.equal(result.rows[0].interest,10);assert.equal(result.rows[1].payment,300);
  assert.equal(result.rows.at(-1).balance,0);
});
test('missing payments accrue interest and unrelated or void transactions are excluded',()=>{
  const terms={category_id:'loan',currency:'INR',principal:'1000',annual_rate:'12',monthly_payment:'300',start_date:'2026-01-01'};
  const rows=[{voided:true,event_type:'expense',currency:'INR',effective_date:'2026-01-05',allocations:[{category_id:'loan',amount:'300'}]}];
  const result=schedule(terms,rows,'2026-02-28');
  assert.equal(result.paid,0);assert.equal(result.remaining,1020.10);
});
