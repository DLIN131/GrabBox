// 下載任務管理：設定、任務清單存檔、排隊、速度計算，以及新增視窗要的「探測」。
// 一般檔案 / HLS 同時下載數量受 maxActive 限制；種子不受限制（各自連自己的節點）。
const { EventEmitter } = require('events')
const fs = require('original-fs')
const path = require('path')
const crypto = require('crypto')
const util = require('./util')
const httpdl = require('./httpdl')
const hls = require('./hls')
const torrent = require('./torrent')
const ytdlp = require('./ytdlp')

const ev = new EventEmitter()
let userData = ''
let settings = null
let jobs = []
const rt = new Map() // job.id → { ctrl, acc, speed }
const finishing = new Map() // job.id → 這個任務目前那一次執行的 Promise（結束前不能再開一次）
let saveTimer = null

const DEFAULTS = {
  dir: '',
  connections: 8,
  maxActive: 3,
  askOnBrowser: true,
  notify: true,
  closeToTray: true,
  seed: true,
  seedRatio: 1,
  torrentPort: 0,
  upLimit: 0,
  downLimit: 0,
  ffmpeg: '',
  ytdlp: '',
}

const settingsFile = () => path.join(userData, 'settings.json')
const jobsFile = () => path.join(userData, 'jobs.json')

function readJson(f, fallback) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(f, data) {
  try {
    fs.writeFileSync(f + '.tmp', JSON.stringify(data))
    fs.renameSync(f + '.tmp', f)
  } catch (e) {
    console.warn('存檔失敗', e.message)
  }
}

function init(dataDir, defaultDir) {
  userData = dataDir
  settings = { ...DEFAULTS, ...readJson(settingsFile(), {}) }
  if (!settings.dir) settings.dir = defaultDir
  jobs = readJson(jobsFile(), [])
  if (!Array.isArray(jobs)) jobs = []
  torrent.init(path.join(userData, 'torrents'), {
    port: settings.torrentPort,
    upLimit: settings.upLimit,
    downLimit: settings.downLimit,
  })
  ytdlp.init(path.join(userData, 'bin'))
  ytdlp.setCustomPath(settings.ytdlp)
  for (const j of jobs) {
    j.speed = 0
    j.upSpeed = 0
    j.peers = 0
    delete j.phase
    // 上次關程式時還在跑的，這次接著跑
    if (j.status === 'running' || j.status === 'seeding') j.status = j.kind === 'torrent' ? j.status : 'queued'
  }
  for (const j of jobs) if (j.kind === 'torrent' && (j.status === 'running' || j.status === 'seeding')) startTorrent(j)
  schedule()
  setInterval(tick, 1000)
  // 網站常改版，yt-dlp 每週在背景更新一次（啟動後等一下，不搶開機資源）
  setTimeout(() => ytdlp.updateIfOld(), 60 * 1000)
}

function getSettings() {
  return { ...settings }
}

function setSettings(patch) {
  for (const k of Object.keys(DEFAULTS)) if (k in patch) settings[k] = patch[k]
  settings.connections = clampInt(settings.connections, 1, 32, 8)
  settings.maxActive = clampInt(settings.maxActive, 1, 10, 3)
  writeJson(settingsFile(), settings)
  torrent.setLimits({ upLimit: Number(settings.upLimit) || 0, downLimit: Number(settings.downLimit) || 0 })
  ytdlp.setCustomPath(settings.ytdlp)
  schedule()
  return getSettings()
}

function clampInt(v, min, max, def) {
  v = parseInt(v, 10)
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def
}

function save(now = false) {
  clearTimeout(saveTimer)
  if (now) return flush()
  saveTimer = setTimeout(flush, 800)
}

function flush() {
  clearTimeout(saveTimer)
  writeJson(jobsFile(), jobs)
}

function pub(j) {
  return { ...j, headers: undefined, bitfield: undefined, chunks: undefined, segDone: undefined }
}

function emit(j) {
  ev.emit('update', pub(j))
}

function list() {
  return jobs.map(pub)
}

function find(id) {
  return jobs.find((j) => j.id === id)
}

/** 其他任務已經佔用的檔名（避免兩個任務寫同一個檔） */
function takenFiles(except) {
  const s = new Set()
  for (const j of jobs) if (j !== except && j.file && j.status !== 'done') s.add(j.file.toLowerCase())
  return s
}

