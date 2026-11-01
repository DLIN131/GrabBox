// 本機接收服務：瀏覽器擴充把偵測到的影片 / 連結送到 http://127.0.0.1:47321
// 只接受擴充功能（chrome-extension://、moz-extension://）或沒有 Origin 的本機程式，一般網頁送不進來。
const http = require('http')

const PORTS = [47321, 47322, 47323]
let server = null
let port = 0

function allowedOrigin(origin) {
  return !origin || /^(chrome|moz|edge)-extension:\/\//.test(origin)
}

function send(res, code, obj, origin) {
  const h = { 'Content-Type': 'application/json; charset=utf-8' }
  if (origin && allowedOrigin(origin)) {
    h['Access-Control-Allow-Origin'] = origin
    h['Access-Control-Allow-Headers'] = 'Content-Type, X-GrabBox'
    h['Access-Control-Allow-Methods'] = 'GET, POST'
    h['Access-Control-Allow-Private-Network'] = 'true'
  }
  res.writeHead(code, h)
  res.end(JSON.stringify(obj))
}

/** handlers = { version, onAdd(items) → Promise<result> } */
function start(handlers) {
  return new Promise((resolve) => {
    const tryPort = (i) => {
      if (i >= PORTS.length) return resolve(0)
      const s = http.createServer((req, res) => handle(req, res, handlers))
      s.once('error', () => tryPort(i + 1))
      s.listen(PORTS[i], '127.0.0.1', () => {
        server = s
        port = PORTS[i]
        resolve(port)
      })
    }
    tryPort(0)
  })
}

function handle(req, res, handlers) {
  const origin = req.headers.origin || ''
  if (!allowedOrigin(origin)) return send(res, 403, { error: 'forbidden' })
  if (req.method === 'OPTIONS') return send(res, 204, {}, origin)
  const url = new URL(req.url, 'http://127.0.0.1')
  if (req.method === 'GET' && url.pathname === '/ping') {
    return send(res, 200, { app: 'GrabBox', version: handlers.version }, origin)
  }
  if (req.method === 'POST' && url.pathname === '/add') {
    // 一定要有自訂標頭：網頁要送就得先過 CORS 預檢，而預檢只放行擴充功能
    if (req.headers['x-grabbox'] !== '1') return send(res, 403, { error: 'forbidden' }, origin)
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 2 * 1024 * 1024) req.destroy()
    })
    req.on('end', async () => {
      let data
      try {
        data = JSON.parse(body)
      } catch {
        return send(res, 400, { error: 'bad json' }, origin)
      }
      const items = Array.isArray(data.items) ? data.items : [data]
      try {
        const r = await handlers.onAdd(items.filter((x) => x && typeof x.url === 'string').slice(0, 20))
        send(res, 200, { ok: true, ...r }, origin)
      } catch (e) {
        send(res, 500, { error: e.message }, origin)
      }
    })
    return
  }
  send(res, 404, { error: 'not found' }, origin)
}

function stop() {
  server?.close()
  server = null
}

module.exports = { start, stop, port: () => port }
