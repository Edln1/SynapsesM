import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
function extract(start, end) { const a=html.indexOf(start),b=html.indexOf(end,a);assert.ok(a>=0&&b>a,start);return html.slice(a,b); }
const current = extract('  function _micSessionCurrent(generation)', '  function _stopMicTracks');
const failure = extract('  function _desktopVoiceSpeechError(reasonCode,message){', '  window.__synapsesDesktopVoiceHookVersion');
const routeTrace = extract('  var _pcSpeechRouteCount = 0;', '  window.__synapsesDesktopVoiceHookVersion');
const fallback = extract('  function _desktopVoiceFluxFallback(generation,reasonCode){', '  function _desktopVoiceSpeechError(reasonCode,message){');
const recording = extract('  function record() {', '  // ── Barge-in:');
const speaking = extract('function _getAvaAndroidCallAudio()', 'function _stopAvaAndroidCallAudio()') +
  extract('  function speak(text, forTurn)', '  function _desktopVoiceFluxFallback(generation,reasonCode){');
const ask = extract('  async function ask(text, speech)', '    // DESKTOP_VOICE_COMMAND_HOOK_END') + '\n normal++;\n}';
function fixture(client,{native=false}={}) {
  const spoken=[],timers=[];
  const context=vm.createContext({window:{synapsesDesktopVoiceClient:client},_on:true,_micSessionGeneration:4,_voiceTurnId:0,_bargeNeedsDirectAnswer:false,_bargeTurnActive:false,_ttsBusy:false,_busy:true,_busySince:100,normal:0,
    speak:value=>spoken.push(value),toast:value=>spoken.push(value),record(){context.records++;},records:0,setTimeout:fn=>{timers.push(fn);}});
  if(native)context.window.synapsesDesktopVoice={getState(){},runCommand(){}};
  vm.runInContext(current+'\n'+routeTrace+'\n'+ask,context);return{context,spoken,timers};
}
test('only tagged current accepted Whisper/Flux finals reach native PC consumption',async()=>{
  let calls=0;const client={enabled:()=>true,consume:async()=>{calls++;return{handled:true,ok:true,message:'Opening example.com.'};}};
  for(const provider of ['whisper','flux']){const f=fixture(client);await f.context.ask('Ava, open example.com',{acceptedSpeech:true,provider,generation:4});assert.equal(f.context.normal,0);assert.deepEqual(f.spoken,['Opening example.com.']);assert.equal(f.timers.length,0);assert.equal(f.context.records,0);}
  assert.equal(calls,2);
  for(const speech of [undefined,{acceptedSpeech:false,provider:'whisper',generation:4},{acceptedSpeech:true,provider:'tool',generation:4}]){const f=fixture(client);await f.context.ask('Ava, open example.com',speech);assert.equal(f.context.normal,1);}
  assert.equal(calls,2);
});
test('normal web/mobile and non-command native responses retain the normal model path',async()=>{
  for(const client of [undefined,{enabled:()=>false},{enabled:()=>true,consume:async()=>({handled:false,ok:false,message:''})}]){const f=fixture(client);await f.context.ask('Tell me a story',{acceptedSpeech:true,provider:'whisper',generation:4});assert.equal(f.context.normal,1);assert.equal(f.spoken.length,0);}
});
test('stale ASR generations and results arriving after Stop never execute or speak commands',async()=>{
  let consumeCalls=0,resolve;const f=fixture({enabled:()=>true,consume:()=>{consumeCalls++;return new Promise(yes=>{resolve=yes;});}});
  await f.context.ask('Ava, open example.com',{acceptedSpeech:true,provider:'whisper',generation:3});assert.equal(consumeCalls,0);assert.equal(f.context.normal,0);
  const pending=f.context.ask('Ava, open example.com',{acceptedSpeech:true,provider:'whisper',generation:4});f.context._on=false;f.context._micSessionGeneration++;
  resolve({handled:true,ok:true,message:'Opening example.com.'});await pending;assert.equal(f.spoken.length,0);assert.equal(f.context.normal,0);
});
test('native rejected/unsupported commands and IPC failures cannot fall through to a model success claim',async()=>{
  for(const consume of [async()=>({handled:true,ok:false,message:'Only public HTTPS websites are supported.'}),async()=>{throw Error('IPC unavailable');}]){const f=fixture({enabled:()=>true,consume});await f.context.ask('Ava, open file:///secret',{acceptedSpeech:true,provider:'whisper',generation:4});assert.equal(f.context.normal,0);assert.equal(f.spoken.length,1);assert.doesNotMatch(f.spoken[0],/^Opening/);}
});
test('a PC result uses real TTS ownership without opening a listener over its own spoken reply',async()=>{
  const f=fixture({enabled:()=>true,consume:async()=>({handled:true,ok:true,message:'Opening example.com.'})});
  f.context.window._elevenSelected=true;f.context._vmGenId=1;f.context._speakIsStale=()=>false;f.context._avatarLive=()=>false;f.context.btnState=()=>{};f.context._bargeForceToast=false;
  const played=[];let ended,requests=0;f.context._registerTurnAbort=()=>{};f.context._elevenFetchFile=async()=>{requests++;return{};};f.context.URL={createObjectURL:()=> 'blob:test',revokeObjectURL(){}};f.context.Audio=class{};f.context.toastHide=()=>{};f.context._playAudio=(audio,complete,gen,turn)=>{ended=complete;played.push({gen,turn});};
  vm.runInContext(speaking,f.context);
  await f.context.ask('open example.com',{acceptedSpeech:true,provider:'whisper',generation:4});
  await settle();assert.equal(requests,1);assert.equal(played.length,1);assert.equal(played[0].turn,1);assert.equal(f.context._ttsBusy,true);assert.equal(f.context._busy,true);
  f.timers.splice(0).forEach(fn=>fn());assert.equal(f.context.records,0);
  ended();assert.equal(f.context._ttsBusy,false);assert.equal(f.timers.length,1);f.timers.shift()();assert.equal(f.context.records,1);
});
function assertPrivateRoute(route){
  assert.deepEqual(Object.keys(route).sort(),['version','at','count','phase','provider','on','acceptedSpeech','generationCurrent','clientPresent','clientEnabled','handled','ok'].sort());
  assert.ok(Object.isFrozen(route));assert.ok(Number.isFinite(route.at));assert.ok(Number.isSafeInteger(route.count));
  assert.doesNotMatch(JSON.stringify(route),/private-user|private-reply|private@example|secret-session|youtube|https:/i);
}
test('ASR hop trace is absent without native capability and rejects missing speech metadata without storing words',async()=>{
  const web=fixture();await web.context.ask('private-user');assert.equal(web.context.window.__synapsesPcSpeechRoute,undefined);
  let consumed=0;const f=fixture({enabled:()=>true,consume:async()=>{consumed++;}},{native:true});f.context.window.currentUser={email:'private@example.test',id:'secret-session'};
  await f.context.ask('private-user');const route=f.context.window.__synapsesPcSpeechRoute;assertPrivateRoute(route);assert.equal(route.phase,'rejected-metadata');assert.equal(route.provider,'other');assert.equal(route.acceptedSpeech,false);assert.equal(route.generationCurrent,false);assert.equal(consumed,0);assert.equal(f.context.normal,1);
});
test('ASR hop trace distinguishes a disabled client from rejected metadata while preserving normal routing',async()=>{
  const f=fixture({enabled:()=>false},{native:true});await f.context.ask('private-user',{acceptedSpeech:true,provider:'whisper',generation:4});
  const route=f.context.window.__synapsesPcSpeechRoute;assertPrivateRoute(route);assert.equal(route.phase,'unhandled');assert.equal(route.provider,'whisper');assert.equal(route.on,true);assert.equal(route.acceptedSpeech,true);assert.equal(route.generationCurrent,true);assert.equal(route.clientPresent,true);assert.equal(route.clientEnabled,false);assert.equal(route.handled,false);assert.equal(f.context.normal,1);
});
test('ASR hop trace records native awaiting, handled and stale outcomes using only fixed flags',async()=>{
  for(const stale of [false,true]){
    let resolve;const f=fixture({enabled:()=>true,consume:()=>new Promise(yes=>{resolve=yes;})},{native:true});
    const pending=f.context.ask('private-user',{acceptedSpeech:true,provider:'flux',generation:4});assert.equal(f.context.window.__synapsesPcSpeechRoute.phase,'await-native');assertPrivateRoute(f.context.window.__synapsesPcSpeechRoute);
    if(stale){f.context._on=false;f.context._micSessionGeneration++;}
    resolve({handled:true,ok:true,message:'private-reply'});await pending;const route=f.context.window.__synapsesPcSpeechRoute;assertPrivateRoute(route);assert.equal(route.phase,stale?'stale':'handled');assert.equal(route.handled,true);assert.equal(route.ok,true);assert.equal(route.generationCurrent,!stale);assert.equal(f.context.normal,0);assert.equal(f.spoken.length,stale?0:1);
  }
});

