'use strict';
const crypto=require('node:crypto');
const {parseVoiceCommand,publicAddress}=require('./desktop-voice-policy.cjs');
const {trustedSite}=require('./policy.cjs');
const {safeReason}=require('./voice-diagnostics.cjs');

function voiceSender(event,contents) {
  try {return !!event&&event.sender===contents&&event.senderFrame===contents.mainFrame&&trustedSite(event.senderFrame.url)&&trustedSite(contents.getURL());}catch{return false;}
}
function startClientFromNativeGesture(contents) {
  if(!trustedSite(contents.getURL()))return Promise.reject(Error('PC voice requires the trusted Synapses page.'));
  return contents.executeJavaScript("Promise.resolve(window.synapsesDesktopVoiceClient.start()).then(result=>result===true)",true);
}
function createDesktopVoiceHost({onState=()=>{},onStop=()=>true,onRevoke=()=>{},onDiagnostic=()=>{},openBrowser,lookupHost,makeId=crypto.randomUUID,pendingTimeoutMs=30000,dnsTimeoutMs=4000,now=Date.now}) {
  let enabled=false,listening=false,sessionId=null,message='',pendingTimer=null,lastCleanup=Promise.resolve(true),generation=0,hiddenStartUntil=0;
  const state=()=>({available:true,enabled,listening,sessionId,message});
  const publish=()=>onState(state());
  function stop(reason='PC voice is stopped.',reasonCode='user_stop') {
    generation++;
    const wasEnabled=enabled,previousMessage=message;
    clearTimeout(pendingTimer);pendingTimer=null;enabled=false;listening=false;sessionId=null;hiddenStartUntil=0;message=reason;onRevoke();if(wasEnabled||previousMessage!==message)publish();
    if(wasEnabled||reasonCode!=='user_stop')onDiagnostic('stopped',safeReason(reasonCode));
    if(wasEnabled)lastCleanup=Promise.resolve().then(()=>onStop(reason)).catch(()=>false);
    return state();
  }
  function start(options={}) {
    if(enabled)return state();
    enabled=true;listening=false;sessionId=makeId();message='Starting PC voice.';
    hiddenStartUntil=options.allowHiddenStart===true?Math.min(now()+pendingTimeoutMs,Number(options.expiresAt)||now()+pendingTimeoutMs):0;
    const timeout=hiddenStartUntil?Math.max(1,hiddenStartUntil-now()):pendingTimeoutMs;
    pendingTimer=setTimeout(()=>stop('PC voice setup timed out. Start it again when you are ready.','setup_timeout'),timeout);pendingTimer.unref?.();publish();onDiagnostic('starting');return state();
  }
  function setListening(payload) {
    if(!enabled||!payload||payload.sessionId!==sessionId||typeof payload.active!=='boolean')return {...state(),message:'The PC voice session has expired.'};
    if(!payload.active)return stop();
    clearTimeout(pendingTimer);pendingTimer=null;listening=true;message='PC voice is listening. Say “open YouTube”, “open browser” or “search for …”. Ava is optional.';publish();onDiagnostic('listening');return state();
  }
  async function runCommand(payload) {
    const fail=(reasonCode,message)=>{onDiagnostic('command-failed',reasonCode);return {handled:true,ok:false,reasonCode,message};};
    if(!enabled||!listening||!payload||payload.sessionId!==sessionId){if(enabled&&listening){onDiagnostic('command-received');fail('command_lease_revoked','PC voice is off.');}return {handled:false,ok:false,message:'PC voice is off.'};}
    onDiagnostic('command-received');
    const result=parseVoiceCommand(payload.text);
    if(!result.handled){onDiagnostic('command-unrecognized');return result;}
    if(!result.ok)return fail(['command_missing_target','command_target_invalid','command_parse_invalid'].includes(result.reasonCode)?result.reasonCode:'command_parse_invalid',result.message);
    if(result.type==='stop'){stop();return {handled:true,ok:true,message:result.message};}
    const id=sessionId;let stage='dns',dnsTimedOut=false;
    try {
      let timeout;
      const addresses=await Promise.race([lookupHost(new URL(result.url).hostname),new Promise((_,reject)=>{timeout=setTimeout(()=>{dnsTimedOut=true;reject(Error('DNS timeout'));},dnsTimeoutMs);})]).finally(()=>clearTimeout(timeout));
      if(!enabled||!listening||sessionId!==id)return fail('command_lease_revoked','PC voice was stopped before opening the website.');
      if(!Array.isArray(addresses)||!addresses.length)return fail('command_dns_empty','That address is not a verified public website.');
      if(!addresses.every(item=>publicAddress(typeof item==='string'?item:item.address)))return fail('command_dns_nonpublic','That address is not a verified public website.');
      stage='open';
      await openBrowser(result.url);
      onDiagnostic('command-complete');
      return {handled:true,ok:true,message:result.message};
    } catch {return fail(stage==='open'?'command_open_rejected':!enabled||!listening||sessionId!==id?'command_lease_revoked':dnsTimedOut?'command_dns_timeout':'command_dns_failed','I could not open that public website. Please try again.');}
  }
  return {state,start,stop,setListening,runCommand,waitForStop:()=>lastCleanup,active:()=>enabled&&listening,startingHidden:()=>enabled&&!listening&&hiddenStartUntil>now(),generation:()=>generation};
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
        const approval=await authorizeStart(),allowed=approval===true||approval?.allowed===true;
        if(!voiceSender(event,contents)||frame.url!==url||host.generation()!==ticket)return {...host.state(),message:'PC voice setup was canceled. Start it again when ready.'};
        if(!allowed)return {...host.state(),message:'PC voice was not enabled.'};
        onStartGesture(approval);return host.start({allowHiddenStart:approval?.allowHiddenStart===true,expiresAt:approval?.expiresAt});
      })().finally(()=>{pendingStart=null;});
      return pendingStart;
    },
    'pc-voice:stop':async(_event,payload)=>{host.stop('PC voice is stopped.',safeReason(payload?.reasonCode));await host.waitForStop();return host.state();},
    'pc-voice:listening':(_event,payload)=>{
      if(!host.state().enabled||payload?.sessionId!==host.state().sessionId)return host.setListening(payload);
      if(payload?.active===true&&!micAllowed())return host.stop('Allow the microphone before starting PC voice.','capture_not_approved');
      return host.setListening(payload);
    },
    'pc-voice:command':(_event,payload)=>host.runCommand(payload)
  };
  for(const [name,handler] of Object.entries(handlers))ipcMain.handle(name,(event,payload)=>{if(!voiceSender(event,contents))throw Error('PC voice is available only to the trusted Synapses main frame.');return handler(event,payload);});
  return ()=>{for(const name of Object.keys(handlers))ipcMain.removeHandler(name);};
}
module.exports={createDesktopVoiceHost,bindDesktopVoice,voiceSender,startClientFromNativeGesture};
