'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('synapsesWindow', Object.freeze({
  minimize: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  onState: callback => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('window:state', (_event, state) => callback({ maximized: state.maximized === true }));
  }
}));
