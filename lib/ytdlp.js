// 影音網站下載（YouTube、Bilibili、X…）：交給 yt-dlp 解析與下載，ffmpeg 合併影像和聲音。
// yt-dlp.exe 第一次用時從官方 GitHub 下載到 userData/bin，之後每週自動更新（網站常改版，舊版很快就不能用）。
// YouTube 要用 JavaScript 解驗證，yt-dlp 需要 Node ≥ 22：直接用 Electron 本身（ELECTRON_RUN_AS_NODE）當 Node。
const fs = require('original-fs')
const path = require('path')
const os = require('os')
const { spawn, execFile } = require('child_process')
const { request, abortError } = require('./util')

const DOWNLOAD_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
const UPDATE_EVERY = 7 * 24 * 3600 * 1000

let binDir = ''
let custom = ''
let ensuring = null

function init(dir) {
  binDir = dir
}

function setCustomPath(p) {
  custom = p || ''
}

const bundledPath = () => path.join(binDir, 'yt-dlp.exe')
const stampFile = () => path.join(binDir, 'yt-dlp.json')

function readStamp() {
  try {
    return JSON.parse(fs.readFileSync(stampFile(), 'utf8'))
  } catch {
    return {}
  }
}

/** 取得 yt-dlp 路徑，沒有就下載。onStatus(text) 給新增視窗顯示 */
async function ensure(onStatus) {
  if (custom && fs.existsSync(custom)) return custom
  const exe = bundledPath()
  if (fs.existsSync(exe)) return exe
  if (!ensuring) {
    ensuring = (async () => {
      fs.mkdirSync(binDir, { recursive: true })
      onStatus?.('第一次使用，正在下載 yt-dlp 元件（約 18 MB）…')
      const { res } = await request(DOWNLOAD_URL, { timeout: 60000 })
      if (res.statusCode !== 200) {
        res.resume()
        throw new Error('下載 yt-dlp 失敗（HTTP ' + res.statusCode + '）')
      }
      const tmp = exe + '.download'
      const total = Number(res.headers['content-length']) || 0
      let got = 0
      let lastPct = -1
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(tmp)
        res.on('data', (c) => {
          got += c.length
          const pct = total ? Math.floor((got / total) * 100) : -1
          if (pct !== lastPct && pct % 5 === 0) {
            lastPct = pct
            onStatus?.(`第一次使用，正在下載 yt-dlp 元件… ${pct}%`)
          }
        })
        res.on('error', reject)
        out.on('error', reject)
        out.on('finish', resolve)
        res.pipe(out)
      })
      if (got < 1024 * 1024) throw new Error('下載的 yt-dlp 不完整')
      fs.renameSync(tmp, exe)
      fs.writeFileSync(stampFile(), JSON.stringify({ updated: Date.now() }))
      return exe
    })().finally(() => (ensuring = null))
  }
  return ensuring
}

/** 背景更新（yt-dlp -U 會直接更新自己） */
function updateIfOld(force = false) {
  const exe = bundledPath()
  if (custom || !fs.existsSync(exe)) return Promise.resolve(null)
  if (!force && Date.now() - (readStamp().updated || 0) < UPDATE_EVERY) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(exe, ['-U'], { windowsHide: true, timeout: 120000, env: env() }, (err, stdout, stderr) => {
      if (!err) fs.writeFileSync(stampFile(), JSON.stringify({ updated: Date.now() }))
      resolve(String(stdout || stderr || (err && err.message) || '').trim())
    })
  })
}

function version() {
  return new Promise((resolve) => {
    const exe = custom && fs.existsSync(custom) ? custom : bundledPath()
    if (!fs.existsSync(exe)) return resolve('')
    execFile(exe, ['--version'], { windowsHide: true, timeout: 20000, env: env() }, (err, stdout) => resolve(err ? '' : String(stdout).trim()))
  })
}

