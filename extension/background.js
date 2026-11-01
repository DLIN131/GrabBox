// GrabBox 擴充背景程式：從網路請求裡找出影片（MP4 等直連檔、HLS 播放清單），
// 記在每個分頁底下，通知頁面顯示「下載此影片」按鈕；按下後連同 Cookie / Referer 送給本機的 GrabBox。
const PORTS = [47321, 47322, 47323]
const DEFAULTS = { overlay: true, magnet: true, takeover: false }
const MIN_SIZE = 400 * 1024 // 小於這個的多半是預覽、廣告、音效

let settings = { ...DEFAULTS }
const tabs = new Map() // tabId → { page, items: [] , children: [] }
const reqHeaders = new Map() // requestId → { referer, origin }
let goodPort = 0

// Service worker 隨時會被 Chrome 收掉，偵測結果存在 session storage，醒來時讀回來
const ready = (async () => {
  try {
    const s = await chrome.storage.local.get(DEFAULTS)
    settings = { ...DEFAULTS, ...s }
    const { tabs: saved } = await chrome.storage.session.get('tabs')
    if (saved) for (const [id, t] of Object.entries(saved)) tabs.set(Number(id), t)
  } catch {}
})()

let saveTimer = null
function persist() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    chrome.storage.session.set({ tabs: Object.fromEntries(tabs) }).catch(() => {})
  }, 300)
}

chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return
  for (const k of Object.keys(DEFAULTS)) if (ch[k]) settings[k] = ch[k].newValue
})

// ───────────────────────────── 偵測 ─────────────────────────────

