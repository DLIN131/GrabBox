// 內建的網站解析：yt-dlp 不支援、網路請求裡也認不出影片的網站，自己從網頁找出播放清單網址，交給 HLS 下載。
// 清單跟擴充功能 background.js 的 SITES（builtin: true 的那幾個）一致
const { fetchBuffer } = require('./util')

const SITES = [
  // 網域常換（rouvb1.xyz、rou.video…），比對名稱就好
  { name: '肉視頻', re: /^https?:\/\/(www\.)?rou(vb\d*|video\d*)?\.[a-z]+\/v\/[a-z0-9]+/i, resolve: rouVideo },
]

function siteFor(url) {
  return SITES.find((s) => s.re.test(url)) || null
}

/**
 * 肉視頻：網頁資料裡有 ev: { d: base64, k: 數字 }，base64 解開後每個字元減 k 是 JSON { videoUrl: '/api/hls/<id>' }。
 * 那個網址會轉到 index.png：播放清單和片段都包在 PNG 裡（hls.js 的 unwrapPng 會拆開）。
 * 回傳 { url: 播放清單網址, title }
 */
async function rouVideo(url, headers, signal) {
  const { buf, url: finalUrl } = await fetchBuffer(url, { headers, signal }, 8 * 1024 * 1024)
  const html = buf.toString('utf8')
  let videoUrl = ''
  const m = /\bev:(?:\$R\[\d+\]=)?\{d:"([A-Za-z0-9+/=]+)",k:(\d+)\}/.exec(html)
  if (m) {
    try {
      const k = Number(m[2])
      const text = [...Buffer.from(m[1], 'base64').toString('latin1')].map((c) => String.fromCharCode(c.charCodeAt(0) - k)).join('')
      videoUrl = JSON.parse(text).videoUrl || ''
    } catch {}
  }
  // 解不出來（網站改版）就用目前固定的 API 路徑試試
  const id = new URL(finalUrl).pathname.split('/')[2]
  if (!videoUrl && id) videoUrl = '/api/hls/' + id
  if (!videoUrl) throw new Error('網頁裡找不到影片')
  const title = decodeEntities(/<title>([^<]*)<\/title>/i.exec(html)?.[1] || '').replace(/\s+-\s+肉視頻.*$/, '').trim()
  return { url: new URL(videoUrl, finalUrl).href, title }
}

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (all, e) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()]
    if (named) return named
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return Number.isFinite(n) ? String.fromCodePoint(n) : all
  })
}

module.exports = { SITES, siteFor }
