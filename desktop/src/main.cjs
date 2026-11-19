'use strict';
const { app, BrowserWindow, WebContentsView, Menu, dialog, ipcMain, protocol, net, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { trustedSite, externalLink, audioRequest, downloadLink, newMainDocument } = require('./policy.cjs');
const { bindWindowControls } = require('./window-controls.cjs');

const CHROME_URL = 'synapses-shell://app/index.html';
const START_URL = 'https://synapses.cloud/';
const BAR_HEIGHT = 32;
const remoteShellCss = fs.readFileSync(path.join(__dirname,'remote-shell.css'),'utf8');
const smoke = process.argv.includes('--smoke-test');
const smokeDir = smoke ? path.resolve(process.env.SYNAPSES_SMOKE_DIR || path.join(app.getPath('temp'),'synapses-desktop-smoke')) : null;
let mainWindow;
protocol.registerSchemesAsPrivileged([{ scheme:'synapses-shell', privileges:{ standard:true, secure:true, supportFetchAPI:true } }]);
app.enableSandbox();
app.setName('Synapses');
app.setAppUserModelId('cloud.synapses.desktop');
if (smoke) { fs.mkdirSync(smokeDir,{recursive:true}); app.setPath('userData', path.join(smokeDir,'profile')); }
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if(mainWindow){ if(mainWindow.isMinimized())mainWindow.restore(); mainWindow.focus(); } });
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
  const site = new WebContentsView({webPreferences:{session:siteSession, nodeIntegration:false, contextIsolation:true, sandbox:true, devTools:false, webSecurity:true, allowRunningInsecureContent:false}});
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

  let lastInput = 0, micAllowed = false, pendingMic = false, closing = false;
  const freshInput = () => Date.now()-lastInput < 5000 && !win.isMinimized();
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
    if(requester!==contents||permission!=='media'||!audioRequest(contents.getURL(),details)||!freshInput()||pendingMic){callback(false);return;}
    if(micAllowed){callback(true);return;}
    pendingMic=true;
    try {
      const {response}=await dialog.showMessageBox(win,{type:'question',title:'Synapses microphone',message:'Allow Synapses to use your microphone?',detail:'Only synapses.cloud can use this permission for voice features in this app.',buttons:['Allow microphone','Cancel'],defaultId:1,cancelId:1,noLink:true});
      micAllowed=response===0&&!contents.isDestroyed()&&audioRequest(contents.getURL(),details)&&!win.isMinimized();
      callback(micAllowed);
    } catch {callback(false);} finally {pendingMic=false;}
  });
  siteSession.setDisplayMediaRequestHandler((_request,callback)=>callback(null));
  siteSession.setDevicePermissionHandler(()=>false);
  siteSession.on('will-download',(event,item)=>{if(!trustedSite(contents.getURL())||!freshInput()||!downloadLink(item.getURL()))event.preventDefault();});
  const stopVoice = () => trustedSite(contents.getURL())&&!contents.isDestroyed()
    ? contents.executeJavaScript("(()=>{if(typeof window.stopTopNavVoice==='function')window.stopTopNavVoice();else if(typeof window.avaFloatingStopVoice==='function')window.avaFloatingStopVoice();})()",false).catch(()=>{}) : Promise.resolve();
  win.on('minimize',()=>{void stopVoice();});
  win.on('close',event=>{
    if(contents.isDestroyed())return;
    event.preventDefault(); if(closing)return; closing=true;
    Promise.race([stopVoice(),new Promise(resolve=>setTimeout(resolve,400))]).then(()=>contents.close({waitForBeforeUnload:true}));
  });
  contents.on('will-prevent-unload',event=>{
    const answer=dialog.showMessageBoxSync(win,{type:'question',message:'Leave Synapses?',detail:'There may be unsaved work.',buttons:['Stay','Close'],defaultId:0,cancelId:0,noLink:true});
    if(answer===1)event.preventDefault();else closing=false;
  });
  contents.on('destroyed',()=>{if(!win.isDestroyed())win.destroy();});
  win.on('closed',()=>{unbindWindowControls(); if(!contents.isDestroyed())contents.close(); mainWindow=null;});
  let inputStylesReady = Promise.resolve(false);
  contents.on('did-start-navigation',(event,_url,_inPlace,isMainFrame)=>{
    if(newMainDocument(event,_inPlace,isMainFrame)){site.setVisible(false);inputStylesReady=Promise.resolve(false);}
  });
  contents.on('dom-ready',()=>{
    inputStylesReady = trustedSite(contents.getURL())
      ? contents.insertCSS(remoteShellCss,{cssOrigin:'user'}).then(()=>true).catch(()=>false)
      : Promise.resolve(false);
  });
  contents.on('did-finish-load',async()=>{
    const documentUrl=contents.getURL();
    if(trustedSite(documentUrl)&&(await inputStylesReady)&&contents.getURL()===documentUrl)site.setVisible(true);
  });
  contents.on('did-fail-load',(_event,code,_description,_url,isMain)=>{if(isMain&&code!==-3)site.setVisible(false);});
  contents.on('render-process-gone',()=>site.setVisible(false));
  await win.loadURL(CHROME_URL);
  await contents.loadURL(START_URL).catch(()=>{});
  if(smoke) await smokeTest(win,site);
}

