// 共用小工具：檔名處理、HTTP 請求（自動跟隨轉址）、格式化
const http = require('http')
const https = require('https')
const fs = require('original-fs')
const path = require('path')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

// 同一台主機的連線重複使用（分段下載會對同一個檔案發很多個 Range 請求）
const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 64 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 64 }),
}

/**
 * 發出請求並跟隨轉址，回傳 { res, url }（url 是最後真正的位址）。
 * 呼叫的人負責讀完或 destroy 回應。
 */
function request(url, { headers = {}, method = 'GET', signal, timeout = 20000, redirects = 8 } = {}) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(url)
    } catch {
      return reject(new Error('網址格式錯誤'))
    }
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
        // 轉到別的網站時不要把 Cookie 一起帶過去
        const nh = { ...headers }
        if (new URL(next).host !== u.host) delete nh.Cookie
        return request(next, { headers: nh, method, signal, timeout, redirects: redirects - 1 }).then(resolve, reject)
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
