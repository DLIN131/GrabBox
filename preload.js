// 頁面不能直接碰檔案和網路，透過這裡呼叫主程序
const { contextBridge, ipcRenderer, webUtils } = require('electron')

const on = (ch) => (fn) => ipcRenderer.on(ch, (_e, d) => fn(d))

contextBridge.exposeInMainWorld('gb', {
  jobs: {
    list: () => ipcRenderer.invoke('jobs:list'),
    pause: (id) => ipcRenderer.invoke('jobs:pause', id),
    resume: (id) => ipcRenderer.invoke('jobs:resume', id),
    remove: (id, del) => ipcRenderer.invoke('jobs:remove', id, del),
    pauseAll: () => ipcRenderer.invoke('jobs:pauseAll'),
    resumeAll: () => ipcRenderer.invoke('jobs:resumeAll'),
    clearDone: () => ipcRenderer.invoke('jobs:clearDone'),
    open: (id) => ipcRenderer.invoke('jobs:open', id),
    show: (id) => ipcRenderer.invoke('jobs:show', id),
    copyUrl: (id) => ipcRenderer.invoke('jobs:copyUrl', id),
    onUpdate: on('jobs:update'),
    onRemoved: on('jobs:removed'),
    onTick: on('jobs:tick'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (p) => ipcRenderer.invoke('settings:set', p),
    chooseDir: () => ipcRenderer.invoke('settings:chooseDir'),
    chooseFile: () => ipcRenderer.invoke('settings:chooseFile'),
    ytdlpInfo: () => ipcRenderer.invoke('settings:ytdlpInfo'),
    ytdlpUpdate: () => ipcRenderer.invoke('settings:ytdlpUpdate'),
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    newUrl: (url) => ipcRenderer.invoke('app:newUrl', url),
    openTorrent: () => ipcRenderer.invoke('app:openTorrent'),
    dropFiles: (files) => ipcRenderer.invoke('app:dropFiles', [...files].map((f) => webUtils.getPathForFile(f))),
    setMagnet: () => ipcRenderer.invoke('app:setMagnet'),
    extensionDir: () => ipcRenderer.invoke('app:extensionDir'),
  },
  add: {
    init: (id) => ipcRenderer.invoke('add:init', id),
    probe: (id, url) => ipcRenderer.invoke('add:probe', id, url),
    confirm: (id, spec) => ipcRenderer.invoke('add:confirm', id, spec),
    onStatus: on('add:status'),
  },
})
