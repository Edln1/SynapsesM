'use strict';
const { app, BrowserWindow, WebContentsView, Tray, Menu, dialog, ipcMain, protocol, net, session, shell, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const dns = require('node:dns').promises;
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { trustedSite, externalLink, audioRequest, downloadLink, newMainDocument } = require('./policy.cjs');
const { bindWindowControls } = require('./window-controls.cjs');
const { createTrayLifecycle } = require('./tray-lifecycle.cjs');
const { createDesktopVoiceHost, bindDesktopVoice, startClientFromNativeGesture } = require('./desktop-voice-host.cjs');
const { captureAllowed: voiceCaptureAllowed, captureApprovalCurrent } = require('./desktop-voice-policy.cjs');
const { createDocumentGate } = require('./document-gate.cjs');
const { createTrayVoiceStarter, showDialogPreservingWindowState } = require('./tray-voice-start.cjs');
const { createVoiceDiagnostics } = require('./voice-diagnostics.cjs');
const { RUNTIME_EXPRESSION, sanitizeRuntimeReport, dispatchSecondInstance } = require('./voice-runtime-report.cjs');
const { createPcTaskRunner } = require('./pc-task-runner.cjs');
const { createPcTaskTools } = require('./pc-task-tools.cjs');
const { createWindowsActions } = require('./windows-actions.cjs');
const { createBrowserActions } = require('./browser-actions.cjs');
const { createTaskDiagnostics } = require('./pc-task-diagnostics.cjs');

const CHROME_URL = 'synapses-shell://app/index.html';
const START_URL = 'https://synapses.cloud/?desktop=0.1.7&v=pc-planner2';
const BAR_HEIGHT = 32;
const remoteShellCss = fs.readFileSync(path.join(__dirname,'remote-shell.css'),'utf8');
const smoke = process.argv.includes('--smoke-test');
const reportOnly = process.argv.includes('--pc-voice-report');
const smokeDir = smoke ? path.resolve(process.env.SYNAPSES_SMOKE_DIR || path.join(app.getPath('temp'),'synapses-desktop-smoke')) : null;
let mainWindow, desktopRuntime,pendingRuntimeReport=false;
function writeRuntimeReport(raw,host={}){
  const data=sanitizeRuntimeReport(raw,{version:app.getVersion(),time:new Date().toISOString(),host});
  try{fs.mkdirSync(app.getPath('userData'),{recursive:true});fs.writeFileSync(path.join(app.getPath('userData'),'pc-voice-runtime.json'),JSON.stringify(data,null,2)+'\n','utf8');return true;}catch{return false;}
}
protocol.registerSchemesAsPrivileged([{ scheme:'synapses-shell', privileges:{ standard:true, secure:true, supportFetchAPI:true } }]);
app.enableSandbox();
app.setName('Synapses');
app.setAppUserModelId('cloud.synapses.desktop');
if (smoke) { fs.mkdirSync(smokeDir,{recursive:true}); app.setPath('userData', path.join(smokeDir,'profile')); }
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event,argv) => dispatchSecondInstance(argv,{report:()=>{if(desktopRuntime)void desktopRuntime.reportVoiceRuntime();else pendingRuntimeReport=true;},restore:()=>{if(desktopRuntime)desktopRuntime.lifecycle.restore();}}));
  app.on('before-quit', event => {
    if(mainWindow&&!mainWindow.isDestroyed()&&desktopRuntime){event.preventDefault();void desktopRuntime.lifecycle.quit();}
  });
  app.whenReady().then(()=>{if(reportOnly){writeRuntimeReport(null);app.quit();return;}return createWindow();}).catch(error => { console.error(error); app.exit(1); });
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
  let pcVoice,lifecycle,tray,trayMenu,trayIntent=null,trayIntentTimer=null,pcStartAt=0,taskRunner,browserActions,windowsActions,browserOwner='';
  const voiceDiagnostics=createVoiceDiagnostics({file:path.join(app.getPath('userData'),'pc-voice-status.json'),version:app.getVersion(),readState:()=>pcVoice?.state()});
  const freshInput = () => Date.now()-lastInput < 5000 && win.isVisible() && !win.isMinimized();
  const captureAllowed = () => voiceCaptureAllowed({freshInput:freshInput(),visible:win.isVisible(),minimized:win.isMinimized(),lease:pcVoice?.state(),hiddenStart:pcVoice?.startingHidden(),startedAt:pcStartAt,now:Date.now()});
  function validTrayIntent(){try{return !!trayIntent&&Date.now()<trayIntent.expiresAt&&trayIntent.generation===pcVoice.generation()&&trayIntent.frame===contents.mainFrame&&trustedSite(contents.getURL());}catch{return false;}}
  function updateBackgroundPolicy(){if(!contents.isDestroyed())contents.setBackgroundThrottling(!(pcVoice?.state().enabled||validTrayIntent()));}
  function clearTrayIntent(){clearTimeout(trayIntentTimer);trayIntentTimer=null;trayIntent=null;updateBackgroundPolicy();}
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
    function denied(code){if(pcVoice.state().enabled||validTrayIntent())voiceDiagnostics.record('capture_denied',code);callback(false);}
    if(requester!==contents||permission!=='media'||!audioRequest(contents.getURL(),details)){denied('permission_wrong_request');return;}
    if(!captureAllowed()){denied('permission_window_not_allowed');return;}
    if(pendingMic){denied('permission_pending');return;}
    voiceDiagnostics.record('capture_requested');
    if(micAllowed){voiceDiagnostics.record('capture_approved');callback(true);return;}
    pendingMic=true;
    const captureSnapshot=()=>({generation:pcVoice.generation(),sessionId:pcVoice.state().sessionId,frame:contents.mainFrame});
    const requestedCapture=captureSnapshot();
    try {
      const {response}=await showDialogPreservingWindowState(dialog,win,{type:'question',title:'Synapses microphone',message:'Allow Synapses to use your microphone?',detail:'Only synapses.cloud can use this permission for voice features in this app.',buttons:['Allow microphone','Cancel'],defaultId:1,cancelId:1,noLink:true});
      if(response===0&&win.isVisible()&&!win.isMinimized())lastInput=Date.now();
      micAllowed=response===0&&!contents.isDestroyed()&&audioRequest(contents.getURL(),details)&&captureApprovalCurrent(requestedCapture,captureSnapshot(),captureAllowed());
      voiceDiagnostics.record(micAllowed?'capture_approved':'capture_denied',micAllowed?'none':response===0?'permission_expired':'permission_declined');
      callback(micAllowed);
    } catch {voiceDiagnostics.record('capture_denied','permission_error');callback(false);} finally {pendingMic=false;}
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
    const starting=validTrayIntent();
    if(process.platform==='win32')template.push({label:state.enabled?'Stop PC voice':starting?'Cancel PC voice setup':'Start PC voice',type:'checkbox',checked:state.enabled||starting,click:()=>{if(pcVoice.state().enabled||validTrayIntent())pcVoice.stop();else void startPcVoiceFromTray();}});
    template.push({type:'separator'},{label:'Quit Synapses',click:()=>{void lifecycle.quit();}});
    trayMenu=Menu.buildFromTemplate(template);tray.setContextMenu(trayMenu);tray.setToolTip(state.listening?'Synapses — PC voice listening':state.enabled||starting?'Synapses — PC voice starting':'Synapses');
    if(desktopRuntime)desktopRuntime.trayMenu=trayMenu;
  }
  function assertPcActive(){
    if(!pcVoice?.active()||contents.isDestroyed()||!trustedSite(contents.getURL()))throw Error('PC voice control is stopped.');
    return true;
  }
  windowsActions=createWindowsActions({displays:()=>screen.getAllDisplays().map(display=>({...display,
    physicalBounds:screen.dipToScreenRect(null,display.bounds),physicalWorkArea:screen.dipToScreenRect(null,display.workArea)})),assertActive:assertPcActive});
  browserActions=createBrowserActions({BrowserWindow,lookupHost:host=>dns.lookup(host,{all:true,verbatim:true}),assertActive:assertPcActive});
  const taskTools=createPcTaskTools({windows:windowsActions,browser:{perform:(...args)=>browserActions.perform(...args),cancel:options=>browserActions.cancel(options)},assertActive:assertPcActive,
    authorizeAction:async request=>{
      assertPcActive();
      const generation=pcVoice.generation(),id=pcVoice.state().sessionId;
      const {response}=await showDialogPreservingWindowState(dialog,win,{type:'question',title:'Confirm Ava action',message:'Allow this action?',detail:request.description,buttons:['Allow this action','Cancel'],defaultId:1,cancelId:1,noLink:true});
      assertPcActive();return response===0&&generation===pcVoice.generation()&&id===pcVoice.state().sessionId;
    }});
  const taskDiagnostics=createTaskDiagnostics({file:path.join(app.getPath('userData'),'pc-task-status.json'),version:app.getVersion()});
  taskRunner=createPcTaskRunner({tools:taskTools,assertActive:assertPcActive,onProgress:event=>{taskDiagnostics.record(event);pcVoice?.taskProgress(event.phase);},maxSteps:12,timeoutMs:90000});
  pcVoice=createDesktopVoiceHost({
    lookupHost:host=>dns.lookup(host,{all:true,verbatim:true}),
    openBrowser:url=>shell.openExternal(url),
    runTask:(text,options)=>{
      const owner=options.userId||pcVoice.state().sessionId;
      if(owner!==browserOwner){
        browserActions.close();browserOwner=owner;
        const partition='persist:synapses-agent-'+createHash('sha256').update(owner).digest('hex').slice(0,20);
        browserActions=createBrowserActions({BrowserWindow,partition,lookupHost:host=>dns.lookup(host,{all:true,verbatim:true}),assertActive:assertPcActive});
      }
      return taskRunner.run(text,options);
    },cancelTask:()=>{taskRunner.cancel();windowsActions.cancel?.();browserActions.cancel({keepIdleWindow:true});},
    onState:state=>{
      updateBackgroundPolicy();
      if(!contents.isDestroyed()&&trustedSite(contents.getURL()))contents.send('pc-voice:state',state);
      refreshTrayMenu();
    },
    onRevoke:()=>{clearTrayIntent();refreshTrayMenu();},
    onDiagnostic:(phase,reason)=>voiceDiagnostics.record(phase,reason),
    onStop:()=>{if(!contents.isDestroyed()&&trustedSite(contents.getURL()))contents.send('pc-voice:request',{action:'stop'});return stopWebVoice();}
  });
  const revokeAndStop=()=>{const enabled=pcVoice.state().enabled;pcVoice.stop();return enabled?pcVoice.waitForStop():stopWebVoice();};
  const unbindDesktopVoice=process.platform==='win32'?bindDesktopVoice({
    ipcMain,contents,host:pcVoice,micAllowed:()=>micAllowed,
    authorizeStart:async()=>{
      if(!trustedSite(contents.getURL())){voiceDiagnostics.record('stopped','native_start_denied');return false;}
      const intent=validTrayIntent()?{allowed:true,allowHiddenStart:true,expiresAt:trayIntent.expiresAt,beganAt:trayIntent.beganAt}:null;
      if(!intent&&(!win.isVisible()||win.isMinimized()||!freshInput())){voiceDiagnostics.record('stopped','native_start_denied');return false;}
      const {response}=await showDialogPreservingWindowState(dialog,win,{type:'question',title:'PC voice control',message:'Let Ava operate this PC while listening?',detail:'Ava can open installed apps and websites, move windows, and read or interact with visible controls in the windows you ask about. Your spoken request and the needed app, window and page information are sent to the existing AI service. Sensitive actions ask for confirmation. Stop PC voice to revoke control. Normal voice chat stays separate.',buttons:['Enable PC voice','Cancel'],defaultId:1,cancelId:1,noLink:true});
      const approved=response===0&&(intent?validTrayIntent():win.isVisible()&&!win.isMinimized());
      if(!approved){voiceDiagnostics.record('stopped','native_start_denied');return false;}
      if(intent){clearTrayIntent();return intent;}return true;
    },
    onStartGesture:approval=>{lastInput=Date.now();pcStartAt=approval?.beganAt||Date.now();}
  }):()=>{};
  const trayVoiceStarter=createTrayVoiceStarter({
    beginIntent:()=>{clearTrayIntent();lastInput=Date.now();trayIntent={generation:pcVoice.generation(),frame:contents.mainFrame,beganAt:Date.now(),expiresAt:Date.now()+30000};trayIntentTimer=setTimeout(()=>{if(trayIntent)pcVoice.stop('PC voice setup timed out.','setup_timeout');},30000);voiceDiagnostics.record('tray_start');updateBackgroundPolicy();refreshTrayMenu();},
    ready:async()=>trustedSite(contents.getURL())&&await contents.executeJavaScript("!!(window.__synapsesDesktopVoiceHookVersion===1&&window.synapsesDesktopVoiceClient&&window.synapsesDesktopVoiceClient.version===1)",false),
    startClient:()=>startClientFromNativeGesture(contents),
    requestReload:async()=>{voiceDiagnostics.record('stopped','hook_missing');const {response}=await showDialogPreservingWindowState(dialog,win,{type:'info',title:'Refresh Synapses',message:'Refresh Synapses to enable PC voice control.',detail:'This page has an older voice connection. Reload it before starting.',buttons:['Reload','Cancel'],defaultId:1,cancelId:1,noLink:true});if(response===0)await contents.loadURL(START_URL);},
    failed:()=>{pcVoice.stop('PC voice could not start.','tray_start_failed');if(tray&&!tray.isDestroyed())tray.displayBalloon({iconType:'info',title:'PC voice did not start',content:'Open Synapses to sign in or check microphone access, then try again.'});},
    finishAttempt:()=>{if(!pcVoice.state().enabled)clearTrayIntent();refreshTrayMenu();}
  });
  async function startPcVoiceFromTray(){
    return trayVoiceStarter.start();
  }
  lifecycle = createTrayLifecycle({
    stopVoice:()=>pcVoice.active()||pcVoice.startingHidden()?Promise.resolve(true):revokeAndStop(),
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
  async function reportVoiceRuntime(){
    let raw=null;
    if(!contents.isDestroyed()&&trustedSite(contents.getURL()))raw=await contents.executeJavaScript(RUNTIME_EXPRESSION,false).catch(()=>null);
    writeRuntimeReport(raw,pcVoice.state());
  }
  desktopRuntime = { lifecycle, tray, trayMenu, pcVoice,reportVoiceRuntime };
  voiceDiagnostics.record('idle');
  win.on('minimize',()=>{if(!pcVoice.active()&&!pcVoice.startingHidden())void revokeAndStop();});
  win.on('close',event=>{
    if(contents.isDestroyed())return;
    event.preventDefault();
    if(lifecycle.isQuitting())void lifecycle.quit();else void lifecycle.hide();
  });
  contents.on('will-prevent-unload',event=>{
    const answer=dialog.showMessageBoxSync(win,{type:'question',message:'Leave Synapses?',detail:'There may be unsaved work.',buttons:['Stay','Close'],defaultId:0,cancelId:0,noLink:true});
    if(answer===1)event.preventDefault();else lifecycle.cancelQuit();
  });
  contents.on('destroyed',()=>{pcVoice.stop('PC voice is stopped.','window_closed');if(!win.isDestroyed())win.destroy();});
  win.on('closed',()=>{taskRunner.cancel();windowsActions.cancel?.();browserActions.close();clearTrayIntent();unbindWindowControls();unbindDesktopVoice();if(!tray.isDestroyed())tray.destroy();if(!contents.isDestroyed())contents.close();mainWindow=null;desktopRuntime=null;});
  const documentGate=createDocumentGate({showSurface:()=>{if(trustedSite(contents.getURL()))site.setVisible(true);},hideSurface:()=>site.setVisible(false),onOptionalError:()=>console.warn('PC voice client is unavailable on this page.')});
  contents.on('did-start-navigation',(event,_url,_inPlace,isMainFrame)=>{
    if(newMainDocument(event,_inPlace,isMainFrame)){pcVoice.stop('PC voice stopped because the page changed.','page_changed');documentGate.reset();}
  });
  contents.on('dom-ready',()=>{
    if(trustedSite(contents.getURL()))documentGate.prepare(contents.insertCSS(remoteShellCss,{cssOrigin:'user'}),()=>{
      if(process.platform==='win32'&&trustedSite(contents.getURL()))return contents.executeJavaScript(fs.readFileSync(path.join(__dirname,'desktop-voice-client.js'),'utf8'),false);
    });
  });
  contents.on('did-finish-load',()=>{void documentGate.finish();});
  contents.on('did-fail-load',(_event,code,_description,_url,isMain)=>{if(isMain&&code!==-3)site.setVisible(false);});
  contents.on('render-process-gone',()=>{pcVoice.stop('PC voice stopped because the page closed.','renderer_gone');site.setVisible(false);});
  await win.loadURL(CHROME_URL);
  await contents.loadURL(START_URL).catch(()=>{});
  if(pendingRuntimeReport){pendingRuntimeReport=false;await reportVoiceRuntime();}
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
  const diagnostic=JSON.parse(fs.readFileSync(path.join(app.getPath('userData'),'pc-voice-status.json'),'utf8'));
  if(Object.keys(diagnostic).sort().join(',')!=='enabled,listening,phase,stopReasonCode,time,version'||diagnostic.version!==app.getVersion())throw Error('Voice diagnostic schema smoke failed');
  evidence.voiceDiagnostics={version:diagnostic.version,fields:Object.keys(diagnostic).sort()};
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
  const reportPath=path.join(app.getPath('userData'),'pc-voice-runtime.json');
  const beforeReport={visible:win.isVisible(),minimized:win.isMinimized(),focused:win.isFocused()};
  const reportArgs=[...(app.isPackaged?[]:[app.getAppPath()]),'--smoke-test','--pc-voice-report'];
  await new Promise((resolve,reject)=>{const child=require('node:child_process').spawn(process.execPath,reportArgs,{env:process.env,windowsHide:true,stdio:'ignore'});const timeout=setTimeout(()=>{child.kill();reject(Error('Report second-instance timed out'));},5000);child.once('error',error=>{clearTimeout(timeout);reject(error);});child.once('exit',()=>{clearTimeout(timeout);resolve();});});
  for(let retry=0;retry<30&&!fs.existsSync(reportPath);retry++)await new Promise(resolve=>setTimeout(resolve,100));
  const report=JSON.parse(fs.readFileSync(reportPath,'utf8'));
  const windowUnchanged=beforeReport.visible===win.isVisible()&&beforeReport.minimized===win.isMinimized()&&beforeReport.focused===win.isFocused();
  if(!windowUnchanged||report.version!==app.getVersion()||report.hostEnabled!==false)throw Error('Read-only voice report smoke failed');
  evidence.runtimeReport={written:true,windowUnchanged};
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
