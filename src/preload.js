const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('tonix', {
  engineInfo: () => ipcRenderer.invoke('engine:info'),
  restartEngine: () => ipcRenderer.invoke('engine:restart'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  saveHotkeys: (map) => ipcRenderer.invoke('hotkeys:save', map),
  getDestination: () => ipcRenderer.invoke('dest:get'),
  saveDestination: (d) => ipcRenderer.invoke('dest:save', d),
  pickFolder: (current) => ipcRenderer.invoke('dialog:folder', current),
  setLive: (live) => ipcRenderer.send('state:live', live),
  filePath: (file) => webUtils.getPathForFile(file),
  onEngineStatus: (cb) => {
    const handler = (_e, s) => cb(s);
    ipcRenderer.on('engine:status', handler);
    return () => ipcRenderer.removeListener('engine:status', handler);
  },
  onHotkey: (cb) => {
    const handler = (_e, action) => cb(action);
    ipcRenderer.on('hotkey', handler);
    return () => ipcRenderer.removeListener('hotkey', handler);
  }
});
