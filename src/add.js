// 新增下載視窗：分析網址（大小、畫質、種子檔案清單）→ 選檔名 / 資料夾 → 開始
const $ = (s) => document.querySelector(s)
const id = new URLSearchParams(location.search).get('id')
let info = null
let busy = false

function fmtBytes(n) {
  if (!(n >= 0)) return '未知'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024
    i++
  }
  return (i ? n.toFixed(n < 10 ? 2 : n < 100 ? 1 : 0) : n) + ' ' + u[i]
}

function fmtDur(s) {
  s = Math.round(s || 0)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const p = (n) => String(n).padStart(2, '0')
  return h ? `${h}:${p(m)}:${p(s % 60)}` : `${m}:${p(s % 60)}`
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function setKind(kind) {
  const icon = kind === 'torrent' ? 'magnet' : kind === 'hls' ? 'stream' : kind === 'http' ? 'down' : 'plus'
  const el = $('#kindIcon')
  el.className = 'kind big ' + (kind || '')
  el.innerHTML = iconSvg(icon, 20)
}

function status(text, kind) {
  const el = $('#status')
  el.classList.toggle('hidden', !text)
  el.className = 'status' + (kind === 'err' ? ' err' : '') + (text ? '' : ' hidden')
  el.innerHTML = (kind === 'busy' ? '<div class="spin"></div>' : '') + `<span>${esc(text)}</span>`
}

function setReady(ok) {
  $('#start').disabled = !ok
  $('#later').disabled = !ok
}

async function analyze() {
  if (busy) return
  const url = $('#url').value.trim()
  if (!url && !init.req.torrentFile) return $('#url').focus()
  busy = true
  setReady(false)
  $('#info').classList.add('hidden')
  const isMagnet = /^magnet:/i.test(url)
  status(isMagnet ? '正在從 DHT / Tracker 取得種子資訊，可能要十幾秒…' : '分析中…', 'busy')
  try {
    // 種子檔是本機路徑，不能當網址送
    info = await gb.add.probe(id, init.req.torrentFile ? undefined : url)
    show()
  } catch (e) {
    status(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err')
  } finally {
    busy = false
  }
}

function show() {
  status('')
  setKind(info.kind)
  $('#info').classList.remove('hidden')
  $('#hlsBox').classList.toggle('hidden', info.kind !== 'hls')
  $('#torrentBox').classList.toggle('hidden', info.kind !== 'torrent')
  $('#nameBox').classList.toggle('hidden', info.kind === 'torrent')
  const facts = []
  const fact = (k, v, warn) => facts.push(`<div class="fact${warn ? ' warn' : ''}">${k ? esc(k) + ' ' : ''}<b>${esc(v)}</b></div>`)

  if (info.kind === 'http') {
    $('#headTitle').textContent = info.name
    $('#headSub').textContent = info.media ? '影片 / 音訊檔' : '一般檔案'
    $('#name').value = info.name
    fact('大小', fmtBytes(info.size))
    if (info.mime) fact('類型', info.mime)
    fact('', info.resumable ? '支援多連線與續傳' : '不支援續傳（單一連線）', !info.resumable)
  } else if (info.kind === 'hls') {
    $('#headTitle').textContent = info.name
    $('#headSub').textContent = 'HLS 串流影片（會自動合併成 MP4）'
    $('#name').value = info.name
    const sel = $('#variant')
    sel.innerHTML = info.variants.map((v, i) => `<option value="${i}">${esc(v.label)}${v.size ? '　約 ' + fmtBytes(v.size) : ''}${v.audioUrl ? '　（另有音軌）' : ''}</option>`).join('')
    if (info.duration) fact('片長', fmtDur(info.duration))
    if (info.segs) fact('片段', info.segs + ' 個')
    if (info.encrypted) fact('', 'AES-128 加密（會自動解密）')
    if (info.live) fact('', '直播：只會下載目前已有的片段', true)
    if (!info.ffmpeg) fact('', '找不到 ffmpeg，會存成 .ts', true)
  } else if (info.kind === 'torrent') {
    $('#headTitle').textContent = info.name
    $('#headSub').textContent = 'BT 種子'
    fact('檔案', info.files.length + ' 個')
    fact('總大小', fmtBytes(info.total))
    if (info.private) fact('', '私有種子（只用 Tracker）')
    $('#files').innerHTML = info.files
      .map((f, i) => `<label><input type="checkbox" data-i="${i}" checked /><span class="p">${esc(f.path)}</span><span class="z">${fmtBytes(f.length)}</span></label>`)
      .join('')
    updateTorrentSel()
  }
  $('#facts').innerHTML = facts.join('')
  setReady(true)
  $('#start').focus()
}

function checkedFiles() {
  return [...document.querySelectorAll('#files input')].filter((c) => c.checked).map((c) => Number(c.dataset.i))
}

function updateTorrentSel() {
  const sel = checkedFiles()
  const size = sel.reduce((s, i) => s + info.files[i].length, 0)
  $('#footNote').textContent = `已選 ${sel.length} / ${info.files.length} 個檔案 · ${fmtBytes(size)}`
  setReady(sel.length > 0)
}

$('#files').addEventListener('change', updateTorrentSel)
const setAll = (fn) => {
  document.querySelectorAll('#files input').forEach((c) => (c.checked = fn(info.files[c.dataset.i])))
  updateTorrentSel()
}
$('#selAll').onclick = () => setAll(() => true)
$('#selNone').onclick = () => setAll(() => false)
$('#selVideo').onclick = () => setAll((f) => /\.(mp4|mkv|avi|mov|wmv|webm|m4v|ts|flv|rmvb|iso)$/i.test(f.path))

async function confirm(paused) {
  if (!info) return
  const dir = $('#dir').value.trim()
  const spec = { kind: info.kind, dir, paused }
  if (info.kind === 'torrent') {
    Object.assign(spec, {
      name: info.name,
      infoHash: info.infoHash,
      magnet: info.magnet || '',
      files: info.files,
      selected: checkedFiles(),
      total: checkedFiles().reduce((s, i) => s + info.files[i].length, 0),
      private: info.private,
    })
  } else {
    const name = $('#name').value.trim()
    if (!name) return $('#name').focus()
    Object.assign(spec, { url: info.url, name, total: info.size || -1 })
    if (info.kind === 'hls') {
      const v = info.variants[Number($('#variant').value) || 0]
      spec.tracks = [{ url: v.url, type: 'video' }]
      if (v.audioUrl) spec.tracks.push({ url: v.audioUrl, type: 'audio' })
      spec.total = v.size || -1
    }
  }
  setReady(false)
  try {
    await gb.add.confirm(id, spec)
  } catch (e) {
    status(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err')
    setReady(true)
  }
}

$('#start').onclick = () => confirm(false)
$('#later').onclick = () => confirm(true)
$('#cancel').onclick = () => window.close()
$('#analyze').onclick = analyze
$('#url').addEventListener('keydown', (e) => e.key === 'Enter' && analyze())
$('#dirBtn').onclick = async () => {
  const d = await gb.settings.chooseDir()
  if (d) $('#dir').value = d
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.close()
  if (e.key === 'Enter' && e.target.id !== 'url' && !$('#start').disabled) confirm(false)
})

let init = null
;(async () => {
  applyIcons()
  setKind('')
  init = await gb.add.init(id)
  if (!init) return window.close()
  $('#dir').value = init.settings.dir
  const r = init.req
  if (r.torrentFile) {
    $('#url').value = r.torrentFile
    $('#url').readOnly = true
    analyze()
  } else if (r.url) {
    $('#url').value = r.url
    if (r.title) $('#headSub').textContent = r.title
    analyze()
  } else {
    $('#url').focus()
  }
})()
