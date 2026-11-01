// BT 種子下載（WebTorrent，走 TCP / uTP / DHT，跟一般 BT 用戶端互通）。
// 種子檔取得後存一份在 userData/torrents/<infoHash>.torrent，下次啟動不用再從 DHT 找種子資訊。
const fs = require('original-fs')
const os = require('os')
const path = require('path')

// 磁力連結常常沒帶 tracker，補幾個公開的讓找節點快一點（私有種子不會加）
const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.qu.ax:6969/announce',
  'https://tracker.zhuqiy.com:443/announce',
]

let client = null
let clientPromise = null
let options = { port: 0, upLimit: 0, downLimit: 0, maxConns: 80 }
let torrentDir = ''
const active = new Map() // job.id → { torrent, job }

let parseTorrentFn = null
async function parseTorrent(input) {
  if (!parseTorrentFn) parseTorrentFn = (await import('parse-torrent')).default
  return parseTorrentFn(input)
}

function init(dir, opts) {
  torrentDir = dir
  fs.mkdirSync(torrentDir, { recursive: true })
  Object.assign(options, opts)
}

async function getClient() {
  if (client) return client
  if (!clientPromise) {
    clientPromise = (async () => {
      const { default: WebTorrent } = await import('webtorrent')
      client = new WebTorrent({
        torrentPort: options.port || 0,
        maxConns: options.maxConns,
        uploadLimit: options.upLimit > 0 ? options.upLimit * 1024 : -1,
        downloadLimit: options.downLimit > 0 ? options.downLimit * 1024 : -1,
        tracker: { announce: TRACKERS },
      })
      client.on('error', (e) => console.warn('[torrent]', e.message))
      return client
    })()
  }
  return clientPromise
}

/** 速度限制改了立刻套用（單位 KB/s，0 = 不限） */
function setLimits({ upLimit, downLimit }) {
  options.upLimit = upLimit
  options.downLimit = downLimit
  if (!client) return
  client.throttleUpload(upLimit > 0 ? upLimit * 1024 : -1)
  client.throttleDownload(downLimit > 0 ? downLimit * 1024 : -1)
}

function fileList(files) {
  return files.map((f) => ({ path: f.path, length: f.length }))
}

function torrentPath(infoHash) {
  return path.join(torrentDir, infoHash + '.torrent')
}

/**
 * 給新增視窗看的種子資訊（檔案清單）。
 * source = 磁力連結字串，或 .torrent 檔的 Buffer
 */
async function inspect(source, signal) {
  if (Buffer.isBuffer(source)) {
    const t = await parseTorrent(source)
    if (!t.files) throw new Error('種子檔格式不對')
    fs.writeFileSync(torrentPath(t.infoHash), source)
    return { name: t.name, infoHash: t.infoHash, files: fileList(t.files), total: t.length, private: !!t.private }
  }
  const parsed = await parseTorrent(source)
  const saved = torrentPath(parsed.infoHash)
  if (fs.existsSync(saved)) return inspect(fs.readFileSync(saved), signal)

  const c = await getClient()
  const existing = await c.get(parsed.infoHash)
  if (existing && existing.metadata) {
    fs.writeFileSync(saved, Buffer.from(existing.torrentFile))
    return { name: existing.name, infoHash: existing.infoHash, files: fileList(existing.files), total: existing.length, private: !!existing.private }
  }
  if (existing) throw new Error('這個種子正在取得資訊中')

  // 只為了拿種子資訊：不選任何檔案，存到暫存資料夾，拿到就移除
  const tmp = path.join(os.tmpdir(), 'grabbox-meta')
  return new Promise((resolve, reject) => {
    const t = c.add(source, { path: tmp, deselect: true, destroyStoreOnDestroy: true })
    let timer = null
    const finish = (err, val) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (!t.destroyed) t.destroy({ destroyStore: true })
      err ? reject(err) : resolve(val)
    }
    const onAbort = () => finish(new Error('已取消'))
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => finish(new Error('找不到種子資訊（2 分鐘內沒有節點回應）')), 120000)
    t.once('metadata', () => {
      const buf = Buffer.from(t.torrentFile)
      fs.writeFileSync(saved, buf)
      finish(null, { name: t.name, infoHash: t.infoHash, files: fileList(t.files), total: t.length, private: !!t.private })
    })
    t.once('error', (e) => finish(e))
  })
}

function magnetParams(magnet) {
  if (!magnet || !/^magnet:\?/i.test(magnet)) return { trackers: [], peers: [] }
  const q = new URLSearchParams(magnet.slice(8))
  return { trackers: q.getAll('tr'), peers: q.getAll('x.pe') }
}

function selectedFiles(job, torrent) {
  if (!job.selected) return torrent.files
  return job.selected.map((i) => torrent.files[i]).filter(Boolean)
}

/**
 * 開始（或繼續）下載 / 做種。hooks = { onMeta(), onDone(), onError(err) }
 */
