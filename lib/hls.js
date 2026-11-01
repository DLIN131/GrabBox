// HLS（m3u8）串流下載：抓播放清單 → 多條連線下載片段（AES-128 會解密）→ 接起來 → ffmpeg 轉成 MP4。
// 片段先放在 <檔名>.gbhls 資料夾，完成的片段記在 job.segDone，可以續傳。
const fs = require('original-fs')
const path = require('path')
const crypto = require('crypto')
const zlib = require('zlib')
const { promisify } = require('util')
const { spawn } = require('child_process')
const { fetchBuffer, abortError } = require('./util')
const { sleep } = require('./httpdl')

const inflate = promisify(zlib.inflate)

function attrs(line) {
  const out = {}
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g
  let m
  while ((m = re.exec(line))) out[m[1]] = m[2].replace(/^"|"$/g, '')
  return out
}

function byterange(s, prevEnd) {
  if (!s) return null
  const [len, off] = s.split('@')
  const offset = off !== undefined ? Number(off) : prevEnd
  return { offset, length: Number(len) }
}

/** 解析播放清單。master 會有 variants；media 會有 segments */
function parse(text, base) {
  if (!/^﻿?#EXTM3U/.test(text.trimStart())) throw new Error('不是 HLS 播放清單')
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  const abs = (u) => new URL(u, base).href
  const pl = { master: false, variants: [], audios: {}, segments: [], endList: false, duration: 0, drm: false, encrypted: false }
  let seq = 0
  let key = null
  let map = null
  let pendingInf = null
  let pendingStream = null
  let pendingRange = null
  let lastEnd = 0
  // 中斷點（#EXT-X-DISCONTINUITY）把片段分成好幾段，插播廣告通常自成一段
  let period = 0
  let inCue = false
  // DATERANGE 標的廣告：從標記開始，到廣告片段之後的下一個中斷點為止
  let dateAd = false
  let dateAdSeen = false
  for (const line of lines) {
    if (!line) continue
    if (line === '#EXT-X-DISCONTINUITY') {
      period++
      if (dateAd && dateAdSeen) dateAd = dateAdSeen = false
    } else if (/^#EXT-X-CUE-OUT(?!-CONT)/.test(line)) {
      inCue = true
    } else if (/^#EXT-X-CUE-IN/.test(line)) {
      inCue = false
    } else if (line.startsWith('#EXT-X-DATERANGE:') && /CLASS="[^"]*\bad|X-AD-|SCTE35-OUT/i.test(line)) {
      dateAd = true
      dateAdSeen = false
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pl.master = true
      pendingStream = attrs(line.slice(18))
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = attrs(line.slice(13))
      if (a.TYPE === 'AUDIO' && a.URI) {
        ;(pl.audios[a['GROUP-ID']] ||= []).push({ url: abs(a.URI), name: a.NAME || a.LANGUAGE || '', lang: a.LANGUAGE || '', def: a.DEFAULT === 'YES' })
      }
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      seq = Number(line.slice(22)) || 0
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = attrs(line.slice(11))
      if (a.METHOD === 'NONE') key = null
      else {
        // 只有 AES-128 整段加密能自己解；SAMPLE-AES、FairPlay（skd://）都是 DRM
        if (a.METHOD !== 'AES-128' || !a.URI || /^skd:/i.test(a.URI)) pl.drm = true
        key = { method: a.METHOD, uri: a.URI ? (a.URI.startsWith('data:') ? a.URI : abs(a.URI)) : '', iv: a.IV || '' }
        pl.encrypted = true
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = attrs(line.slice(11))
      map = { url: abs(a.URI), range: a.BYTERANGE ? byterange(a.BYTERANGE, 0) : null }
    } else if (line.startsWith('#EXTINF:')) {
      pendingInf = parseFloat(line.slice(8)) || 0
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = line.slice(17)
    } else if (line === '#EXT-X-ENDLIST') {
      pl.endList = true
    } else if (!line.startsWith('#')) {
      if (pendingStream) {
        const s = pendingStream
        pl.variants.push({
          url: abs(line),
          bandwidth: Number(s['AVERAGE-BANDWIDTH'] || s.BANDWIDTH) || 0,
          resolution: s.RESOLUTION || '',
          codecs: s.CODECS || '',
          audioGroup: s.AUDIO || '',
        })
        pendingStream = null
      } else if (pendingInf !== null) {
        const range = byterange(pendingRange, lastEnd)
        if (range) lastEnd = range.offset + range.length
        pl.segments.push({ url: abs(line), duration: pendingInf, seq, key, map, range, period, cue: inCue || dateAd })
        if (dateAd) dateAdSeen = true
        pl.duration += pendingInf
        seq++
        pendingInf = null
        pendingRange = null
      }
    }
  }
  return pl
}

/** 片段網址的「樣子」：主機 + 路徑，把數字換掉（seg-001.ts、seg-002.ts 會是同一種） */
function signature(url) {
  try {
    const u = new URL(url)
    return u.host + u.pathname.replace(/\d+/g, '#')
  } catch {
    return url
  }
}

/**
 * 找出插播的廣告片段並拿掉。判斷方式：
 * 1. 有 CUE-OUT / 廣告 DATERANGE 標記的片段
 * 2. 有中斷點分段時，網址樣子跟正片（總長最長的那種）不一樣、而且很短的一段
 * 回傳 { segments, adSeconds }
 */
function stripAds(segments) {
  const total = segments.reduce((s, x) => s + x.duration, 0)
  const bySig = new Map()
  for (const s of segments) bySig.set(signature(s.url), (bySig.get(signature(s.url)) || 0) + s.duration)
  const mainSig = [...bySig.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const periods = new Map()
  for (const s of segments) {
    if (!periods.has(s.period)) periods.set(s.period, [])
    periods.get(s.period).push(s)
  }
  const adPeriods = new Set()
  if (periods.size > 1) {
    for (const [p, list] of periods) {
      const dur = list.reduce((s, x) => s + x.duration, 0)
      const main = list.filter((x) => signature(x.url) === mainSig).length
      // 這一段大部分片段都不是正片的樣子，而且不長（一次插播通常幾十秒，最多兩三分鐘）
      if (main < list.length / 2 && dur <= 150 && dur < total * 0.5) adPeriods.add(p)
    }
  }
  const kept = segments.filter((s) => !s.cue && !adPeriods.has(s.period))
  // 全部都被判成廣告就是判斷錯了，照原樣下載
  if (!kept.length) return { segments, adSeconds: 0 }
  const adSeconds = total - kept.reduce((s, x) => s + x.duration, 0)
  return { segments: kept, adSeconds }
}

async function load(url, headers, signal) {
  const { buf, url: finalUrl } = await fetchBuffer(url, { headers, signal }, 16 * 1024 * 1024)
  const pl = parse((await unwrapPng(buf)).toString('utf8'), finalUrl)
  if (!pl.master && pl.segments.length) {
    const r = stripAds(pl.segments)
    pl.segments = r.segments
    pl.adSeconds = r.adSeconds
    pl.duration = r.segments.reduce((s, x) => s + x.duration, 0)
  }
  return pl
}

function qualityLabel(v) {
  const h = /x(\d+)/.exec(v.resolution || '')?.[1]
  const parts = []
  if (h) parts.push(h + 'p')
  if (v.bandwidth) parts.push((v.bandwidth / 1e6).toFixed(v.bandwidth < 1e7 ? 1 : 0) + ' Mbps')
  return parts.join(' · ') || '預設'
}

function pickAudio(pl, v) {
  const list = pl.audios[v.audioGroup]
  if (!list || !list.length) return ''
  return (list.find((a) => a.def) || list[0]).url
}

/** 給新增視窗用：列出可選的畫質、片長、估計大小 */
async function inspect(url, headers, signal) {
  const pl = await load(url, headers, signal)
  if (!pl.master) {
    return { variants: [{ url, label: '預設', audioUrl: '' }], duration: pl.duration, segs: pl.segments.length, live: !pl.endList, drm: pl.drm, encrypted: pl.encrypted, adSeconds: pl.adSeconds || 0 }
  }
  const variants = pl.variants
    .sort((a, b) => b.bandwidth - a.bandwidth)
    .map((v) => ({ url: v.url, label: qualityLabel(v), bandwidth: v.bandwidth, resolution: v.resolution, audioUrl: pickAudio(pl, v) }))
  // 抓最高畫質那一份，拿片長
  let info = { duration: 0, segs: 0, live: false, drm: false, encrypted: false, adSeconds: 0 }
  try {
    const top = await load(variants[0].url, headers, signal)
    info = { duration: top.duration, segs: top.segments.length, live: !top.endList, drm: top.drm, encrypted: top.encrypted, adSeconds: top.adSeconds || 0 }
  } catch {}
  for (const v of variants) if (v.bandwidth && info.duration) v.size = Math.round((v.bandwidth * info.duration) / 8)
  return { variants, ...info }
}

/** 片段清單；init 段（EXT-X-MAP）在換的時候插進去 */
function pieces(pl, track) {
  const out = []
  let lastMap = null
  for (const s of pl.segments) {
    if (s.map && (!lastMap || s.map.url !== lastMap.url || s.map.range?.offset !== lastMap.range?.offset)) {
      out.push({ track, url: s.map.url, range: s.map.range, key: null, init: true, period: s.period })
      lastMap = s.map
    }
    out.push({ track, url: s.url, range: s.range, key: s.key, seq: s.seq, period: s.period })
  }
  return { list: out, fmp4: !!lastMap }
}

function ivFor(key, seq) {
  if (key.iv) {
    const hex = key.iv.replace(/^0x/i, '').padStart(32, '0')
    return Buffer.from(hex, 'hex')
  }
  const iv = Buffer.alloc(16)
  iv.writeUInt32BE(seq >>> 0, 12)
  iv.writeUInt32BE(Math.floor(seq / 2 ** 32), 8)
  return iv
}

/**
 * 下載整個串流。job.tracks = [{ url, type: 'video'|'audio' }]，輸出到 job.file（.mp4）
 * ctx = { signal, connections, onProgress(delta), save(), ffmpeg }
 */
async function run(job, ctx) {
  const headers = job.headers
  const all = []
  const fmp4 = []
  for (let t = 0; t < job.tracks.length; t++) {
    let pl = await load(job.tracks[t].url, headers, ctx.signal)
    if (pl.master) {
      // 直接丟 master 進來（沒經過新增視窗）就挑最高畫質
      const v = pl.variants.sort((a, b) => b.bandwidth - a.bandwidth)[0]
      if (!v) throw new Error('播放清單裡沒有影片')
      const audio = pickAudio(pl, v)
      job.tracks[t].url = v.url
      if (audio && !job.tracks.some((x) => x.type === 'audio')) job.tracks.push({ url: audio, type: 'audio' })
      pl = await load(v.url, headers, ctx.signal)
    }
    if (pl.drm) throw new Error('這個影片有 DRM 保護，無法下載')
    if (!pl.segments.length) throw new Error('播放清單是空的')
    const p = pieces(pl, t)
    all.push(...p.list)
    fmp4[t] = p.fmp4
  }

  const tmp = job.part
  fs.mkdirSync(tmp, { recursive: true })
  if (!job.segDone || job.segDone.length !== all.length) {
    job.segDone = '0'.repeat(all.length)
    job.done = 0
  }
  job.segs = all.length
  const done = job.segDone.split('')
  const keys = new Map()
  const getKey = async (uri) => {
    if (!keys.has(uri)) {
      keys.set(
        uri,
        (async () => {
          if (uri.startsWith('data:')) return Buffer.from(uri.split(',')[1], 'base64')
          const { buf } = await fetchBuffer(uri, { headers, signal: ctx.signal }, 4096)
          if (buf.length !== 16) throw new Error('解密金鑰格式不對')
          return buf
        })(),
      )
    }
    try {
      return await keys.get(uri)
    } catch (e) {
      keys.delete(uri)
      throw e
    }
  }

  const segFile = (i) => path.join(tmp, i + '.seg')
  let nextIdx = 0
  let failed = null
  const updateEstimate = () => {
    const n = done.filter((c) => c === '1').length
    job.progress = n / all.length
    if (n) job.total = Math.round((job.done / Math.max(1, n)) * all.length)
  }
  updateEstimate()

  const worker = async () => {
    for (;;) {
      if (failed || ctx.signal.aborted) return
      while (nextIdx < all.length && done[nextIdx] === '1') nextIdx++
      if (nextIdx >= all.length) return
      const i = nextIdx++
      const p = all[i]
      let tries = 0
      for (;;) {
        try {
          const h = { ...headers }
          if (p.range) h.Range = `bytes=${p.range.offset}-${p.range.offset + p.range.length - 1}`
          let { buf } = await fetchBuffer(p.url, { headers: h, signal: ctx.signal, timeout: 30000 }, 512 * 1024 * 1024)
          buf = await unwrapPng(buf)
          if (p.key && p.key.method === 'AES-128') {
            const k = await getKey(p.key.uri)
            const d = crypto.createDecipheriv('aes-128-cbc', k, ivFor(p.key, p.seq))
            buf = Buffer.concat([d.update(buf), d.final()])
          }
          if (!fmp4[p.track] && !p.init) buf = alignTs(buf)
          fs.writeFileSync(segFile(i), buf)
          done[i] = '1'
          job.segDone = done.join('')
          ctx.onProgress(buf.length)
          updateEstimate()
          ctx.save()
          break
        } catch (e) {
          if (ctx.signal.aborted) return
          if (e.status && [401, 403, 404, 410].includes(e.status) && tries >= 2) {
            failed = e
            return
          }
          if (++tries >= 6) {
            failed = e
            return
          }
          await sleep(Math.min(8000, 700 * 2 ** tries), ctx.signal).catch(() => {})
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(ctx.connections, all.length)) }, worker))
  if (ctx.signal.aborted) throw abortError()
  if (failed) throw failed

  // 每個軌道接起來。TS 有中斷點時每一段各自接成一個檔，再交給 ffmpeg 的 concat 重新排時間戳：
  // 中斷點後時間戳常常從 0 重來，直接整個接起來轉檔會被截斷（只剩前面幾秒）
  job.phase = 'merge'
  ctx.save(true)
  const inputs = []
  for (let t = 0; t < job.tracks.length; t++) {
    const ext = fmp4[t] ? '.mp4' : '.ts'
    const idx = all.map((_, i) => i).filter((i) => all[i].track === t)
    const order = [...new Set(idx.map((i) => all[i].period))]
    const groups = !fmp4[t] && ctx.ffmpeg && order.length > 1 ? order.map((pp) => idx.filter((i) => all[i].period === pp)) : [idx]
    const files = []
    for (let g = 0; g < groups.length; g++) {
      const f = path.join(tmp, `track${t}_${g}${ext}`)
      await joinFiles(groups[g].map(segFile), f, ctx.signal)
      files.push(f)
    }
    if (files.length === 1) inputs.push({ file: files[0], ext })
    else {
      const list = path.join(tmp, `track${t}.txt`)
      // concat 清單用正斜線；單引號要跳脫
      fs.writeFileSync(list, files.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n')
      inputs.push({ file: list, concat: true, parts: files, ext })
    }
  }

  let finalFile = job.file
  let ok = false
  if (ctx.ffmpeg) {
    try {
      await remux(ctx.ffmpeg, inputs, finalFile, ctx.signal)
      ok = true
    } catch (e) {
      if (ctx.signal.aborted) throw abortError()
      console.warn('ffmpeg 轉檔失敗，保留原始格式', e.message)
    }
  }
  if (!ok) {
    // 沒有 ffmpeg 或轉檔失敗：直接保留接好的 .ts / .mp4
    const single = async (inp, t) => {
      if (!inp.concat) return inp.file
      const f = path.join(tmp, `track${t}${inp.ext}`)
      await joinFiles(inp.parts, f, ctx.signal)
      return f
    }
    finalFile = job.file.replace(/\.[^.\\/]+$/, '') + inputs[0].ext
    fs.renameSync(await single(inputs[0], 0), finalFile)
    if (inputs[1]) fs.renameSync(await single(inputs[1], 1), finalFile.replace(/\.[^.\\/]+$/, '') + '.audio' + inputs[1].ext)
  }
  fs.rmSync(tmp, { recursive: true, force: true })
  job.file = finalFile
  job.total = fs.statSync(finalFile).size
  job.done = job.total
  delete job.phase
  return finalFile
}

/** 依序把檔案接成一個（非同步讀寫，幾千個片段時主程序才不會卡住） */
async function joinFiles(files, out, signal) {
  const h = await fs.promises.open(out, 'w')
  try {
    for (const f of files) {
      if (signal?.aborted) throw abortError()
      await h.write(await fs.promises.readFile(f))
    }
  } finally {
    await h.close()
  }
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * 有些網站（例如肉視頻）把播放清單和片段整個包進一張 PNG：真正的內容放在自訂的 roUd 區塊，
 * 區塊第一個位元組是旗標（bit 0 = 有 deflate 壓縮），後面才是內容。不是這種格式就原樣回傳
 */
async function unwrapPng(buf) {
  if (buf.length < 16 || !buf.subarray(0, 8).equals(PNG_SIG)) return buf
  // PNG 區塊：長度（4）+ 類型（4）+ 資料 + CRC（4）
  for (let i = 8; i + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(i)
    const data = i + 8
    if (data + len > buf.length) break
    if (buf.toString('latin1', i + 4, i + 8) === 'roUd' && len > 0) {
      const body = buf.subarray(data + 1, data + len)
      return buf[data] & 1 ? inflate(body) : body
    }
    i = data + len + 4
  }
  return buf
}

/**
 * 有些網站把 TS 片段偽裝成圖片（前面塞一段 PNG / JPEG 標頭），ffmpeg 讀到就壞掉。
 * TS 每 188 位元組一個封包、開頭都是 0x47：找到連續三個對得上的位置，從那裡開始
 */
function alignTs(buf) {
  if (buf.length < 188 * 3 || (buf[0] === 0x47 && buf[188] === 0x47)) return buf
  const limit = Math.min(buf.length - 188 * 2, 1024 * 1024)
  for (let i = 1; i < limit; i++) {
    if (buf[i] === 0x47 && buf[i + 188] === 0x47 && buf[i + 376] === 0x47) return buf.subarray(i)
  }
  return buf
}

function remux(ffmpeg, inputs, out, signal) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y']
  for (const inp of inputs) {
    if (inp.concat) args.push('-f', 'concat', '-safe', '0')
    args.push('-i', inp.file)
  }
  // 只取影像和聲音，TS 裡的 ID3 等資料軌放進 MP4 會出錯
  args.push('-map', '0:v?', '-map', '0:a?')
  if (inputs[1]) args.push('-map', '1:a?')
  args.push('-c', 'copy', '-movflags', '+faststart', out)
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { windowsHide: true })
    let err = ''
    p.stderr.on('data', (d) => (err = (err + d).slice(-2000)))
    const onAbort = () => p.kill()
    signal?.addEventListener('abort', onAbort, { once: true })
    p.on('error', reject)
    p.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (code === 0 && fs.existsSync(out) && fs.statSync(out).size > 0) resolve()
      else {
        try {
          fs.rmSync(out, { force: true })
        } catch {}
        reject(new Error(err.trim() || 'ffmpeg 結束代碼 ' + code))
      }
    })
  })
}

module.exports = { parse, inspect, run, stripAds, alignTs, unwrapPng }
