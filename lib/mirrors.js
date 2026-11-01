// 多 CDN 下載（參考 ReelBox）：同一個檔案常同時放在好幾台 CDN 主機上（eu-cdn03 / us-cdn04、v1～v5.xxx…），
// 網站只給其中一台。找出其他也有這個檔案的主機，下載時每一段挑比較快的主機抓（runTasks）。
// 主機要回一樣的大小、一樣的開頭資料才算鏡像，避免抓到別的檔案。
const { request, abortError } = require('./util')

const DENIED = [401, 403, 404, 410] // 連結過期、這台沒有這個檔案

const SAMPLE = 1024 // 比對開頭的位元組數
const CACHE_MS = 30 * 60 * 1000
const MAX_NUM = 12
const cache = new Map() // 主機 → { hosts, time }：之前找到的鏡像主機（不同檔案可能放在不同組，每次還是會確認）

/**
 * 照主機名稱的編號猜其他主機：第一段名稱裡最後一個數字換成 1～12（位數照原本的），eu- / us- 開頭的兩區都猜。
 * 只有三段以上的主機名稱才猜（不會去改網站本身的網域）
 */
function candidates(host) {
  const labels = host.split('.')
  if (labels.length < 3 || /^\d+$/.test(labels[labels.length - 1])) return []
  const m = /^(.*?)(\d+)(\D*)$/.exec(labels[0])
  if (!m) return []
  const rest = '.' + labels.slice(1).join('.')
  const width = m[2].length
  const region = /^(eu|us)-/.exec(m[1])
  const prefixes = region ? ['eu', 'us'].map((r) => r + m[1].slice(2)) : [m[1]]
  const out = []
  for (const p of prefixes) for (let n = 1; n <= MAX_NUM; n++) out.push(p + String(n).padStart(width, '0') + m[3] + rest)
  return out.filter((h) => h !== host)
}

/** 拿檔案的總大小和開頭 1 KB：{ total, head, ranged, url（轉址後的位址） }，失敗回傳 null */
async function sample(url, headers, signal, timeout = 6000) {
  const ctl = new AbortController()
  const stop = () => ctl.abort()
  signal?.addEventListener('abort', stop, { once: true })
  const timer = setTimeout(stop, timeout)
  try {
    const { res, url: final } = await request(url, { headers: { ...headers, Range: `bytes=0-${SAMPLE - 1}` }, signal: ctl.signal, timeout })
    if (res.statusCode !== 200 && res.statusCode !== 206) {
      res.destroy()
      return null
    }
    const ranged = res.statusCode === 206
    const total = ranged ? Number(/\/(\d+)\s*$/.exec(res.headers['content-range'] || '')?.[1]) || 0 : Number(res.headers['content-length']) || 0
    const parts = []
    let n = 0
    // 不支援 Range 的會回整個檔案：讀到 1 KB 就斷掉
    for await (const c of res) {
      parts.push(c)
      n += c.length
      if (n >= SAMPLE) break
    }
    res.destroy()
    return { total, head: Buffer.concat(parts).subarray(0, SAMPLE), ranged, url: final }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', stop)
  }
}

