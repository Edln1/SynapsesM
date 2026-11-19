'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {audioRequest}=require('../src/policy.cjs');
const {captureAllowed,captureApprovalCurrent}=require('../src/desktop-voice-policy.cjs');
const {createDesktopVoiceHost}=require('../src/desktop-voice-host.cjs');
const {showDialogPreservingWindowState}=require('../src/tray-voice-start.cjs');
const main=fs.readFileSync(require.resolve('../src/main.cjs'),'utf8');
const start=main.indexOf('  siteSession.setPermissionRequestHandler('),end=main.indexOf('  siteSession.setDisplayMediaRequestHandler',start);
assert.ok(start>0&&end>start);
function fixture(){
  let clock=1000,permissionHandler,approve;
  const records=[],results=[],dialogCalls=[],contents={mainFrame:{},getURL:()=> 'https://synapses.cloud/',isDestroyed:()=>false};
  const host=createDesktopVoiceHost({now:()=>clock,openBrowser:()=>{},lookupHost:()=>[]});host.start({allowHiddenStart:true,expiresAt:31000});
  const win={isVisible:()=>false,isMinimized:()=>true};
  const context={contents,win,pcVoice:host,micAllowed:false,pendingMic:false,lastInput:0,audioRequest,captureApprovalCurrent,showDialogPreservingWindowState,
    captureAllowed:()=>captureAllowed({freshInput:false,visible:false,minimized:true,lease:host.state(),hiddenStart:host.startingHidden(),startedAt:1000,now:clock}),validTrayIntent:()=>false,
    voiceDiagnostics:{record:(phase,code)=>records.push({phase,code})},siteSession:{setPermissionRequestHandler:fn=>{permissionHandler=fn;}},Date:{now:()=>clock},
    dialog:{showMessageBox:(...args)=>{dialogCalls.push(args);return new Promise(resolve=>{approve=resolve;});}}};
  vm.runInNewContext(main.slice(start,end),context);
  const details={requestingUrl:'https://synapses.cloud/',isMainFrame:true,mediaTypes:['audio']};
  return {host,records,results,dialogCalls,context,setClock:value=>{clock=value;},approve:()=>approve({response:0}),request:()=>permissionHandler(contents,'media',value=>results.push(value),details)};
}
test('actual native permission handler retains hidden startup through delayed microphone approval',async()=>{
  const f=fixture();try{const pending=f.request();assert.equal(f.dialogCalls[0].length,1);assert.deepEqual(f.results,[]);
    f.setClock(3500);f.approve();await pending;assert.deepEqual(f.results,[true]);assert.equal(f.context.micAllowed,true);assert.equal(f.records.at(-1).phase,'capture_approved');
  }finally{f.host.stop();}
});
test('actual native permission handler rejects and records an expired or revoked delayed approval',async()=>{
  for(const cause of ['expiry','stop']){
    const f=fixture();try{const pending=f.request();if(cause==='expiry')f.setClock(31001);else f.host.stop();f.approve();await pending;
      assert.deepEqual(f.results,[false],cause);assert.equal(f.context.micAllowed,false,cause);assert.deepEqual(f.records.at(-1),{phase:'capture_denied',code:'permission_expired'});
    }finally{f.host.stop();}
  }
});
