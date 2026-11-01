// 共用小工具：檔名處理、HTTP 請求（自動跟隨轉址）、格式化
const http = require('http')
const https = require('https')
const fs = require('original-fs')
const path = require('path')
const { PassThrough } = require('stream')

// 在 Electron 主程序裡才有 net（Chromium 的網路）；ELECTRON_RUN_AS_NODE 或純 Node 測試時是空的
let electron = null
try {
  electron = require('electron')
} catch {}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

// 同一台主機的連線重複使用（分段下載會對同一個檔案發很多個 Range 請求）
const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 64 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 64 }),
}

// 被 Cloudflare 擋過、之後都改用 Chromium 連線的主機
const chromiumHosts = new Set()

/**
 * 發出請求並跟隨轉址，回傳 { res, url }（url 是最後真正的位址）。
 * 呼叫的人負責讀完或 destroy 回應。
 *
 * 有些 CDN（例如 missav 的 surrit.com）用 Cloudflare 看 TLS 指紋，Node 的連線不管帶什麼標頭都回 403「you have been blocked」：
 * 遇到這種回應就改用 Electron 內建的 Chromium 網路（跟瀏覽器同一套）再試一次，成功的話這台主機之後都走 Chromium
 */
async function request(url, opts = {}) {
  let u
  try {
    u = new URL(url)
  } catch {
    throw new Error('網址格式錯誤')
  }
  if (chromiumHosts.has(u.host) && chromiumReady()) return chromiumRequest(u, opts)
  const r = await nodeRequest(u, opts)
  if (r.res.viaChromium || !cloudflareBlocked(r.res) || !chromiumReady()) return r
  const final = new URL(r.url)
  const retry = await chromiumRequest(final, opts).catch(() => null)
  if (!retry) return r
  r.res.resume()
  if (retry.res.statusCode < 400) chromiumHosts.add(final.host)
  return retry
}

function nodeRequest(u, { headers = {}, method = 'GET', signal, timeout = 20000, redirects = 8 } = {}) {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'http:' ? http : u.protocol === 'https:' ? https : null
    if (!lib) return reject(new Error('不支援的協定：' + u.protocol))
    if (signal?.aborted) return reject(abortError())
    const h = { 'User-Agent': UA, Accept: '*/*', 'Accept-Encoding': 'identity', ...clean(headers) }
    const req = lib.request(u, { method, headers: h, agent: agents[u.protocol], timeout }, (res) => {
      const loc = res.headers.location
      if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
        res.resume()
        if (redirects <= 0) return reject(new Error('轉址次數過多'))
        const next = new URL(loc, u).href
        return request(next, { headers: redirectHeaders(headers, u, next), method, signal, timeout, redirects: redirects - 1 }).then(resolve, reject)
      }
      resolve({ res, url: u.href })
    })
    const onAbort = () => req.destroy(abortError())
    signal?.addEventListener('abort', onAbort, { once: true })
    req.on('close', () => signal?.removeEventListener('abort', onAbort))
    req.on('timeout', () => req.destroy(new Error('連線逾時')))
    req.on('error', reject)
    req.end()
  })
}

/** 轉到別的網站時不要把 Cookie 一起帶過去 */
function redirectHeaders(headers, from, next) {
  const nh = { ...headers }
  if (new URL(next).host !== from.host) delete nh.Cookie
  return nh
}

/** Cloudflare 的封鎖 / 驗證頁（不是原站自己回的 403） */
function cloudflareBlocked(res) {
  const h = res.headers
  return (res.statusCode === 403 || res.statusCode === 503) && /cloudflare/i.test(h.server || '') && /text\/html/i.test(h['content-type'] || '')
}

function chromiumReady() {
  return typeof electron?.net?.request === 'function' && !!electron.app?.isReady?.()
}

/**
 * 用 Chromium 的網路發請求。回傳的 res 包成 Node 的串流（statusCode、headers、for await、destroy 都跟 Node 的一樣）。
 * 不帶 Electron 自己存的 Cookie，只送呼叫的人給的標頭
 */
