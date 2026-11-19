'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{execFile}=require('node:child_process');
const {publicWebUrl}=require('./desktop-voice-policy.cjs');
const SENSITIVE=/\b(?:buy|purchase|pay|payment|checkout|order|delete|remove|send|submit|publish|install|uninstall|transfer|password|credential|security|confirm)\b/i;
const KEYS=new Set(['ENTER','ESCAPE','TAB','SHIFT_TAB','SPACE','ARROW_UP','ARROW_DOWN','ARROW_LEFT','ARROW_RIGHT','HOME','END','PAGE_UP','PAGE_DOWN','CTRL_L','CTRL_A','CTRL_F','BACKSPACE','DELETE']);
function materializeDriver(){
  const bytes=fs.readFileSync(path.join(__dirname,'windows-actions.ps1')),hash=crypto.createHash('sha256').update(bytes).digest('hex');
  const directory=path.join(os.tmpdir(),'SynapsesDesktop','native',hash),file=path.join(directory,'windows-actions.ps1');
  fs.mkdirSync(directory,{recursive:true});try{fs.writeFileSync(file,bytes,{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
  if(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==hash)throw Error('The trusted Windows driver did not match its packaged hash.');
  return file;
}
function createWindowsActions({displays=()=>[],assertActive=()=>true,runScript}={}){
  const apps=new Map(),appKeys=new Map(),knownWindows=new Map(),windowKeys=new Map(),snapshots=new Map(),pending=new Set();let generation=0;
  async function current(){if(await assertActive()===false)throw Error('PC control is stopped.');}
  function native(payload){
    return new Promise((resolve,reject)=>{
      const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
      const child=execFile(powershell,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',materializeDriver()],{windowsHide:true,timeout:15000,maxBuffer:2*1024*1024,encoding:'utf8'},(error,stdout)=>{
        pending.delete(task);if(error){reject(Error('The Windows driver could not complete this action.'));return;}
        try{resolve(JSON.parse(stdout.replace(/^\uFEFF/,'')));}catch{reject(Error('The Windows driver returned an invalid response.'));}
      });
      const task={cancel:()=>{child.kill();reject(Error('PC control is stopped.'));}};pending.add(task);child.stdin.end(JSON.stringify(payload));
    });
  }
  async function call(payload){
    const ticket=generation;await current();if(ticket!==generation)throw Error('PC control is stopped.');
    let rejectCancellation;const task={cancel:()=>rejectCancellation(Error('PC control is stopped.'))};
    const canceled=new Promise((_,reject)=>{rejectCancellation=reject;});pending.add(task);
    try{const result=await Promise.race([Promise.resolve().then(async()=>{await current();if(ticket!==generation)throw Error('PC control is stopped.');return runScript?runScript(payload):native(payload);}),canceled]);await current();if(ticket!==generation)throw Error('PC control is stopped.');return result||{ok:false,message:'Windows returned no result.'};}finally{pending.delete(task);}
  }
  const opaque=prefix=>prefix+'_'+crypto.randomUUID();
  async function catalog({query=''}={}){
    const result=await call({op:'catalog'});if(result.ok===false)return result;
    const all=Array.isArray(result.apps)?result.apps:[];const available=[];apps.clear();
    for(const item of all){if(!item||typeof item.key!=='string'||typeof item.name!=='string')continue;const id=appKeys.get(item.key)||opaque('app');appKeys.set(item.key,id);apps.set(id,{key:item.key,name:item.name});available.push({appId:id,name:item.name.slice(0,160),aliases:Array.isArray(item.aliases)?item.aliases.filter(x=>typeof x==='string').map(x=>x.slice(0,80)).slice(0,8):[],type:String(item.kind||'app').slice(0,30)});}
    const words=String(query).toLowerCase().trim().slice(0,160).split(/\s+/).filter(Boolean);
    const filtered=words.length?available.filter(item=>words.every(word=>(item.name+' '+item.aliases.join(' ')).toLowerCase().includes(word))):available;
    return {ok:true,count:available.length,matched:filtered.length,truncated:filtered.length>400,apps:filtered.slice(0,400)};
  }
  function monitorList(){return displays().map(item=>({displayId:String(item.id),label:String(item.label||'Display '+item.id).slice(0,100),bounds:item.physicalBounds||null,workArea:item.physicalWorkArea||null}));}
  async function windows(){
    const result=await call({op:'windows',excludePid:process.pid});if(result.ok===false)return result;knownWindows.clear();
    const list=[];for(const item of (Array.isArray(result.windows)?result.windows:[])){
      if(!item||!/^\d+$/.test(String(item.hwnd))||!Number.isInteger(item.pid)||typeof item.started!=='string')continue;
      const key=item.hwnd+':'+item.pid+':'+item.started,id=windowKeys.get(key)||opaque('window');windowKeys.set(key,id);knownWindows.set(id,{hwnd:String(item.hwnd),pid:item.pid,started:item.started,app:String(item.app||''),title:String(item.title||'')});
      list.push({windowId:id,title:String(item.title||'').slice(0,240),app:String(item.app||'').slice(0,100),foreground:item.foreground===true,minimized:item.minimized===true,bounds:item.bounds});
    }
    return {ok:true,windows:list.slice(0,100),displays:monitorList()};
  }
  function target(windowId){const found=knownWindows.get(windowId);if(!found)throw Error('List windows again before using this window.');return found;}
  async function launch({appId}={}){const item=apps.get(appId);if(!item)return {ok:false,verified:false,message:'Find the app in the installed app catalog first.'};return call({op:'launch',appKey:item.key});}
  async function moveWindow({windowId,displayId}={}){
    const window=target(windowId),display=monitorList().find(x=>x.displayId===String(displayId));
    if(!display?.workArea)return {ok:false,verified:false,message:'Select a display with verified physical work-area coordinates.'};
    return call({op:'move',window,area:display.workArea});
  }
  async function readWindow({windowId}={}){
    const result=await call({op:'read',window:target(windowId)});if(result.ok===false)return result;
    const controls=new Map(),out=[];let textLength=0;
    for(const node of (Array.isArray(result.controls)?result.controls:[]).slice(0,150)){
      if(!Array.isArray(node.runtimeId)||!node.runtimeId.every(Number.isInteger))continue;
      const ref=opaque('control'),name=node.password?'Password':String(node.name||'').slice(0,Math.max(0,Math.min(300,6000-textLength)));textLength+=name.length;
      controls.set(ref,{runtimeId:node.runtimeId,name:node.password?'':String(node.name||''),nameHash:String(node.nameHash||''),type:String(node.type||''),bounds:node.bounds,password:node.password===true,risky:node.risky===true||SENSITIVE.test(name)});
      out.push({ref,name,role:String(node.type||'').slice(0,80),bounds:node.bounds,enabled:node.enabled===true,password:node.password===true});
    }
    snapshots.set(windowId,{controls,generation,windowGeneration:String(result.windowGeneration||'')});return {ok:true,windowId,controls:out,truncated:result.truncated===true};
  }
  async function controlAction(op,{windowId,ref,text}={},options={}){
    const window=target(windowId),snapshot=snapshots.get(windowId),control=snapshot?.controls.get(ref);
    if(!control||snapshot.generation!==generation)return {ok:false,verified:false,message:'Read this window again; the control reference is stale.'};
    if(/terminal|powershell|command prompt|run command/i.test(control.name))return {ok:false,verified:false,message:'Shell and command-entry controls are not supported.'};
    if(control.password)return {ok:false,verified:false,message:'Password fields are not supported by this controller.'};
    if(op==='type'&&/^explorer$/i.test(window.app)&&/address|location/i.test(control.name))return {ok:false,verified:false,message:'Explorer command and address fields are not supported.'};
    if(control.risky&&options.confirmed!==true)return {ok:false,confirmationRequired:true,message:'Confirm '+(op==='click'?'activating ':'editing ')+control.name.slice(0,180)+'.'};
    if(op==='type'&&(typeof text!=='string'||text.length>6000))return {ok:false,verified:false,message:'Use text of at most 6000 characters.'};
    if(op==='type'&&/chrome|msedge|firefox|brave|opera/i.test(window.app)&&/address|omnibox|location/i.test(control.name)){
      const value=text.trim();if(/^(?:\\\\|[a-z]:[\\/]|\/|~[\\/])/i.test(value))return {ok:false,verified:false,message:'Local paths are not supported in a browser address field.'};if(/^[a-z][a-z0-9+.-]*:/i.test(value)||/^(?:localhost|\d{1,3}(?:\.\d{1,3}){1,3})(?::|\/|$)/i.test(value)||/^[^\s]+\.[^\s]+$/.test(value)){if(!publicWebUrl(/^[a-z][a-z0-9+.-]*:/i.test(value)?value:'https://'+value))return {ok:false,verified:false,message:'Only public HTTPS addresses or plain search words may be entered in a browser address field.'};}
    }
    const result=await call({op,window,control,windowGeneration:snapshot.windowGeneration,...(op==='type'?{text}:{})});snapshots.delete(windowId);return result;
  }
  async function pressKey({windowId,key}={},options={}){
    const aliases={ARROWUP:'ARROW_UP',ARROWDOWN:'ARROW_DOWN',ARROWLEFT:'ARROW_LEFT',ARROWRIGHT:'ARROW_RIGHT',PAGEUP:'PAGE_UP',PAGEDOWN:'PAGE_DOWN',CONTROL_A:'CTRL_A',CONTROL_L:'CTRL_L',CONTROL_F:'CTRL_F'};
    let normalized=String(key||'').toUpperCase().replace(/[+ -]/g,'_');normalized=aliases[normalized]||normalized;if(!KEYS.has(normalized))return {ok:false,verified:false,message:'That keyboard shortcut is not supported.'};
    if(['ENTER','SPACE','DELETE'].includes(normalized)&&options.confirmed!==true)return {ok:false,confirmationRequired:true,message:'Confirm sending '+normalized+' to the selected app.'};
    const result=await call({op:'key',window:target(windowId),key:normalized});snapshots.delete(windowId);return result;
  }
  async function scrollWindow({windowId,direction,amount=3}={}){
    if(!['up','down','left','right'].includes(direction))return {ok:false,verified:false,message:'Use a supported scroll direction.'};
    return call({op:'scroll',window:target(windowId),direction,amount:Math.max(1,Math.min(10,Number(amount)||3))});
  }
  function cancel(){generation++;snapshots.clear();for(const task of [...pending])task.cancel();pending.clear();}
  return {catalog,windows,launch,moveWindow,readWindow,clickControl:(args,options)=>controlAction('click',args,options),typeControl:(args,options)=>controlAction('type',args,options),pressKey,scrollWindow,cancel};
}
module.exports={createWindowsActions,materializeDriver};