function ffmpegPath() {
  if (settings.ffmpeg && fs.existsSync(settings.ffmpeg)) return settings.ffmpeg
  try {
    // 打包後 ffmpeg.exe 在 app.asar.unpacked 裡
    const p = require('ffmpeg-static').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep)
    if (p && fs.existsSync(p)) return p
  } catch {}
  return ''
}

// ───────────────────────────── 新增任務 ─────────────────────────────

/**
 * spec = { kind, url, headers, name, dir, tracks, infoHash, magnet, selected, files, total, paused, private }
 */
function add(spec) {
  const dir = spec.dir || settings.dir
  fs.mkdirSync(dir, { recursive: true })
  const j = {
    id: crypto.randomUUID(),
    kind: spec.kind,
    name: '',
    dir,
    url: spec.url || '',
    referer: spec.headers?.Referer || '',
    headers: spec.headers || {},
    status: spec.paused ? 'paused' : 'queued',
    total: spec.total || -1,
    done: 0,
    speed: 0,
    created: Date.now(),
  }
  if (spec.kind === 'torrent') {
    const dup = spec.infoHash && jobs.find((x) => x.kind === 'torrent' && x.infoHash === spec.infoHash)
    if (dup) throw new Error('這個種子已經在下載清單裡了')
    Object.assign(j, {
      name: util.safeName(spec.name, 'torrent'),
      infoHash: spec.infoHash || '',
      magnet: spec.magnet || '',
      selected: spec.selected && spec.files && spec.selected.length < spec.files.length ? spec.selected : null,
      files: spec.files ? spec.files.map((f, i) => ({ ...f, sel: !spec.selected || spec.selected.includes(i), done: 0 })) : null,
      private: !!spec.private,
      uploaded: 0,
    })
    j.file = path.join(dir, j.files && j.files.length === 1 ? j.files[0].path : j.name)
  } else if (spec.kind === 'ytdlp') {
    // 副檔名照選的格式（mp4 / m4a / mp3），最後實際檔名以 yt-dlp 輸出為準
    const ext = '.' + (spec.ext || 'mp4')
    const name = util.safeName(spec.name).replace(/\.(mp4|m4a|mp3|webm|mkv)$/i, '') + ext
    j.format = spec.format || ''
    j.estimate = spec.total > 0 ? spec.total : 0
    j.file = util.uniquePath(path.join(dir, name), takenFiles())
    j.name = path.basename(j.file)
  } else {
    let name = util.safeName(spec.name)
    if (spec.kind === 'hls') {
      name = name.replace(/\.(m3u8|ts|mp4)$/i, '') + '.mp4'
      j.tracks = spec.tracks && spec.tracks.length ? spec.tracks : [{ url: spec.url, type: 'video' }]
    }
    j.name = name
    j.file = util.uniquePath(path.join(dir, name), takenFiles())
    j.name = path.basename(j.file)
    j.part = j.file + (spec.kind === 'hls' ? '.gbhls' : '.gbpart')
  }
  jobs.unshift(j)
  save()
  emit(j)
  if (j.status === 'queued' && j.kind === 'torrent') startTorrent(j)
  schedule()
  return pub(j)
}

// ───────────────────────────── 排程 ─────────────────────────────

function schedule() {
  const running = jobs.filter((j) => j.kind !== 'torrent' && j.status === 'running').length
  let slots = settings.maxActive - running
  // 清單是新的在前面，排隊時先來的先下
  for (let i = jobs.length - 1; i >= 0 && slots > 0; i--) {
    const j = jobs[i]
    if (j.kind !== 'torrent' && j.status === 'queued') {
      slots--
      runDirect(j)
    }
  }
}

function runDirect(j) {
  const ctrl = new AbortController()
  const r = { ctrl, acc: 0, speed: 0 }
  const prev = finishing.get(j.id)
  rt.set(j.id, r)
  j.status = 'running'
  j.error = ''
  emit(j)
  const p = (async () => {
    // 剛暫停又馬上繼續：等上一次的下載（yt-dlp 程序、開著的檔案）完全結束，才不會兩份同時寫同一個檔
    if (prev) await prev
    // 等的期間又被暫停 / 刪除，或上一次其實剛好下載完了
    if (ctrl.signal.aborted || j.status !== 'running') {
      if (rt.get(j.id) === r) rt.delete(j.id)
      return
    }
    await runOnce(j, r)
  })()
  finishing.set(j.id, p)
  p.finally(() => finishing.get(j.id) === p && finishing.delete(j.id))
}

