'use strict';
const path = require('node:path');
const { chromeSender } = require('./policy.cjs');

const PC_COMMAND_URL = 'synapses-shell://app/pc-command.html';
const PC_COMMAND_ROUTES = Object.freeze(['/pc-command.html', '/pc-command.css', '/pc-command.js']);
const RUN = 'pc-command:run';
const CANCEL = 'pc-command:cancel';
const PROGRESS = 'pc-command:progress';
const canceled = { ok: false, message: 'Command canceled.' };
const progressMessages = new Map([
  ['planning', 'Understanding your command…'],
  ['thinking', 'Understanding your command…'],
  ['observing', 'Checking your PC…'],
  ['running-tool', 'Working on your PC…'],
  ['acting', 'Working on your PC…']
]);

function createPcCommandWindow({ BrowserWindow, ipcMain, icon, run, cancel }) {
  let popup = null;
  let ready = false;
  let pending = null;
  let disposed = false;

  function checkedWindow(event) {
    if (disposed || !popup || popup.isDestroyed() || popup.webContents.isDestroyed() ||
        !chromeSender(event, popup.webContents, PC_COMMAND_URL)) {
      throw new Error('Untrusted PC command sender.');
    }
    return popup;
  }

  function endSession() {
    try { cancel(); } catch {}
  }

  function cancelPending(win) {
    if (pending?.win !== win || pending.canceled) return false;
    pending.canceled = true;
    endSession();
    return true;
  }

  function setProgress(phase) {
    const message = progressMessages.get(phase);
    if (!pending || pending.canceled || !message) return;
    const contents = pending.win.webContents;
    if (!contents.isDestroyed()) contents.send(PROGRESS, message);
  }

  ipcMain.handle(RUN, async (event, value) => {
    const win = checkedWindow(event);
    if (!win.isVisible() || win.isMinimized()) return { ok: false, message: 'Open this window to run a PC command.' };
    const command = typeof value === 'string' ? value.trim() : '';
    if (!command || command.length > 1000 || /[\u0000-\u001f\u007f]/.test(command)) {
      return { ok: false, message: 'Enter a PC command of up to 1,000 characters on one line.' };
    }
    if (pending) return { ok: false, message: 'A PC command is already running.' };
    const task = pending = { win, canceled: false };
    try {
      const result = await run(command);
      if (task.canceled) return canceled;
      return {
        ok: result?.ok === true,
        message: typeof result?.message === 'string' && result.message.trim()
          ? result.message.trim().slice(0, 500)
          : 'Try a PC command such as “Open YouTube”.'
      };
    } catch {
      return task.canceled ? canceled : { ok: false, message: 'The PC command could not finish. Try again.' };
    } finally {
      if (pending === task) pending = null;
    }
  });
  ipcMain.handle(CANCEL, event => cancelPending(checkedWindow(event)));

  function reveal(win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  function open() {
    if (disposed) return null;
    if (popup && !popup.isDestroyed()) {
      if (ready) reveal(popup);
      return popup;
    }
    ready = false;
    const win = popup = new BrowserWindow({
      width: 456, height: 250, minWidth: 340, minHeight: 205, useContentSize: true,
      show: false, maximizable: false, fullscreenable: false, autoHideMenuBar: true,
      title: 'Synapses · PC command', icon, backgroundColor: '#0c0c0e',
      webPreferences: {
        preload: path.join(__dirname, 'pc-command-preload.cjs'), nodeIntegration: false,
        contextIsolation: true, sandbox: true, devTools: false, spellcheck: false
      }
    });
    const contents = win.webContents;
    contents.on('will-frame-navigate', event => event.preventDefault());
    contents.on('will-navigate', event => event.preventDefault());
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.once('render-process-gone', () => { if (!win.isDestroyed()) win.destroy(); });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.key !== 'Escape' || input.isAutoRepeat) return;
      event.preventDefault();
      if (!cancelPending(win)) win.close();
    });
    win.once('ready-to-show', () => {
      if (popup !== win || win.isDestroyed()) return;
      ready = true;
      reveal(win);
    });
    win.once('closed', () => {
      if (pending?.win === win) cancelPending(win);
      else endSession();
      if (popup === win) {
        popup = null;
        ready = false;
      }
    });
    void win.loadURL(PC_COMMAND_URL).catch(() => { if (!win.isDestroyed()) win.destroy(); });
    return win;
  }

  function dialogParent() {
    return popup && !popup.isDestroyed() && popup.isVisible() && !popup.isMinimized() ? popup : null;
  }

  function close() {
    if (popup && !popup.isDestroyed()) popup.close();
  }

  function destroy() {
    if (disposed) return;
    disposed = true;
    ipcMain.removeHandler(RUN);
    ipcMain.removeHandler(CANCEL);
    if (popup && !popup.isDestroyed()) popup.destroy();
  }

  return { open, close, destroy, dialogParent, setProgress };
}

module.exports = { createPcCommandWindow, PC_COMMAND_URL, PC_COMMAND_ROUTES };
