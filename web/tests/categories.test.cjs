const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../categories.js'),'utf8');
function categories() {const context={window:{},Map,Set,BigInt};vm.runInNewContext(code,context);return context.window.finwiseCategories;}
const items=[{id:'food',name:'Food',kind:'expense',parent_id:null},{id:'dining',name:'Dining',kind:'expense',parent_id:'food'},{id:'coffee',name:'Coffee',kind:'expense',parent_id:'dining'},{id:'salary',name:'Salary',kind:'income',parent_id:null}];

test('category paths and ordering preserve every nested level',()=>{
  const view=categories();
  assert.equal(view.path(items,'coffee'),'Food › Dining › Coffee');
  assert.equal(view.path(items,null),'Uncategorized');
  assert.deepEqual(Array.from(view.ordered(items,'expense'),v=>[v.category.id,v.depth]),[['food',0],['dining',1],['coffee',2]]);
});

test('category analytics roll up subcategories with exact decimal arithmetic',()=>{
  const view=categories();
  const totals=view.rollup([{id:'dining',amount:'19.99',currency:'INR',count:1},{id:'coffee',amount:'0.02',currency:'INR',count:1},{id:'food',amount:'1.00',currency:'INR',count:1}],items);
  assert.equal(totals.get('food').amount,'21.01');
  assert.equal(totals.get('dining').amount,'20.01');
  assert.equal(totals.get('coffee').amount,'0.02');
});