// 這些網站的影片是分段 / 加簽名的串流，網路請求裡抓不到完整檔案：直接把「網頁網址」交給 GrabBox（yt-dlp）。
// 清單跟 lib/ytdlp.js 的 SITES 一致
const SITES = [
  { name: 'YouTube', re: /^https?:\/\/((www|m|music)\.)?youtube\.com\/(watch\?|shorts\/|live\/|embed\/)|^https?:\/\/youtu\.be\//i },
  { name: 'Bilibili', re: /^https?:\/\/((www|m)\.)?bilibili\.com\/(video|bangumi\/play)\/|^https?:\/\/b23\.tv\//i },
  { name: 'X', re: /^https?:\/\/(www\.|mobile\.)?(x|twitter)\.com\/[^/]+\/status\/\d+/i },
  { name: 'Instagram', re: /^https?:\/\/(www\.)?instagram\.com\/(p|reel|reels|tv)\//i },
  { name: 'Facebook', re: /^https?:\/\/(www\.|m\.|web\.)?facebook\.com\/(watch|reel|.+\/videos\/)|^https?:\/\/fb\.watch\//i },
  { name: 'TikTok', re: /^https?:\/\/(www\.)?tiktok\.com\/@[^/]+\/video\/\d+/i },
  { name: 'Vimeo', re: /^https?:\/\/(www\.)?vimeo\.com\/\d+/i },
  { name: 'Twitch', re: /^https?:\/\/(www\.|m\.)?twitch\.tv\/(videos\/\d+|[^/]+\/clip\/)|^https?:\/\/clips\.twitch\.tv\//i },
  { name: 'Dailymotion', re: /^https?:\/\/(www\.)?dailymotion\.com\/video\//i },
  { name: 'niconico', re: /^https?:\/\/(www\.|sp\.)?nicovideo\.jp\/watch\//i },
]

/** 分頁換到支援的影音網站頁面時，加一個「整頁交給 yt-dlp」的項目（排在最前面） */
function setPageItem(t, url) {
  t.items = t.items.filter((it) => !it.page)
  const site = SITES.find((s) => s.re.test(url))
  if (site) t.items.unshift({ url, kind: 'page', page: true, site: site.name, time: Date.now() })
}

const MEDIA_EXT = /^(mp4|m4v|webm|mkv|mov|flv|avi|wmv|3gp|mp3|m4a|aac|ogg|oga|opus|wav|flac)$/
const SEGMENT_EXT = /^(ts|m4s|m4f|m4v_|cmfv|cmfa|aac_|vtt|webvtt|key)$/

function headerMap(list) {
  const h = {}
  for (const x of list || []) h[x.name.toLowerCase()] = x.value || ''
  return h
}

function classify(d) {
  if (d.tabId < 0 || d.statusCode >= 400) return null
  let u
  try {
    u = new URL(d.url)
  } catch {
    return null
  }
  if (!/^https?:$/.test(u.protocol)) return null
  const h = headerMap(d.responseHeaders)
  const ct = (h['content-type'] || '').split(';')[0].trim().toLowerCase()
  const p = u.pathname.toLowerCase()
  const ext = (/\.([a-z0-9_]{2,5})$/.exec(p) || [])[1] || ''

  // YouTube 這類 DASH 串流是一小段一小段的，拿到也接不起來
  if (/(^|\.)googlevideo\.com$/.test(u.hostname)) return null
  if (ext === 'm3u8' || ct.includes('mpegurl')) return { kind: 'hls', mime: ct }
  if (ext === 'mpd' || ct.includes('dash+xml')) return null
  if (SEGMENT_EXT.test(ext) || ct === 'video/mp2t' || ct === 'video/iso.segment') return null
  // 網址裡帶 range / bytes 參數的多半是播放器自己切的片段
  if (/[?&](range|bytes|byterange)=\d/.test(u.search)) return null

  const isMediaCt = /^(video|audio)\//.test(ct)
  const isMediaExt = MEDIA_EXT.test(ext) && (!ct || /octet-stream|binary|video|audio/.test(ct))
  if (!isMediaCt && !isMediaExt) return null

  let size = -1
  const m = /\/(\d+)\s*$/.exec(h['content-range'] || '')
  if (m) size = Number(m[1])
  else if (h['content-length']) size = Number(h['content-length'])
  if (size >= 0 && size < MIN_SIZE) return null
  return { kind: 'http', mime: ct, size, ext }
}

function tabState(tabId) {
  let t = tabs.get(tabId)
  if (!t) {
    t = { page: '', items: [], children: [] }
    tabs.set(tabId, t)
  }
  return t
}

function stripQuery(url) {
  return url.split('?')[0]
}

function fmtBytes(n) {
  if (!(n > 0)) return ''
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024
    i++
  }
  return n.toFixed(n < 10 && i ? 1 : 0) + ' ' + u[i]
}

function fmtDur(s) {
  s = Math.round(s)
  const p = (n) => String(n).padStart(2, '0')
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}` : `${Math.floor(s / 60)}:${p(s % 60)}`
}

/** 給按鈕選單 / 彈出視窗顯示的文字 */
function labelOf(it) {
  if (it.page) return `${it.site} 影片（選擇畫質下載）`
  if (it.kind === 'hls') {
    const parts = ['HLS 串流']
    if (it.quality) parts.push(it.quality)
    if (it.duration) parts.push(fmtDur(it.duration))
    return parts.join(' · ')
  }
  const type = (it.ext || (it.mime || '').split('/')[1] || 'video').toUpperCase().replace('X-', '')
  return [type, fmtBytes(it.size)].filter(Boolean).join(' · ')
}

/** 分頁上目前要顯示的項目：master 播放清單底下的子清單不重複列 */
function visibleItems(tabId) {
  const t = tabs.get(tabId)
  if (!t) return []
  const kids = new Set(t.children)
  return t.items
    .filter((it) => !it.drm && !(it.kind === 'hls' && !it.master && (kids.has(it.url) || kids.has(stripQuery(it.url)))))
    .sort((a, b) => (b.page ? 1 : 0) - (a.page ? 1 : 0) || (b.master ? 1 : 0) - (a.master ? 1 : 0) || (b.size || 0) - (a.size || 0) || b.time - a.time)
    .map((it) => ({ ...it, label: labelOf(it) }))
}

function notifyTab(tabId) {
  const list = visibleItems(tabId)
  chrome.action.setBadgeText({ tabId, text: list.length ? String(list.length) : '' }).catch(() => {})
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#4f8cff' }).catch(() => {})
  chrome.tabs.sendMessage(tabId, { type: 'items', items: list }).catch(() => {})
  persist()
}

async function addItem(tabId, info, url, extra = {}) {
  await ready
  const t = tabState(tabId)
  const existing = t.items.find((x) => x.url === url)
  if (existing) {
    if (info.size > 0 && !(existing.size > 0)) existing.size = info.size
    return
  }
  const it = { url, ...info, ...extra, time: Date.now() }
  t.items.push(it)
  if (t.items.length > 40) t.items.shift()
  if (it.kind === 'hls') await inspectHls(t, it)
  notifyTab(tabId)
}

/** 讀播放清單內容：master 的話記下子清單網址和最高畫質；一般清單算片長 */
async function inspectHls(t, it) {
  try {
    const r = await fetch(it.url, { credentials: 'include' })
    const text = await r.text()
    if (!text.includes('#EXTM3U')) {
      it.drm = true // 不是播放清單，當作無效項目藏起來
      return
    }
    const base = r.url || it.url
    const lines = text.split(/\r?\n/).map((l) => l.trim())
    if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
      it.master = true
      let best = 0
      lines.forEach((l, i) => {
        if (l.startsWith('#EXT-X-STREAM-INF')) {
          const h = Number((/RESOLUTION=\d+x(\d+)/.exec(l) || [])[1] || 0)
          if (h > best) best = h
          const next = lines.slice(i + 1).find((x) => x && !x.startsWith('#'))
          if (next) addChild(t, new URL(next, base).href)
        }
        const media = /^#EXT-X-MEDIA:.*URI="([^"]+)"/.exec(l)
        if (media) addChild(t, new URL(media[1], base).href)
      })
      if (best) it.quality = '最高 ' + best + 'p'
    } else {
      it.duration = lines.reduce((s, l) => s + (l.startsWith('#EXTINF:') ? parseFloat(l.slice(8)) || 0 : 0), 0)
      if (lines.some((l) => /^#EXT-X-KEY:.*METHOD=(SAMPLE-AES|ISO-23001)/.test(l) || /^#EXT-X-KEY:.*URI="skd:/.test(l))) it.drm = true
    }
  } catch {}
}

function addChild(t, url) {
  t.children.push(url, stripQuery(url))
  if (t.children.length > 400) t.children.splice(0, t.children.length - 400)
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (d) => {
    if (d.tabId < 0 || !['media', 'xmlhttprequest', 'other', 'object'].includes(d.type)) return
    const h = headerMap(d.requestHeaders)
    if (h.referer || h.origin) {
      reqHeaders.set(d.requestId, { referer: h.referer || '', origin: h.origin || '' })
      if (reqHeaders.size > 500) reqHeaders.delete(reqHeaders.keys().next().value)
    }
  },
  { urls: ['http://*/*', 'https://*/*'] },
  ['requestHeaders', 'extraHeaders'],
)

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    const info = classify(d)
    const rh = reqHeaders.get(d.requestId)
    reqHeaders.delete(d.requestId)
    if (!info) return
    addItem(d.tabId, info, d.url, { referer: rh?.referer || '', origin: rh?.origin || '', frameUrl: d.documentUrl || d.initiator || '' })
  },
  { urls: ['http://*/*', 'https://*/*'] },
  ['responseHeaders'],
)

// 換頁時清掉舊的偵測結果
chrome.webRequest.onBeforeRequest.addListener(
  async (d) => {
    if (d.type !== 'main_frame' || d.tabId < 0) return
    await ready
    const t = { page: d.url, items: [], children: [] }
    setPageItem(t, d.url)
    tabs.set(d.tabId, t)
    notifyTab(d.tabId)
  },
  { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] },
)

chrome.tabs.onUpdated.addListener(async (tabId, ch) => {
  if (!ch.url) return
  await ready
  const t = tabState(tabId)
  const changed = t.page.split('#')[0] !== ch.url.split('#')[0]
  // 單頁式網站切換影片（網址變了但沒有重新載入，例如 YouTube 點下一部）
  if (changed && t.page) {
    const keepAfter = Date.now() - 1500
    t.items = t.items.filter((it) => it.time > keepAfter && !it.page)
  }
  t.page = ch.url
  if (changed || !t.items.some((it) => it.page)) {
    setPageItem(t, ch.url)
    notifyTab(tabId)
  }
})

chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId)
  persist()
})

// ───────────────────────────── 送給 GrabBox ─────────────────────────────

async function cookieFor(url) {
  try {
    const list = await chrome.cookies.getAll({ url })
    return list.map((c) => `${c.name}=${c.value}`).join('; ')
  } catch {
    return ''
  }
}

async function ping() {
  const order = goodPort ? [goodPort, ...PORTS.filter((p) => p !== goodPort)] : PORTS
  for (const port of order) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(1500) })
      const j = await r.json()
      if (j.app === 'GrabBox') {
        goodPort = port
        return { port, version: j.version }
      }
    } catch {}
  }
  return null
}

/** list = [{ url, kind, referer, origin, title }] */
async function sendToApp(list, tab) {
  const app = await ping()
  if (!app) return { ok: false, error: 'GrabBox 沒有開啟' }
  const items = await Promise.all(
    list.map(async (it) => ({
      url: it.url,
      kind: it.kind || '',
      title: it.title || tab?.title || '',
      referer: it.referer || tab?.url || '',
      origin: it.origin || '',
      cookie: /^https?:/i.test(it.url) ? await cookieFor(it.url) : '',
      ua: navigator.userAgent,
    })),
  )
  try {
    const r = await fetch(`http://127.0.0.1:${app.port}/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GrabBox': '1' },
      body: JSON.stringify({ items }),
    })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: '送出失敗：' + e.message }
  }
}

/** 叫醒 GrabBox（瀏覽器會先問要不要開啟外部程式） */
function launchApp(tabId) {
  if (tabId >= 0) chrome.tabs.update(tabId, { url: 'grabbox://launch' }).catch(() => {})
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  ;(async () => {
    await ready
    const tabId = msg.tabId ?? sender.tab?.id ?? -1
    const tab = tabId >= 0 ? await chrome.tabs.get(tabId).catch(() => null) : null
    switch (msg.type) {
      case 'get':
        return reply({ items: visibleItems(tabId), settings })
      case 'popup':
        return reply({ items: visibleItems(tabId), settings, app: await ping() })
      case 'download': {
        const it = visibleItems(tabId).find((x) => x.url === msg.url) || { url: msg.url, kind: msg.kind || '' }
        return reply(await sendToApp([{ ...it, title: msg.title || tab?.title }], tab))
      }
      case 'link':
        return reply(await sendToApp([{ url: msg.url, referer: msg.referer }], tab))
      case 'videoSrc':
        // 頁面上 <video src> 直接是檔案網址（擴充裝好前就載入的頁面也抓得到）
        await addItem(tabId, { kind: /\.m3u8(\?|$)/i.test(msg.url) ? 'hls' : 'http', mime: '', size: -1, ext: ((/\.([a-z0-9]{2,4})(\?|$)/i.exec(msg.url) || [])[1] || '').toLowerCase() }, msg.url, { referer: msg.referer || '' })
        return reply({ ok: true })
      case 'launch':
        launchApp(tabId)
        return reply({ ok: true })
      case 'ping':
        return reply(await ping())
    }
    reply(null)
  })()
  return true
})

