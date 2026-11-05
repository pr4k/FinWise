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

test('device wall time is saved as the same instant in the household timezone',()=>{
  const context={window:{},Date,Intl}; vm.runInNewContext(code,context);
  const time=context.window.finwiseTime;
  for(const timezone of ['Asia/Kolkata','America/Los_Angeles','Europe/London']) {
    for(const date of ['2026-01-15','2026-07-15']) {
      const result=time.transactionTime(date,'23:47',timezone);
      assert.equal(Date.parse(result.effective_at),Date.parse(time.localTimestamp(`${date}T23:47`)));
      assert.equal(result.effective_date,result.effective_at.slice(0,10));
      const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(result.effective_at));
      const part=Object.fromEntries(parts.map(p=>[p.type,p.value]));
      assert.equal(result.effective_date,`${part.year}-${part.month}-${part.day}`);
    }
  }
  assert.throws(()=>time.transactionTime('2026-02-30','12:00','Asia/Kolkata'),/does not exist/);
});