function env() {
  // 讓 Electron 被 yt-dlp 叫起來時當成 Node；輸出一律 UTF-8，中文檔名才不會亂碼
  return { ...process.env, ELECTRON_RUN_AS_NODE: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
}

// ───────────────────────────── 支援的網站 ─────────────────────────────

/** 一般偵測抓不到（影音分段、加簽名）的網站，直接交給 yt-dlp。跟擴充功能的清單一致 */
const SITES = [
  { name: 'YouTube', re: /^https?:\/\/((www|m|music)\.)?youtube\.com\/(watch\?|shorts\/|live\/|embed\/)|^https?:\/\/youtu\.be\//i, noCookies: true },
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

function siteFor(url) {
  return SITES.find((s) => s.re.test(url)) || null
}

// ───────────────────────────── 執行 ─────────────────────────────

function baseArgs(ctx, headers, site) {
  const a = ['--no-playlist', '--no-color', '--js-runtimes', 'node:' + process.execPath]
  if (ctx.ffmpeg) a.push('--ffmpeg-location', ctx.ffmpeg)
  // YouTube 帶帳號 Cookie 給 yt-dlp 有被標記的風險，不帶；其他網站（例如 Bilibili 高畫質要登入）照帶
  if (!site?.noCookies) {
    if (headers?.['User-Agent']) a.push('--user-agent', headers['User-Agent'])
    if (headers?.Referer) a.push('--referer', headers.Referer)
    const cf = cookieFile(headers)
    if (cf) a.push('--cookies', cf)
  }
  return a
}

/** 把瀏覽器送來的 Cookie 標頭轉成 yt-dlp 吃的 Netscape cookies.txt（暫存檔） */
function cookieFile(headers) {
  const cookie = headers?.Cookie
  const ref = headers?.Referer
  if (!cookie || !ref) return ''
  let host
  try {
    host = new URL(ref).hostname.replace(/^(www|m)\./, '')
  } catch {
    return ''
  }
  const lines = ['# Netscape HTTP Cookie File']
  for (const part of cookie.split(/;\s*/)) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    lines.push(['.' + host, 'TRUE', '/', 'FALSE', '0', part.slice(0, i), part.slice(i + 1)].join('\t'))
  }
  const f = path.join(os.tmpdir(), `grabbox-cookies-${process.pid}-${Date.now()}.txt`)
  fs.writeFileSync(f, lines.join('\n') + '\n')
  // yt-dlp 讀完就不需要了
  setTimeout(() => fs.rm(f, { force: true }, () => {}), 10 * 60 * 1000)
  return f
}

function lastError(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => /^ERROR:/.test(l))
  const msg = (lines.pop() || String(text).trim().split(/\r?\n/).pop() || '').replace(/^ERROR:\s*(\[[^\]]+\]\s*)?([\w-]+:\s*)?/, '')
  if (/Sign in to confirm you.re not a bot/i.test(msg)) return 'YouTube 要求驗證，請稍後再試'
  if (/Private video|private/i.test(msg) && /video/i.test(msg)) return '這是私人影片，無法下載'
  if (/members-only|Join this channel/i.test(msg)) return '會員限定影片，無法下載'
  if (/age/i.test(msg) && /confirm|restricted|inappropriate/i.test(msg)) return '有年齡限制的影片，需要登入才能下載'
  if (/DRM/i.test(msg)) return '這個影片有 DRM 保護，無法下載'
  if (/Unsupported URL/i.test(msg)) return '這個網址沒有可下載的影片'
  return msg || 'yt-dlp 執行失敗'
}

/**
 * yt-dlp.exe 輸出到管線時用系統的 ANSI 編碼（繁中 Windows 是 cp950），環境變數改不掉。
 * 先當 UTF-8 解，有亂碼再用 Big5 解（錯誤訊息裡可能有中文標題）
 */
function decode(buf) {
  const s = buf.toString('utf8')
  if (!s.includes('�')) return s
  try {
    return new TextDecoder('big5').decode(buf)
  } catch {
    return s
  }
}

function runJson(exe, args, signal) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { windowsHide: true, env: env() })
    // -J 的 JSON 是純 ASCII（非英文字都是 \u 跳脫），不受編碼影響
    let out = ''
    let errBuf = Buffer.alloc(0)
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (errBuf = Buffer.concat([errBuf, d]).subarray(-16000)))
    const errText = () => decode(errBuf)
    const onAbort = () => killTree(p)
    signal?.addEventListener('abort', onAbort, { once: true })
    p.on('error', reject)
    p.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(abortError())
      if (code !== 0) return reject(new Error(lastError(errText())))
      try {
        resolve(JSON.parse(out))
      } catch {
        reject(new Error(lastError(errText()) || 'yt-dlp 回傳格式錯誤'))
      }
    })
  })
}

