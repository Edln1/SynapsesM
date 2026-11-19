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
test('transport metadata is content-free, bounded, retained for the result and reset per task',()=>{
  const writes=[];const log=createTaskDiagnostics({file:'unused',version:'0.1.7',now:()=> 'fixed',write:(_file,data)=>writes.push(JSON.parse(data))});
  log.record({phase:'planning',step:1});
  log.record({phase:'transport',step:1,httpStatus:400,providerCode:'output_parse_failed',model:'openai/gpt-oss-20b',attempt:1,accountReferencePresent:true,error:'PRIVATE',userId:'PRIVATE'});
  log.record({phase:'transport',step:1,httpStatus:200,providerCode:'none',model:'openai/gpt-oss-120b',attempt:3,accountReferencePresent:true});
  log.record({phase:'complete',step:3,action:'finish'});
  assert.deepEqual(writes.at(-1).transport,{httpStatus:200,providerCode:'none',model:'openai/gpt-oss-120b',attempt:3,accountReferencePresent:true});assert.doesNotMatch(JSON.stringify(writes),/PRIVATE/);
  log.record({phase:'planning',step:1});assert.equal(Object.hasOwn(writes.at(-1),'transport'),false);
  log.record({phase:'transport',httpStatus:Infinity,providerCode:'PRIVATE',model:'PRIVATE',attempt:99,accountReferencePresent:'PRIVATE'});
  assert.deepEqual(writes.at(-1).transport,{httpStatus:null,providerCode:'unknown',model:'unknown',attempt:null,accountReferencePresent:false});
});
