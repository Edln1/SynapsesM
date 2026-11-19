'use strict';
const {contextBridge,ipcRenderer}=require('electron');
let trusted=false;
try {const u=new URL(location.href);trusted=u.protocol==='https:'&&['synapses.cloud','www.synapses.cloud'].includes(u.hostname)&&!u.username&&!u.password&&(!u.port||u.port==='443');}catch{}
if(process.platform==='win32'&&process.isMainFrame&&trusted){
  const subscribe=(channel,callback,copy)=>{
    if(typeof callback!=='function')return ()=>{};
    const listener=(_event,payload)=>callback(copy(payload||{}));ipcRenderer.on(channel,listener);return ()=>ipcRenderer.removeListener(channel,listener);
  };
  const copyState=p=>({available:p.available===true,enabled:p.enabled===true,listening:p.listening===true,sessionId:typeof p.sessionId==='string'?p.sessionId:null,message:typeof p.message==='string'?p.message:''});
  contextBridge.exposeInMainWorld('synapsesDesktopVoice',Object.freeze({
    getState:()=>ipcRenderer.invoke('pc-voice:state'),start:()=>ipcRenderer.invoke('pc-voice:start'),stop:p=>ipcRenderer.invoke('pc-voice:stop',{reasonCode:typeof p?.reasonCode==='string'?p.reasonCode:''}),
    setListening:p=>ipcRenderer.invoke('pc-voice:listening',{sessionId:typeof p?.sessionId==='string'?p.sessionId:'',active:p?.active===true}),
    runCommand:p=>ipcRenderer.invoke('pc-voice:command',{sessionId:typeof p?.sessionId==='string'?p.sessionId:'',text:typeof p?.text==='string'?p.text:''}),
    onRequest:callback=>subscribe('pc-voice:request',callback,p=>({action:p.action==='start'?'start':'stop'})),
    onState:callback=>subscribe('pc-voice:state',callback,copyState)
  }));
}
