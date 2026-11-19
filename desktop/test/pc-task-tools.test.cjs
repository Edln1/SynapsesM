'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createPcTaskTools}=require('../src/pc-task-tools.cjs');
test('model common fields map only to fixed native and browser operations',async()=>{
  const calls=[];const windows={catalog:async()=>({ok:true,apps:[]}),windows:async()=>({ok:true,windows:[]}),launch:async args=>{calls.push(args);return{ok:true,verified:true};},moveWindow:async args=>{calls.push(args);return{ok:true,verified:true};}};
  const browser={perform:async(...args)=>{calls.push(args);return{ok:true,verified:true};}};
  const tools=createPcTaskTools({windows,browser,assertActive:()=>true});
  await tools.open_app({target:'app-observed',value:'ignored shell code'});
  await tools.move_window({target:'window-observed',secondary:'display-observed'});
  await tools.type({target:'control-observed',value:'A user query',confirmed:true});
  assert.deepEqual(calls,[{appId:'app-observed'},{windowId:'window-observed',displayId:'display-observed'},['type',{ref:'control-observed',text:'A user query'},{confirmed:false}]]);
});
test('only actual native approval can authorize a concrete risky retry',async()=>{
  const approvals=[],attempts=[];let active=true;
  const tools=createPcTaskTools({windows:{clickControl:async(args,options)=>{attempts.push(options.confirmed);return options.confirmed?{ok:true,verified:true}:{ok:false,confirmationRequired:true,message:'Send this message?'};}},browser:{},assertActive:()=>active,authorizeAction:async question=>{approvals.push(question);return true;}});
  assert.equal((await tools.click_control({target:'window-id',secondary:'observed-ref',confirmed:true})).verified,true);
  assert.deepEqual(attempts,[false,true]);assert.deepEqual(approvals,[{action:'click_control',description:'Send this message?'}]);
  active=false;await assert.rejects(tools.click_control({target:'window-id',secondary:'observed-ref'}));assert.equal(attempts.length,2);
});
test('cancellation or lease revocation while confirmation is open prevents the action',async()=>{
  let active=true,resolveApproval,invocations=0;
  const tools=createPcTaskTools({windows:{pressKey:async()=>{invocations++;return{needsConfirmation:true,message:'Submit form?'};}},browser:{},assertActive:()=>active,authorizeAction:()=>new Promise(resolve=>{resolveApproval=resolve;})});
  const pending=tools.press_key({target:'window-id',value:'ENTER'});await new Promise(resolve=>setImmediate(resolve));active=false;resolveApproval(true);await assert.rejects(pending);assert.equal(invocations,1);
  const canceled=new AbortController();canceled.abort();active=true;await assert.rejects(tools.press_key({target:'window-id',value:'ENTER'},{signal:canceled.signal}));assert.equal(invocations,1);
});
