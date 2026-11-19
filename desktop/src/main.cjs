'use strict';
const { app, BrowserWindow, WebContentsView, Tray, Menu, dialog, ipcMain, protocol, net, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const dns = require('node:dns').promises;
const { pathToFileURL } = require('node:url');
const { trustedSite, externalLink, audioRequest, downloadLink, newMainDocument } = require('./policy.cjs');
const { bindWindowControls } = require('./window-controls.cjs');
const { createTrayLifecycle } = require('./tray-lifecycle.cjs');
const { createDesktopVoiceHost, bindDesktopVoice, startClientFromNativeGesture } = require('./desktop-voice-host.cjs');
const { captureAllowed: voiceCaptureAllowed } = require('./desktop-voice-policy.cjs');
const { createDocumentGate } = require('./document-gate.cjs');

const CHROME_URL = 'synapses-shell://app/index.html';
const START_URL = 'https://synapses.cloud/?desktop=0.1.3';
const BAR_HEIGHT = 32;
const remoteShellCss = fs.readFileSync(path.join(__dirname,'remote-shell.css'),'utf8');
const smoke = process.argv.includes('--smoke-test');
const smokeDir = smoke ? path.resolve(process.env.SYNAPSES_SMOKE_DIR || path.join(app.getPath('temp'),'synapses-desktop-smoke')) : null;
let mainWindow, desktopRuntime;
protocol.registerSchemesAsPrivileged([{ scheme:'synapses-shell', privileges:{ standard:true, secure:true, supportFetchAPI:true } }]);
app.enableSandbox();
app.setName('Synapses');
app.setAppUserModelId('cloud.synapses.desktop');
if (smoke) { fs.mkdirSync(smokeDir,{recursive:true}); app.setPath('userData', path.join(smokeDir,'profile')); }
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if(desktopRuntime)desktopRuntime.lifecycle.restore(); });
  app.on('before-quit', event => {
    if(mainWindow&&!mainWindow.isDestroyed()&&desktopRuntime){event.preventDefault();void desktopRuntime.lifecycle.quit();}
  });
  app.whenReady().then(createWindow).catch(error => { console.error(error); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
}

async function createWindow() {
  const chromeFiles = new Map([
    ['/index.html', path.join(__dirname,'chrome/index.html')],
    ['/shell.css', path.join(__dirname,'chrome/shell.css')],
    ['/shell.js', path.join(__dirname,'chrome/shell.js')],
    ['/favicon.png', path.join(__dirname,'../assets/favicon.png')]
  ]);
  protocol.handle('synapses-shell', request => {
    const url = new URL(request.url);
    const file = url.hostname === 'app' && !url.search && !url.hash && chromeFiles.get(url.pathname);
    return file ? net.fetch(pathToFileURL(file).href) : new Response('Not found', {status:404});
  });
  const win = mainWindow = new BrowserWindow({
    width:1320, height:860, minWidth:760, minHeight:520, frame:false,
    backgroundColor:'#000000', title:'Synapses', icon:path.join(__dirname,'../assets/app.ico'),
    show:!smoke, autoHideMenuBar:true, roundedCorners:false,
    webPreferences:{ preload:path.join(__dirname,'chrome-preload.cjs'), nodeIntegration:false, contextIsolation:true, sandbox:true, devTools:false, spellcheck:false }
  });
  Menu.setApplicationMenu(null);
  const siteSession = session.fromPartition(smoke ? 'synapses-smoke' : 'persist:synapses-main');
  const site = new WebContentsView({webPreferences:{session:siteSession, ...(process.platform==='win32'?{preload:path.join(__dirname,'desktop-voice-preload.cjs')}:{}), nodeIntegration:false, contextIsolation:true, sandbox:true, devTools:false, webSecurity:true, allowRunningInsecureContent:false}});
  const contents = site.webContents;
  site.setBackgroundColor('#000000');
  win.contentView.addChildView(site);
  site.setVisible(false);
  function resize() {
    const [width,height] = win.getContentSize();
    site.setBounds({x:0,y:BAR_HEIGHT,width,height:Math.max(1,height-BAR_HEIGHT)});
  }
  resize(); win.on('resize', resize);
  const sendState = () => { if(!win.webContents.isDestroyed())win.webContents.send('window:state',{maximized:win.isMaximized()}); };
  win.on('maximize',sendState); win.on('unmaximize',sendState);
  const unbindWindowControls = bindWindowControls(ipcMain,win,contents,CHROME_URL);
  win.webContents.on('will-navigate',event=>event.preventDefault());
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));

  let lastInput = 0, micAllowed = false, pendingMic = false;
  let pcVoice,lifecycle,tray,trayMenu,returnToTray=false,trayOptInUntil=0,pcStartAt=0;
  const freshInput = () => Date.now()-lastInput < 5000 && win.isVisible() && !win.isMinimized();
  const captureAllowed = () => voiceCaptureAllowed({freshInput:freshInput(),visible:win.isVisible(),minimized:win.isMinimized(),lease:pcVoice?.state(),startedAt:pcStartAt,now:Date.now()});
  contents.on('before-mouse-event',(_event,input)=>{if(input.type==='mouseDown')lastInput=Date.now();});
  contents.on('before-input-event',(event,input)=>{
    if(input.type!=='keyDown')return;
    lastInput=Date.now();
    if(input.control&&input.key.toLowerCase()==='r'){event.preventDefault();site.setVisible(false);contents.reload();}
    if(input.alt&&input.key==='F4'){event.preventDefault();win.close();}
  });
  win.webContents.on('before-input-event',(event,input)=>{
    if(input.type==='keyDown'&&input.control&&input.key.toLowerCase()==='r'){event.preventDefault();void contents.loadURL(START_URL).catch(()=>{});}
    if(input.type==='keyDown'&&input.alt&&input.key==='F4'){event.preventDefault();win.close();}
  });
  async function openExternal(url) {
    if(!trustedSite(contents.getURL())||!freshInput()||!externalLink(url))return;
    await shell.openExternal(new URL(url).href).catch(()=>{});
  }
  contents.on('will-navigate',(event,url)=>{const target=event.url||url;if(!trustedSite(target)){event.preventDefault();void openExternal(target);}});
  contents.on('will-redirect',(event,url)=>{if(!trustedSite(event.url||url))event.preventDefault();});
  contents.setWindowOpenHandler(details=>{
    if(trustedSite(details.url)&&freshInput())void contents.loadURL(details.url).catch(()=>{});
    else void openExternal(details.url);
    return {action:'deny'};
  });
  contents.on('will-attach-webview',event=>event.preventDefault());
  siteSession.setPermissionCheckHandler(()=>false);
  siteSession.setPermissionRequestHandler(async(requester,permission,callback,details)=>{
    if(requester!==contents||permission!=='media'||!audioRequest(contents.getURL(),details)||!captureAllowed()||pendingMic){callback(false);return;}
    if(micAllowed){callback(true);return;}
    pendingMic=true;
    try {
      const {response}=await dialog.showMessageBox(win,{type:'question',title:'Synapses microphone',message:'Allow Synapses to use your microphone?',detail:'Only synapses.cloud can use this permission for voice features in this app.',buttons:['Allow microphone','Cancel'],defaultId:1,cancelId:1,noLink:true});
      micAllowed=response===0&&!contents.isDestroyed()&&audioRequest(contents.getURL(),details)&&(win.isVisible()||!!pcVoice?.active())&&!win.isMinimized();
      callback(micAllowed);
    } catch {callback(false);} finally {pendingMic=false;}
  });
  siteSession.setDisplayMediaRequestHandler((_request,callback)=>callback(null));
  siteSession.setDevicePermissionHandler(()=>false);
  siteSession.on('will-download',(event,item)=>{if(!trustedSite(contents.getURL())||!freshInput()||!downloadLink(item.getURL()))event.preventDefault();});
  const stopWebVoice = () => trustedSite(contents.getURL())&&!contents.isDestroyed()
    ? contents.executeJavaScript("(async()=>{if(typeof window.stopTopNavVoice==='function')await window.stopTopNavVoice({skipAway:true});else if(typeof window.avaFloatingStopVoice==='function')await window.avaFloatingStopVoice();return true;})()",false).catch(()=>false) : Promise.resolve(true);
  function refreshTrayMenu(){
    if(!tray||tray.isDestroyed())return;
    const state=pcVoice.state();
    const template=[{label:'Open Synapses',click:()=>lifecycle.restore()}];
    if(process.platform==='win32')template.push({label:state.enabled?'Stop PC voice':'Start PC voice',type:'checkbox',checked:state.enabled,click:()=>{if(pcVoice.state().enabled)pcVoice.stop();else void startPcVoiceFromTray();}});
    template.push({type:'separator'},{label:'Quit Synapses',click:()=>{void lifecycle.quit();}});
    trayMenu=Menu.buildFromTemplate(template);tray.setContextMenu(trayMenu);tray.setToolTip(state.listening?'Synapses — PC voice listening':state.enabled?'Synapses — PC voice starting':'Synapses');
    if(desktopRuntime)desktopRuntime.trayMenu=trayMenu;
  }
  pcVoice=createDesktopVoiceHost({
    lookupHost:host=>dns.lookup(host,{all:true,verbatim:true}),
    openBrowser:url=>shell.openExternal(url),
    onState:state=>{
      if(!contents.isDestroyed()){contents.setBackgroundThrottling(!(state.enabled&&state.listening));if(trustedSite(contents.getURL()))contents.send('pc-voice:state',state);}
      refreshTrayMenu();
      if(!state.enabled){returnToTray=false;trayOptInUntil=0;}
      if(state.enabled&&state.listening&&returnToTray){returnToTray=false;queueMicrotask(()=>{if(pcVoice.active())void lifecycle.hide();});}
    },
    onStop:()=>{if(!contents.isDestroyed()&&trustedSite(contents.getURL()))contents.send('pc-voice:request',{action:'stop'});return stopWebVoice();}
  });
  const revokeAndStop=()=>{const enabled=pcVoice.state().enabled;pcVoice.stop();return enabled?pcVoice.waitForStop():stopWebVoice();};
  const unbindDesktopVoice=process.platform==='win32'?bindDesktopVoice({
    ipcMain,contents,host:pcVoice,micAllowed:()=>micAllowed,
    authorizeStart:async()=>{
      if(!win.isVisible()||win.isMinimized()||!trustedSite(contents.getURL()))return false;
      if(Date.now()<trayOptInUntil){trayOptInUntil=0;return true;}
      if(!freshInput())return false;
      const {response}=await dialog.showMessageBox(win,{type:'question',title:'PC voice control',message:'Enable PC voice control?',detail:'While this session is listening, say “Ava, open …” or “Ava, search for …” to open public websites in your browser. It can keep listening in the tray until you stop it.',buttons:['Enable PC voice','Cancel'],defaultId:1,cancelId:1,noLink:true});
      return response===0&&win.isVisible()&&!win.isMinimized();
    },
    onStartGesture:()=>{lastInput=Date.now();pcStartAt=Date.now();}
  }):()=>{};
  async function startPcVoiceFromTray(){
    lifecycle.restore();lastInput=Date.now();refreshTrayMenu();
    try {
      const ready=trustedSite(contents.getURL())&&await contents.executeJavaScript("!!(window.__synapsesDesktopVoiceHookVersion===1&&window.synapsesDesktopVoiceClient&&window.synapsesDesktopVoiceClient.version===1)",false);
      if(!ready){const {response}=await dialog.showMessageBox(win,{type:'info',title:'Refresh Synapses',message:'Refresh Synapses to enable PC voice control.',detail:'This page has an older voice connection. Reload it before starting.',buttons:['Reload','Cancel'],defaultId:1,cancelId:1,noLink:true});if(response===0)await contents.loadURL(START_URL);return;}
      returnToTray=true;trayOptInUntil=Date.now()+15000;
      // This native tray selection is a genuine user gesture; forward it only
      // to the packaged client, without changing autoplay/security globally.
      await startClientFromNativeGesture(contents);
    } catch {pcVoice.stop('PC voice could not start. Please try again.');}
    finally {refreshTrayMenu();}
  }
  lifecycle = createTrayLifecycle({
    stopVoice:()=>pcVoice.active()?Promise.resolve(true):revokeAndStop(),
    stopBeforeQuit:revokeAndStop,
    hideWindow:()=>{if(!win.isDestroyed())win.hide();},
    restoreWindow:()=>{if(win.isDestroyed())return;if(win.isMinimized())win.restore();win.show();win.focus();},
    closeContents:()=>{if(!contents.isDestroyed())contents.close({waitForBeforeUnload:true});}
  });
  tray = new Tray(path.join(__dirname,'../assets/app.ico'));
  tray.setToolTip('Synapses');
  refreshTrayMenu();
  tray.on('click',()=>lifecycle.restore());
  tray.on('double-click',()=>lifecycle.restore());
  desktopRuntime = { lifecycle, tray, trayMenu, pcVoice };
  win.on('minimize',()=>{if(!pcVoice.active())void revokeAndStop();});
  win.on('close',event=>{
    if(contents.isDestroyed())return;
    event.preventDefault();
    if(lifecycle.isQuitting())void lifecycle.quit();else void lifecycle.hide();
  });
  contents.on('will-prevent-unload',event=>{
    const answer=dialog.showMessageBoxSync(win,{type:'question',message:'Leave Synapses?',detail:'There may be unsaved work.',buttons:['Stay','Close'],defaultId:0,cancelId:0,noLink:true});
    if(answer===1)event.preventDefault();else lifecycle.cancelQuit();
  });
  contents.on('destroyed',()=>{pcVoice.stop();if(!win.isDestroyed())win.destroy();});
  win.on('closed',()=>{unbindWindowControls();unbindDesktopVoice();if(!tray.isDestroyed())tray.destroy();if(!contents.isDestroyed())contents.close();mainWindow=null;desktopRuntime=null;});
  const documentGate=createDocumentGate({showSurface:()=>{if(trustedSite(contents.getURL()))site.setVisible(true);},hideSurface:()=>site.setVisible(false),onOptionalError:()=>console.warn('PC voice client is unavailable on this page.')});
  contents.on('did-start-navigation',(event,_url,_inPlace,isMainFrame)=>{
    if(newMainDocument(event,_inPlace,isMainFrame)){pcVoice.stop('PC voice stopped because the page changed.');documentGate.reset();}
  });
  contents.on('dom-ready',()=>{
    if(trustedSite(contents.getURL()))documentGate.prepare(contents.insertCSS(remoteShellCss,{cssOrigin:'user'}),()=>{
      if(process.platform==='win32'&&trustedSite(contents.getURL()))return contents.executeJavaScript(fs.readFileSync(path.join(__dirname,'desktop-voice-client.js'),'utf8'),false);
    });
  });
  contents.on('did-finish-load',()=>{void documentGate.finish();});
  contents.on('did-fail-load',(_event,code,_description,_url,isMain)=>{if(isMain&&code!==-3)site.setVisible(false);});
  contents.on('render-process-gone',()=>{pcVoice.stop('PC voice stopped because the page closed.');site.setVisible(false);});
  await win.loadURL(CHROME_URL);
  await contents.loadURL(START_URL).catch(()=>{});
  if(smoke) await smokeTest(win,site,desktopRuntime);
}

