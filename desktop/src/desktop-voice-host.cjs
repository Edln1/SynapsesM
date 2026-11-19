'use strict';
const crypto=require('node:crypto');
const {parseVoiceCommand,publicAddress}=require('./desktop-voice-policy.cjs');
const {trustedSite}=require('./policy.cjs');

function voiceSender(event,contents) {
  try {return !!event&&event.sender===contents&&event.senderFrame===contents.mainFrame&&trustedSite(event.senderFrame.url)&&trustedSite(contents.getURL());}catch{return false;}
}
function startClientFromNativeGesture(contents) {
  if(!trustedSite(contents.getURL()))return Promise.reject(Error('PC voice requires the trusted Synapses page.'));
  return contents.executeJavaScript("Promise.resolve(window.synapsesDesktopVoiceClient.start()).then(()=>true)",true);
}
function createDesktopVoiceHost({onState=()=>{},onStop=()=>true,openBrowser,lookupHost,makeId=crypto.randomUUID,pendingTimeoutMs=30000}) {
  let enabled=false,listening=false,sessionId=null,message='',pendingTimer=null,lastCleanup=Promise.resolve(true),generation=0;
  const state=()=>({available:true,enabled,listening,sessionId,message});
  const publish=()=>onState(state());
  function stop(reason='PC voice is stopped.') {
    generation++;
    const wasEnabled=enabled,previousMessage=message;
    clearTimeout(pendingTimer);pendingTimer=null;enabled=false;listening=false;sessionId=null;message=reason;if(wasEnabled||previousMessage!==message)publish();
    if(wasEnabled)lastCleanup=Promise.resolve().then(()=>onStop(reason)).catch(()=>false);
    return state();
  }
  function start() {
    if(enabled)return state();
    enabled=true;listening=false;sessionId=makeId();message='Starting PC voice.';
    pendingTimer=setTimeout(()=>stop('PC voice setup timed out. Start it again when you are ready.'),pendingTimeoutMs);pendingTimer.unref?.();publish();return state();
  }
  function setListening(payload) {
    if(!enabled||!payload||payload.sessionId!==sessionId||typeof payload.active!=='boolean')return {...state(),message:'The PC voice session has expired.'};
    if(!payload.active)return stop();
    clearTimeout(pendingTimer);pendingTimer=null;listening=true;message='PC voice is listening. Say “Ava, open …” or “Ava, search for …”.';publish();return state();
  }
  async function runCommand(payload) {
    if(!enabled||!listening||!payload||payload.sessionId!==sessionId)return {handled:false,ok:false,message:'PC voice is off.'};
    const result=parseVoiceCommand(payload.text);
    if(!result.handled||!result.ok)return result;
    if(result.type==='stop'){stop();return {handled:true,ok:true,message:result.message};}
    const id=sessionId;
    try {
      let timeout;
      const addresses=await Promise.race([lookupHost(new URL(result.url).hostname),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('DNS timeout')),4000);})]).finally(()=>clearTimeout(timeout));
      if(!Array.isArray(addresses)||!addresses.length||!addresses.every(item=>publicAddress(typeof item==='string'?item:item.address)))return {handled:true,ok:false,message:'That address is not a verified public website.'};
      if(!enabled||!listening||sessionId!==id)return {handled:true,ok:false,message:'PC voice was stopped before opening the website.'};
      await openBrowser(result.url);
      return {handled:true,ok:true,message:result.message};
    } catch {return {handled:true,ok:false,message:'I could not open that public website. Please try again.'};}
  }
  return {state,start,stop,setListening,runCommand,waitForStop:()=>lastCleanup,active:()=>enabled&&listening,generation:()=>generation};
}
function bindDesktopVoice({ipcMain,contents,host,authorizeStart,micAllowed,onStartGesture=()=>{}}) {
  let pendingStart=null;
  const handlers={
    'pc-voice:state':()=>host.state(),
    'pc-voice:start':async event=>{
      if(host.state().enabled)return host.state();
      if(pendingStart)return pendingStart;
      const ticket=host.generation(),frame=event.senderFrame,url=frame.url;
      pendingStart=(async()=>{
        const allowed=await authorizeStart();
        if(!voiceSender(event,contents)||frame.url!==url||host.generation()!==ticket)return {...host.state(),message:'PC voice setup was canceled. Start it again when ready.'};
        if(!allowed)return {...host.state(),message:'PC voice was not enabled.'};
        onStartGesture();return host.start();
      })().finally(()=>{pendingStart=null;});
      return pendingStart;
    },
    'pc-voice:stop':async()=>{host.stop();await host.waitForStop();return host.state();},
    'pc-voice:listening':(_event,payload)=>{
      if(!host.state().enabled||payload?.sessionId!==host.state().sessionId)return host.setListening(payload);
      if(payload?.active===true&&!micAllowed())return host.stop('Allow the microphone before starting PC voice.');
      return host.setListening(payload);
    },
    'pc-voice:command':(_event,payload)=>host.runCommand(payload)
  };
  for(const [name,handler] of Object.entries(handlers))ipcMain.handle(name,(event,payload)=>{if(!voiceSender(event,contents))throw Error('PC voice is available only to the trusted Synapses main frame.');return handler(event,payload);});
  return ()=>{for(const name of Object.keys(handlers))ipcMain.removeHandler(name);};
}
module.exports={createDesktopVoiceHost,bindDesktopVoice,voiceSender,startClientFromNativeGesture};
