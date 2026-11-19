'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {createVoiceDiagnostics,safeReason}=require('../src/voice-diagnostics.cjs');
const {createDesktopVoiceHost,bindDesktopVoice}=require('../src/desktop-voice-host.cjs');
test('diagnostics persist only fixed non-sensitive fields and allowlisted reasons',()=>{
  const writes=[],state={enabled:true,listening:false,sessionId:'DO-NOT-WRITE',email:'private@example.test'};
  const log=createVoiceDiagnostics({file:'status.json',version:'0.1.5',readState:()=>state,writeFile:(file,data)=>writes.push(JSON.parse(data)),now:()=> 'fixed-time'});
  log.record('tray_start');log.record('capture_denied','permission_declined');log.record('stopped','tray_start_failed');
  assert.deepEqual(writes.at(-1),{version:'0.1.5',time:'fixed-time',enabled:true,listening:false,phase:'stopped',stopReasonCode:'permission_declined'});
  assert.equal(JSON.stringify(writes).includes('DO-NOT-WRITE'),false);assert.equal(JSON.stringify(writes).includes('private@'),false);
  log.record('stopped','secret transcript');assert.equal(log.snapshot().stopReasonCode,'permission_declined');
  log.record('tray_start');assert.equal(log.snapshot().stopReasonCode,'none');assert.equal(safeReason('private@example.test'),'user_stop');
  log.record('capture_denied','permission_pending');log.record('listening');assert.equal(log.snapshot().stopReasonCode,'none');
});
test('a client startup failure is recorded even before an enabled lease exists',async()=>{
  const recorded=[],host=createDesktopVoiceHost({onDiagnostic:(phase,reason)=>recorded.push({phase,reason}),openBrowser:()=>{},lookupHost:()=>[]});
  const frame={url:'https://synapses.cloud/'},contents={mainFrame:frame,getURL:()=>frame.url},event={sender:contents,senderFrame:frame};
  const handlers=new Map(),ipcMain={handle:(key,fn)=>handlers.set(key,fn),removeHandler:()=>{}};
  bindDesktopVoice({ipcMain,contents,host,authorizeStart:()=>false,micAllowed:()=>false});
  await handlers.get('pc-voice:stop')(event,{reasonCode:'account_missing',phase:'stopped',transcript:'DO-NOT-WRITE'});
  assert.deepEqual(recorded,[{phase:'stopped',reason:'account_missing'}]);assert.equal(host.state().enabled,false);
});
test('the diagnostic stop payload cannot carry transcript, account or session data through preload',()=>{
  let bridge;const calls=[];
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/desktop-voice-preload.cjs'),'utf8'),{URL,location:{href:'https://synapses.cloud/'},process:{platform:'win32',isMainFrame:true},require:()=>({contextBridge:{exposeInMainWorld:(_name,value)=>{bridge=value;}},ipcRenderer:{invoke:(...args)=>calls.push(args),on:()=>{},removeListener:()=>{}}})});
  bridge.stop({reasonCode:'asr_error',phase:'stopped',text:'private spoken words',email:'private@example.test',sessionId:'PRIVATE'});
  assert.equal(JSON.stringify(calls),JSON.stringify([['pc-voice:stop',{reasonCode:'asr_error'}]]));
});
test('command-complete is persisted only after browser launch resolves, with no requested URL or query',async()=>{
  const writes=[];let release,host;
  const log=createVoiceDiagnostics({file:'status.json',version:'0.1.5',readState:()=>host.state(),writeFile:(_file,data)=>writes.push(JSON.parse(data)),now:()=> 'fixed-time'});
  host=createDesktopVoiceHost({onDiagnostic:log.record,openBrowser:()=>new Promise(resolve=>{release=resolve;}),lookupHost:async()=>[{address:'8.8.8.8'}]});
  const pending=host.start();host.setListening({sessionId:pending.sessionId,active:true});
  const command=host.runCommand({sessionId:pending.sessionId,text:'search for PRIVATE-QUERY'});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(writes.at(-1).phase,'command-received');release();assert.equal((await command).ok,true);assert.equal(writes.at(-1).phase,'command-complete');
  assert.equal(writes.at(-1).enabled,true);assert.equal(writes.at(-1).listening,true);assert.equal(JSON.stringify(writes).includes('PRIVATE-QUERY'),false);assert.equal(JSON.stringify(writes).includes('google.com'),false);
  await host.runCommand({sessionId:pending.sessionId,text:'open file:///C:/PRIVATE'});assert.equal(writes.at(-1).phase,'command-failed');
  await host.runCommand({sessionId:pending.sessionId,text:'PRIVATE-ORDINARY-CONVERSATION'});assert.equal(writes.at(-1).phase,'command-unrecognized');assert.equal(JSON.stringify(writes).includes('PRIVATE-ORDINARY-CONVERSATION'),false);host.stop();
});
test('command diagnostics separate parse, DNS, browser rejection and revoked-lease failures without error content',async()=>{
  const cases=[
    {text:'open',expected:'command_missing_target'},
    {text:'open localhost',expected:'command_target_invalid'},
    {text:'search YouTube',expected:'command_parse_invalid'},
    {lookupHost:async()=>[],expected:'command_dns_empty'},
    {lookupHost:async()=>[{address:'127.0.0.1'}],expected:'command_dns_nonpublic'},
    {lookupHost:async()=>{throw Error('PRIVATE-DNS-DETAIL');},expected:'command_dns_failed'},
    {lookupHost:()=>new Promise(()=>{}),dnsTimeoutMs:1,expected:'command_dns_timeout'},
    {openBrowser:async()=>{throw Error('PRIVATE-OPEN-DETAIL');},expected:'command_open_rejected'}
  ];
  for(const item of cases){
    const recorded=[];const host=createDesktopVoiceHost({onDiagnostic:(phase,reason)=>recorded.push({phase,reason}),lookupHost:async()=>[{address:'8.8.8.8'}],openBrowser:async()=>{},...item});
    const pending=host.start();host.setListening({sessionId:pending.sessionId,active:true});
    try{const result=await host.runCommand({sessionId:pending.sessionId,text:item.text||'open YouTube'});assert.equal(result.reasonCode,item.expected);assert.deepEqual(recorded.at(-1),{phase:'command-failed',reason:item.expected});assert.equal(JSON.stringify(recorded).includes('PRIVATE-'),false);}finally{host.stop();}
  }
  let resolve;const recorded=[],host=createDesktopVoiceHost({onDiagnostic:(phase,reason)=>recorded.push({phase,reason}),lookupHost:()=>new Promise(done=>{resolve=done;}),openBrowser:async()=>{throw Error('must not launch');}});
  const pending=host.start();host.setListening({sessionId:pending.sessionId,active:true});const command=host.runCommand({sessionId:pending.sessionId,text:'open YouTube'});host.stop();resolve([{address:'8.8.8.8'}]);
  assert.equal((await command).reasonCode,'command_lease_revoked');assert.equal(recorded.at(-1).reason,'command_lease_revoked');
});
test('a new command clears older command-only failures while startup or stop failures remain primary',()=>{
  const log=createVoiceDiagnostics({file:'status.json',version:'0.1.5',readState:()=>({enabled:true,listening:true}),writeFile:()=>{}});
  log.record('command-received');log.record('command-failed','command_missing_target');assert.equal(log.snapshot().stopReasonCode,'command_missing_target');
  log.record('command-received');assert.equal(log.snapshot().stopReasonCode,'none');log.record('command-failed','command_dns_failed');assert.equal(log.snapshot().stopReasonCode,'command_dns_failed');
  log.record('command-received');log.record('command-complete');assert.equal(log.snapshot().stopReasonCode,'none');
  log.record('stopped','user_stop');log.record('command-failed','command_lease_revoked');assert.equal(log.snapshot().stopReasonCode,'user_stop');
});
