const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('storybreakNative', {
  platform: process.platform,
  isElectron: true,
  version: require('./package.json').version,
});