function chromiumRequest(u, { headers = {}, method = 'GET', signal, timeout = 20000, redirects = 8 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    // Referer 只有在 unsafe-url 時 Chromium 才肯送（其他 policy 會整個請求被擋：ERR_BLOCKED_BY_CLIENT）
    const req = electron.net.request({ url: u.href, method, redirect: 'manual', useSessionCookies: false, referrerPolicy: 'unsafe-url' })
    for (const [k, v] of Object.entries({ 'User-Agent': UA, Accept: '*/*', 'Accept-Encoding': 'identity', ...clean(headers) })) {
      try {
        req.setHeader(k, v)
      } catch {}
    }
    let out = null
    let settled = false
    let timer = null
    const fail = (e) => {
      clearTimeout(timer)
      if (out) out.destroy(e)
      else if (!settled) {
        settled = true
        reject(e)
      }
    }
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        req.abort()
        fail(new Error('連線逾時'))
      }, timeout)
    }
    const onAbort = () => {
      req.abort()
      fail(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    req.on('redirect', (_status, _method, loc) => {
      req.abort()
      cleanup()
      settled = true
      if (redirects <= 0) return reject(new Error('轉址次數過多'))
      const next = new URL(loc, u).href
      request(next, { headers: redirectHeaders(headers, u, next), method, signal, timeout, redirects: redirects - 1 }).then(resolve, reject)
    })
    req.on('response', (res) => {
      settled = true
      let ended = false
      out = new PassThrough()
      out.statusCode = res.statusCode
      out.headers = res.headers
      out.viaChromium = true
      // 跟 Node 的 timeout 一樣：太久沒收到資料就斷掉
      arm()
      res.on('data', arm)
      res.on('end', () => {
        ended = true
        clearTimeout(timer)
      })
      res.on('error', (e) => out.destroy(e))
      res.on('aborted', () => out.destroy(new Error('連線中斷')))
      // 呼叫的人提早 destroy（例如只要標頭）：把請求也停掉
      out.on('close', () => {
        cleanup()
        if (!ended) req.abort()
      })
      res.pipe(out)
      resolve({ res: out, url: u.href })
    })
    req.on('error', fail)
    arm()
    req.end()
  })
}

/** 整個回應讀成 Buffer（播放清單、金鑰、種子檔這種小東西用） */
async function fetchBuffer(url, opts = {}, limit = 32 * 1024 * 1024) {
  const { res, url: finalUrl } = await request(url, opts)
  if (res.statusCode >= 400) {
    res.resume()
    throw httpError(res.statusCode)
  }
  const parts = []
  let n = 0
  for await (const c of res) {
    n += c.length
    if (n > limit) {
      res.destroy()
      throw new Error('回應太大')
    }
    parts.push(c)
  }
  return { buf: Buffer.concat(parts), url: finalUrl, headers: res.headers }
}

function clean(headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers || {})) if (v) out[k] = v
  return out
}

function abortError() {
  const e = new Error('已中止')
  e.name = 'AbortError'
  return e
}

function httpError(code) {
  const e = new Error(code === 403 ? '伺服器拒絕（403），連結可能已過期' : code === 404 ? '找不到檔案（404）' : 'HTTP ' + code)
  e.status = code
  return e
}

/** Windows 不能用的字元換掉，太長的截斷 */
function safeName(name, fallback = 'download') {
  let s = String(name || '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = '_' + s
  if (!s) s = fallback
  if (s.length > 180) {
    const ext = path.extname(s)
    s = s.slice(0, 180 - ext.length) + (ext.length <= 10 ? ext : '')
  }
  return s
}

/** 目標檔已存在（或正在下載同名檔）就加上 (1)、(2)… */
function uniquePath(file, taken = new Set()) {
  const dir = path.dirname(file)
  const ext = path.extname(file)
  const base = path.basename(file, ext)
  let p = file
  for (let i = 1; fs.existsSync(p) || taken.has(p.toLowerCase()); i++) p = path.join(dir, `${base} (${i})${ext}`)
  return p
}

/** 從 Content-Disposition 取檔名 */
function nameFromDisposition(cd) {
  if (!cd) return ''
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(cd)
  if (star) {
    try {
      return decodeURIComponent(star[2].trim().replace(/^"|"$/g, ''))
    } catch {}
  }
  const m = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(cd)
  if (!m) return ''
  const raw = (m[2] ?? m[1]).trim()
  // 很多伺服器直接塞 UTF-8 位元組，被 Node 當 latin1 讀進來
  try {
    const fixed = Buffer.from(raw, 'latin1').toString('utf8')
    if (!fixed.includes('�')) return fixed
  } catch {}
  return raw
}

function nameFromUrl(url) {
  try {
    const u = new URL(url)
    const last = u.pathname.split('/').filter(Boolean).pop() || ''
    return decodeURIComponent(last)
  } catch {
    return ''
  }
}

const MIME_EXT = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
  'video/quicktime': '.mov',
  'video/x-flv': '.flv',
  'video/x-msvideo': '.avi',
  'video/mp2t': '.ts',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/ogg': '.ogg',
  'audio/webm': '.weba',
  'audio/wav': '.wav',
  'audio/flac': '.flac',
  'application/zip': '.zip',
  'application/pdf': '.pdf',
  'application/x-bittorrent': '.torrent',
}

function extForMime(mime) {
  return MIME_EXT[String(mime || '').split(';')[0].trim().toLowerCase()] || ''
}

function fmtBytes(n) {
  if (!(n >= 0)) return '?'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024
    i++
  }
  return (i ? n.toFixed(n < 10 ? 2 : n < 100 ? 1 : 0) : n) + ' ' + u[i]
}

module.exports = {
  UA,
  request,
  fetchBuffer,
  abortError,
  httpError,
  safeName,
  uniquePath,
  nameFromDisposition,
  nameFromUrl,
  extForMime,
  fmtBytes,
}
