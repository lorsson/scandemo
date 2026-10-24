'use strict';

// 预加载脚本：渲染进程只能看到这里明确暴露的几个函数。
// sandbox + contextIsolation 下，preload 仍然可以 require('electron') 拿到
// contextBridge / ipcRenderer / webUtils。

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('imagecore', {
  version: () => ipcRenderer.invoke('version'),
  pickFile: () => ipcRenderer.invoke('pick-file'),
  openFile: (filePath) => ipcRenderer.invoke('open', filePath),
  process: (options) => ipcRenderer.invoke('process', options),
  saveAs: (options) => ipcRenderer.invoke('save-as', options),
  reveal: (filePath) => ipcRenderer.invoke('reveal', filePath),

  // sandbox 下 webUtils 是否可用（不可用时界面给出降级提示）
  dragDropReady: typeof webUtils?.getPathForFile === 'function',

  // 拖拽进来的 File 对象没有 .path 了（Electron 32 起移除），改用官方 webUtils。
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },

  onInitialFile: (handler) => {
    ipcRenderer.on('initial-file', (_event, filePath, filter) => handler(filePath, filter));
  },

  // 截图模式用：通知主进程预览已经画出来
  previewReady: (info) => ipcRenderer.send('preview-ready', info),
});
