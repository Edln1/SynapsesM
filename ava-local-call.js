(function(){
 'use strict';
 var LOCAL_ORIGIN='http://127.0.0.1:8816';
 var dialog=null,frame=null,popup=null,popupTimer=null,previousFocus=null,observer=null,active=false;
 var requests=new Map();
 var camera='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="6" width="12" height="12" rx="3"/><path d="m15 10 6-3v10l-6-3" stroke-linejoin="round"/></svg>';
 function base(){return typeof GROQ_PROXY==='string'&&GROQ_PROXY?GROQ_PROXY:'https://synbot-whatsapp-2.onrender.com';}
 function shortReply(value){var text=String(value||'').replace(/<think>[\s\S]*?<\/think>/gi,'').trim();return text.length<=240?text:text.slice(0,237).replace(/\s+\S*$/,'')+'…';}
 function validId(value){return typeof value==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value);}
 function url(){return LOCAL_ORIGIN+'/local-call.html?parentOrigin='+encodeURIComponent(location.origin);}
 function trustedSource(event){return active&&event.origin===LOCAL_ORIGIN&&((frame&&event.source===frame.contentWindow)||(popup&&!popup.closed&&event.source===popup));}
 function send(target,payload){try{target.postMessage(payload,LOCAL_ORIGIN);}catch(_){}}
 async function voiceWave(blob){
  var Context=window.AudioContext||window.webkitAudioContext;
  if(!Context)throw new Error('This browser cannot decode the configured voice audio.');
  var context=new Context();
  try{
   var audio=await context.decodeAudioData(await blob.arrayBuffer());
   var channels=Math.min(audio.numberOfChannels,2),frames=audio.length;
   if(!frames||audio.duration>20)throw new Error('Keep this test reply under 20 seconds.');
   var buffer=new ArrayBuffer(44+frames*channels*2),view=new DataView(buffer);
   function label(offset,text){for(var i=0;i<text.length;i++)view.setUint8(offset+i,text.charCodeAt(i));}
   label(0,'RIFF');view.setUint32(4,buffer.byteLength-8,true);label(8,'WAVE');label(12,'fmt ');
   view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,channels,true);
   view.setUint32(24,audio.sampleRate,true);view.setUint32(28,audio.sampleRate*channels*2,true);
   view.setUint16(32,channels*2,true);view.setUint16(34,16,true);label(36,'data');view.setUint32(40,frames*channels*2,true);
   var samples=[];for(var ch=0;ch<channels;ch++)samples.push(audio.getChannelData(ch));
   var at=44;for(var sample=0;sample<frames;sample++)for(var channel=0;channel<channels;channel++){
    var value=Math.max(-1,Math.min(1,samples[channel][sample]));view.setInt16(at,value<0?Math.round(value*32768):Math.round(value*32767),true);at+=2;
   }
   return buffer;
  }finally{await context.close().catch(function(){});}
 }
 async function onMessage(event){
  if(!trustedSource(event))return;
  var data=event.data||{};
  if(data.type==='ava-local:cancel'){
   if(validId(data.id)&&requests.has(data.id))requests.get(data.id).abort();
   return;
  }
  if(!validId(data.id)||requests.has(data.id))return;
  if(data.type!=='ava-local:chat'&&data.type!=='ava-local:transcribe'&&data.type!=='ava-local:voice')return;
  var controller=new AbortController(),timer=setTimeout(function(){controller.abort();},60000);
  requests.set(data.id,controller);
  var responseType=data.type==='ava-local:chat'?'ava-local:reply':data.type==='ava-local:voice'?'ava-local:audio':'ava-local:transcript';
  try{
   var response,result;
   if(data.type==='ava-local:voice'){
    var spoken=typeof data.text==='string'?data.text.trim():'';
    if(!spoken||spoken.length>240)throw new Error('Use a short reply for this local avatar test.');
    if(typeof _ttsRestFetch!=='function')throw new Error('The Synapses voice provider is not ready.');
    var voiceBlob=await _ttsRestFetch(spoken,controller);
    var wave=await voiceWave(voiceBlob);
    if(controller.signal.aborted||!active)return;
    event.source.postMessage({type:responseType,id:data.id,audio:wave,mimeType:'audio/wav',provider:window._elevenSelected?'elevenlabs':window._ttsProvider||'deepgram'},LOCAL_ORIGIN,[wave]);
   }else if(data.type==='ava-local:transcribe'){
    if(!(data.audio instanceof ArrayBuffer)||!data.audio.byteLength||data.audio.byteLength>5*1024*1024)throw new Error('This recording is too large. Keep it under 30 seconds.');
    if(typeof data.mimeType!=='string'||!/^audio\/(webm|ogg|mp4|wav)(;|$)/i.test(data.mimeType))throw new Error('Unsupported microphone recording format.');
    var form=new FormData();
    form.append('file',new Blob([data.audio],{type:data.mimeType}),'local-ava.'+(/ogg/i.test(data.mimeType)?'ogg':/mp4/i.test(data.mimeType)?'mp4':/wav/i.test(data.mimeType)?'wav':'webm'));
    form.append('model','whisper-large-v3');
    response=await fetch(base()+'/groq-transcribe',{method:'POST',body:form,signal:controller.signal});
    if(!response.ok)throw new Error('Speech recognition is unavailable ('+response.status+'). You can type instead.');
    result=await response.json();var transcript=String(result.text||'').trim();
    if(!transcript)throw new Error('No speech was recognized. Try again or type your message.');
    send(event.source,{type:responseType,id:data.id,text:transcript.slice(0,2000)});
   }else{
    var text=typeof data.text==='string'?data.text.trim():'';
    if(!text||text.length>2000)throw new Error('Enter a short message.');
    var history=Array.isArray(data.history)?data.history.filter(function(x){return x&&['user','assistant'].includes(x.role)&&typeof x.content==='string';}).slice(-12).map(function(x){return {role:x.role,content:x.content.slice(0,1000)};}):[];
    if(history.length&&history[history.length-1].role==='user'&&history[history.length-1].content===text)history.pop();
    var model=typeof groqModel==='function'?groqModel('llama-3.1-8b-instant'):'llama-3.1-8b-instant';
    var body={model:model,messages:[{role:'system',content:'You are Ava, a warm, direct conversational assistant inside Synapses. Reply naturally in one short spoken sentence, at most 220 characters, with no markdown. Be honest about what you can do; never claim an action was completed unless it actually was.'}].concat(history,[{role:'user',content:text}]),max_tokens:100,stream:false};
    if(typeof groqApplyQwenFlags==='function')body=groqApplyQwenFlags(body)||body;
    response=await fetch(base()+'/groq-chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
    if(!response.ok)throw new Error('Ava could not answer ('+response.status+'). Your message is still here; try again shortly.');
    result=await response.json();var reply=shortReply(result.choices&&result.choices[0]&&result.choices[0].message&&result.choices[0].message.content);
    if(!reply)throw new Error('Ava returned an empty reply. Try again.');
    send(event.source,{type:responseType,id:data.id,text:reply});
   }
  }catch(error){send(event.source,{type:responseType,id:data.id,error:error.name==='AbortError'?'The request timed out. Try again.':error.message});}
  finally{clearTimeout(timer);requests.delete(data.id);}
 }
 function end(){
  active=false;
  clearInterval(popupTimer);popupTimer=null;
  requests.forEach(function(controller){controller.abort();});requests.clear();
  if(frame){send(frame.contentWindow,{type:'ava-local:end'});frame.src='about:blank';}
  if(popup&&!popup.closed){send(popup,{type:'ava-local:end'});popup.close();}popup=null;
  if(dialog)dialog.hidden=true;
  if(previousFocus&&previousFocus.isConnected)previousFocus.focus();
 }
 function ensureDialog(){
  if(dialog)return;
  dialog=document.createElement('section');dialog.id='avaLocalCallDialog';dialog.hidden=true;
  dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-labelledby','avaLocalCallTitle');
  dialog.innerHTML='<div class="ava-local-shell"><header class="ava-local-bar"><h2 id="avaLocalCallTitle">Ava · Local video call</h2><span>Experimental test</span><button type="button" class="ava-local-window">Open in window ↗</button><button type="button" class="ava-local-close" aria-label="Close local call">×</button></header><iframe id="avaLocalCallFrame" title="Ava local video call test" allow="microphone; autoplay" referrerpolicy="no-referrer"></iframe><p class="ava-local-help">The local Ava runtime must be running on this computer. If the panel cannot connect, <a href="'+LOCAL_ORIGIN+'/local-call.html" target="_blank" rel="noopener">open the runtime</a> and try again. Video is rendered locally; voice and conversation use your existing Synapses providers.</p></div>';
  document.body.appendChild(dialog);frame=dialog.querySelector('iframe');
  dialog.querySelector('.ava-local-close').onclick=end;
  dialog.querySelector('.ava-local-window').onclick=function(){
   if(frame){send(frame.contentWindow,{type:'ava-local:end'});frame.src='about:blank';}
   popup=window.open(url(),'synapses-ava-local-test','width=1100,height=800');
   if(popup){
    dialog.hidden=true;
    popupTimer=setInterval(function(){if(popup&&popup.closed)end();},500);
   }else{frame.src=url();if(typeof showToast==='function')showToast('Allow this window to open, or use the call panel.');}
  };
  dialog.addEventListener('keydown',function(event){
   if(event.key==='Escape'){event.preventDefault();end();return;}
   if(event.key==='Tab'&&document.activeElement===dialog.querySelector('.ava-local-close')&&!event.shiftKey){event.preventDefault();frame.focus();}
  });
 }
 function open(){
  if(popup&&!popup.closed){popup.focus();return;}
  ensureDialog();previousFocus=document.activeElement;
  try{if(typeof closeVoiceMode==='function')closeVoiceMode();}catch(_){}
  try{if(typeof stopTopNavVoice==='function')stopTopNavVoice();}catch(_){}
  try{if(typeof disableAvaAvatar==='function')disableAvaAvatar();}catch(_){}
  var menu=document.getElementById('avaStsCtxMenu');if(menu)menu.style.display='none';
  var close=document.getElementById('avaFloatClose');if(close)close.click();
  active=true;dialog.hidden=false;frame.src=url();dialog.querySelector('.ava-local-close').focus();
 }
 function entry(id){var button=document.createElement('button');button.id=id;button.type='button';button.className='ava-local-entry';button.innerHTML=camera+'<span>Local video call</span><small>TEST</small>';button.onclick=open;return button;}
 function install(){
  var popover=document.getElementById('avaFloatPopover');
  if(popover&&!document.getElementById('avaLocalHubButton')){
   var actions=popover.querySelector('.af-actions');popover.insertBefore(entry('avaLocalHubButton'),actions||null);
  }
  var menu=document.getElementById('avaStsCtxMenu');
  if(menu&&!document.getElementById('avaLocalContextButton')){
   var regular=document.getElementById('avaCx4');menu.insertBefore(entry('avaLocalContextButton'),regular?regular.nextSibling:null);
  }
  if(popover&&menu&&observer)observer.disconnect();
 }
 window.openAvaLocalCall=open;window.closeAvaLocalCall=end;
 window.addEventListener('message',onMessage);
 window.addEventListener('pagehide',end);
 install();observer=new MutationObserver(install);observer.observe(document.body,{childList:true,subtree:true});
 if(new URLSearchParams(location.search).get('ava-local')==='1')open();
})();