async function runOnce(j, r) {
  const ctrl = r.ctrl
  const ctx = {
    signal: ctrl.signal,
    connections: settings.connections,
    ffmpeg: ffmpegPath(),
    onProgress: (d) => {
      j.done += d
      if (d > 0) r.acc += d
    },
    save: (now) => {
      save(now)
      if (now) emit(j)
    },
  }
  try {
    if (j.kind === 'hls') await hls.run(j, ctx)
    else if (j.kind === 'ytdlp') await ytdlp.run(j, ctx)
    else {
      await httpdl.run(j, ctx)
      let target = j.file
      if (fs.existsSync(target)) target = util.uniquePath(target, takenFiles(j))
      fs.renameSync(j.part, target)
      j.file = target
      j.name = path.basename(target)
    }
    j.status = 'done'
    j.finished = Date.now()
    j.speed = 0
    ev.emit('done', pub(j))
  } catch (e) {
    if (e.name === 'AbortError' || ctrl.signal.aborted) {
      // 暫停或刪除：狀態已經由呼叫的人設定
    } else {
      j.status = 'error'
      j.error = e.message
      console.warn('[download]', j.name, e)
    }
    j.speed = 0
  } finally {
    if (rt.get(j.id) === r) rt.delete(j.id)
    save(true)
    if (jobs.includes(j)) emit(j)
    schedule()
  }
}

function startTorrent(j) {
  j.status = j.status === 'seeding' || j.doneOnce ? 'seeding' : 'running'
  j.error = ''
  emit(j)
  torrent
    .start(j, {
      onMeta: () => {
        j.name = util.safeName(j.name || 'torrent')
        save()
        emit(j)
      },
      onDone: () => {
        if (!j.doneOnce) {
          j.doneOnce = true
          j.finished = Date.now()
          ev.emit('done', pub(j))
        }
        j.done = j.total
        if (settings.seed && !seedLimitReached(j)) {
          j.status = 'seeding'
          save(true)
          emit(j)
        } else finishTorrent(j)
      },
      onError: (e) => {
        j.status = 'error'
        j.error = e.message
        save(true)
        emit(j)
      },
    })
    .catch((e) => {
      j.status = 'error'
      j.error = e.message
      save(true)
      emit(j)
    })
}

/** 種子下載完、不再做種：停掉並清掉沒勾選的檔案 */
async function finishTorrent(j) {
  j.status = 'done'
  j.speed = 0
  j.upSpeed = 0
  j.peers = 0
  await torrent.stop(j)
  torrent.cleanupUnselected(j)
  save(true)
  emit(j)
}

function seedLimitReached(j) {
  if (j.forceSeed) return false
  const ratio = Number(settings.seedRatio) || 0
  return ratio > 0 && j.total > 0 && (j.uploaded || 0) / j.total >= ratio
}

/** 每秒：算速度、更新種子狀態、送給畫面 */
let snapCount = 0
function tick() {
  const snap = ++snapCount % 30 === 0
  for (const j of jobs) {
    if (j.kind === 'torrent') {
      if (!torrent.isActive(j)) continue
      const s = torrent.stats(j)
      if (!s) continue
      j.speed = s.speed
      j.upSpeed = s.upSpeed
      j.peers = s.peers
      j.uploaded = s.uploaded
      if (j.status === 'running') j.done = s.done
      if (j.status === 'seeding' && seedLimitReached(j)) {
        finishTorrent(j)
        continue
      }
      if (snap) torrent.snapshot(j)
      emit(j)
    } else if (j.status === 'running') {
      const r = rt.get(j.id)
      if (!r) continue
      r.speed = r.speed ? r.speed * 0.6 + r.acc * 0.4 : r.acc
      r.acc = 0
      j.speed = Math.round(r.speed)
      emit(j)
    }
  }
  if (snap) save()
  ev.emit('tick', summary())
}

/** 給工作列進度條用：所有進行中任務的整體進度 */
function summary() {
  let total = 0
  let done = 0
  let speed = 0
  let active = 0
  for (const j of jobs) {
    if (j.status !== 'running') continue
    active++
    speed += j.speed || 0
    if (j.total > 0) {
      total += j.total
      done += Math.min(j.done, j.total)
    }
  }
  return { active, speed, progress: total ? done / total : active ? -1 : 0 }
}

