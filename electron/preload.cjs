const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  aiChat: (payload) => ipcRenderer.invoke('ai:chat', payload),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('app:setAutoLaunch', enabled),
  getAutoLaunch: () => ipcRenderer.invoke('app:getAutoLaunch'),
  printToPDF: (html) => ipcRenderer.invoke('app:printToPDF', html),
  setSpellCheckerLanguages: (langs) => ipcRenderer.invoke('app:setSpellCheckerLanguages', langs),
  onQuickCapture: (cb) => { ipcRenderer.on('quick-capture', cb); return () => ipcRenderer.removeListener('quick-capture', cb); },
  onUpdateAvailable: (cb) => { ipcRenderer.on('update-available', (_e, v) => cb(v)); return () => ipcRenderer.removeListener('update-available', cb); },
  onCollabJoin: (cb) => { const handler = (_e, code) => cb(code); ipcRenderer.on('collab-join', handler); return () => ipcRenderer.removeListener('collab-join', handler); },
});

// minimal DOM ready marker
window.addEventListener('DOMContentLoaded', () => {});