/** 同時跑的數量有上限（幾十個主機一起問，DNS 查詢會塞住） */
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length)
  let next = 0
  const run = async () => {
    while (next < list.length) {
      const i = next++
      out[i] = await fn(list[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, run))
  return out
}

/** [[host, url]] 裡哪些主機回的跟樣本一樣（大小、開頭、支不支援 Range） */
async function verify(ref, list, headers, signal) {
  const got = await mapLimit(list, 6, ([, url]) => sample(url, headers, signal))
  return list.filter((_, i) => got[i] && got[i].total === ref.total && got[i].ranged === ref.ranged && got[i].head.equals(ref.head)).map(([h]) => h)
}

function swapHost(url, host, search) {
  const u = new URL(url)
  u.host = host
  if (search !== undefined) u.search = search
  return u.href
}

/**
 * 一般檔案：找出其他也有這個檔案、支援 Range 的主機，回傳鏡像網址（不含原本的）。
 * 找不到或出錯就回傳空陣列（照原本的方式下載）
 */
async function find(url, headers, signal) {
  const ref = await sample(url, headers, signal, 15000)
  if (!ref || !ref.total || !ref.ranged) return []
  // 網址可能會轉址到真正的 CDN，用最後的位址猜
  const final = ref.url
  const host = new URL(final).host
  const hit = cache.get(host)
  const fresh = hit && Date.now() - hit.time < CACHE_MS
  const list = (fresh ? hit.hosts : candidates(host)).map((h) => [h, swapHost(final, h)])
  if (!list.length) return []
  const hosts = await verify(ref, list, headers, signal)
  if (!fresh) cache.set(host, { hosts, time: Date.now() })
  return hosts.map((h) => swapHost(final, h))
}

/**
 * HLS：片段可以改從哪幾台主機抓。回傳 [{ host, url(片段網址) → 這台的網址 }]，少於兩台就回傳空陣列。
 * - 播放清單本身就把片段分散在好幾台時（例如肉視頻的 v1～v5），每台都試試能不能抓別台的片段；
 *   網址參數要「每台固定一組」（換主機時用那台自己的），每個片段各自簽名的就不能換
 * - 參數跟主機無關（或沒有參數）時，再照主機名稱的編號猜其他主機
 */
async function hlsHosts(pieces, headers, signal) {
  const media = pieces.filter((p) => !p.init)
  if (!media.length) return []
  const query = new Map()
  for (const p of media) {
    const u = new URL(p.url)
    if (!query.has(u.host)) query.set(u.host, u.search)
    else if (query.get(u.host) !== u.search) return []
  }
  const ref = media[0]
  const refHost = new URL(ref.url).host
  const shared = new Set(query.values()).size === 1
  const guessed = shared ? [...new Set([...query.keys()].flatMap(candidates))].filter((h) => !query.has(h)) : []
  const others = [...query.keys(), ...guessed].filter((h) => h !== refHost)
  if (!others.length) return []
  const searchOf = (h) => (query.has(h) ? query.get(h) : query.get(refHost))
  const first = await sample(ref.url, headers, signal, 15000)
  if (!first || !first.total) return []
  const ok = await verify(
    first,
    others.map((h) => [h, swapHost(ref.url, h, searchOf(h))]),
    headers,
    signal,
  )
  if (!ok.length) return []
  return [refHost, ...ok].map((h) => ({ host: h, url: (u) => swapHost(u, h, searchOf(h)) }))
}

/**
 * 用多台主機下載一堆片段 / 分段（hls.js、httpdl.js 共用）。
 * opts = {
 *   count, isDone(i), connections, signal,
 *   hosts: [{ key, any, ... }]：any = 這台可以抓任何一段；不是的話只抓 prefer(i) 指到它的段,
 *   prefer(i) → 這段原本該從哪台抓（主機 key，沒有就 null）,
 *   more: Promise<hosts>：背景找到的鏡像，找到再加進來（同 key 的會更新）,
 *   fetch(i, host, signal) → Promise<位元組數>：自己寫檔、標記完成（另一份先完成了就不要重複算）,
 *   waitMore：等鏡像幾毫秒再開滿連線（一般檔案用：一開始全部連線都塞給原本那台，鏡像找到後要等分段下載完才輪得到）,
 *   stickToOwn：每段一律用原本那台，別台只拿來救急（原本那台停用了、或最後拖太久的段重抓）,
 *   onHosts(n)：可用的主機數變了,
 * }
 * 挑主機：記每台的總速度（每條連線的速度 × 當時的連線數），挑「再多開一條能分到最多」的那台；
 * 原本那台不比最好的差一半以上就用它（網站自己的分配）。還沒量過的主機先當作跟最快的一樣（會輪流試到）。
 * 同時連線數維持 connections 條，不會因為主機多就開更多。
 * 最後剩下的段被慢的主機拖住時，閒著的連線找另一台重抓一份，先完成的算數、另一份中止。
 */
async function runTasks({ count, isDone, connections, signal, hosts, prefer = () => null, more, waitMore = 0, stickToOwn = false, fetch, onHosts }) {
  const pool = hosts.map((h) => ({ ...h, rate: 0, busy: 0, fails: 0, denied: 0, dead: false }))
  const running = new Map() // i → [{ host, start, ctl }]
  const times = [] // 最近完成的段花多久（判斷哪段拖太久）
  let low = 0
  let lastErr = null
  let finished = false

  const alive = () => pool.filter((h) => !h.dead)
  const report = () => onHosts?.(alive().filter((h) => h.any || h.used).length || 1)
  more
    ?.then((list) => {
      if (finished) return
      for (const h of list || []) {
        const old = pool.find((x) => x.key === h.key)
        if (old) Object.assign(old, h)
        else pool.push({ ...h, rate: 0, busy: 0, fails: 0, denied: 0, dead: false })
      }
      report()
    })
    .catch(() => {})

  const top = () => Math.max(0, ...alive().map((h) => h.rate))
  // 再多開一條連線，這條大概分得到多少
  const score = (h) => (h.rate || top() || 1) / (h.busy + 1)
  const canServe = (i) => pool.some((h) => !h.dead && (h.any || h.key === prefer(i)))

  function pickHost(i, exclude) {
    const p = prefer(i)
    const cap = alive().length > 1 ? Math.max(2, Math.ceil(connections / 2)) : connections
    // 原本那台不限連線數（跟以前一樣）；改抓別台時每台最多一半的連線
    const free = pool.filter((h) => !h.dead && h !== exclude && (h.key === p ? h.busy < connections : h.any && h.busy < cap))
    if (!free.length) return null
    const own = free.find((h) => h.key === p)
    if (own && stickToOwn) return own
    const best = Math.max(...free.map(score))
    if (own && score(own) >= best / 2) return own
    let pick = null
    for (const h of free) if (score(h) >= best * 0.999 && (!pick || h.busy < pick.busy)) pick = h
    return pick
  }

  function nextTask() {
    while (low < count && isDone(low)) low++
    let blocked = false
    for (let i = low; i < count; i++) {
      if (isDone(i) || running.has(i)) continue
      const host = pickHost(i)
      if (host) return { i, host }
      if (canServe(i)) blocked = true // 有主機能抓，只是連線滿了
    }
    // 沒有新的段了：拖最久的那段（超過平常的兩倍、至少 3 秒）找另一台重抓一份
    const sorted = [...times].sort((a, b) => a - b)
    const typical = sorted[Math.floor(sorted.length / 2)] || 0
    let slow = null
    for (const [i, list] of running) {
      if (list.length > 1 || isDone(i)) continue
      const age = Date.now() - list[0].start
      if (age > Math.max(3000, typical * 2) && (!slow || age > slow.age)) slow = { i, age, from: list[0].host }
    }
    if (slow) {
      const host = pickHost(slow.i, alive().length > 1 ? slow.from : null)
      if (host) return { i: slow.i, host }
    }
    return blocked || running.size ? { wait: true } : null
  }

  async function worker() {
    for (;;) {
      if (signal.aborted) return
      const t = nextTask()
      if (!t) return
      if (t.wait) {
        await wait(200, signal)
        continue
      }
      const { i, host } = t
      const ctl = new AbortController()
      const me = { host, start: Date.now(), ctl }
      running.set(i, [...(running.get(i) || []), me])
      host.busy++
      if (!host.used) {
        host.used = true
        report()
      }
      let err = null
      let bytes = 0
      try {
        bytes = await fetch(i, host, AbortSignal.any([signal, ctl.signal]))
      } catch (e) {
        err = e
      }
      host.busy--
      const rest = (running.get(i) || []).filter((x) => x !== me)
      if (rest.length) running.set(i, rest)
      else running.delete(i)
      if (signal.aborted) return
      if (!err) {
        const ms = Date.now() - me.start
        if (bytes > 0) {
          // 這台的總速度 ≈ 這條的速度 × 這台目前的連線數（含這條）
          const s = (bytes / Math.max(1, ms)) * (host.busy + 1)
          host.rate = host.rate ? host.rate * 0.6 + s * 0.4 : s
          times.push(ms)
          if (times.length > 30) times.shift()
        }
        host.fails = host.denied = 0
        // 另一份不用了：中止，並馬上從清單拿掉（不然收尾時會被當成「拖很久的段」又重抓一次）
        for (const x of rest) x.ctl.abort()
        running.delete(i)
        continue
      }
      if (ctl.signal.aborted) continue // 另一份先完成，這份被中止
      lastErr = err
      // 被拒 3 次、或連續失敗 3 次（只剩這台時 6 次）就不用這台了
      if (err.status && DENIED.includes(err.status)) {
        if (++host.denied >= 3) host.dead = true
      } else if (++host.fails >= (alive().length > 1 ? 3 : 6)) host.dead = true
      if (host.dead) report()
      else await wait(Math.min(8000, 700 * 2 ** host.fails), signal)
    }
  }

  try {
    const n = Math.max(1, connections)
    const first = more && waitMore ? Math.min(2, n) : n
    const workers = Array.from({ length: first }, worker)
    if (first < n) {
      await Promise.race([more.catch(() => {}), wait(waitMore, signal)])
      for (let k = first; k < n; k++) workers.push(worker())
    }
    await Promise.all(workers)
  } finally {
    finished = true
  }
  if (signal.aborted) throw abortError()
  for (let i = 0; i < count; i++) if (!isDone(i)) throw lastErr || new Error('下載不完整')
}

/** 等一下；中止時馬上結束（不丟錯，呼叫的人自己看 signal） */
function wait(ms, signal) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const t = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

module.exports = { candidates, sample, find, hlsHosts, runTasks }
