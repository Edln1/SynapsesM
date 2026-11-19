import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
function extract(start, end) { const a=html.indexOf(start),b=html.indexOf(end,a);assert.ok(a>=0&&b>a,start);return html.slice(a,b); }
const current = extract('  function _micSessionCurrent(generation)', '  function _stopMicTracks');
const failure = extract('  function _desktopVoiceSpeechError(){', '  window.__synapsesDesktopVoiceHookVersion');
const ask = extract('  async function ask(text, speech)', '    // DESKTOP_VOICE_COMMAND_HOOK_END') + '\n normal++;\n}';
function fixture(client) {
  const spoken=[],timers=[];
  const context=vm.createContext({window:{synapsesDesktopVoiceClient:client},_on:true,_micSessionGeneration:4,_voiceTurnId:0,_bargeNeedsDirectAnswer:false,_bargeTurnActive:false,_ttsBusy:false,_busy:true,_busySince:100,normal:0,
    speak:value=>spoken.push(value),toast:value=>spoken.push(value),record(){context.records++;},records:0,setTimeout:fn=>{timers.push(fn);}});
  vm.runInContext(current+'\n'+ask,context);return{context,spoken,timers};
}
test('only tagged current accepted Whisper/Flux finals reach native PC consumption',async()=>{
  let calls=0;const client={enabled:()=>true,consume:async()=>{calls++;return{handled:true,ok:true,message:'Opening example.com.'};}};
  for(const provider of ['whisper','flux']){const f=fixture(client);await f.context.ask('Ava, open example.com',{acceptedSpeech:true,provider,generation:4});assert.equal(f.context.normal,0);assert.deepEqual(f.spoken,['Opening example.com.']);f.timers[0]();assert.equal(f.context.records,1);}
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

const fluxSource=extract('function _fluxHandleEvent(msg, speech)', 'window._fluxSessionStop = _fluxSessionStop;');
const handoff=html.match(/window\._fluxSessionStart\((\{[\s\S]*?\n\s*\})\)\)/)?.[1];assert.ok(handoff);
function fluxFixture({failCapture=false,failSocket=false,pc=false}={}) {
  const events=[],errors=[],sockets=[],timers=new Map();let nextTimer=0;
  const node=()=>({connect(){},disconnect(){}});
  class Context{constructor(){this.state='running';this.sampleRate=48000;this.destination={};}createMediaStreamSource(){if(failCapture)throw Error('capture failed');return node();}createScriptProcessor(){return node();}createGain(){return{...node(),gain:{value:1}};}close(){this.state='closed';}resume(){}}
  class Socket{static OPEN=1;static CONNECTING=0;constructor(){if(failSocket)throw Error('socket failed');this.readyState=0;sockets.push(this);}close(){this.readyState=3;}send(){}}
  const context=vm.createContext({window:{_stream:{},AudioContext:Context},_flux:{},_sttProvider:'flux',FLUX_PATH:'/test',WebSocket:Socket,_vmSpeaking:true,
    console:{log(){},warn(){},error:(...args)=>errors.push(args)},setTimeout:(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),events});
  context.window.synapsesDesktopVoiceClient={active:()=>pc,stop:()=>{events.push({error:true});context.privateSpeech.stop();}};
  vm.runInContext(fluxSource,context);
  // The real callback object is evaluated in a separate private scope. None of
  // the STS private identifiers are placed in the global Flux script's scope.
  vm.runInContext('var privateSpeech=(function(){var _on=true,_micSessionGeneration=4,micGeneration=4,_bargeNeedsDirectAnswer=false,_bargeForceToast=false;'+current+failure+'function ask(text,speech){events.push({text,speech});}function btnState(value){events.push({state:value});}function _commitInterruptedReply(){events.push({barge:true});}return{speech:'+handoff+',stop:function(){_on=false;_micSessionGeneration++;},flags:function(){return[_bargeNeedsDirectAnswer,_bargeForceToast];}};})();',context);
  return{context,events,errors,sockets,timers};
}
test('actual global Flux code uses private callbacks without missing-private-global errors',()=>{
  const f=fluxFixture();assert.equal(f.context.window._fluxSessionStart(f.context.privateSpeech.speech),true);assert.equal(f.errors.length,0);
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
test('Flux errors, rejected/closed sockets and stalled connection revoke PC mode without changing normal reconnect',()=>{
  for(const kind of ['error','close','timeout']){
    const f=fluxFixture({pc:true});assert.equal(f.context.window._fluxSessionStart(f.context.privateSpeech.speech),true);
    if(kind==='error')f.sockets[0].onerror(Error('ASR unavailable'));
    else if(kind==='close')f.sockets[0].onclose({code:1008});
    else [...f.timers.values()].find(t=>t.ms===10000).fn();
    assert.equal(f.events.filter(e=>e.error).length,1,kind);
    const count=f.events.length;f.sockets[0].onerror(Error('stale error'));assert.equal(f.events.length,count);
  }
  const ordinary=fluxFixture();ordinary.context.window._fluxSessionStart(ordinary.context.privateSpeech.speech);ordinary.sockets[0].onerror(Error('temporary'));ordinary.sockets[0].onclose({code:1006});
  assert.equal(ordinary.events.some(e=>e.error),false);assert.ok([...ordinary.timers.values()].some(t=>t.ms===1200));
  const connected=fluxFixture({pc:true});connected.context.window._fluxSessionStart(connected.context.privateSpeech.speech);connected.sockets[0].onopen();assert.equal([...connected.timers.values()].some(t=>t.ms===10000),false);
});

const transcribe=extract('  function transcribe(blob)', '  function record()');
function whisperFixture() {
  let resolve,reject;const accepted=[];
  class Data{append(){}}
  const context=vm.createContext({window:{},_on:true,_micSessionGeneration:4,_busy:false,_busySince:0,_bargeTurnActive:false,_bargeNeedsDirectAnswer:false,
    FormData:Data,AbortController,GROQ_PROXY:'https://voice.invalid',_registerTurnAbort(){},setTimeout:()=>1,clearTimeout(){},fetch:()=>new Promise((yes,no)=>{resolve=yes;reject=no;}),
    console:{log(){},warn(){}},ask:(text,speech)=>accepted.push({text,speech}),record(){},toast(){},toastHide(){},_bargeHoldToast:false});
  vm.runInContext(current+'\n'+failure+'\n'+transcribe,context);context.transcribe({type:'audio/webm'});
  return{context,accepted,resolve:text=>resolve({json:async()=>({text})}),reject};
}
async function settle(){for(let i=0;i<15;i++)await Promise.resolve();}
test('actual Whisper delivery tags the generation captured before its network request',async()=>{
  const f=whisperFixture();f.resolve('Ava, open YouTube');await settle();assert.equal(f.accepted.length,1);assert.equal(f.accepted[0].speech.provider,'whisper');assert.equal(f.accepted[0].speech.generation,4);
  const stale=whisperFixture();stale.context._micSessionGeneration=5;stale.resolve('Ava, open YouTube');await settle();assert.equal(stale.accepted.length,0);
});
test('terminal Whisper errors revoke an active PC controller while ordinary browser errors keep existing recovery',async()=>{
  const f=whisperFixture();let stopped=0;f.context.window.synapsesDesktopVoiceClient={active:()=>true,stop:()=>{stopped++;}};f.reject(Error('transcription unavailable'));await settle();assert.equal(stopped,1);
  const ordinary=whisperFixture();ordinary.reject(Error('transcription unavailable'));await settle();assert.equal(ordinary.accepted.length,0);
});