const fluxSource=extract('function _fluxResampleTo16k(float32In, fromRate)', 'function _wsClose()');
const fluxEndpoint=html.match(/var FLUX_PATH = '([^']+)';/)?.[1];assert.ok(fluxEndpoint);
const handoff=html.match(/window\._fluxSessionStart\((\{[\s\S]*?\n\s*\})\)\)/)?.[1];assert.ok(handoff);
function fluxFixture({failCapture=false,failSocket=false,failRecording=false,pc=false,mobile=false}={}) {
  const events=[],errors=[],sockets=[],timers=new Map();let nextTimer=0;
  const node=()=>({connect(){},disconnect(){this.disconnected=true;}});
  class Context{constructor(){this.state='running';this.sampleRate=48000;this.destination={};}createMediaStreamSource(){if(failCapture)throw Error('capture failed');return node();}createScriptProcessor(){return node();}createGain(){return{...node(),gain:{value:1}};}close(){this.state='closed';}resume(){}}
  class Socket{static OPEN=1;static CONNECTING=0;constructor(url){if(failSocket)throw Error('socket failed');this.url=url;this.readyState=0;this.frames=[];sockets.push(this);}open(){this.readyState=1;this.onopen();}close(){this.readyState=3;}send(frame){this.frames.push(frame);}}
  class Recorder{static isTypeSupported(){return true;}constructor(){if(failRecording)throw Error('recording failed');this.state='inactive';}start(){this.state='recording';events.push({recording:true});}}
  const context=vm.createContext({window:{_stream:{},_dgKey:'test-api-key',AudioContext:Context},_flux:{},_sttProvider:'flux',FLUX_PATH:fluxEndpoint,WebSocket:Socket,MediaRecorder:Recorder,_vmSpeaking:true,
    console:{log(){},warn(){},error:(...args)=>errors.push(args)},setTimeout:(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),events});
  if(mobile){context.window.document={documentElement:{classList:{contains:name=>name==='ava-app-mode'}}};context.window.appCaptureContext=new Context();}
  context.window.synapsesDesktopVoiceClient={active:()=>pc,isCurrentAccount:()=>pc,stop:(message,reasonCode)=>{events.push({error:true,reasonCode});context.privateSpeech.stop();},noteFallback:reasonCode=>events.push({fallback:reasonCode})};
  vm.runInContext(fluxSource,context);
  // The real callback object is evaluated in a separate private scope. None of
  // the STS private identifiers are placed in the global Flux script's scope.
  vm.runInContext('var privateSpeech=(function(){var _on=true,_micSessionGeneration=4,micGeneration=4,_bargeNeedsDirectAnswer=false,_bargeForceToast=false,_busy=false,_busySince=0,_ttsBusy=false,_bargingIn=false,_bargeTurnActive=false,_stream=window._stream,_recorder=null,mobileAva=!!window.appCaptureContext,_bargeCtx=window.appCaptureContext;'+current+failure+fallback+recording+'function _micTrackDead(){return false;}function _ensureBargeAnalyser(){}function toast(){}function ask(text,speech){events.push({text,speech});}function btnState(value){events.push({state:value});}function _commitInterruptedReply(){events.push({barge:true});}return{speech:'+handoff+',record:record,setSpeaking:function(value){_ttsBusy=value;},stop:function(){_on=false;_micSessionGeneration++;},flags:function(){return[_bargeNeedsDirectAnswer,_bargeForceToast];}};})();',context);
  return{context,events,errors,sockets,timers};
}
function captureFrame(f) {
  f.context._flux.proc.onaudioprocess({inputBuffer:{getChannelData:()=>new Float32Array(2048).fill(0.1)}});
}
test('actual global Flux code uses private callbacks without missing-private-global errors',()=>{
  const f=fluxFixture();assert.equal(f.context.window._fluxSessionStart(f.context.privateSpeech.speech),true);assert.equal(f.errors.length,0);
  const url=new URL(f.sockets[0].url);assert.equal(url.origin,'wss://api.deepgram.com');assert.equal(url.pathname,'/v2/listen');assert.equal(url.searchParams.get('model'),'flux-general-en');
  assert.deepEqual(f.events.map(e=>e.state).filter(Boolean),['listen']);
  f.sockets[0].onmessage({data:JSON.stringify({event:'StartOfTurn'})});f.sockets[0].onmessage({data:JSON.stringify({event:'EndOfTurn',transcript:'Ava, open YouTube'})});
  const accepted=f.events.find(e=>e.text);assert.equal(accepted.speech.provider,'flux');assert.equal(accepted.speech.generation,4);assert.equal(accepted.speech.acceptedSpeech,true);
  assert.deepEqual(Array.from(f.context.privateSpeech.flags()),[true,true]);assert.equal(f.context._bargeNeedsDirectAnswer,undefined);
  const count=f.events.length;f.context.privateSpeech.stop();f.sockets[0].onmessage({data:JSON.stringify({event:'EndOfTurn',transcript:'stale speech'})});assert.equal(f.events.length,count);
});
test('Flux setup failure keeps its existing legacy fallback rather than revoking working voice',()=>{
  const f=fluxFixture({failCapture:true});assert.equal(f.context.window._fluxSessionStart(f.context.privateSpeech.speech),false);assert.equal(f.context._flux.ws,null);assert.equal(f.errors.length,1);
  const socket=fluxFixture({failSocket:true,pc:true});assert.equal(socket.context.window._fluxSessionStart(socket.context.privateSpeech.speech),false);assert.equal(socket.context._flux.ws,null);assert.equal(socket.events.some(e=>e.error),false);assert.equal(socket.timers.size,0);
});
test('PC legacy recording waits for its current TTS and never duplicates a healthy Flux microphone owner',()=>{
  const f=fluxFixture({pc:true});f.context.window._fluxSessionStart(f.context.privateSpeech.speech);f.context.privateSpeech.record();assert.equal(f.events.filter(e=>e.recording).length,0);
  f.context.window._fluxSessionStop();f.context.privateSpeech.setSpeaking(true);f.context.privateSpeech.record();assert.equal(f.events.filter(e=>e.recording).length,0);
  f.context.privateSpeech.setSpeaking(false);f.context.privateSpeech.record();assert.equal(f.events.filter(e=>e.recording).length,1);
  const ordinary=fluxFixture();ordinary.context.window._fluxSessionStart(ordinary.context.privateSpeech.speech);ordinary.context.privateSpeech.record();assert.equal(ordinary.events.filter(e=>e.recording).length,1);
});
test('Ava app speech switches once from failed streaming recognition to the existing recorder',()=>{
  const f=fluxFixture({mobile:true});
  assert.equal(f.context.window._fluxSessionStart(f.context.privateSpeech.speech),true);
  f.context.privateSpeech.record();
  assert.equal(f.events.filter(event=>event.recording).length,0);
  f.sockets[0].onerror(Error('ASR unavailable'));
  assert.equal(f.context._flux.ws,null);
  assert.equal(f.events.filter(event=>event.recording).length,1);
  f.sockets[0].onerror(Error('late failure'));
  assert.equal(f.events.filter(event=>event.recording).length,1);
  assert.equal(f.events.some(event=>event.fallback||event.error),false);
});

