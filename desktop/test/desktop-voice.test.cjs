'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {parseVoiceCommand,publicAddress,publicWebUrl,captureAllowed}=require('../src/desktop-voice-policy.cjs');
const {createDesktopVoiceHost,bindDesktopVoice,voiceSender,startClientFromNativeGesture}=require('../src/desktop-voice-host.cjs');
function fixture(options={}){const opened=[],states=[],stops=[];const host=createDesktopVoiceHost({onState:s=>states.push(s),onStop:m=>{stops.push(m);return true},openBrowser:async url=>opened.push(url),lookupHost:async()=>[{address:'8.8.8.8'}],...options});return {host,opened,states,stops};}
function activate(host){const s=host.start();host.setListening({sessionId:s.sessionId,active:true});return s.sessionId;}
test('voice commands require the wake prefix and route only supported public web actions',()=>{
  assert.equal(parseVoiceCommand('open youtube.com').handled,false);
  assert.equal(parseVoiceCommand('Ava, how are you?').handled,false);
  assert.equal(parseVoiceCommand('Ava, open YouTube.').url,'https://www.youtube.com/');
  assert.equal(parseVoiceCommand('Ava open YouTube').url,'https://www.youtube.com/');
  assert.equal(parseVoiceCommand('Hey Ava: search for coffee').url,'https://www.google.com/search?q=coffee');
  for(const phrase of ['available open youtube.com','tell Ava open youtube.com','"Ava open youtube.com"'])assert.equal(parseVoiceCommand(phrase).handled,false);
  assert.equal(parseVoiceCommand('Ava, open the YouTube website').url,'https://www.youtube.com/');
  assert.equal(parseVoiceCommand('Ava, open example.com').url,'https://example.com/');
  assert.equal(parseVoiceCommand('Ava, search for good coffee').url,'https://www.google.com/search?q=good+coffee');
  assert.equal(parseVoiceCommand('Ava, stop PC voice').type,'stop');
  for(const target of ['http://example.com','file:///C:/test.txt','C:\\Windows\\cmd.exe','localhost','router.local','127.0.0.1','192.168.1.1','[::1]','https://user:pass@example.com','https://example.com:444/','javascript:alert(1)']){const r=parseVoiceCommand('Ava, open '+target);assert.equal(r.handled,true,target);assert.equal(r.ok,false,target);}
});
test('URL and resolved-address policies reject local, private and reserved endpoints',()=>{
  for(const address of ['127.0.0.1','10.1.2.3','192.168.0.1','169.254.1.1','172.16.0.1','100.64.0.1','0.0.0.0','198.51.100.1','203.0.113.2','224.0.0.1','::1','::ffff:127.0.0.1','fe80::1','fc00::1','2001:db8::1'])assert.equal(publicAddress(address),false,address);
  for(const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])assert.equal(publicAddress(address),true,address);
  assert.equal(publicWebUrl('https://127.1/'),null);assert.equal(publicWebUrl('https://example.com/'),'https://example.com/');
});
test('only a current listening lease can open a website or stop control',async()=>{
  const f=fixture();assert.equal((await f.host.runCommand({sessionId:'bad',text:'Ava, open YouTube'})).handled,false);
  const pending=f.host.start();assert.equal(f.host.active(),false);assert.equal((await f.host.runCommand({sessionId:pending.sessionId,text:'Ava, open YouTube'})).handled,false);
  f.host.setListening({sessionId:'stale',active:true});assert.equal(f.host.active(),false);
  f.host.setListening({sessionId:pending.sessionId,active:true});assert.equal(f.host.active(),true);
  assert.equal((await f.host.runCommand({sessionId:pending.sessionId,text:'Ava, open YouTube'})).ok,true);assert.deepEqual(f.opened,['https://www.youtube.com/']);
  assert.equal((await f.host.runCommand({sessionId:pending.sessionId,text:'Ava, stop'})).ok,true);assert.equal(f.host.active(),false);assert.equal(f.host.state().sessionId,null);
  assert.equal((await f.host.runCommand({sessionId:pending.sessionId,text:'Ava, open github.com'})).handled,false);
});
test('DNS private addresses and lease revocation during lookup cannot launch a browser',async()=>{
  const local=fixture({lookupHost:async()=>[{address:'127.0.0.1'}]});const localId=activate(local.host);assert.equal((await local.host.runCommand({sessionId:localId,text:'Ava, open public-looking.example.com'})).ok,false);assert.equal(local.opened.length,0);local.host.stop();
  let resolve;const f=fixture({lookupHost:()=>new Promise(done=>{resolve=done})});const id=activate(f.host);const action=f.host.runCommand({sessionId:id,text:'Ava, open youtube.com'});f.host.stop();resolve([{address:'8.8.8.8'}]);assert.equal((await action).ok,false);assert.equal(f.opened.length,0);
});
test('inactive capture and startup timeout revoke the session',async()=>{
  const f=fixture();const id=activate(f.host);f.host.setListening({sessionId:id,active:false});assert.equal(f.host.state().enabled,false);await f.host.waitForStop();assert.equal(f.stops.length,1);
  const timed=fixture({pendingTimeoutMs:1});timed.host.start();await new Promise(resolve=>setTimeout(resolve,8));assert.equal(timed.host.state().enabled,false);
});
test('native voice IPC rejects foreign contents, subframes and origin changes',async()=>{
  const frame={url:'https://synapses.cloud/'},contents={mainFrame:frame,getURL:()=>frame.url};const event={sender:contents,senderFrame:frame};assert.equal(voiceSender(event,contents),true);assert.equal(voiceSender({sender:contents,senderFrame:{url:frame.url}},contents),false);assert.equal(voiceSender({sender:{},senderFrame:frame},contents),false);
  const handlers=new Map(),ipcMain={handle:(n,f)=>handlers.set(n,f),removeHandler:n=>handlers.delete(n)};const f=fixture();let allow=false;
  const unbind=bindDesktopVoice({ipcMain,contents,host:f.host,authorizeStart:async()=>allow,micAllowed:()=>false});
  assert.equal((await handlers.get('pc-voice:start')(event)).enabled,false);allow=true;const s=await handlers.get('pc-voice:start')(event);assert.equal(s.enabled,true);
  assert.equal(handlers.get('pc-voice:listening')(event,{sessionId:'stale',active:true}).enabled,true);
  assert.equal(handlers.get('pc-voice:listening')(event,{sessionId:s.sessionId,active:true}).enabled,false);
  frame.url='https://evil.test/';assert.throws(()=>handlers.get('pc-voice:state')(event));unbind();assert.equal(handlers.size,0);
});
test('preload exposes only the narrow Windows trusted-main-frame capability',()=>{
  const code=fs.readFileSync(require.resolve('../src/desktop-voice-preload.cjs'),'utf8');
  function load(platform,isMainFrame,href){let bridge;const sandbox={URL,location:{href},process:{platform,isMainFrame},require:name=>{assert.equal(name,'electron');return {contextBridge:{exposeInMainWorld:(_name,value)=>{bridge=value}},ipcRenderer:{invoke:()=>{},on:()=>{},removeListener:()=>{}}}}};vm.runInNewContext(code,sandbox);return bridge;}
  assert.equal(load('win32',false,'https://synapses.cloud/'),undefined);assert.equal(load('win32',true,'https://synapses.cloud.evil.test/'),undefined);assert.equal(load('android',true,'https://synapses.cloud/'),undefined);
  const bridge=load('win32',true,'https://synapses.cloud/');assert.deepEqual(Object.keys(bridge).sort(),['getState','onRequest','onState','runCommand','setListening','start','stop']);assert.equal(Object.isFrozen(bridge),true);
});
test('Stop during pending native consent cannot revive a lease or spawn duplicate dialogs',async()=>{
  const frame={url:'https://synapses.cloud/'},contents={mainFrame:frame,getURL:()=>frame.url},event={sender:contents,senderFrame:frame};
  const handlers=new Map(),ipcMain={handle:(n,f)=>handlers.set(n,f),removeHandler:n=>handlers.delete(n)},f=fixture();let approve,dialogs=0;
  bindDesktopVoice({ipcMain,contents,host:f.host,authorizeStart:()=>{dialogs++;return new Promise(resolve=>{approve=resolve})},micAllowed:()=>true});
  const first=handlers.get('pc-voice:start')(event),duplicate=handlers.get('pc-voice:start')(event);assert.equal(dialogs,1);
  f.host.stop('Signed out.');approve(true);assert.equal((await first).enabled,false);assert.equal((await duplicate).enabled,false);assert.equal(f.host.state().sessionId,null);
});
test('hidden audio capture requires a live explicit lease, not just a startup token or old gesture',()=>{
  const base={freshInput:false,visible:false,minimized:false,lease:{enabled:false,listening:false},startedAt:1000,now:2000};
  assert.equal(captureAllowed(base),false);assert.equal(captureAllowed({...base,freshInput:true}),false);
  assert.equal(captureAllowed({...base,lease:{enabled:true,listening:false}}),false);
  assert.equal(captureAllowed({...base,lease:{enabled:true,listening:true}}),true);
  assert.equal(captureAllowed({...base,visible:true,lease:{enabled:true,listening:false}}),true);
  assert.equal(captureAllowed({...base,visible:true,now:32000,lease:{enabled:true,listening:false}}),false);
});
test('only the trusted native tray path forwards user activation to the packaged client',async()=>{
  const calls=[],contents={getURL:()=> 'https://synapses.cloud/?desktop=0.1.3',executeJavaScript:async(script,userGesture)=>{calls.push({script,userGesture});return true}};
  assert.equal(await startClientFromNativeGesture(contents),true);assert.equal(calls[0].userGesture,true);assert.ok(calls[0].script.includes('window.synapsesDesktopVoiceClient.start()'));
  contents.getURL=()=> 'https://evil.test/';await assert.rejects(startClientFromNativeGesture(contents));assert.equal(calls.length,1);
});
