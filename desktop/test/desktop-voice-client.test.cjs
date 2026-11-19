'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createDesktopVoiceClient}=require('../src/desktop-voice-client.js');
const {createDesktopVoiceHost}=require('../src/desktop-voice-host.cjs');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

class Element {
  constructor(document){this.document=document;this.children=[];this.style={};this.textContent='';this.hidden=false;this.attrs={};}
  set id(value){this._id=value;this.document.nodes.set(value,this);}get id(){return this._id;}
  appendChild(node){node.parentNode=this;this.children.push(node);return node;}
  insertBefore(node,anchor){node.parentNode=this;const i=this.children.indexOf(anchor);if(i<0)this.children.push(node);else this.children.splice(i,0,node);return node;}
  setAttribute(name,value){this.attrs[name]=String(value);}
  querySelector(){return this.children.find(node=>node.id==='account')||null;}
  remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(node=>node!==this);this.document.nodes.delete(this.id);}
}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
async function flush(){for(let i=0;i<20;i++)await Promise.resolve();}
function webSource(){
  const candidates=[process.env.SYNAPSES_WEB_SOURCE,path.join(__dirname,'../../index.html'),path.join(__dirname,'../../synapses-ava-agent-v1/index.html')].filter(Boolean);
  const sourcePath=candidates.find(value=>fs.existsSync(value));assert.ok(sourcePath,'Actual Synapses web source is required. Set SYNAPSES_WEB_SOURCE to the release index.html.');
  return fs.readFileSync(sourcePath,'utf8');
}
function fixture(t,{api=true,available=true,hook=true,capture=true,startOverride,runOverride}={}){
  const document={nodes:new Map(),hidden:false};document.createElement=()=>new Element(document);document.getElementById=id=>document.nodes.get(id)||null;
  document.head=new Element(document);const menu=new Element(document);menu.id='avaFloatPopover';const account=new Element(document);account.id='account';menu.appendChild(account);
  const window=new EventTarget();window.document=document;window.currentUser={id:'one',email:'one@example.test'};
  window.__synapsesDesktopVoiceHookVersion=hook?1:0;let now=1000,nextTimer=0;const timers=new Map();
  window.Date={now:()=>now};window.setTimeout=fn=>{const id=++nextTimer;timers.set(id,fn);return id;};window.clearTimeout=id=>timers.delete(id);
  const calls={start:0,stop:0,listen:[],voiceStarts:0,voiceStops:0,commands:[],urls:[]},states=[],requests=[];
  const host=createDesktopVoiceHost({onState:state=>states.forEach(fn=>fn(state)),openBrowser:async url=>{calls.urls.push(url);},lookupHost:async()=>[{address:'93.184.216.34'}],makeId:()=> 'native-owned-session'});
  const native={getState:async()=>({...host.state(),available}),start:async()=>{calls.start++;return startOverride?startOverride(host):host.start();},stop:async payload=>{calls.stop++;calls.stopPayload=payload;return host.stop();},
    setListening:async value=>{calls.listen.push(value);return host.setListening(value);},runCommand:async value=>{calls.commands.push(value);return runOverride?runOverride(value):host.runCommand(value);},
    onState:fn=>{states.push(fn);return()=>states.splice(states.indexOf(fn),1);},onRequest:fn=>{requests.push(fn);return()=>requests.splice(requests.indexOf(fn),1);}};
  function live(){window._topNavVoiceActive=true;window._stream={getAudioTracks:()=>[{enabled:true,readyState:'live'}]};}
  window.avaFloatingStartVoice=()=>{calls.voiceStarts++;if(!window.currentUser)return 'sign-in';window._topNavVoiceActive=true;if(capture)live();return 'speech-to-speech';};
  window.toggleTopNavVoice=()=>{calls.voiceStarts++;window._topNavVoiceActive=true;if(capture)live();};
  window.avaCompanionChatBridge={verify:async()=>{},current:()=>window.currentUser,isCurrent:user=>!!user&&user===window.currentUser};
  window.stopTopNavVoice=options=>{calls.voiceStops++;calls.stopOptions=options;window._topNavVoiceActive=false;window._stream=null;};
  if(api)window.synapsesDesktopVoice=native;
  const client=createDesktopVoiceClient(window,document);
  t.after(async()=>{if(client)await client.destroy();host.stop();});
  return{window,document,client,host,calls,live,timerCount:()=>timers.size,request:action=>requests.forEach(fn=>fn({action})),
    async tick(ms=250){now+=ms;for(const[id,fn]of[...timers]){timers.delete(id);await fn();}await flush();}};
}

