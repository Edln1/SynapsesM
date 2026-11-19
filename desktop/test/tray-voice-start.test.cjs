'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createTrayVoiceStarter,showDialogPreservingWindowState}=require('../src/tray-voice-start.cjs');
const {createDesktopVoiceHost,bindDesktopVoice}=require('../src/desktop-voice-host.cjs');
const {captureAllowed,captureApprovalCurrent}=require('../src/desktop-voice-policy.cjs');
function windowFixture(visible,minimized){const state={visible,minimized},calls=[];return {state,calls,win:{isVisible:()=>state.visible,isMinimized:()=>state.minimized,show:()=>calls.push('show'),hide:()=>calls.push('hide'),restore:()=>calls.push('restore'),focus:()=>calls.push('focus')}};}
test('tray Start preserves visible, hidden and minimized window states exactly',async()=>{
  for(const [visible,minimized] of [[true,false],[false,false],[false,true]]){
    const f=windowFixture(visible,minimized),starter=createTrayVoiceStarter({beginIntent:()=>{},ready:async()=>true,startClient:async()=>true,requestReload:async()=>{},failed:()=>{},finishAttempt:()=>{}});
    assert.equal(await starter.start(),true);assert.deepEqual(f.state,{visible,minimized});assert.deepEqual(f.calls,[]);
  }
});
test('an async start never restores an old snapshot over a newer user window choice',async()=>{
  const f=windowFixture(true,false);let ready;const starter=createTrayVoiceStarter({beginIntent:()=>{},ready:()=>new Promise(resolve=>{ready=resolve}),startClient:async()=>true,requestReload:async()=>{},failed:()=>{},finishAttempt:()=>{}});
  const start=starter.start();f.state.visible=false;f.state.minimized=true;ready(true);await start;assert.deepEqual(f.state,{visible:false,minimized:true});assert.deepEqual(f.calls,[]);
});
test('failed account/capture startup notifies without opening or hiding the app',async()=>{
  const f=windowFixture(false,true);let failures=0;const starter=createTrayVoiceStarter({beginIntent:()=>{},ready:async()=>true,startClient:async()=>false,requestReload:async()=>{},failed:()=>{failures++},finishAttempt:()=>{}});assert.equal(await starter.start(),false);assert.equal(failures,1);assert.deepEqual(f.state,{visible:false,minimized:true});assert.deepEqual(f.calls,[]);
});
test('native consent is parented only when the main window is already visible and restored',async()=>{
  for(const [visible,minimized] of [[true,false],[false,false],[true,true],[false,true]]){
    const f=windowFixture(visible,minimized),calls=[],options={message:'Allow microphone?'};await showDialogPreservingWindowState({showMessageBox:async(...args)=>{calls.push(args);return {response:0}}},f.win,options);
    assert.equal(calls[0].length,visible&&!minimized?2:1);assert.equal(calls[0].at(-1),options);assert.deepEqual(f.state,{visible,minimized});assert.deepEqual(f.calls,[]);
  }
});
test('a hidden tray grant survives client return and delayed microphone consent until live-track handoff',async()=>{
  let clock=1000,intent=null,micApproved=false;
  const frame={url:'https://synapses.cloud/'},contents={mainFrame:frame,getURL:()=>frame.url},event={sender:contents,senderFrame:frame},handlers=new Map();
  const host=createDesktopVoiceHost({now:()=>clock,openBrowser:()=>{},lookupHost:()=>[]});
  bindDesktopVoice({ipcMain:{handle:(key,fn)=>handlers.set(key,fn),removeHandler:()=>{}},contents,host,micAllowed:()=>micApproved,authorizeStart:()=>{const grant={allowed:true,allowHiddenStart:true,expiresAt:intent.expiresAt};intent=null;return grant;}});
  const starter=createTrayVoiceStarter({beginIntent:()=>{intent={expiresAt:clock+30000};},ready:async()=>true,startClient:async()=>{await handlers.get('pc-voice:start')(event);return host.state().enabled;},requestReload:()=>{},failed:()=>{throw Error('must stay starting');},finishAttempt:()=>{if(!host.state().enabled)intent=null;}});
  assert.equal(await starter.start(),true);assert.equal(intent,null);assert.equal(host.startingHidden(),true);assert.equal(host.state().listening,false);
  const before={generation:host.generation(),sessionId:host.state().sessionId,frame};
  clock+=2500;
  const allowed=captureAllowed({freshInput:false,visible:false,minimized:true,lease:host.state(),hiddenStart:host.startingHidden(),startedAt:1000,now:clock});
  assert.equal(captureApprovalCurrent(before,{...before},allowed),true);micApproved=true;
  assert.equal(handlers.get('pc-voice:listening')(event,{sessionId:before.sessionId,active:true}).listening,true);assert.equal(host.active(),true);host.stop();
});
