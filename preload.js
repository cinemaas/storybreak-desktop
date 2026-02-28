const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('storybreakNative', {
  platform: process.platform,
  isElectron: true,
  version: require('./package.json').version,
  openOAuth: (url) => ipcRenderer.send('oauth-url', url),
});
