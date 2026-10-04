const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zoomComp', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  start: () => ipcRenderer.invoke('companion:start'),
  stop: () => ipcRenderer.invoke('companion:stop'),
  ask: (text) => ipcRenderer.invoke('companion:ask', text),
  sendAudio: (arrayBuffer) => ipcRenderer.send('companion:audio', arrayBuffer),
  setAlwaysOnTop: (enabled) => ipcRenderer.invoke('window:always-on-top', enabled),
  setCompact: (compact) => ipcRenderer.invoke('window:compact', compact),
  onEvent: (handler) => {
    const listener = (_event, value) => handler(value);
    ipcRenderer.on('companion:event', listener);
    return () => ipcRenderer.removeListener('companion:event', listener);
  },
  onShortcutToggle: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('companion:shortcut-toggle', listener);
    return () => ipcRenderer.removeListener('companion:shortcut-toggle', listener);
  }
});
