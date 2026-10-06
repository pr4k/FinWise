const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../time.js'),'utf8');

test('historical local check keeps the browser offset instead of sending UTC wall time',()=>{
  const context={window:{},Date}; vm.runInNewContext(code,context);
  assert.equal(context.window.finwiseTime.localTimestamp('2026-09-01T23:59'),'2026-09-01T23:59:00+05:30');
  assert.throws(()=>context.window.finwiseTime.localTimestamp('2026-02-30T23:59'),/does not exist/);
});
