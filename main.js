const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, nativeImage, clipboard } = require('electron')
const path = require('path')
const fs = require('original-fs')
const crypto = require('crypto')
const manager = require('./lib/manager')
const server = require('./lib/server')
const util = require('./lib/util')
const updater = require('./lib/updater')

app.setAppUserModelId('GrabBox')

// 指定資料夾（測試或可攜用）：資料存在別處、不搶系統的協定關聯。一定要在單一實例鎖之前設定
const separateData = process.env.GRABBOX_USER_DATA || ''
if (separateData) app.setPath('userData', separateData)

// 同時只開一份：再開一次（例如點了磁力連結）就交給原本那份處理
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    if (!handleArgv(argv)) showMain()
  })
}

// grabbox:// 讓擴充功能在程式沒開時可以叫醒它
if (separateData) {
  // 不註冊
} else if (process.defaultApp) app.setAsDefaultProtocolClient('grabbox', process.execPath, [path.resolve(process.argv[1])])
else app.setAsDefaultProtocolClient('grabbox')

const ICON = path.join(__dirname, 'src', 'icon.png')
let mainWin = null
let tray = null
let quitting = false
const pending = new Map() // 新增視窗 id → { req, ctrl, win }

function createMain(show) {
  mainWin = new BrowserWindow({
    width: 1100,
    height: 680,
    minWidth: 760,
    minHeight: 420,
    show: false,
    backgroundColor: '#111318',
    title: 'GrabBox',
    autoHideMenuBar: true,
    icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  mainWin.removeMenu()
  mainWin.loadFile(path.join(__dirname, 'src', 'index.html'))
  if (show) mainWin.once('ready-to-show', () => mainWin.show())
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWin.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      mainWin.webContents.toggleDevTools()
      e.preventDefault()
    }
  })
  mainWin.on('close', (e) => {
    if (!quitting && manager.getSettings().closeToTray) {
      e.preventDefault()
      mainWin.hide()
    }
  })
  mainWin.on('closed', () => (mainWin = null))
}

function showMain() {
  if (!mainWin) createMain(true)
  if (mainWin.isMinimized()) mainWin.restore()
  mainWin.show()
  mainWin.focus()
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }))
  tray.setToolTip('GrabBox')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '開啟 GrabBox', click: showMain },
      { label: '新增網址…', click: () => openAdd({ url: clipboardUrl() }) },
      { type: 'separator' },
      { label: '全部繼續', click: () => manager.resumeAll() },
      { label: '全部暫停', click: () => manager.pauseAll() },
      { type: 'separator' },
      { label: '結束', click: quit },
    ]),
  )
  tray.on('click', showMain)
}

function quit() {
  quitting = true
  app.quit()
}

/** 剪貼簿裡如果是網址或磁力連結就直接帶進新增視窗 */
function clipboardUrl() {
  const t = clipboard.readText().trim()
  return /^(https?:\/\/|magnet:\?)\S+$/i.test(t) ? t : ''
}

// ───────────────────────────── 新增下載視窗 ─────────────────────────────

/**
 * req = { url, headers, title, torrentFile, kind, fromBrowser }
 * 從瀏覽器送來時也是開這個視窗（像 IDM 的「下載檔案資訊」）
 */