test('normal browsers and mobile documents without the native API install no PC UI or controller',t=>{
  const f=fixture(t,{api:false});assert.equal(f.client,null);assert.equal(f.window.synapsesDesktopVoiceClient,undefined);assert.equal(f.document.getElementById('avaDesktopVoiceToggle'),null);
});
test('API shape alone does not enable PC features without the native capability handshake',async t=>{
  const f=fixture(t,{available:false});assert.equal(await f.client.ready,false);assert.equal(f.window.synapsesDesktopVoiceClient,undefined);assert.equal(f.document.getElementById('avaDesktopVoiceToggle'),null);assert.equal(await f.client.start(),false);assert.equal(f.calls.start,0);
});
test('cached HTML without the accepted-ASR hook asks for reload before requesting native consent',async t=>{
  const f=fixture(t,{hook:false});await f.client.ready;assert.equal(await f.client.start(),false);assert.equal(f.calls.start,0);assert.match(f.document.getElementById('avaDesktopVoiceStatus').textContent,/Reload/);
});
test('native listening is reported only after actual voice and a live enabled capture track',async t=>{
  const f=fixture(t,{capture:false});await f.client.ready;await f.client.start();assert.equal(f.calls.voiceStarts,1);assert.equal(f.calls.listen.length,0);assert.equal(f.client.enabled(),false);
  f.live();await f.tick();assert.equal(f.client.enabled(),true);assert.deepEqual(f.calls.listen,[{sessionId:'native-owned-session',active:true}]);
});
test('tray startup verifies the real account and starts the header engine rather than cosmetic fingerprint verification',async t=>{
  const f=fixture(t);await f.client.ready;let cosmetic=0;f.window.avaFloatingStartVoice=()=>{cosmetic++;return 'verification';};
  f.document.hidden=true;f.window.setView=()=>{throw Error('must preserve view');};f.window.show=()=>{throw Error('must preserve visibility');};f.window.focus=()=>{throw Error('must preserve focus');};
  await f.client.start();assert.equal(cosmetic,0);assert.equal(f.calls.voiceStarts,1);assert.equal(f.client.enabled(),true);
  assert.equal(f.document.hidden,true);
});
test('an unverified account cannot start native PC voice even if a cosmetic helper reports success',async t=>{
  const f=fixture(t);await f.client.ready;f.window.avaCompanionChatBridge.current=()=>null;
  assert.equal(await f.client.start(),false);assert.equal(f.calls.voiceStarts,0);assert.equal(f.host.active(),false);
});
test('hidden startup never opens sign-in or another app view when account verification is missing or fails',async t=>{
  for(const cause of ['missing','unverified','error']){
    const f=fixture(t);await f.client.ready;f.document.hidden=true;let changes=0;
    f.window.avaFloatingStartVoice=()=>{changes++;};f.window.setView=()=>{changes++;};f.window.show=()=>{changes++;};f.window.focus=()=>{changes++;};
    if(cause==='missing')f.window.currentUser=null;
    else if(cause==='unverified')f.window.avaCompanionChatBridge.current=()=>null;
    else f.window.avaCompanionChatBridge.verify=async()=>{throw Error('session unavailable');};
    assert.equal(await f.client.start(),false,cause);assert.equal(changes,0,cause);assert.equal(f.document.hidden,true,cause);assert.equal(f.calls.voiceStarts,0,cause);assert.equal(f.host.active(),false,cause);
    assert.match(f.document.getElementById('avaDesktopVoiceStatus').textContent,/Sign in|could not start/,cause);
  }
});
test('an explicitly leased hidden session keeps capture and opens only the native HTTPS/search commands',async t=>{
  const f=fixture(t);await f.client.ready;await f.client.start();f.document.hidden=true;f.window.dispatchEvent(new Event('visibilitychange'));await f.tick(1000);
  assert.equal(f.client.enabled(),true);assert.equal(f.calls.voiceStops,0);
  assert.equal((await f.client.consume('Ava, open YouTube')).ok,true);assert.equal((await f.client.consume('Ava, search for space news')).ok,true);
  assert.deepEqual(f.calls.urls,['https://www.youtube.com/','https://www.google.com/search?q=space+news']);
});
test('ordinary conversation falls through while invalid wake-prefixed browser commands are consumed errors',async t=>{
  const f=fixture(t);await f.client.ready;await f.client.start();assert.equal((await f.client.consume('Tell me a joke')).handled,false);
  const invalid=await f.client.consume('Ava, open file:///C:/Windows');assert.equal(invalid.handled,true);assert.equal(invalid.ok,false);assert.equal(f.calls.urls.length,0);
});
test('voice-off, account change and true pagehide each revoke the native lease',async t=>{
  for(const cause of ['voice','account','pagehide']){
    const f=fixture(t);await f.client.ready;await f.client.start();
    if(cause==='voice')f.window._topNavVoiceActive=false;
    if(cause==='account')f.window.currentUser={id:'two',email:'two@example.test'};
    if(cause==='pagehide')f.window.dispatchEvent(new Event('pagehide'));
    await f.tick();assert.equal(f.host.active(),false,cause);assert.equal(f.client.enabled(),false,cause);assert.deepEqual(f.calls.stopOptions,{skipAway:true},cause);
  }
});
test('logout while native consent is pending cancels that attempt before voice starts',async t=>{
  const consent=deferred(),f=fixture(t,{startOverride:()=>consent.promise});await f.client.ready;const starting=f.client.start();await flush();
  f.window.currentUser=null;await f.tick();assert.ok(f.calls.stop>0);consent.resolve(f.host.state());assert.equal(await starting,false);assert.equal(f.calls.voiceStarts,0);
});
test('a late native approval cannot transfer PC voice to a different signed-in account',async t=>{
  const consent=deferred(),f=fixture(t,{startOverride:async host=>{await consent.promise;return host.start();}});await f.client.ready;const starting=f.client.start();await flush();
  f.window.currentUser={id:'two',email:'two@example.test'};consent.resolve();assert.equal(await starting,false);assert.equal(f.calls.voiceStarts,0);assert.equal(f.host.active(),false);
});
test('native setup timeout clears pending account monitoring even while account verification is hung',async t=>{
  const verify=deferred(),f=fixture(t);await f.client.ready;f.window.avaCompanionChatBridge.verify=()=>verify.promise;
  const starting=f.client.start();await flush();assert.ok(f.timerCount()>0);f.host.stop('Microphone setup timed out.');await flush();
  assert.equal(f.timerCount(),0);assert.equal(f.client.active(),false);await f.tick();assert.equal(f.timerCount(),0);
  verify.resolve();assert.equal(await starting,false);assert.equal(f.calls.voiceStarts,0);
});
test('denied consent and the real capture startup deadline leave no enabled native session',async t=>{
  const denied=fixture(t,{startOverride:host=>({...host.state(),message:'Cancelled'})});await denied.client.ready;assert.equal(await denied.client.start(),false);assert.equal(denied.calls.voiceStarts,0);
  const failed=fixture(t,{capture:false});await failed.client.ready;await failed.client.start();failed.window._topNavVoiceActive=false;await failed.tick(2000);assert.equal(failed.client.active(),true);assert.equal(failed.calls.stop,0);
  await failed.tick(29000);assert.equal(failed.host.active(),false);assert.equal(failed.client.active(),false);assert.equal(failed.client.diagnostics().reasonCode,'capture_timeout');
});
test('a delayed asynchronous microphone starter remains starting beyond 1.5 seconds and then becomes listening',async t=>{
  const f=fixture(t,{capture:false}),permission=deferred();await f.client.ready;f.window.toggleTopNavVoice=async()=>{f.calls.voiceStarts++;await permission.promise;f.live();};
  const start=f.client.start();await flush();await f.tick(2500);assert.equal(f.client.diagnostics().phase,'microphone-starting');assert.equal(f.client.active(),true);assert.equal(f.client.enabled(),false);assert.equal(f.calls.stop,0);
  permission.resolve();assert.equal(await start,true);assert.equal(f.client.enabled(),true);assert.equal(f.client.diagnostics().phase,'listening');
});
test('actual production toggle and acquisition stay starting during delayed microphone permission, then record and listen',async t=>{
  const html=webSource();function extract(a,b){const start=html.indexOf(a),end=html.indexOf(b,start);assert.ok(start>=0&&end>start,a);return html.slice(start,end);}
  const active=extract('  function _setTopNavVoiceActive(v)', '  // True while Ava');
  const mic=extract('  var _micSessionGeneration = 0;', '  // AVA_MIC_LIFECYCLE_END');
  const toggle=extract('  window.stopTopNavVoice = function(opt)', '\n})();');
  const f=fixture(t,{capture:false}),permission=deferred();await f.client.ready;let requests=0,records=0;
  f.document.body={classList:{toggle(){}}};f.document.addEventListener=()=>{};f.window._sttProvider='legacy';
  const context=vm.createContext({window:f.window,document:f.document,navigator:{mediaDevices:{getUserMedia(){requests++;return permission.promise;}}},fetch:()=>Promise.resolve(),console:{error(){},log(){},warn(){}},
    _on:false,_stream:null,_busy:false,_busySince:0,_ttsBusy:false,_maybeGuideNotesSaveLine:()=>false,_maybeGuideS2SIntro:()=>false,_maybeS2SFirstIntro:()=>false,_unlockVoiceAudio(){},_ensureBargeAnalyser(){},record(){records++;},toast(){},
    stopAll(){context._on=false;context._setTopNavVoiceActive(false);context._invalidateMicCapture();}});
  vm.runInContext(active+'\n'+mic+'\n'+toggle,context);
  assert.equal(await f.client.start(),true);await f.tick(2500);assert.equal(requests,1);assert.equal(records,0);assert.equal(f.client.active(),true);assert.equal(f.client.enabled(),false);assert.equal(f.client.diagnostics().phase,'microphone-starting');assert.equal(f.calls.stop,0);
  const track={enabled:true,readyState:'live',stop(){this.readyState='ended';}};permission.resolve({getAudioTracks:()=>[track],getTracks:()=>[track]});await flush();await f.tick();
  assert.equal(records,1);assert.equal(f.client.enabled(),true);assert.equal(f.client.diagnostics().phase,'listening');assert.equal(f.calls.listen.length,1);
});
test('privacy-safe diagnostics retain exact terminal reason codes and immutable snapshots',async t=>{
  const f=fixture(t);await f.client.ready;await f.client.start();f.client.noteFallback('asr_closed');assert.equal(f.client.diagnostics().phase,'whisper-fallback');
  await f.client.stop('Could not start microphone capture.','capture_unreadable');const snapshot=f.client.diagnostics();assert.equal(snapshot.phase,'stopped');assert.equal(snapshot.reasonCode,'capture_unreadable');assert.deepEqual(f.calls.stopPayload,{phase:'stopped',reasonCode:'capture_unreadable'});
  assert.ok(Object.isFrozen(snapshot));assert.ok(Object.isFrozen(snapshot.transitions));assert.doesNotMatch(JSON.stringify(snapshot),/one@example|native-owned-session|Could not|transcript|query|https:/);
  assert.deepEqual(Object.keys(snapshot).sort(),['captureLive','elapsedMs','enabled','hidden','listening','phase','reasonCode','starting','transitions','version','voiceActive'].sort());
});
test('IPC command failures are consumed and revoke PC control instead of falling through to model success claims',async t=>{
  const f=fixture(t,{runOverride:async()=>{throw Error('IPC lost');}});await f.client.ready;await f.client.start();const result=await f.client.consume('Ava, open YouTube');assert.equal(result.handled,true);assert.equal(result.ok,false);assert.equal(f.host.active(),false);
});
test('native tray start/stop requests use the same real voice controller',async t=>{
  const f=fixture(t);await f.client.ready;f.request('start');await flush();assert.equal(f.client.enabled(),true);f.request('stop');await flush();assert.equal(f.client.enabled(),false);assert.equal(f.host.active(),false);
});
test('destroy becomes unavailable before asynchronous cleanup, preventing concurrent restarts',async t=>{
  const f=fixture(t);await f.client.ready;await f.client.start();const closing=f.client.destroy();assert.equal(await f.client.start(),false);await closing;assert.equal(f.window.synapsesDesktopVoiceClient,undefined);assert.equal(f.calls.start,1);
});