test('the first Ava mobile mic tap starts Flux with the gesture context instead of the first-use intro',()=>{
  const micReady=extract('      function _afterMicReady() {', '      if (_stream && !_micTrackDead()) {');
  for(const mobile of [true,false]){
    let introCalls=0,speech;
    const captureContext={state:'running'};
    const sandbox=vm.createContext({_bargeCtx:captureContext,
      window:{document:{documentElement:{classList:{contains:()=>mobile}}},_sttProvider:'flux',_fluxSessionStart(value){speech=value;return true;}},
      _maybeGuideNotesSaveLine:()=>false,_maybeGuideS2SIntro:()=>false,_maybeS2SFirstIntro:()=>{introCalls++;return true;}});
    vm.runInContext(micReady+'\n_afterMicReady();',sandbox);
    assert.equal(introCalls,mobile?0:1);
    assert.equal(speech?.captureContext,mobile?captureContext:undefined);
  }
});

test('Ava mobile shares its unlocked context and waits for PCM on the open socket before listening',()=>{
  const f=fluxFixture({mobile:true});
  const app=f.context.window;
  app.AudioContext=class{constructor(){throw Error('a second capture context was created');}};
  assert.equal(app._fluxSessionStart(f.context.privateSpeech.speech),true);
  const {ctx,proc,sink}=f.context._flux;
  assert.equal(ctx,app.appCaptureContext);
  captureFrame(f);
  assert.equal(f.events.length,0);
  f.sockets[0].open();
  assert.equal(f.events.length,0);
  captureFrame(f);
  captureFrame(f);
  assert.equal(f.sockets[0].frames.length,2);
  assert.equal(f.sockets[0].frames[0].byteLength,1364);
  assert.equal(f.events.filter(event=>event.state==='listen').length,1);
  assert.equal(f.timers.size,0);
  f.sockets[0].onmessage({data:JSON.stringify({event:'EndOfTurn',transcript:'Can you hear me?'})});
  assert.equal(f.events.find(event=>event.text)?.text,'Can you hear me?');
  app._fluxSessionStop();
  assert.equal(ctx.state,'running');
  assert.equal(proc.onaudioprocess,null);
  assert.equal(sink.disconnected,true);
});

