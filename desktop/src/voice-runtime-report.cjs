'use strict';
const {safeReason}=require('./voice-diagnostics.cjs');
const CLIENT_PHASES=new Set(['initializing','idle','consent','account-verification','microphone-starting','listening','stopped','destroyed','whisper-fallback']);
const SPEECH_PHASES=new Set(['entered','await-native','handled','unhandled','rejected-metadata','stale']);
const RUNTIME_EXPRESSION=`(()=>{
  const client=window.synapsesDesktopVoiceClient;
  function read(fn){try{return fn();}catch{return null;}}
  const diagnostic=read(()=>client&&client.diagnostics())||{};
  const header=read(()=>typeof window.toggleTopNavVoice==='function'?Function.prototype.toString.call(window.toggleTopNavVoice):'')||'';
  const flux=typeof FLUX_PATH==='string'?FLUX_PATH:'';
  const speech=window.__synapsesPcSpeechRoute;
  return {
    clientActive:read(()=>client&&typeof client.active==='function'?client.active():null),
    clientEnabled:read(()=>client&&typeof client.enabled==='function'?client.enabled():null),
    clientPhase:diagnostic.phase,clientReasonCode:diagnostic.reasonCode,
    captureLive:diagnostic.captureLive,voiceActive:diagnostic.voiceActive,hidden:document.hidden===true,
    hookVersion:window.__synapsesDesktopVoiceHookVersion===1?1:0,
    FLUX_PATH:flux==='/v1/listen'||flux==='/v2/listen'?flux:'missing',
    STTProvider:window._sttProvider==='flux'?'flux':window._sttProvider==='legacy'?'legacy':'other',
    headerRepairPresent:header.includes('acceptedSpeech')&&header.includes('_desktopVoiceFluxFallback'),
    serviceWorkerControlled:!!(navigator.serviceWorker&&navigator.serviceWorker.controller),
    AnamNativeActive:window._avaAvatarConnected===true&&window._avaNativeVoice===true&&!!window._avaAnamClient,
    speechRoute:speech?{version:speech.version,at:speech.at,count:speech.count,phase:speech.phase,provider:speech.provider,on:speech.on,acceptedSpeech:speech.acceptedSpeech,generationCurrent:speech.generationCurrent,clientPresent:speech.clientPresent,clientEnabled:speech.clientEnabled,handled:speech.handled,ok:speech.ok}:null
  };
})()`;
function sanitizeRuntimeReport(raw,{version,time,host={}}){
  const data=raw&&typeof raw==='object'?raw:{};
  const nullableBool=value=>typeof value==='boolean'?value:null;
  return {version,time,hostEnabled:host.enabled===true,hostListening:host.listening===true,
    clientActive:nullableBool(data.clientActive),clientEnabled:nullableBool(data.clientEnabled),
    clientPhase:CLIENT_PHASES.has(data.clientPhase)?data.clientPhase:'missing',clientReasonCode:safeReason(data.clientReasonCode,'none'),
    captureLive:nullableBool(data.captureLive),voiceActive:nullableBool(data.voiceActive),hidden:nullableBool(data.hidden),
    hookVersion:data.hookVersion===1?1:0,
    FLUX_PATH:['/v1/listen','/v2/listen'].includes(data.FLUX_PATH)?data.FLUX_PATH:'missing',
    STTProvider:['flux','legacy'].includes(data.STTProvider)?data.STTProvider:'other',
    headerRepairPresent:data.headerRepairPresent===true,serviceWorkerControlled:data.serviceWorkerControlled===true,AnamNativeActive:data.AnamNativeActive===true,
    speechRoute:sanitizeSpeechRoute(data.speechRoute)};
}
function sanitizeSpeechRoute(raw){
  if(!raw||raw.version!==1||!SPEECH_PHASES.has(raw.phase))return null;
  const bool=value=>value===true;
  const integer=value=>Number.isSafeInteger(value)&&value>=0?value:0;
  return {version:1,at:integer(raw.at),count:integer(raw.count),phase:raw.phase,provider:['whisper','flux'].includes(raw.provider)?raw.provider:'other',on:bool(raw.on),acceptedSpeech:bool(raw.acceptedSpeech),generationCurrent:bool(raw.generationCurrent),clientPresent:bool(raw.clientPresent),clientEnabled:bool(raw.clientEnabled),handled:bool(raw.handled),ok:bool(raw.ok)};
}
function dispatchSecondInstance(argv,{report,restore}){
  if(Array.isArray(argv)&&argv.includes('--pc-voice-report')){report();return 'report';}
  restore();return 'restore';
}
module.exports={RUNTIME_EXPRESSION,sanitizeRuntimeReport,dispatchSecondInstance};