async function smokeTest(win,site) {
  await new Promise(resolve=>setTimeout(resolve,100));
  const visibleBeforeHash = site.getVisible();
  await site.webContents.executeJavaScript("location.hash='desktop-shell-smoke'");
  await new Promise(resolve=>setTimeout(resolve,100));
  const visibleAfterHash = site.getVisible();
  const chrome=await win.webContents.executeJavaScript("({buttons:[...document.querySelectorAll('button')].map(x=>x.getAttribute('aria-label')),bridge:typeof window.synapsesWindow,require:typeof require})");
  const remote=await site.webContents.executeJavaScript("({url:location.href,title:document.title,require:typeof require,process:typeof process,bridge:typeof window.synapsesWindow})");
  const prefs=site.webContents.getLastWebPreferences();
  await win.webContents.executeJavaScript('window.synapsesWindow.toggleMaximize()');
  await new Promise(resolve=>setTimeout(resolve,150));
  const maximized=win.isMaximized();
  await win.webContents.executeJavaScript('window.synapsesWindow.toggleMaximize()');
  await new Promise(resolve=>setTimeout(resolve,150));
  const restored=!win.isMaximized();
  const evidence={chrome,remote,controls:{maximized,restored},navigation:{visibleBeforeHash,visibleAfterHash},bounds:site.getBounds(),sandbox:prefs.sandbox,contextIsolation:prefs.contextIsolation,nodeIntegration:prefs.nodeIntegration,remotePreload:prefs.preload||null};
  if(!trustedSite(remote.url)||remote.require!=='undefined'||remote.process!=='undefined'||remote.bridge!=='undefined'||chrome.buttons.length!==4||!maximized||!restored||!visibleBeforeHash||!visibleAfterHash||!prefs.sandbox||!prefs.contextIsolation||prefs.nodeIntegration||prefs.preload)throw new Error('Desktop isolation smoke test failed');
  fs.mkdirSync(smokeDir,{recursive:true});
  fs.writeFileSync(path.join(smokeDir,'smoke.json'),JSON.stringify(evidence,null,2));
  fs.writeFileSync(path.join(smokeDir,'window.png'),(await win.capturePage()).toPNG());
  fs.writeFileSync(path.join(smokeDir,'site.png'),(await site.webContents.capturePage()).toPNG());
  console.log('SMOKE PASS',JSON.stringify(evidence));
  await win.webContents.executeJavaScript('window.synapsesWindow.close()').catch(()=>{});
}
