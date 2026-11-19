'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createDocumentGate}=require('../src/document-gate.cjs');
const {newMainDocument}=require('../src/policy.cjs');
function fixture(){let visible=false;const gate=createDocumentGate({showSurface:()=>{visible=true},hideSurface:()=>{visible=false}});return {gate,visible:()=>visible};}
test('hash and pushState changes during pending CSS do not blank the same document',async()=>{
  for(const type of ['hash','pushState']){
    const f=fixture();let finishCss;f.gate.prepare(new Promise(resolve=>{finishCss=resolve}),()=>new Promise(()=>{}));const showing=f.gate.finish();
    const event={isMainFrame:true,isSameDocument:true,type};if(newMainDocument(event))f.gate.reset();finishCss();assert.equal(await showing,true,type);assert.equal(f.visible(),true,type);
  }
});
test('an optional slow or failed client cannot block the required app surface',async()=>{
  const f=fixture();f.gate.prepare(Promise.resolve(),()=>new Promise(()=>{}));assert.equal(await f.gate.finish(),true);assert.equal(f.visible(),true);
  f.gate.reset();f.gate.prepare(Promise.resolve(),()=>{throw Error('optional unavailable')});assert.equal(await f.gate.finish(),true);assert.equal(f.visible(),true);
});
test('a new document invalidates old CSS readiness and prevents stale visibility',async()=>{
  const f=fixture();let finishOld;f.gate.prepare(new Promise(resolve=>{finishOld=resolve}));const old=f.gate.finish();f.gate.reset();finishOld();assert.equal(await old,false);assert.equal(f.visible(),false);f.gate.prepare(Promise.resolve());assert.equal(await f.gate.finish(),true);
});
