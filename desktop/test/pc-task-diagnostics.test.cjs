'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createTaskDiagnostics}=require('../src/pc-task-diagnostics.cjs');
test('task diagnostics retain only fixed progress names and bounded counts',()=>{
  const writes=[];const log=createTaskDiagnostics({file:'unused',version:'0.1.6',now:()=> 'fixed',write:(_file,data)=>writes.push(JSON.parse(data))});
  log.record({phase:'running-tool',step:3,action:'click_control',text:'PRIVATE',url:'https://PRIVATE',account:'PRIVATE'});
  log.record({phase:'failed',step:0,reasonCode:'timeout',message:'PRIVATE',action:'PRIVATE'});
  assert.deepEqual(writes.at(-1),{version:'0.1.6',time:'fixed',phase:'failed',step:3,action:'click_control',reasonCode:'timeout'});assert.doesNotMatch(JSON.stringify(writes),/PRIVATE/);
  log.record({phase:'planning',step:1});assert.equal(writes.at(-1).action,null);assert.equal(writes.at(-1).reasonCode,'none');
  log.record({phase:'PRIVATE',action:'PRIVATE'});assert.equal(writes.length,3);
});
