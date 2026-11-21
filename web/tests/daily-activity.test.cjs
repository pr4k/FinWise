const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const context=vm.createContext({window:{}});
for(const file of ['analytics.js','daily-activity.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),context);
const view=context.window.finwiseDailyActivity;
function fixture(overrides={}) {
  const transaction=(id,date,account,extra={})=>({id,effective_date:date,currency:'INR',description:id,movements:[{account_id:account}],...extra});
  return {month:'2026-11',today:'2026-11-20',currency:'INR',accounts:[{id:'bank',subtype:'bank'},{id:'cash',subtype:'cash'},{id:'card',subtype:'credit_card'}],transactions:[
    transaction('purchase','2026-11-02','bank'),transaction('card-purchase','2026-11-02','card'),transaction('refund','2026-11-03','card'),
    transaction('fund','2026-11-04','bank'),transaction('withdraw','2026-11-05','bank'),transaction('repayment','2026-11-06','card',{event_type:'transfer'}),
    transaction('void','2026-11-02','bank',{voided:true}),transaction('future','2026-11-21','bank'),transaction('usd','2026-11-02','bank',{currency:'USD'}),transaction('cash-purchase','2026-11-07','cash')
  ],summary:{breakdown:[
    {transaction_id:'purchase',spending:'10.10'},{transaction_id:'purchase',spending:'2.05'},
    {transaction_id:'card-purchase',spending:'100.00'},{transaction_id:'refund',spending:'-20.00'},
    {transaction_id:'fund',net_invested:'50.00'},{transaction_id:'withdraw',net_invested:'-10.00'},
    {transaction_id:'repayment',spending:'0'},{transaction_id:'void',spending:'900'},
    {transaction_id:'future',spending:'800'},{transaction_id:'usd',spending:'700'},
    {transaction_id:'cash-purchase',spending:'3.01'}
  ]},...overrides};
}
test('all expenses preserve cents, net refunds and exclude nonexpenses, voids, future dates and other currencies',()=>{
  const data=view.calendar(fixture());
  assert.equal(data.total,'95.16');
  assert.equal(data.days[1].amount,'112.15');
  assert.equal(data.days[1].rows.length,2);
  assert.equal(data.days[2].amount,'-20.00');
  assert.equal(data.days[5].rows.length,0);
  assert.equal(data.days[20].future,true);
});
test('credit card, cash and investment filters use authoritative scoped effects',()=>{
  assert.equal(view.calendar(fixture({filter:'credit_card'})).total,'80.00');
  assert.equal(view.calendar(fixture({filter:'cash'})).total,'15.16');
  const investment=view.calendar(fixture({filter:'investments'}));
  assert.equal(investment.total,'40.00');
  assert.equal(investment.days[4].amount,'-10.00');
});
test('calendar aligns Monday first and handles leap years and empty future months',()=>{
  assert.equal(view.calendar(fixture()).offset,6);
  const leap=view.calendar(fixture({month:'2028-02'}));
  assert.equal(leap.days.length,29);
  assert.equal(leap.offset,1);
  assert.equal(leap.total,'0.00');
  assert.ok(leap.days.every(day=>day.future));
});
test('render exposes accessible day values, refund colors, selection and escaped transaction descriptions',()=>{
  const input=fixture();input.transactions[0].description='<img onerror=bad>';
  const html=view.render(input,'2026-11-02');
  assert.match(html,/Daily activity view/);
  assert.match(html,/data-level="refund"/);
  assert.match(html,/aria-pressed="true"/);
  assert.match(html,/&lt;img onerror=bad&gt;/);
  assert.doesNotMatch(html,/<img/);
  assert.match(html,/data-action="transaction-detail"/);
  assert.match(html,/data-date="2026-11-21"[^>]*disabled/);
  assert.match(view.render(fixture({filter:'investments'})),/Net withdrawals/);
});
