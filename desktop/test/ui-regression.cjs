'use strict';
// Run with Electron, not node --test. Uses an isolated synthetic document and
// the actual two production handlers; it never opens an installed user profile.
const { app, BrowserWindow, WebContentsView, protocol, net, session, ipcMain } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { bindWindowControls } = require('../src/window-controls.cjs');
const root=path.resolve(__dirname,'..'), output=path.join(root,'.preview/input-regression');
const source=fs.readFileSync(process.env.SYNAPSES_WEB_SOURCE || path.resolve(root,'../synapses-ava-agent-v1/index.html'),'utf8');
function actualFunction(name,next) {
  const start=source.indexOf('function '+name+'('),end=source.indexOf('function '+next+'(',start);
  assert.ok(start>=0&&end>start,'Production handler not found: '+name);return source.slice(start,end);
}
const handlers=actualFunction('_bnavLogoClick','_bnavLogoSyncOpenable')+'\n'+actualFunction('toggleTopBar','_tnvEnsureHomeMic');
const overlays=[...source.matchAll(/<div id="(?:etbDragZoneL|neu-resize-[^"]+)"[^>]*><\/div>/g)].map(x=>x[0]).join('');
assert.ok(overlays.includes('etbDragZoneL')&&overlays.includes('neu-resize-ne'));
const fixture=`<!doctype html><style>body{margin:0;background:#000;color:#fff}.top-bar{height:60px;app-region:drag}#bnavLogoMark{position:absolute;left:10px;top:0;width:28px;height:28px;cursor:pointer}#winStrip{position:fixed;top:0;right:0;z-index:9999999;display:flex;app-region:no-drag}#topBarToggle{width:28px;height:28px;app-region:no-drag}.top-bar.hidden{opacity:0}</style>
<div class="top-bar"><div id="bnavLogoMark" onclick="_bnavLogoClick()">Logo</div></div><aside id="chpSidebar"></aside>
<div id="winStrip"><button id="topBarToggle" onclick="toggleTopBar()">\u25b2</button></div>${overlays}
<script>var TOP_BAR_HIDDEN=false,_tnvGlideTimer=null,_tnvCentered=false,_tnvCachedRowCy=null,TNV_GLIDE_DELAY=700,_chpOpenedFromLogo=false;
function _tnvClearGlideTimer(){clearTimeout(_tnvGlideTimer);_tnvGlideTimer=null}function _tnvTrackToastDuring(){}function _tnvGlideToCenter(){}
function _chpOnChatSurface(){return true}function _chpInLlmChat(){return false}
function toggleChatHistoryPanel(){document.getElementById('chpSidebar').classList.toggle('open')}function newChat(){document.getElementById('chpSidebar').classList.remove('open')}
${handlers}</script>`;
fs.mkdirSync(output,{recursive:true});app.setPath('userData',path.join(output,'profile'));app.enableSandbox();
protocol.registerSchemesAsPrivileged([{scheme:'synapses-shell',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
const timer=setTimeout(()=>app.exit(1),20000);
app.whenReady().then(async()=>{
  protocol.handle('synapses-shell',request=>{
    const name=new URL(request.url).pathname.slice(1);
    const files={'index.html':'src/chrome/index.html','shell.css':'src/chrome/shell.css','shell.js':'src/chrome/shell.js','favicon.png':'assets/favicon.png'};
    return files[name]?net.fetch(pathToFileURL(path.join(root,files[name])).href):new Response('',{status:404});
  });
  const ses=session.fromPartition('input-regression');
  await ses.protocol.handle('https',()=>new Response(fixture,{headers:{'Content-Type':'text/html;charset=utf-8'}}));
  ses.setPermissionCheckHandler(()=>false);ses.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  const win=new BrowserWindow({show:false,width:900,height:600,frame:false,webPreferences:{preload:path.join(root,'src/chrome-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
  const view=new WebContentsView({webPreferences:{session:ses,sandbox:true,contextIsolation:true,nodeIntegration:false}});
  win.contentView.addChildView(view);view.setBounds({x:0,y:32,width:900,height:568});
  const cleanup=bindWindowControls(ipcMain,win,view.webContents,'synapses-shell://app/index.html');
  await win.loadURL('synapses-shell://app/index.html');await view.webContents.loadURL('https://synapses.cloud/fixture');
  const pause=()=>new Promise(resolve=>setTimeout(resolve,45));
  async function click(contents,x,y){contents.sendInputEvent({type:'mouseMove',x,y});contents.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});contents.sendInputEvent({type:'mouseUp',x,y,button:'left',clickCount:1});await pause();}
  const state=()=>view.webContents.executeJavaScript("({drawer:document.getElementById('chpSidebar').classList.contains('open'),hidden:TOP_BAR_HIDDEN,bridge:typeof window.synapsesWindow,logoRect:JSON.stringify(document.getElementById('bnavLogoMark').getBoundingClientRect().toJSON()),arrowRect:JSON.stringify(document.getElementById('topBarToggle').getBoundingClientRect().toJSON())})");
  const initial=await state();
  await click(view.webContents,24,14);const beforeLogo=await state();assert.equal(beforeLogo.drawer,false,'Legacy drag overlay should reproduce blocked web logo');
  await click(view.webContents,896,4);const beforeArrowEdge=await state();assert.equal(beforeArrowEdge.hidden,false,'Legacy corner resize overlay should reproduce blocked arrow hit area');
  await click(view.webContents,886,14);assert.equal((await state()).hidden,true,'Production arrow center handler should work without an interceptor');
  await click(view.webContents,886,14);assert.equal((await state()).hidden,false);
  await view.webContents.insertCSS(fs.readFileSync(path.join(root,'src/remote-shell.css'),'utf8'),{cssOrigin:'user'});await pause();
  await click(view.webContents,24,14);assert.equal((await state()).drawer,true,'Fixed web logo should open the drawer');
  await click(view.webContents,24,14);assert.equal((await state()).drawer,false);
  await click(view.webContents,896,4);assert.equal((await state()).hidden,true,'Fixed arrow edge should receive the click');
  await click(view.webContents,886,14);assert.equal((await state()).hidden,false);
  const native=await win.webContents.executeJavaScript("(()=>{const e=document.getElementById('navigation'),r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),tag:e.tagName,label:e.getAttribute('aria-label'),region:getComputedStyle(e).appRegion}})()");
  assert.equal(native.tag,'BUTTON');assert.equal(native.region,'no-drag');
  await click(win.webContents,native.x,native.y);assert.equal((await state()).drawer,true,'Native brand should dispatch actual production logo action');
  await win.webContents.executeJavaScript("document.getElementById('navigation').focus()");
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});await pause();
  const final=await state();assert.equal(final.drawer,false,'Native navigation button should support keyboard activation');
  assert.equal(final.bridge,'undefined');assert.equal(final.logoRect,initial.logoRect);assert.equal(final.arrowRect,initial.arrowRect);
  const evidence={productionHandlers:true,legacyWebLogoBlocked:true,legacyArrowEdgeBlocked:true,arrowCenterAlreadyFunctional:true,webLogoFixed:true,arrowEdgeFixed:true,nativeBrandClick:true,nativeBrandKeyboard:true,geometryUnchanged:true,remoteBridge:final.bridge};
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(evidence,null,2));console.log('INPUT REGRESSION PASS '+JSON.stringify(evidence));
  cleanup();view.webContents.close();win.destroy();clearTimeout(timer);app.exit(0);
}).catch(error=>{fs.writeFileSync(path.join(output,'error.txt'),String(error.message).slice(0,700));console.error(String(error.message).slice(0,700));app.exit(1);});
