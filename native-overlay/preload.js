const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('callpilot', {
  platformInfo: () => ipcRenderer.invoke('platform-info'),
  setExpanded: (value) => ipcRenderer.send('set-overlay-expanded', value),
  hide: () => ipcRenderer.send('hide-overlay'),
  dragBy: (dx, dy) => ipcRenderer.send('drag-overlay', { dx, dy }),
  onMode: (callback) => ipcRenderer.on('overlay-mode', (_event, payload) => callback(payload)),
  getCallStatus: () => ipcRenderer.invoke('get-call-status'),
  onCallStatus: (callback) => ipcRenderer.on('call-status', (_event, payload) => callback(payload)),
  apiConfig: () => ipcRenderer.invoke('get-api-config'),
  getPermissions: () => ipcRenderer.invoke('get-permissions'),
  requestPermission: (kind) => ipcRenderer.invoke('request-permission', kind)
});
