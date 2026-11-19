'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createDesktopVoiceHost}=require('../src/desktop-voice-host.cjs');
function hostFixture(options={}){
  const opened=[],diagnostics=[];
  const host=createDesktopVoiceHost({openBrowser:async url=>opened.push(url),lookupHost:async()=>[{address:'8.8.8.8'}],onDiagnostic:(...args)=>diagnostics.push(args),...options});
  const lease=host.start();host.setListening({sessionId:lease.sessionId,active:true});return{host,id:lease.sessionId,opened,diagnostics};
}
test('the opt-in task runner receives flexible PC requests before a website-only parse can reject them',async()=>{
  const requests=[];const f=hostFixture({runTask:async(...args)=>{requests.push(args);return {handled:true,ok:true,message:'Codex is on the other monitor.'};}});
  const result=await f.host.runCommand({sessionId:f.id,text:'Could you put Codex over on my other screen?',userId:'verified-account-id'});
  assert.equal(result.ok,true);assert.equal(requests[0][0],'Could you put Codex over on my other screen?');assert.deepEqual(requests[0][1],{userId:'verified-account-id'});assert.deepEqual(f.opened,[]);assert.deepEqual(f.diagnostics.at(-1),['command-complete']);
  assert.equal((await f.host.runCommand({sessionId:f.id,text:'stop PC voice'})).ok,true);assert.equal(requests.length,1);
});
test('ordinary conversation can return to the existing voice chat and no result from a revoked task is accepted',async()=>{
  const normal=hostFixture({runTask:async()=>({handled:false,ok:false,message:''})});
  assert.equal((await normal.host.runCommand({sessionId:normal.id,text:'How are you today?'})).handled,false);normal.host.stop();
  let finish,canceled=0;
  const f=hostFixture({runTask:()=>new Promise(resolve=>{finish=resolve;}),cancelTask:()=>{canceled++;}});
  const pending=f.host.runCommand({sessionId:f.id,text:'open Steam'});f.host.stop();finish({handled:true,ok:true,message:'Must not speak stale success.'});
  const result=await pending;assert.equal(result.ok,false);assert.match(result.message,/canceled/);assert.equal(canceled,1);assert.equal(f.diagnostics.some(row=>row[0]==='command-complete'),false);
});
test('a newer spoken task supersedes an older completion without ending the live microphone session',async()=>{
  const pending=[];const f=hostFixture({runTask:()=>new Promise(resolve=>pending.push(resolve))});
  const older=f.host.runCommand({sessionId:f.id,text:'open Steam'}),newer=f.host.runCommand({sessionId:f.id,text:'open Codex instead'});
  pending[1]({handled:true,ok:true,message:'Opened Codex.'});assert.equal((await newer).ok,true);
  pending[0]({handled:true,ok:true,message:'Opened Steam.'});assert.equal((await older).ok,false);assert.equal(f.host.active(),true);f.host.stop();
});