// ───────────────────────────── 操作 ─────────────────────────────

async function pause(id) {
  const j = find(id)
  if (!j) return
  if (j.kind === 'torrent') {
    if (j.status === 'done') return
    if (j.status === 'seeding') return finishTorrent(j)
    await torrent.stop(j)
    j.status = 'paused'
    j.speed = 0
    j.upSpeed = 0
    j.peers = 0
  } else if (j.status === 'running' || j.status === 'queued') {
    j.status = 'paused'
    rt.get(id)?.ctrl.abort()
  }
  save(true)
  emit(j)
}

function resume(id) {
  const j = find(id)
  if (!j) return
  if (j.kind === 'torrent') {
    // 已完成的種子按繼續 = 使用者想繼續做種，不管分享率上限
    if (j.status === 'done') j.forceSeed = true
    if (!torrent.isActive(j)) startTorrent(j)
    return
  }
  if (j.status === 'paused' || j.status === 'error') {
    j.status = 'queued'
    j.error = ''
    emit(j)
    schedule()
  }
}

/** 重新下載（例如連結過期，換一個新網址） */
function redownload(id, url, headers) {
  const j = find(id)
  if (!j || j.kind === 'torrent') return
  if (url) {
    j.url = url
    if (j.kind === 'hls') j.tracks = [{ url, type: 'video' }]
  }
  if (headers) j.headers = headers
  j.probed = false
  j.status = 'queued'
  emit(j)
  schedule()
}

async function remove(id, deleteFile) {
  const j = find(id)
  if (!j) return
  jobs = jobs.filter((x) => x !== j)
  rt.get(id)?.ctrl.abort()
  if (j.kind === 'torrent') {
    await torrent.stop(j)
    if (deleteFile) torrent.deleteFiles(j)
    torrent.forget(j)
  } else {
    // 等下載的迴圈停下來、檔案關掉再刪
    setTimeout(() => {
      try {
        if (j.part) fs.rmSync(j.part, { recursive: true, force: true })
        if (j.kind === 'ytdlp' && j.status !== 'done') ytdlp.cleanup(j)
        if (deleteFile && j.status === 'done') fs.rmSync(j.file, { force: true })
      } catch {}
    }, 500)
  }
  save(true)
  ev.emit('removed', id)
  schedule()
}

async function pauseAll() {
  for (const j of jobs) if (['running', 'queued', 'seeding'].includes(j.status)) await pause(j.id)
}

function resumeAll() {
  for (const j of jobs) if (j.status === 'paused' || (j.status === 'error' && j.kind !== 'torrent')) resume(j.id)
}

function clearDone() {
  const done = jobs.filter((j) => j.status === 'done')
  jobs = jobs.filter((j) => j.status !== 'done')
  for (const j of done) {
    if (j.kind === 'torrent') torrent.forget(j)
    ev.emit('removed', j.id)
  }
  save(true)
}

async function shutdown() {
  for (const j of jobs) if (j.kind === 'torrent') torrent.snapshot(j)
  for (const r of rt.values()) r.ctrl.abort()
  // 狀態先存成 running，下次啟動會接著下
  flush()
  await torrent.destroyAll(jobs.filter((j) => j.kind === 'torrent')).catch(() => {})
}

// ───────────────────────────── 新增視窗的探測 ─────────────────────────────

const VIDEO_EXT = /\.(mp4|m4v|webm|mkv|mov|flv|avi|wmv|ts|mp3|m4a|aac|ogg|opus|wav|flac)$/i

/**
 * req = { url, headers, title, kind }，回傳新增視窗要顯示的資訊。
 * kind: 'http' | 'hls' | 'torrent' | 'ytdlp'
 * onStatus(text)：花比較久的步驟（第一次下載 yt-dlp、解析影片）告訴視窗目前在做什麼
 */
