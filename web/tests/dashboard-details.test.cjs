const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
function setup() {
  const listeners={},pending=[];
  const modal={querySelector:()=>({tabIndex:0,focus:()=>{}}),open:false,innerHTML:'',addEventListener:(name,fn)=>listeners[name]=fn,showModal(){this.open=true;},close(){this.open=false;}};
  const context=vm.createContext({document:{querySelector:()=>modal},state:{month:'2026-10',scope:'personal',me:{household:{base_currency:'INR'}}},reportQuery:()=>'',h:String,
    api:{request:()=>new Promise(resolve=>pending.push(resolve)),collection:async()=>({data:[]})},
    analyticsView:{metricBreakdown:(_summary,_transactions,key)=>({key})},renders:0});
  vm.runInContext(source.slice(source.indexOf('let metricDetailRequest=0;'),source.indexOf('const actions = {')),context);
  vm.runInContext('renderMetricDetail=()=>{renders++;};',context);
  return {context,modal,listeners,pending};
}
test('a queued native close event cannot invalidate a newly opened hero detail',async()=>{
  const {context,modal,listeners,pending}=setup();
  const first=context.openMetricDetail('earned_income');pending.shift()({});await first;
  context.closeMetricDetail();
  const second=context.openMetricDetail('actual_spending');
  listeners.close(); // Browsers queue this event after close() returns.
  pending.shift()({});await second;
  assert.equal(modal.open,true);assert.equal(context.renders,2);
  assert.equal(context.state.metricDetail.data.key,'actual_spending');
});
test('outdated scope responses and responses received after Escape do not overwrite details',async()=>{
  const {context,listeners,pending,modal}=setup();
  const older=context.openMetricDetail('earned_income');
  const newer=context.openMetricDetail('actual_spending');
  pending[1]({});await newer;
  pending[0]({});await older;
  assert.equal(context.state.metricDetail.data.key,'actual_spending');assert.equal(context.renders,1);
  const cancelled=context.openMetricDetail('net_invested');
  listeners.cancel();modal.open=false;
  pending[2]({});await cancelled;
  assert.equal(context.renders,1);
});
