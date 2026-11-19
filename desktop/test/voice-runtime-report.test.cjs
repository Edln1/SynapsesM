'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {RUNTIME_EXPRESSION,sanitizeRuntimeReport,dispatchSecondInstance}=require('../src/voice-runtime-report.cjs');
test('the report second-instance route never restores or changes window state',()=>{
  const calls=[];const route={report:()=>calls.push('report'),restore:()=>calls.push('restore')};
  assert.equal(dispatchSecondInstance(['Synapses.exe','--pc-voice-report'],route),'report');assert.deepEqual(calls,['report']);
  assert.equal(dispatchSecondInstance(['Synapses.exe'],route),'restore');assert.deepEqual(calls,['report','restore']);
});
test('the fixed runtime probe and serializer omit transcripts, account data, keys and URLs',()=>{
  const privateValue='PRIVATE-CONTENT';
  const window={synapsesDesktopVoiceClient:{active:()=>true,enabled:()=>true,diagnostics:()=>({phase:'listening',reasonCode:'',captureLive:true,voiceActive:true,transitions:[privateValue],email:privateValue})},
    toggleTopNavVoice:function(){/* acceptedSpeech _desktopVoiceFluxFallback */},__synapsesDesktopVoiceHookVersion:1,_sttProvider:'flux',_avaAvatarConnected:true,_avaNativeVoice:true,_avaAnamClient:{id:privateValue},
    __synapsesPcSpeechRoute:{version:1,at:123,count:4,phase:'await-native',provider:'flux',on:true,acceptedSpeech:true,generationCurrent:true,clientPresent:true,clientEnabled:true,handled:false,ok:false,text:privateValue,token:privateValue},token:privateValue};
  const raw=vm.runInNewContext(RUNTIME_EXPRESSION,{window,document:{hidden:true},navigator:{serviceWorker:{controller:{scriptURL:privateValue}}},FLUX_PATH:'/v2/listen'});
  const report=sanitizeRuntimeReport({...raw,transcript:privateValue,account:privateValue},{version:'0.1.5',time:'fixed',host:{enabled:true,listening:true,sessionId:privateValue}});
  assert.equal(report.hostEnabled,true);assert.equal(report.hostListening,true);assert.equal(report.clientActive,true);assert.equal(report.captureLive,true);assert.equal(report.hidden,true);assert.equal(report.FLUX_PATH,'/v2/listen');assert.equal(report.STTProvider,'flux');assert.equal(report.headerRepairPresent,true);assert.equal(report.AnamNativeActive,true);assert.equal(report.serviceWorkerControlled,true);
  assert.deepEqual(Object.keys(report.speechRoute),['version','at','count','phase','provider','on','acceptedSpeech','generationCurrent','clientPresent','clientEnabled','handled','ok']);
  assert.equal(JSON.stringify(report).includes(privateValue),false);
});
test('missing or unexpected runtime values are reduced to safe enums and booleans',()=>{
  const report=sanitizeRuntimeReport({clientPhase:'PRIVATE',clientReasonCode:'PRIVATE',FLUX_PATH:'https://PRIVATE',STTProvider:'PRIVATE',speechRoute:{version:1,at:'PRIVATE',count:Infinity,phase:'entered',provider:'PRIVATE',text:'PRIVATE'}},{version:'0.1.5',time:'fixed'});
  assert.equal(report.clientPhase,'missing');assert.equal(report.clientReasonCode,'none');assert.equal(report.FLUX_PATH,'missing');assert.equal(report.STTProvider,'other');assert.equal(report.speechRoute.at,0);assert.equal(report.speechRoute.count,0);assert.equal(JSON.stringify(report).includes('PRIVATE'),false);
});