test('real accepted-ASR hook routes plain commands through the packaged client and native host before any model path',async t=>{
  const html=webSource();
  function extract(a,b){const start=html.indexOf(a),end=html.indexOf(b,start);assert.ok(start>=0&&end>start,a);return html.slice(start,end);}
  const current=extract('  function _micSessionCurrent(generation)','  function _stopMicTracks');
  const ask=extract('  async function ask(text, speech)','    // DESKTOP_VOICE_COMMAND_HOOK_END')+'\n normal++;\n}';
  const routeTrace=extract('  var _pcSpeechRouteCount = 0;', '  window.__synapsesDesktopVoiceHookVersion');
  const transcribe=extract('  function transcribe(blob)','  function record()');
  const flux=extract('function _fluxHandleEvent(msg, speech)','function _fluxConnect(');
  const handoff=html.match(/window\._fluxSessionStart\((\{[\s\S]*?\n\s*\})\)\)/)?.[1];assert.ok(handoff);
  function speechFixture(f){
    const spoken=[];let transcript='';const context=vm.createContext({window:f.window,mobileAva:false,_on:true,_micSessionGeneration:4,micGeneration:4,_voiceTurnId:0,_bargeNeedsDirectAnswer:false,_bargeTurnActive:false,_bargeForceToast:false,_ttsBusy:false,_busy:true,_busySince:100,_bargeHoldToast:false,_flux:{},normal:0,
      FormData:class{append(){}},AbortController,GROQ_PROXY:'https://voice.invalid',_registerTurnAbort(){},fetch:async()=>({json:async()=>({text:transcript})}),console:{log(){},warn(){}},
      speak:value=>spoken.push(value),toast:value=>spoken.push(value),toastHide(){},record(){},setTimeout(){},clearTimeout(){}});
    vm.runInContext(current+'\n'+routeTrace+'\n'+ask+'\n'+transcribe+'\n'+flux+'\nvar acceptedFlux='+handoff+';',context);
    return{context,spoken,async deliver(text,provider){transcript=text;if(provider==='flux')context._fluxHandleEvent({event:'EndOfTurn',transcript:text},context.acceptedFlux);else context.transcribe({type:'audio/webm'});await flush();}};
  }
  for(const provider of ['whisper','flux']){
    const f=fixture(t);await f.client.ready;await f.client.start();f.document.hidden=true;const speech=speechFixture(f);
    const utterances=['open YouTube','open browser','search for quiet keyboards','Would you be able to open YouTube?','Are you able to open YouTube?','Can you open YouTube for me?','Open up YouTube','Open You Tube','open DoorDash','open Door Dash','search YouTube for Michael Jackson','go to YouTube and search for Michael Jackson','play Michael Jackson on YouTube'];
    for(const command of utterances)await speech.deliver(command,provider);
    assert.deepEqual(f.calls.urls,['https://www.youtube.com/','https://www.google.com/','https://www.google.com/search?q=quiet+keyboards',...Array(5).fill('https://www.youtube.com/'),...Array(2).fill('https://www.doordash.com/'),...Array(3).fill('https://www.youtube.com/results?search_query=Michael+Jackson')]);
    assert.deepEqual(f.calls.commands.map(value=>value.text),utterances);assert.ok(f.calls.commands.every(value=>value.sessionId==='native-owned-session'));
    assert.equal(speech.context.normal,0);assert.equal(speech.spoken.length,utterances.length);assert.match(speech.spoken[0],/^Opening/);assert.equal(speech.spoken[2],'Searching the web.');
    assert.deepEqual(speech.spoken.slice(-3),Array(3).fill('Showing YouTube results. Choose a video to play.'));
    assert.equal(f.window.__synapsesPcSpeechRoute.phase,'handled');assert.equal(f.window.__synapsesPcSpeechRoute.provider,provider);assert.equal(f.window.__synapsesPcSpeechRoute.clientEnabled,true);
    await speech.deliver('open file:///C:/Windows',provider);assert.equal(speech.context.normal,0);assert.equal(f.calls.urls.length,utterances.length);assert.doesNotMatch(speech.spoken[utterances.length],/^Opening/);
    await speech.deliver('Tell me a joke',provider);assert.equal(speech.context.normal,1);
    await f.client.stop();await speech.deliver('open YouTube',provider);assert.equal(speech.context.normal,2);assert.equal(f.calls.urls.length,utterances.length);
  }
  for(const options of [{api:false},{}]){
    const f=fixture(t,options);if(f.client)await f.client.ready;const speech=speechFixture(f);
    await speech.deliver('open YouTube','whisper');assert.equal(speech.context.normal,1);assert.equal(f.calls.urls.length,0);
  }
});
