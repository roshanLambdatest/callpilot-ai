const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('captureIPC', {
  ended: (reason) => ipcRenderer.send('capture-ended', reason),
  error: (message) => ipcRenderer.send('capture-error', message)
});