function openAdd(req) {
  const id = crypto.randomUUID()
  const win = new BrowserWindow({
    width: 640,
    height: 560,
    minWidth: 520,
    minHeight: 380,
    show: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    backgroundColor: '#111318',
    title: '新增下載',
    autoHideMenuBar: true,
    icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  win.removeMenu()
  pending.set(id, { req, ctrl: new AbortController(), win })
  win.loadFile(path.join(__dirname, 'src', 'add.html'), { query: { id } })
  win.once('ready-to-show', () => {
    win.show()
    win.moveTop()
    win.focus()
  })
  // 跳出來時置頂，使用者切到別的視窗後就不再擋著
  win.on('blur', () => !win.isDestroyed() && win.setAlwaysOnTop(false))
  win.on('closed', () => {
    pending.get(id)?.ctrl.abort()
    pending.delete(id)
  })
}

function headersFrom(item) {
  const h = {}
  if (item.referer) h.Referer = item.referer
  if (item.origin) h.Origin = item.origin
  if (item.cookie) h.Cookie = item.cookie
  if (item.ua) h['User-Agent'] = item.ua
  return h
}

/** 擴充功能送來的東西 */
async function onBrowserAdd(items) {
  const s = manager.getSettings()
  for (const it of items.slice(0, 5)) {
    const req = { url: it.url, headers: headersFrom(it), title: it.title || '', kind: it.kind || '', fromBrowser: true }
    if (s.askOnBrowser || /^magnet:/i.test(it.url) || /\.torrent($|\?)/i.test(it.url)) openAdd(req)
    else quickAdd(req)
  }
  return { queued: items.length }
}

/** 不跳視窗直接下載（設定裡關掉「先確認」時） */
async function quickAdd(req) {
  try {
    const info = await manager.probe(req)
    if (info.kind === 'torrent') return openAdd(req)
    const v = info.variants?.[0]
    const c = info.choices?.[0]
    manager.add({
      kind: info.kind,
      url: info.kind === 'ytdlp' ? info.url : req.url,
      headers: req.headers,
      name: info.name,
      tracks: v ? [{ url: v.url, type: 'video' }, ...(v.audioUrl ? [{ url: v.audioUrl, type: 'audio' }] : [])] : null,
      format: c?.id,
      ext: c?.ext,
      total: c?.size || info.size || -1,
    })
  } catch (e) {
    new Notification({ title: '無法下載', body: e.message, icon: ICON }).show()
  }
}

/** 命令列參數：磁力連結、.torrent 檔、grabbox:// */
function handleArgv(argv) {
  let handled = false
  for (const a of argv.slice(1)) {
    if (/^magnet:\?/i.test(a)) {
      openAdd({ url: a })
      handled = true
    } else if (/\.torrent$/i.test(a) && fs.existsSync(a)) {
      openAdd({ torrentFile: a })
      handled = true
    } else if (/^grabbox:/i.test(a)) {
      handled = true
    }
  }
  return handled
}

// ───────────────────────────── IPC ─────────────────────────────

function setupIpc() {
  ipcMain.handle('jobs:list', () => manager.list())
  ipcMain.handle('jobs:pause', (_e, id) => manager.pause(id))
  ipcMain.handle('jobs:resume', (_e, id) => manager.resume(id))
  ipcMain.handle('jobs:remove', (_e, id, del) => manager.remove(id, del))
  ipcMain.handle('jobs:pauseAll', () => manager.pauseAll())
  ipcMain.handle('jobs:resumeAll', () => manager.resumeAll())
  ipcMain.handle('jobs:clearDone', () => manager.clearDone())
  ipcMain.handle('jobs:open', (_e, id) => {
    const j = manager.find(id)
    if (j?.file && fs.existsSync(j.file)) return shell.openPath(j.file)
    return '檔案不存在'
  })
  ipcMain.handle('jobs:show', (_e, id) => {
    const j = manager.find(id)
    if (!j) return
    if (j.file && fs.existsSync(j.file)) shell.showItemInFolder(j.file)
    else shell.openPath(j.dir)
  })
  ipcMain.handle('jobs:copyUrl', (_e, id) => {
    const j = manager.find(id)
    if (j) clipboard.writeText(j.kind === 'torrent' ? j.magnet || (j.infoHash ? 'magnet:?xt=urn:btih:' + j.infoHash : '') : j.url)
  })

  ipcMain.handle('settings:get', () => manager.getSettings())
  ipcMain.handle('settings:set', (_e, patch) => manager.setSettings(patch))
  ipcMain.handle('settings:chooseDir', async (e) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? '' : r.filePaths[0]
  })
  ipcMain.handle('settings:chooseFile', async (e) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openFile'], filters: [{ name: '執行檔', extensions: ['exe'] }] })
    return r.canceled ? '' : r.filePaths[0]
  })

  ipcMain.handle('settings:ytdlpInfo', () => manager.ytdlpInfo())
  ipcMain.handle('settings:ytdlpUpdate', () => manager.ytdlpUpdate())

  ipcMain.handle('app:info', () => ({ version: app.getVersion(), port: server.port(), magnet: app.isDefaultProtocolClient('magnet') }))
  ipcMain.handle('app:newUrl', (_e, url) => openAdd({ url: url || clipboardUrl() }))
  ipcMain.handle('app:openTorrent', async () => {
    const r = await dialog.showOpenDialog(mainWin, { properties: ['openFile', 'multiSelections'], filters: [{ name: '種子檔', extensions: ['torrent'] }] })
    for (const f of r.filePaths || []) openAdd({ torrentFile: f })
  })
  ipcMain.handle('app:dropFiles', (_e, files) => {
    for (const f of files) if (/\.torrent$/i.test(f) && fs.existsSync(f)) openAdd({ torrentFile: f })
  })
  ipcMain.handle('app:setMagnet', () => {
    if (process.defaultApp) app.setAsDefaultProtocolClient('magnet', process.execPath, [path.resolve(process.argv[1])])
    else app.setAsDefaultProtocolClient('magnet')
    return app.isDefaultProtocolClient('magnet')
  })
  ipcMain.handle('app:extensionDir', () => {
    // 打包後擴充功能放在 GrabBox.exe 旁邊的 extension 資料夾
    const dir = app.isPackaged ? path.join(path.dirname(process.execPath), 'extension') : path.join(__dirname, 'extension')
    shell.openPath(dir)
    clipboard.writeText(dir)
    return dir
  })

  // 新增視窗
  ipcMain.handle('add:init', (_e, id) => {
    const p = pending.get(id)
    if (!p) return null
    return { req: { ...p.req, headers: undefined, hasCookie: !!p.req.headers?.Cookie }, settings: manager.getSettings() }
  })
  ipcMain.handle('add:probe', async (_e, id, url) => {
    const p = pending.get(id)
    if (!p) throw new Error('視窗已關閉')
    if (url && url !== p.req.url) p.req = { ...p.req, url, torrentFile: '', kind: '' }
    return manager.probe(p.req, p.ctrl.signal, (text) => !p.win.isDestroyed() && p.win.webContents.send('add:status', text))
  })
  ipcMain.handle('add:confirm', (_e, id, spec) => {
    const p = pending.get(id)
    if (!p) throw new Error('視窗已關閉')
    const job = manager.add({ ...spec, headers: p.req.headers || {} })
    p.win.close()
    return job
  })
}