async function start(job, hooks) {
  if (active.has(job.id)) return
  const c = await getClient()
  const saved = job.infoHash ? torrentPath(job.infoHash) : ''
  const source = saved && fs.existsSync(saved) ? fs.readFileSync(saved) : job.magnet
  if (!source) throw new Error('找不到種子檔')
  const existing = job.infoHash ? await c.get(job.infoHash) : null
  if (existing) existing.destroy()

  const opts = { path: job.dir, deselect: !!job.selected }
  if (job.bitfield) opts.bitfield = new Uint8Array(Buffer.from(job.bitfield, 'base64'))
  // 從存下來的種子檔開始時，磁力連結裡的 tracker（tr=）和指定節點（x.pe=）要自己補回去
  const mg = magnetParams(job.magnet)
  if (mg.trackers.length) opts.announce = mg.trackers
  const torrent = c.add(source, opts)
  if (mg.peers.length) torrent.once('infoHash', () => mg.peers.forEach((p) => torrent.addPeer(p)))
  const entry = { torrent, job, finished: false, uploadedBase: job.uploaded || 0 }
  active.set(job.id, entry)
  job.phase = torrent.metadata ? 'verify' : 'meta'

  torrent.on('metadata', () => {
    if (!job.infoHash) job.infoHash = torrent.infoHash
    const p = torrentPath(torrent.infoHash)
    if (!fs.existsSync(p)) fs.writeFileSync(p, Buffer.from(torrent.torrentFile))
    if (job.selected) for (const f of selectedFiles(job, torrent)) f.select()
    job.name = job.name || torrent.name
    job.files = torrent.files.map((f, i) => ({ path: f.path, length: f.length, sel: !job.selected || job.selected.includes(i) }))
    job.total = selectedFiles(job, torrent).reduce((s, f) => s + f.length, 0)
    job.phase = 'verify'
    hooks.onMeta?.()
  })
  torrent.on('ready', () => {
    job.phase = ''
    check()
  })
  torrent.on('error', (e) => {
    active.delete(job.id)
    hooks.onError?.(e)
  })
  const check = () => {
    if (entry.finished || !torrent.metadata || job.phase) return
    const files = selectedFiles(job, torrent)
    if (files.length && files.every((f) => f.done || f.downloaded >= f.length)) {
      entry.finished = true
      hooks.onDone?.()
    }
  }
  torrent.on('done', check)
  entry.check = check
}

/** 每秒更新一次進度、速度、節點數 */
function stats(job) {
  const e = active.get(job.id)
  if (!e) return null
  const t = e.torrent
  e.check?.()
  if (!t.metadata) return { done: 0, speed: 0, upSpeed: 0, peers: t.numPeers, uploaded: e.uploadedBase }
  const files = selectedFiles(job, t)
  const done = files.reduce((s, f) => s + Math.min(f.length, f.downloaded), 0)
  if (job.files) t.files.forEach((f, i) => job.files[i] && (job.files[i].done = Math.min(f.length, f.downloaded)))
  return {
    done,
    speed: Math.round(t.downloadSpeed),
    upSpeed: Math.round(t.uploadSpeed),
    peers: t.numPeers,
    uploaded: e.uploadedBase + t.uploaded,
  }
}

/** 記下已完成的區塊，下次啟動只抽查不用整個重新校驗 */
function snapshot(job) {
  const e = active.get(job.id)
  if (!e || !e.torrent.bitfield || e.torrent._destroyed) return
  try {
    job.bitfield = Buffer.from(e.torrent.bitfield.buffer).toString('base64')
  } catch {}
}

function stop(job) {
  const e = active.get(job.id)
  if (!e) return Promise.resolve()
  snapshot(job)
  const s = stats(job)
  if (s) job.uploaded = s.uploaded
  active.delete(job.id)
  return new Promise((resolve) => e.torrent.destroy({ destroyStore: false }, () => resolve()))
}

function isActive(job) {
  return active.has(job.id)
}

/** 刪除任務時一併刪掉下載的檔案 */
function deleteFiles(job) {
  for (const f of job.files || []) {
    if (!f.sel) continue
    try {
      fs.rmSync(path.join(job.dir, f.path), { force: true })
    } catch {}
  }
  // 多檔案種子自己的資料夾如果空了也刪掉
  const roots = new Set((job.files || []).filter((f) => /[\\/]/.test(f.path)).map((f) => f.path.split(/[\\/]/)[0]))
  for (const r of roots) {
    const p = path.join(job.dir, r)
    try {
      if (fs.statSync(p).isDirectory()) removeEmptyDirs(p)
    } catch {}
  }
}

/**
 * 停止後把「沒勾選的檔案」刪掉：它們跟勾選檔案共用邊界區塊，寫入那一塊時檔案會被撐到接近原本大小（內容幾乎全是 0）。
 * 之後如果又按繼續做種，邊界那一塊會重新下載，不影響已完成的檔案。
 */
function cleanupUnselected(job) {
  if (!job.selected || active.has(job.id)) return
  for (const f of job.files || []) {
    if (f.sel) continue
    try {
      fs.rmSync(path.join(job.dir, f.path), { force: true })
    } catch {}
  }
}

function removeEmptyDirs(dir) {
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n)
    if (fs.statSync(p).isDirectory()) removeEmptyDirs(p)
  }
  if (!fs.readdirSync(dir).length) fs.rmdirSync(dir)
}

function forget(job) {
  if (!job.infoHash) return
  try {
    fs.rmSync(torrentPath(job.infoHash), { force: true })
  } catch {}
}

async function destroyAll(jobs) {
  for (const j of jobs) if (active.has(j.id)) await stop(j)
  if (client) await new Promise((r) => client.destroy(() => r()))
  client = null
  clientPromise = null
}

module.exports = { init, inspect, start, stop, stats, snapshot, isActive, deleteFiles, cleanupUnselected, forget, setLimits, destroyAll, parseTorrent }
