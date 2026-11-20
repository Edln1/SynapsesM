'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('synapsesPcCommand', Object.freeze({
  run: text => ipcRenderer.invoke('pc-command:run', text),
  cancel: () => ipcRenderer.invoke('pc-command:cancel'),
  onProgress: callback => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('pc-command:progress', (_event, message) => {
      if (typeof message === 'string') callback(message);
    });
  }
}));