async function probe(req, signal, onStatus) {
  const url = String(req.url || '').trim()
  if (/^magnet:/i.test(url)) {
    const t = await torrent.inspect(url, signal)
    return { kind: 'torrent', magnet: url, ...t }
  }
  if (req.torrentFile) {
    const t = await torrent.inspect(fs.readFileSync(req.torrentFile), signal)
    return { kind: 'torrent', ...t }
  }
  const headers = req.headers || {}
  // YouTube 等網站：網頁網址交給 yt-dlp
  if (req.kind === 'page' || ytdlp.siteFor(url)) return probeSite(url, headers, signal, onStatus)
  const looksHls = /\.m3u8($|\?)/i.test(url) || req.kind === 'hls'
  if (!looksHls) {
    const p = await httpdl.probe(url, headers, signal)
    // 貼上的是一般網頁：試試 yt-dlp 能不能從頁面裡找到影片
    if (/^text\/html|xhtml/i.test(p.mime)) return probeSite(url, headers, signal, onStatus)
    const isTorrent = p.mime === 'application/x-bittorrent' || /\.torrent($|\?)/i.test(url)
    if (isTorrent) {
      const { buf } = await util.fetchBuffer(url, { headers, signal }, 16 * 1024 * 1024)
      const t = await torrent.inspect(buf, signal)
      return { kind: 'torrent', ...t }
    }
    const hlsMime = /mpegurl/i.test(p.mime)
    // 有些網站的 m3u8 沒有副檔名、Content-Type 也亂給，小的文字檔就看一下內容
    let sniffHls = false
    if (!hlsMime && p.total > 0 && p.total < 4 * 1024 * 1024 && /text|octet|json|^$/.test(p.mime) && /m3u8|playlist|manifest/i.test(url)) {
      try {
        const { buf } = await util.fetchBuffer(url, { headers, signal }, 4 * 1024 * 1024)
        sniffHls = buf.slice(0, 16).toString().includes('#EXTM3U')
      } catch {}
    }
    if (!hlsMime && !sniffHls) {
      const urlName = util.nameFromUrl(p.finalUrl) || util.nameFromUrl(url)
      const dispName = util.nameFromDisposition(p.disposition)
      const mimeExt = util.extForMime(p.mime)
      const isMedia = /^(video|audio)\//.test(p.mime) || VIDEO_EXT.test(urlName)
      let name = dispName || urlName
      // 影片網址的檔名常常是亂碼或 index.mp4，從瀏覽器來的就用網頁標題
      if (isMedia && req.title) {
        const urlExt = path.extname(dispName || urlName)
        // 網址副檔名不像影音（例如 .php、.bin）就以 Content-Type 為準
        const ext = VIDEO_EXT.test(urlExt) ? urlExt : mimeExt || urlExt || '.mp4'
        name = util.safeName(req.title) + ext
      }
      if (!path.extname(name) && mimeExt) name += mimeExt
      return {
        kind: 'http',
        url,
        name: util.safeName(name || req.title, 'download'),
        size: p.total,
        resumable: p.resumable,
        mime: p.mime,
        media: isMedia,
      }
    }
  }
  const info = await hls.inspect(url, headers, signal)
  if (info.drm) throw new Error('這個影片有 DRM 保護，無法下載')
  return {
    kind: 'hls',
    url,
    name: util.safeName(req.title || util.nameFromUrl(url).replace(/\.m3u8$/i, '') || 'video') + '.mp4',
    ...info,
    ffmpeg: !!ffmpegPath(),
  }
}

async function probeSite(url, headers, signal, onStatus) {
  const info = await ytdlp.inspect(url, headers, signal, { ffmpeg: ffmpegPath() }, onStatus)
  if (info.live) throw new Error('直播中的影片無法下載，等直播結束後再試')
  return { kind: 'ytdlp', url: info.pageUrl, name: util.safeName(info.title, 'video'), ...info, ffmpeg: !!ffmpegPath() }
}

/** 設定頁用：yt-dlp 版本、手動更新 */
async function ytdlpInfo() {
  return { version: await ytdlp.version() }
}

async function ytdlpUpdate() {
  if (settings.ytdlp) return '使用自訂的 yt-dlp，請自行更新'
  try {
    await ytdlp.ensure()
  } catch (e) {
    return e.message
  }
  return (await ytdlp.updateIfOld(true)) || '已是最新版'
}

module.exports = {
  ev,
  init,
  getSettings,
  setSettings,
  list,
  add,
  pause,
  resume,
  redownload,
  remove,
  pauseAll,
  resumeAll,
  clearDone,
  shutdown,
  probe,
  ytdlpInfo,
  ytdlpUpdate,
  find: (id) => {
    const j = find(id)
    return j && pub(j)
  },
}