// ───────────────────────────── 右鍵選單 ─────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'gb-link', title: '用 GrabBox 下載這個連結', contexts: ['link'] })
    chrome.contextMenus.create({ id: 'gb-media', title: '用 GrabBox 下載這個影片 / 音訊', contexts: ['video', 'audio'] })
  })
  // 剛安裝 / 重新載入時，已經開著的分頁不用重新整理就能用
  await ready
  const open = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }).catch(() => [])
  for (const tab of open) {
    const t = tabState(tab.id)
    t.page = tab.url
    setPageItem(t, tab.url)
    chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] }).catch(() => {})
    notifyTab(tab.id)
  }
})

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  await ready
  let url = info.linkUrl || info.srcUrl || ''
  let kind = ''
  // 影片是 blob:（播放器自己組的串流）就改送偵測到的最佳項目
  if (!/^(https?|magnet):/i.test(url)) {
    const best = visibleItems(tab.id)[0]
    if (!best) return
    url = best.url
    kind = best.kind
  }
  const r = await sendToApp([{ url, kind, referer: info.pageUrl }], tab)
  if (!r.ok) chrome.tabs.sendMessage(tab.id, { type: 'toast', error: r.error, launch: true }).catch(() => {})
})

// ───────────────────────────── 接管瀏覽器下載（選用） ─────────────────────────────

const TAKE_EXT = /\.(zip|rar|7z|tar|gz|bz2|xz|iso|img|exe|msi|dmg|apk|mp4|mkv|avi|mov|wmv|flv|webm|mp3|flac|m4a|torrent|pdf)$/i

chrome.downloads.onCreated.addListener(async (item) => {
  await ready
  if (!settings.takeover || item.byExtensionId) return
  const url = item.finalUrl || item.url
  if (!/^https?:/i.test(url)) return
  const name = item.filename || new URL(url).pathname
  if (!TAKE_EXT.test(name) && !(item.totalBytes > 2 * 1024 * 1024)) return
  if (!(await ping())) return
  try {
    await chrome.downloads.cancel(item.id)
    await chrome.downloads.erase({ id: item.id })
  } catch {}
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  const r = await sendToApp([{ url, referer: item.referrer || '' }], tabs[0])
  // 送不過去就還給瀏覽器自己下載
  if (!r.ok) chrome.downloads.download({ url }).catch(() => {})
})