test('an open Ava mobile socket without capture frames gives the recorder the mic',()=>{
  const f=fluxFixture({mobile:true});
  const app=f.context.window;
  assert.equal(app._fluxSessionStart(f.context.privateSpeech.speech),true);
  f.sockets[0].open();
  const timeout=f.timers.get(f.context._flux.captureTimer);
  assert.equal(timeout.ms,2500);
  timeout.fn();
  timeout.fn();
  assert.equal(f.context._flux.ws,null);
  assert.equal(f.events.filter(event=>event.recording).length,1);
  assert.equal(app.appCaptureContext.state,'running');
});

test('a suspended mobile capture context must run or hand speech back to the recorder once',async()=>{
  for(const scenario of ['running','suspended','rejected','timeout','stop-and-restart']){
    const f=fluxFixture();
    const app=f.context.window;
    app.document={documentElement:{classList:{contains:name=>name==='ava-app-mode'}}};
    const RunningContext=app.AudioContext;
    let resolveResume,rejectResume;
    app.AudioContext=class extends RunningContext{
      constructor(){super();this.state='suspended';}
      resume(){return new Promise((resolve,reject)=>{resolveResume=resolve;rejectResume=reject;});}
    };
    const speech=f.context.privateSpeech.speech;
    assert.equal(app._fluxSessionStart(speech),true);
    const original=f.context._flux.ctx;
    assert.equal(f.events.some(event=>event.state==='listen'),false);
    const timer=f.context._flux.resumeTimer;
    const timerCallback=f.timers.get(timer).fn;
    if(scenario==='stop-and-restart'){
      app._fluxSessionStop();
      app.AudioContext=RunningContext;
      assert.equal(app._fluxSessionStart(speech),true);
      rejectResume(Error('old capture ended'));
      timerCallback();
    }else if(scenario==='rejected')rejectResume(Error('resume denied'));
    else if(scenario==='timeout')timerCallback();
    else{
      original.state=scenario;
      resolveResume();
    }
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.timers.has(timer),false,scenario);
    const recovered=scenario==='rejected'||scenario==='suspended'||scenario==='timeout';
    assert.equal(f.events.filter(event=>event.recording).length,recovered?1:0,scenario);
    assert.equal(f.context._flux.ctx===null,recovered,scenario);
    if(!recovered){
      assert.equal(f.events.filter(event=>event.state==='listen').length,0,scenario);
      f.sockets.at(-1).open();
      captureFrame(f);
      assert.equal(f.events.filter(event=>event.state==='listen').length,1,scenario);
    }
    if(scenario==='timeout'){
      resolveResume();
      await new Promise(resolve=>setImmediate(resolve));
      assert.equal(f.events.filter(event=>event.recording).length,1);
    }
  }
});
test('Flux errors, rejected/closed sockets and stalled connection start real legacy recording without changing normal reconnect',()=>{
  for(const kind of ['error','close','timeout']){
    const f=fluxFixture({pc:true});assert.equal(f.context.window._fluxSessionStart(f.context.privateSpeech.speech),true);
    if(kind==='error')f.sockets[0].onerror(Error('ASR unavailable'));
    else if(kind==='close')f.sockets[0].onclose({code:1008});
    else [...f.timers.values()].find(t=>t.ms===10000).fn();
    assert.equal(f.events.filter(e=>e.error).length,0,kind);assert.equal(f.events.filter(e=>e.recording).length,1,kind);assert.equal(f.context._flux.ws,null,kind);
    assert.ok(f.events.some(e=>e.fallback===({error:'asr_error',close:'asr_closed',timeout:'asr_timeout'}[kind])));
    const count=f.events.length;f.sockets[0].onerror(Error('stale error'));assert.equal(f.events.length,count);
  }
  const ordinary=fluxFixture();ordinary.context.window._fluxSessionStart(ordinary.context.privateSpeech.speech);ordinary.sockets[0].onerror(Error('temporary'));ordinary.sockets[0].onclose({code:1006});
  assert.equal(ordinary.events.some(e=>e.error),false);assert.ok([...ordinary.timers.values()].some(t=>t.ms===1200));
  const connected=fluxFixture({pc:true});connected.context.window._fluxSessionStart(connected.context.privateSpeech.speech);connected.sockets[0].onopen();assert.equal([...connected.timers.values()].some(t=>t.ms===10000),false);
  const terminal=fluxFixture({pc:true,failRecording:true});terminal.context.window._fluxSessionStart(terminal.context.privateSpeech.speech);terminal.sockets[0].onerror(Error('ASR unavailable'));assert.equal(terminal.events.filter(e=>e.error).length,1);assert.equal(terminal.events.find(e=>e.error).reasonCode,'voice_init_error');
});