/** Windows 上 yt-dlp.exe 是打包過的 Python，底下還有子程序（ffmpeg），要整棵結束 */
function killTree(p) {
  if (!p.pid || p.exitCode !== null) return
  execFile('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true }, () => {})
}

/** 格式大小：沒有標示就用位元率 × 片長估 */
function sizeOf(f, duration) {
  if (!f) return 0
  return f.filesize || f.filesize_approx || (f.tbr && duration ? Math.round((f.tbr * 1000 * duration) / 8) : 0)
}

/**
 * 解析影片：回傳標題、片長、縮圖，以及畫質選項。
 * 選項的 id 是 yt-dlp 的格式選擇（-f / -S），audio 表示只要聲音。
 */
async function inspect(url, headers, signal, ctx, onStatus) {
  const exe = await ensure(onStatus)
  onStatus?.('正在解析影片…')
  const site = siteFor(url)
  const info = await runJson(exe, [...baseArgs(ctx, headers, site), '-J', url], signal)
  if (info._type === 'playlist') {
    const first = (info.entries || []).find(Boolean)
    if (!first) throw new Error('這個網址沒有可下載的影片')
    return shape(first.webpage_url ? await runJson(exe, [...baseArgs(ctx, headers, site), '-J', first.webpage_url], signal) : first, url, site)
  }
  return shape(info, url, site)
}

function shape(info, url, site) {
  const formats = info.formats || []
  const videos = formats.filter((f) => f.vcodec && f.vcodec !== 'none' && f.height)
  const audios = formats.filter((f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
  const byAbr = audios.sort((a, b) => (b.abr || 0) - (a.abr || 0))
  // 合併成 MP4 時 yt-dlp 會優先挑 m4a 音軌，大小估計也用它
  const bestAudio = byAbr.find((f) => f.ext === 'm4a') || byAbr[0]
  const heights = [...new Set(videos.map((f) => f.height))].sort((a, b) => b - a)
  const choices = []
  for (const h of heights) {
    const atH = videos.filter((f) => f.height === h)
    // 同畫質裡優先 mp4，大小估計用那一個
    const v = atH.find((f) => f.ext === 'mp4') || atH[0]
    const fps = Math.max(...atH.map((f) => f.fps || 0))
    const hasAudio = v.acodec && v.acodec !== 'none'
    const dur = info.duration
    const size = sizeOf(v, dur) + (hasAudio ? 0 : sizeOf(bestAudio, dur))
    choices.push({ id: 'v' + h, label: `${h}p${fps > 30 ? fps : ''}`, size, ext: 'mp4', height: h })
  }
  if (!heights.length && formats.length) choices.push({ id: 'best', label: '最佳畫質', size: sizeOf(formats[formats.length - 1], info.duration), ext: 'mp4' })
  if (bestAudio || audios.length) {
    choices.push({ id: 'a-m4a', label: '只要聲音（M4A 原始音質）', size: sizeOf(bestAudio, info.duration), ext: 'm4a', audio: true })
    // MP3 會重新編碼（最高品質約 245 kbps），大小用片長估
    const mp3Size = info.duration ? Math.round((info.duration * 245000) / 8) : sizeOf(byAbr[0])
    choices.push({ id: 'a-mp3', label: '只要聲音（MP3）', size: mp3Size, ext: 'mp3', audio: true })
  }
  if (!choices.length) throw new Error('找不到可下載的格式')
  return {
    title: info.title || info.id || 'video',
    duration: info.duration || 0,
    thumbnail: info.thumbnail || '',
    site: site?.name || info.extractor_key || info.extractor || '',
    uploader: info.uploader || info.channel || '',
    pageUrl: info.webpage_url || url,
    live: !!info.is_live,
    choices,
  }
}

/** 格式選項 → yt-dlp 參數 */
function formatArgs(id) {
  if (id === 'a-m4a') return ['-f', 'ba[ext=m4a]/ba', '-x', '--audio-format', 'm4a']
  if (id === 'a-mp3') return ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0']
  const h = /^v(\d+)$/.exec(id || '')?.[1]
  // 不超過選的畫質、同畫質優先 mp4 / m4a（相容性最好）
  const sort = h ? `res:${h},ext:mp4:m4a` : 'ext:mp4:m4a'
  return ['-f', 'bv*+ba/b', '-S', sort, '--merge-output-format', 'mp4']
}

/**
 * 下載。job.url = 網頁網址，job.format = 選項 id，job.file = 想要的輸出路徑（副檔名會照實際格式）。
 * 暫停 = 結束程序；繼續時 yt-dlp 會接著 .part 檔續傳。
 */
async function run(job, ctx) {
  const exe = await ensure()
  const site = siteFor(job.url)
  const ext = path.extname(job.file)
  const base = job.file.slice(0, job.file.length - ext.length)
  // 輸出範本裡 % 有特殊意義
  const tpl = base.replace(/%/g, '%%') + '.%(ext)s'
  // 最後的檔名寫到檔案（UTF-8）；印到 stdout 會被轉成系統編碼，中日文、emoji 會壞掉
  const pathFile = path.join(os.tmpdir(), `grabbox-ytdlp-${job.id}.txt`)
  fs.rmSync(pathFile, { force: true })
  const args = [
    ...baseArgs(ctx, job.headers, site),
    ...formatArgs(job.format),
    '-o',
    tpl,
    '--continue',
    '--no-mtime',
    '--concurrent-fragments',
    String(Math.min(16, Math.max(1, ctx.connections))),
    '--newline',
    '--progress',
    '--progress-template',
    'download:GBPROG %(info.format_id)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.status)s',
    '--print-to-file',
    'after_move:filepath',
    pathFile,
    job.url,
  ]
  job.phase = 'prepare'
  // 每次執行 yt-dlp 都會從頭回報各格式已下載的量，進度要重新累計；
  // 但等到第一筆進度才歸零，解析的那幾秒進度條才不會倒退
  const resuming = job.done > 0
  let reset = false
  ctx.save(true)

  const parts = new Map() // format_id → { done, total }
  let finalFile = ''
  let err = ''
  const p = spawn(exe, args, { windowsHide: true, env: env() })
  const onAbort = () => killTree(p)
  ctx.signal.addEventListener('abort', onAbort, { once: true })

  const onLine = (line) => {
    if (line.startsWith('GBPROG ')) {
      const [fid, done, total, est] = line.slice(7).split('|')
      const d = Number(done) || 0
      const t = Number(total) || Number(est) || 0
      const prev = parts.get(fid)
      if (!reset) {
        reset = true
        job.done = 0
      }
      // 續傳時第一筆進度就包含上次下載的部分：直接算進去，不要算成這一秒的速度
      if (!prev && resuming) job.done += d
      else if (d > (prev?.done || 0)) ctx.onProgress(d - (prev?.done || 0))
      parts.set(fid, { done: Math.max(prev?.done || 0, d), total: t || prev?.total || 0 })
      if (job.phase) {
        job.phase = ''
        ctx.save(true)
      }
      const sum = [...parts.values()].reduce((s, x) => s + x.total, 0)
      if (sum > 0) job.total = Math.max(sum, job.estimate || 0)
    } else if (/^\[(Merger|ExtractAudio|VideoConvertor|FixupM3u8|FixupM4a)\]/.test(line)) {
      job.phase = 'merge'
      ctx.save(true)
    }
  }
  // 用位元組切行（Big5 的第二個位元組不會是換行），每行再解碼
  const lineReader = (stream, keep) => {
    let buf = Buffer.alloc(0)
    stream.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      let i
      while ((i = buf.indexOf(10)) >= 0) {
        const line = decode(buf.subarray(0, i)).replace(/\r$/, '')
        buf = buf.subarray(i + 1)
        onLine(line)
        if (keep) err = (err + line + '\n').slice(-8000)
      }
    })
  }
  lineReader(p.stdout, false)
  lineReader(p.stderr, true)

  const code = await new Promise((resolve, reject) => {
    p.on('error', reject)
    p.on('close', resolve)
  })
  ctx.signal.removeEventListener('abort', onAbort)
  if (ctx.signal.aborted) throw abortError()
  if (code !== 0) throw new Error(lastError(err))
  try {
    finalFile = fs.readFileSync(pathFile, 'utf8').trim().split(/\r?\n/).pop() || ''
    fs.rmSync(pathFile, { force: true })
  } catch {}
  if (!finalFile || !fs.existsSync(finalFile)) {
    // 沒拿到路徑就猜：照範本找同名的檔
    const dir = path.dirname(base)
    const name = path.basename(base)
    const hit = fs.readdirSync(dir).find((n) => n.startsWith(name + '.') && !/\.(part|ytdl)$/.test(n) && !/\.f\d+\./.test(n))
    if (!hit) throw new Error('找不到下載完成的檔案')
    finalFile = path.join(dir, hit)
  }
  job.file = finalFile
  job.name = path.basename(finalFile)
  job.total = fs.statSync(finalFile).size
  job.done = job.total
  delete job.phase
}

/** 刪除任務時清掉 yt-dlp 的暫存檔（.part、還沒合併的 .f137.mp4 之類） */
function cleanup(job) {
  if (!job.file) return
  const ext = path.extname(job.file)
  const dir = path.dirname(job.file)
  const name = path.basename(job.file, ext)
  try {
    for (const n of fs.readdirSync(dir)) {
      if (!n.startsWith(name + '.')) continue
      if (/\.(part|ytdl)$/.test(n) || /\.f[\w-]+\.\w+(\.part)?$/.test(n.slice(name.length)) || /\.part-Frag\d+/.test(n)) fs.rmSync(path.join(dir, n), { force: true })
    }
  } catch {}
}

module.exports = { init, setCustomPath, ensure, updateIfOld, version, siteFor, inspect, run, cleanup, SITES, shape, formatArgs }