async function smokeTest(win,site,runtime) {
  for(let attempt=0;attempt<50&&!site.getVisible();attempt++)await new Promise(resolve=>setTimeout(resolve,100));
  const visibleBeforeHash = site.getVisible();
  await site.webContents.executeJavaScript("location.hash='desktop-shell-smoke'");
  await new Promise(resolve=>setTimeout(resolve,100));
  const visibleAfterHash = site.getVisible();
  const chrome=await win.webContents.executeJavaScript("({buttons:[...document.querySelectorAll('button')].map(x=>x.getAttribute('aria-label')),bridge:typeof window.synapsesWindow,require:typeof require})");
  const remote=await site.webContents.executeJavaScript("(async()=>({url:location.href,title:document.title,require:typeof require,process:typeof process,bridge:typeof window.synapsesWindow,pcVoice:typeof window.synapsesDesktopVoice,pcMethods:window.synapsesDesktopVoice?Object.keys(window.synapsesDesktopVoice).sort():[],pcAvailable:window.synapsesDesktopVoice?(await window.synapsesDesktopVoice.getState()).available:false}))()");
  const prefs=site.webContents.getLastWebPreferences();
  await win.webContents.executeJavaScript('window.synapsesWindow.toggleMaximize()');
  await new Promise(resolve=>setTimeout(resolve,150));
  const maximized=win.isMaximized();
  await win.webContents.executeJavaScript('window.synapsesWindow.toggleMaximize()');
  await new Promise(resolve=>setTimeout(resolve,150));
  const restored=!win.isMaximized();
  const configuredRemotePreload=process.platform==='win32'?path.join(__dirname,'desktop-voice-preload.cjs'):null;
  const evidence={chrome,remote,controls:{maximized,restored},navigation:{visibleBeforeHash,visibleAfterHash},bounds:site.getBounds(),sandbox:prefs.sandbox,contextIsolation:prefs.contextIsolation,nodeIntegration:prefs.nodeIntegration,remotePreload:prefs.preload||null,configuredRemotePreload};
  // Recent Electron omits the legacy preload preference in this getter. The
  // configured file is checked in the archive; its actual capability is probed here.
  const narrowPreload=process.platform==='win32'?(!prefs.preload||prefs.preload===configuredRemotePreload)&&remote.pcVoice==='object'&&remote.pcAvailable===true&&remote.pcMethods.join(',')==='getState,onRequest,onState,runCommand,setListening,start,stop':!prefs.preload&&remote.pcVoice==='undefined';
  fs.mkdirSync(smokeDir,{recursive:true});fs.writeFileSync(path.join(smokeDir,'isolation.json'),JSON.stringify({evidence,narrowPreload,expectedPreload:path.join(__dirname,'desktop-voice-preload.cjs')},null,2));
  if(!trustedSite(remote.url)||remote.require!=='undefined'||remote.process!=='undefined'||remote.bridge!=='undefined'||chrome.buttons.length!==4||!maximized||!restored||!visibleBeforeHash||!visibleAfterHash||!prefs.sandbox||!prefs.contextIsolation||prefs.nodeIntegration||!narrowPreload)throw new Error('Desktop isolation smoke test failed');
  fs.mkdirSync(smokeDir,{recursive:true});
  fs.writeFileSync(path.join(smokeDir,'smoke.json'),JSON.stringify(evidence,null,2));
  const windowCapture=await win.capturePage().catch(()=>null),siteCapture=await site.webContents.capturePage().catch(()=>null);
  if(windowCapture)fs.writeFileSync(path.join(smokeDir,'window.png'),windowCapture.toPNG());
  if(siteCapture)fs.writeFileSync(path.join(smokeDir,'site.png'),siteCapture.toPNG());
  console.log('SMOKE PASS',JSON.stringify(evidence));
  await site.webContents.executeJavaScript("window.__desktopCleanupCalls=0;window.stopTopNavVoice=async()=>{window.__desktopCleanupCalls++;return true;};true");
  await win.webContents.executeJavaScript('window.synapsesWindow.close()').catch(()=>{});
  await runtime.lifecycle.hide();
  const hiddenToTray=!win.isVisible()&&!runtime.tray.isDestroyed()&&!site.webContents.isDestroyed();
  const cleanupBeforeHide=await site.webContents.executeJavaScript('window.__desktopCleanupCalls>0');
  runtime.tray.emit('click');await new Promise(resolve=>setTimeout(resolve,100));
  const restoredFromTray=win.isVisible();
  await runtime.lifecycle.hide();runtime.tray.emit('double-click');
  const restoredFromDoubleClick=win.isVisible();
  await runtime.lifecycle.hide();
  runtime.trayMenu.items.find(item=>item.label==='Open Synapses').click();
  const restoredFromMenu=win.isVisible();
  await runtime.lifecycle.hide();app.emit('second-instance');
  const restoredFromSecondInstance=win.isVisible();
  if(!hiddenToTray||!cleanupBeforeHide||!restoredFromTray||!restoredFromDoubleClick||!restoredFromMenu||!restoredFromSecondInstance)throw new Error('Tray smoke test failed');
  evidence.tray={hiddenToTray,cleanupBeforeHide,restoredFromTray,restoredFromDoubleClick,restoredFromMenu,restoredFromSecondInstance,explicitQuitCompleted:false};
  fs.writeFileSync(path.join(smokeDir,'smoke.json'),JSON.stringify(evidence,null,2));
  app.once('will-quit',()=>{evidence.tray.explicitQuitCompleted=true;fs.writeFileSync(path.join(smokeDir,'smoke.json'),JSON.stringify(evidence,null,2));});
  runtime.trayMenu.items.find(item=>item.label==='Quit Synapses').click();
}