// ───────────────────────────── 自動更新 ─────────────────────────────

let updateInfo = null
let notifiedVersion = ''

async function checkUpdate() {
  if (!updater.supported()) return { status: 'dev', current: app.getVersion() }
  try {
    updateInfo = await updater.check()
  } catch (e) {
    return { status: 'error', current: app.getVersion(), error: e.message }
  }
  return updateInfo ? { status: 'available', current: app.getVersion(), info: updateInfo } : { status: 'latest', current: app.getVersion() }
}

/**
 * 自動檢查：有新版就告訴主視窗；視窗收在系統匣時跳通知。
 * startup = 剛開啟程式：主視窗直接跳出更新視窗（之後定期檢查只在右下角提示，不打斷正在做的事）
 */
async function autoCheck(startup = false) {
  if (manager.getSettings().autoUpdate === false) return
  const r = await checkUpdate()
  if (r.status !== 'available') return
  if (mainWin && !mainWin.isDestroyed()) {
    // 主視窗還在載入就等它載入完，不然訊息會掉
    if (mainWin.webContents.isLoading()) await new Promise((res) => mainWin.webContents.once('did-finish-load', res))
    mainWin.webContents.send('update:available', { ...r.info, prompt: startup })
  }
  const visible = mainWin && !mainWin.isDestroyed() && mainWin.isVisible()
  if (!visible && notifiedVersion !== r.info.version && Notification.isSupported()) {
    notifiedVersion = r.info.version
    const n = new Notification({ title: `GrabBox 有新版本 v${r.info.version}`, body: '點這裡開啟 GrabBox 更新', icon: ICON })
    n.on('click', showMain)
    n.show()
  }
}

function setupUpdater() {
  // 上次更新留下的暫存（約 200 MB）。程式能啟動就代表已經裝完，清掉
  setTimeout(() => updater.cleanOld(), 3000)
  // 一開啟就檢查（等主視窗出來一下）
  setTimeout(() => autoCheck(true), 2500)
  setInterval(() => autoCheck(false), 6 * 3600 * 1000)
  ipcMain.handle('update:check', () => checkUpdate())
  ipcMain.handle('update:notes', (_e, v) => updater.notesFor(v))
  ipcMain.handle('update:lastFailure', () => updater.lastFailure())
  ipcMain.handle('update:prepare', async (e) => {
    if (!updateInfo) throw new Error('沒有可以更新的版本')
    await updater.prepare(updateInfo, (p) => !e.sender.isDestroyed() && e.sender.send('update:progress', p))
    return true
  })
  ipcMain.handle('update:install', () => {
    updater.install(() => {
      quitting = true
      app.quit()
    })
    return true
  })
}

function setupManagerEvents() {
  const toAll = (ch, data) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(ch, data)
  }
  manager.ev.on('update', (j) => mainWin && !mainWin.isDestroyed() && mainWin.webContents.send('jobs:update', j))
  manager.ev.on('removed', (id) => toAll('jobs:removed', id))
  manager.ev.on('tick', (s) => {
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.setProgressBar(s.active ? (s.progress >= 0 ? s.progress : 2) : -1)
      mainWin.webContents.send('jobs:tick', s)
    }
    tray?.setToolTip(s.active ? `GrabBox — 下載中 ${s.active} 個 · ${util.fmtBytes(s.speed)}/s` : 'GrabBox')
  })
  manager.ev.on('done', (j) => {
    if (!manager.getSettings().notify || !Notification.isSupported()) return
    const n = new Notification({ title: '下載完成', body: j.name, icon: ICON })
    n.on('click', () => (j.file && fs.existsSync(j.file) ? shell.showItemInFolder(j.file) : shell.openPath(j.dir)))
    n.show()
  })
}

app.whenReady().then(async () => {
  manager.init(app.getPath('userData'), path.join(app.getPath('downloads'), 'GrabBox'))
  setupIpc()
  setupManagerEvents()
  setupUpdater()
  const hidden = process.argv.includes('--hidden') || process.argv.some((a) => /^(grabbox|magnet):/i.test(a) || /\.torrent$/i.test(a))
  createMain(!hidden)
  createTray()
  await server.start({ version: app.getVersion(), onAdd: onBrowserAdd })
  handleArgv(process.argv)
})

app.on('window-all-closed', () => {
  if (quitting || !manager.getSettings().closeToTray) quit()
})

let shuttingDown = false
app.on('before-quit', (e) => {
  quitting = true
  if (shuttingDown) return
  e.preventDefault()
  shuttingDown = true
  server.stop()
  manager
    .shutdown()
    .catch(() => {})
    .finally(() => app.exit(0))
})
