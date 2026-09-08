const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('callpilot', {
  platformInfo: () => ipcRenderer.invoke('platform-info'),
  setExpanded: (value) => ipcRenderer.send('set-overlay-expanded', value),
  hide: () => ipcRenderer.send('hide-overlay'),
  onMode: (callback) => ipcRenderer.on('overlay-mode', (_event, payload) => callback(payload))
});
