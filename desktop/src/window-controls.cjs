'use strict';
const { trustedSite, chromeSender } = require('./policy.cjs');

function bindWindowControls(ipcMain, win, siteContents, chromeUrl) {
  const actions = [
    ['window:minimize', () => win.minimize()],
    ['window:toggle-maximize', () => win.isMaximized() ? win.unmaximize() : win.maximize()],
    ['window:close', () => win.close()],
    ['site:toggle-navigation', () => trustedSite(siteContents.getURL())
      ? siteContents.executeJavaScript("(()=>{const mark=document.getElementById('bnavLogoMark');if(!mark)return false;mark.click();return true;})()", false)
      : false]
  ];
  for (const [channel, action] of actions) {
    ipcMain.handle(channel, event => {
      if (!chromeSender(event, win.webContents, chromeUrl)) throw new Error('Untrusted window control sender');
      return action();
    });
  }
  return () => { for (const [channel] of actions) ipcMain.removeHandler(channel); };
}
module.exports = { bindWindowControls };