const transcribe=extract('  function transcribe(blob)', '  function record()');
function whisperFixture() {
  let resolve,reject;const accepted=[];
  class Data{append(){}}
  const context=vm.createContext({window:{},_on:true,_micSessionGeneration:4,_busy:false,_busySince:0,_bargeTurnActive:false,_bargeNeedsDirectAnswer:false,
    FormData:Data,AbortController,GROQ_PROXY:'https://voice.invalid',_registerTurnAbort(){},setTimeout:()=>1,clearTimeout(){},fetch:()=>new Promise((yes,no)=>{resolve=yes;reject=no;}),
    console:{log(){},warn(){}},ask:(text,speech)=>accepted.push({text,speech}),record(){},toast(){},toastHide(){},_bargeHoldToast:false});
  vm.runInContext(current+'\n'+failure+'\n'+transcribe,context);context.transcribe({type:'audio/webm'});
  return{context,accepted,resolve:text=>resolve({json:async()=>({text})}),resolveResponse:resolve,reject};
}
async function settle(){for(let i=0;i<15;i++)await Promise.resolve();}
test('actual Whisper delivery tags the generation captured before its network request',async()=>{
  const f=whisperFixture();f.resolve('Ava, open YouTube');await settle();assert.equal(f.accepted.length,1);assert.equal(f.accepted[0].speech.provider,'whisper');assert.equal(f.accepted[0].speech.generation,4);
  const stale=whisperFixture();stale.context._micSessionGeneration=5;stale.resolve('Ava, open YouTube');await settle();assert.equal(stale.accepted.length,0);
});
test('terminal Whisper errors revoke an active PC controller while ordinary browser errors keep existing recovery',async()=>{
  const f=whisperFixture();let stopped=0;f.context.window.synapsesDesktopVoiceClient={active:()=>true,stop:()=>{stopped++;}};f.reject(Error('transcription unavailable'));await settle();assert.equal(stopped,1);
  const ordinary=whisperFixture();ordinary.reject(Error('transcription unavailable'));await settle();assert.equal(ordinary.accepted.length,0);
  for(const response of [{ok:false,json:async()=>({})},{ok:true,json:async()=>({error:'provider rejected'})}]){
    const http=whisperFixture();let stopped=0;http.context.window.synapsesDesktopVoiceClient={active:()=>true,stop:(message,code)=>{stopped++;assert.equal(code,'asr_error');}};http.resolveResponse(response);await settle();assert.equal(stopped,1);assert.equal(http.accepted.length,0);
  }
});
