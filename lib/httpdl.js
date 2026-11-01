// 一般檔案下載：伺服器支援 Range 時切成多段、多條連線同時下載（像 IDM），寫進 .gbpart 的對應位置。
// 同一個檔案還放在其他 CDN 主機上時，連線分散到各台一起抓（見 mirrors.js）。
// 進度記在 job.chunks（每段一個字元，1 = 完成），暫停、關程式再開都能從原位置續傳。
const fs = require('original-fs')
const { request, httpError, abortError } = require('./util')
const mirrors = require('./mirrors')

const MB = 1024 * 1024

/** 探測檔案大小、是否支援續傳、伺服器給的檔名 */
async function probe(url, headers, signal) {
  const { res, url: finalUrl } = await request(url, { headers: { ...headers, Range: 'bytes=0-0' }, signal })
  res.destroy()
  if (res.statusCode >= 400) throw httpError(res.statusCode)
  const h = res.headers
  let total = -1
  let resumable = false
  if (res.statusCode === 206) {
    const m = /\/(\d+)\s*$/.exec(h['content-range'] || '')
    if (m) {
      total = Number(m[1])
      resumable = true
    }
  } else if (h['content-length']) {
    total = Number(h['content-length'])
  }
  return {
    total,
    resumable,
    finalUrl,
    mime: String(h['content-type'] || '').split(';')[0].trim(),
    disposition: h['content-disposition'] || '',
  }
}

/** 每段的大小：檔案越大段越大，請求數量維持在幾百個以內 */
function chunkSizeFor(total) {
  return Math.min(16 * MB, Math.max(MB, Math.ceil(total / 512 / MB) * MB))
}

/**
 * 下載到 job.part。ctx = { signal, connections, onProgress(bytesDelta), save() }
 * 完成時 resolve，暫停（signal abort）時 reject AbortError。
 */
async function run(job, ctx) {
  if (!job.probed) {
    const p = await probe(job.url, job.headers, ctx.signal)
    job.total = p.total
    job.resumable = p.resumable && p.total > 0
    job.probed = true
  }
  if (!job.resumable) return single(job, ctx)

  if (!job.chunkSize || !job.chunks) {
    job.chunkSize = chunkSizeFor(job.total)
    job.chunks = '0'.repeat(Math.ceil(job.total / job.chunkSize))
  }
  const count = job.chunks.length
  const done = job.chunks.split('')
  job.done = done.reduce((s, c, i) => s + (c === '1' ? chunkLen(job, i) : 0), 0)

  // 已經有的部分檔：用 r+ 才不會把內容清掉
  const fd = fs.openSync(job.part, fs.existsSync(job.part) ? 'r+' : 'w')
  // 多 CDN：先用原本的網址開始下載，同時在背景找鏡像（每次開始都重新找，主機狀況會變），找到再一起抓。剩沒幾段就不找了
  const findCtl = new AbortController()
  const more =
    done.filter((c) => c !== '1').length >= 4
      ? mirrors.find(job.url, job.headers, AbortSignal.any([ctx.signal, findCtl.signal])).then((urls) => urls.map((u) => ({ key: new URL(u).host, href: u, any: true })))
      : null
  try {
    await mirrors.runTasks({
      count,
      isDone: (i) => done[i] === '1',
      connections: Math.max(1, Math.min(ctx.connections, count)),
      signal: ctx.signal,
      hosts: [{ key: '', href: job.url, any: true }],
      more,
      waitMore: 1500,
      fetch: async (i, host, signal) => {
        await fetchChunk(job, i, fd, { ...ctx, signal }, host.href)
        // 拖太久的段會從另一台重抓一份：另一份先完成了，這份的進度不要重複算
        if (done[i] === '1') {
          ctx.onProgress(-chunkLen(job, i))
          return 0
        }
        done[i] = '1'
        job.chunks = done.join('')
        ctx.save()
        return chunkLen(job, i)
      },
      onHosts: (n) => {
        job.hosts = n
        ctx.save(true)
      },
    })
  } finally {
    findCtl.abort()
    fs.closeSync(fd)
  }
  job.done = job.total
}

function chunkLen(job, i) {
  const start = i * job.chunkSize
  return Math.min(job.chunkSize, job.total - start)
}

/** 下載一段；中途失敗時把這段已算進進度的位元組退回去 */
async function fetchChunk(job, i, fd, ctx, url = job.url) {
  const start = i * job.chunkSize
  const end = start + chunkLen(job, i) - 1
  const { res } = await request(url, { headers: { ...job.headers, Range: `bytes=${start}-${end}` }, signal: ctx.signal })
  if (res.statusCode !== 206) {
    res.destroy()
    // 200 代表伺服器這次不理 Range，整份重傳，不能拿來寫進中間的位置
    throw res.statusCode >= 400 ? httpError(res.statusCode) : new Error('伺服器不支援分段（' + res.statusCode + '）')
  }
  let pos = start
  try {
    for await (const buf of res) {
      const len = Math.min(buf.length, end + 1 - pos)
      if (len <= 0) break
      await write(fd, buf, len, pos)
      pos += len
      ctx.onProgress(len)
    }
  } catch (e) {
    ctx.onProgress(-(pos - start))
    throw e
  }
  if (pos !== end + 1) {
    ctx.onProgress(-(pos - start))
    throw new Error('連線中斷')
  }
}

/** 不支援 Range 的伺服器：只能一條連線從頭下載，暫停後要重來 */
async function single(job, ctx) {
  job.done = 0
  const { res } = await request(job.url, { headers: job.headers, signal: ctx.signal, timeout: 60000 })
  if (res.statusCode >= 400) {
    res.resume()
    throw httpError(res.statusCode)
  }
  const len = Number(res.headers['content-length'])
  if (len > 0) job.total = len
  const fd = fs.openSync(job.part, 'w')
  let pos = 0
  try {
    for await (const buf of res) {
      await write(fd, buf, buf.length, pos)
      pos += buf.length
      ctx.onProgress(buf.length)
    }
  } finally {
    fs.closeSync(fd)
  }
  if (ctx.signal.aborted) throw abortError()
  if (job.total > 0 && pos < job.total) throw new Error('連線中斷')
  job.total = pos
}

function write(fd, buf, len, pos) {
  return new Promise((resolve, reject) => fs.write(fd, buf, 0, len, pos, (err) => (err ? reject(err) : resolve())))
}

module.exports = { probe, run }
