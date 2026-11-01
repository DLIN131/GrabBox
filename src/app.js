// 主視窗：下載清單、分類、工具列、右鍵選單、詳細資訊、設定
const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]

const jobs = new Map()
const rows = new Map() // id → row element
const selected = new Set()
let lastClicked = null
let cat = 'all'
let query = ''

// ───────────────────────────── 格式化 ─────────────────────────────

function fmtBytes(n) {
  if (!(n >= 0)) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024
    i++
  }
  return (i ? n.toFixed(n < 10 ? 2 : n < 100 ? 1 : 0) : n) + ' ' + u[i]
}

function fmtTime(s) {
  if (!isFinite(s) || s < 0) return '—'
  s = Math.round(s)
  if (s < 60) return s + ' 秒'
  if (s < 3600) return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒'
  if (s < 86400 * 2) return Math.floor(s / 3600) + ' 小時 ' + Math.floor((s % 3600) / 60) + ' 分'
  return Math.floor(s / 86400) + ' 天'
}

function fmtDate(t) {
  if (!t) return ''
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

// ───────────────────────────── 任務狀態 ─────────────────────────────

const VIDEO_RE = /\.(mp4|m4v|webm|mkv|mov|flv|avi|wmv|ts|mpg|mpeg|3gp)$/i

function isVideo(j) {
  return j.kind === 'hls' || VIDEO_RE.test(j.name || '')
}

function progressOf(j) {
  if (j.status === 'done') return 1
  if (j.kind === 'hls' && j.progress >= 0) return j.progress
  return j.total > 0 ? Math.min(1, j.done / j.total) : -1
}

function statusText(j) {
  switch (j.status) {
    case 'queued':
      return '排隊中'
    case 'paused':
      return '已暫停'
    case 'error':
      return '錯誤：' + (j.error || '未知錯誤')
    case 'done':
      return '已完成 · ' + fmtDate(j.finished)
    case 'seeding':
      return `做種中 · 分享率 ${ratio(j)} · 節點 ${j.peers || 0}`
    case 'running':
      if (j.kind === 'torrent') {
        if (j.phase === 'meta') return '正在從節點取得種子資訊…'
        if (j.phase === 'verify') return '校驗已下載的資料…'
        return `下載中 · 節點 ${j.peers || 0} · 上傳 ${fmtBytes(j.upSpeed || 0)}/s`
      }
      if (j.phase === 'merge') return '合併片段、轉成 MP4…'
      if (j.kind === 'hls') return j.segs ? `下載中 · 片段 ${Math.round((j.progress || 0) * j.segs)}/${j.segs}` : '讀取播放清單…'
      return j.resumable ? '下載中 · 多連線' : j.probed ? '下載中 · 單一連線（不支援續傳）' : '連線中…'
  }
  return j.status
}

function ratio(j) {
  return j.total > 0 ? ((j.uploaded || 0) / j.total).toFixed(2) : '0.00'
}

function matchCat(j, c) {
  switch (c) {
    case 'active':
      return ['running', 'queued', 'seeding'].includes(j.status)
    case 'unfinished':
      return j.status !== 'done' && j.status !== 'seeding'
    case 'done':
      return j.status === 'done' || j.status === 'seeding'
    case 'video':
      return isVideo(j)
    case 'torrent':
      return j.kind === 'torrent'
    case 'other':
      return j.kind !== 'torrent' && !isVideo(j)
  }
  return true
}

function visible(j) {
  return matchCat(j, cat) && (!query || (j.name || '').toLowerCase().includes(query))
}

// ───────────────────────────── 清單 ─────────────────────────────

function kindIcon(j) {
  return j.kind === 'torrent' ? 'magnet' : j.kind === 'hls' ? 'stream' : isVideo(j) ? 'film' : 'file'
}

function makeRow(j) {
  const el = document.createElement('div')
  el.className = 'job row'
  el.dataset.id = j.id
  el.innerHTML = `
    <div class="c-name"><div class="kind"></div><div class="nm"><div class="t"></div><div class="s"></div></div></div>
    <div class="c-size"></div>
    <div class="c-prog"><div class="bar"><div></div></div><div class="pct"><span></span><span></span></div></div>
    <div class="c-speed"></div>
    <div class="c-eta"></div>`
  rows.set(j.id, el)
  fillRow(el, j)
  return el
}

function fillRow(el, j) {
  const kind = el.querySelector('.kind')
  const ik = kindIcon(j)
  if (kind.dataset.k !== ik) {
    kind.dataset.k = ik
    kind.className = 'kind ' + j.kind
    kind.innerHTML = iconSvg(ik, 16)
  }
  const t = el.querySelector('.t')
  t.textContent = j.name || '（取得名稱中）'
  t.title = j.name || ''
  const s = el.querySelector('.s')
  s.textContent = statusText(j)
  s.className = 's' + (j.status === 'error' ? ' err' : '')
  s.title = s.textContent
  el.querySelector('.c-size').textContent = j.total > 0 ? fmtBytes(j.total) : j.done > 0 ? fmtBytes(j.done) : '—'

  const p = progressOf(j)
  const bar = el.querySelector('.bar')
  bar.className = 'bar ' + j.status + (p < 0 && j.status === 'running' ? ' indet' : '')
  bar.firstElementChild.style.width = (p < 0 ? 0 : p * 100).toFixed(1) + '%'
  const [l, r] = el.querySelectorAll('.pct span')
  l.textContent = p < 0 ? '' : (p * 100).toFixed(p < 1 ? 1 : 0) + '%'
  r.textContent = j.status !== 'done' && j.done > 0 && j.total > 0 ? fmtBytes(j.done) : ''

  const sp = el.querySelector('.c-speed')
  if (j.status === 'running') sp.innerHTML = `<b>${fmtBytes(j.speed || 0)}/s</b>`
  else if (j.status === 'seeding') sp.innerHTML = `↑ ${fmtBytes(j.upSpeed || 0)}/s`
  else sp.textContent = ''
  const eta = el.querySelector('.c-eta')
  eta.textContent = j.status === 'running' && j.speed > 0 && j.total > 0 ? fmtTime((j.total - j.done) / j.speed) : ''
  el.classList.toggle('sel', selected.has(j.id))
}

function sorted() {
  return [...jobs.values()].sort((a, b) => b.created - a.created)
}

function renderList() {
  const list = $('#list')
  const vis = sorted().filter(visible)
  list.replaceChildren(...vis.map((j) => rows.get(j.id) || makeRow(j)))
  for (const id of [...selected]) if (!vis.some((j) => j.id === id)) selected.delete(id)
  $('#empty').classList.toggle('hidden', jobs.size > 0)
  counts()
  updateToolbar()
  renderDetail()
}

function counts() {
  const all = [...jobs.values()]
  for (const a of $$('.side a')) {
    const n = all.filter((j) => matchCat(j, a.dataset.cat)).length
    a.querySelector('.n').textContent = n || ''
  }
}

function upsert(j) {
  const isNew = !jobs.has(j.id)
  const prev = jobs.get(j.id)
  jobs.set(j.id, j)
  if (isNew || (prev && (prev.status !== j.status || prev.name !== j.name))) {
    if (!isNew) fillRow(rows.get(j.id), j)
    renderList()
    return
  }
  const el = rows.get(j.id)
  if (el) fillRow(el, j)
  if (selected.size === 1 && selected.has(j.id)) renderDetail()
}

// ───────────────────────────── 選取 / 工具列 ─────────────────────────────

function selJobs() {
  return [...selected].map((id) => jobs.get(id)).filter(Boolean)
}

function updateToolbar() {
  const s = selJobs()
  $('#btnResume').disabled = !s.some((j) => ['paused', 'error'].includes(j.status) || (j.kind === 'torrent' && j.status === 'done'))
  $('#btnPause').disabled = !s.some((j) => ['running', 'queued', 'seeding'].includes(j.status))
  $('#btnRemove').disabled = !s.length
}

function select(id, e) {
  const vis = $$('#list .job').map((el) => el.dataset.id)
  if (e?.shiftKey && lastClicked && vis.includes(lastClicked)) {
    const a = vis.indexOf(lastClicked)
    const b = vis.indexOf(id)
    if (!e.ctrlKey) selected.clear()
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(vis[i])
  } else if (e?.ctrlKey) {
    selected.has(id) ? selected.delete(id) : selected.add(id)
    lastClicked = id
  } else {
    selected.clear()
    selected.add(id)
    lastClicked = id
  }
  for (const [rid, el] of rows) el.classList.toggle('sel', selected.has(rid))
  updateToolbar()
  renderDetail()
}

$('#list').addEventListener('mousedown', (e) => {
  const row = e.target.closest('.job')
  if (!row) {
    if (e.button === 0) {
      selected.clear()
      for (const el of rows.values()) el.classList.remove('sel')
      updateToolbar()
      renderDetail()
    }
    return
  }
  if (e.button === 2 && selected.has(row.dataset.id)) return
  select(row.dataset.id, e)
})
$('#list').addEventListener('dblclick', (e) => {
  const row = e.target.closest('.job')
  if (!row) return
  const j = jobs.get(row.dataset.id)
  if (j.status === 'done' || j.status === 'seeding') gb.jobs.open(j.id)
  else if (j.status === 'paused' || j.status === 'error') gb.jobs.resume(j.id)
  else gb.jobs.show(j.id)
})

const resumeSel = () => selJobs().forEach((j) => gb.jobs.resume(j.id))
const pauseSel = () => selJobs().forEach((j) => gb.jobs.pause(j.id))

$('#btnAdd').onclick = () => gb.app.newUrl()
$('#btnTorrent').onclick = () => torrentDialog()
$('#btnResume').onclick = resumeSel
$('#btnPause').onclick = pauseSel
$('#btnRemove').onclick = () => confirmRemove(selJobs())
$('#btnResumeAll').onclick = () => gb.jobs.resumeAll()
$('#btnPauseAll').onclick = () => gb.jobs.pauseAll()
$('#btnSettings').onclick = () => settingsDialog()
$('#btnExt').onclick = () => extensionDialog()
$('#search').addEventListener('input', (e) => {
  query = e.target.value.trim().toLowerCase()
  renderList()
})
for (const a of $$('.side a')) {
  a.onclick = () => {
    cat = a.dataset.cat
    $$('.side a').forEach((x) => x.classList.toggle('on', x === a))
    renderList()
  }
}
$('#empty').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act
  if (act === 'add') gb.app.newUrl()
  if (act === 'ext') extensionDialog()
})

// ───────────────────────────── 右鍵選單 ─────────────────────────────

function showMenu(x, y, items) {
  const m = $('#menu')
  m.innerHTML = ''
  for (const it of items) {
    if (it === '-') {
      m.appendChild(document.createElement('hr'))
      continue
    }
    const b = document.createElement('button')
    b.innerHTML = `${it.icon ? iconSvg(it.icon, 15) : '<span style="width:15px"></span>'}<span>${esc(it.label)}</span>`
    if (it.danger) b.className = 'danger'
    b.onclick = () => {
      hideMenu()
      it.run()
    }
    m.appendChild(b)
  }
  m.classList.remove('hidden')
  const r = m.getBoundingClientRect()
  m.style.left = Math.min(x, innerWidth - r.width - 6) + 'px'
  m.style.top = Math.min(y, innerHeight - r.height - 6) + 'px'
}

function hideMenu() {
  $('#menu').classList.add('hidden')
}

document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#menu')) hideMenu()
})
window.addEventListener('blur', hideMenu)

$('#list').addEventListener('contextmenu', (e) => {
  e.preventDefault()
  const s = selJobs()
  if (!s.length) return
  const one = s.length === 1 ? s[0] : null
  const items = []
  if (one && (one.status === 'done' || one.status === 'seeding')) items.push({ label: '開啟檔案', icon: 'file', run: () => gb.jobs.open(one.id) })
  if (one) items.push({ label: '開啟所在資料夾', icon: 'folder', run: () => gb.jobs.show(one.id) })
  if (s.some((j) => ['paused', 'error'].includes(j.status))) items.push({ label: '繼續', icon: 'play', run: resumeSel })
  if (s.some((j) => j.kind === 'torrent' && j.status === 'done')) items.push({ label: '繼續做種', icon: 'up', run: resumeSel })
  if (s.some((j) => ['running', 'queued', 'seeding'].includes(j.status))) items.push({ label: s.every((j) => j.status === 'seeding') ? '停止做種' : '暫停', icon: 'pause', run: pauseSel })
  if (one) items.push({ label: one.kind === 'torrent' ? '複製磁力連結' : '複製下載網址', run: () => gb.jobs.copyUrl(one.id) })
  items.push('-')
  items.push({ label: '從清單移除', icon: 'trash', run: () => confirmRemove(s) })
  items.push({ label: '刪除（含檔案）', icon: 'trash', danger: true, run: () => confirmRemove(s, true) })
  showMenu(e.clientX, e.clientY, items)
})

// ───────────────────────────── 詳細資訊 ─────────────────────────────

function renderDetail() {
  const d = $('#detail')
  const s = selJobs()
  if (s.length !== 1) {
    d.classList.add('hidden')
    return
  }
  const j = s[0]
  d.classList.remove('hidden')
  const kv = []
  const add = (k, v, mono) => kv.push(`<div>${k}</div><div class="${mono ? 'mono' : ''}">${v}</div>`)
  add('狀態', esc(statusText(j)))
  add('儲存位置', esc(j.file || j.dir), true)
  if (j.kind === 'torrent') {
    if (j.infoHash) add('Info Hash', esc(j.infoHash), true)
  } else {
    add('網址', esc(j.url), true)
    if (j.referer) add('來源網頁', esc(j.referer), true)
  }
  add('加入時間', fmtDate(j.created))

  let html = ''
  if (j.kind === 'torrent') {
    html += `<div class="stats">
      <div>${iconSvg('down', 14)} ${fmtBytes(j.speed || 0)}/s</div>
      <div>${iconSvg('up', 14)} ${fmtBytes(j.upSpeed || 0)}/s</div>
      <div>${iconSvg('users', 14)} 節點 ${j.peers || 0}</div>
      <div class="dim">已上傳 ${fmtBytes(j.uploaded || 0)} · 分享率 ${ratio(j)}</div>
    </div>`
  }
  html += `<div class="kv">${kv.join('')}</div>`
  if (j.kind === 'torrent' && j.files && j.files.length) {
    const shown = j.files.slice(0, 300)
    html += `<table class="files" style="margin-top:12px">${shown
      .map((f) => {
        const p = f.length ? Math.min(1, (f.done || 0) / f.length) : 1
        return `<tr class="${f.sel ? '' : 'off'}"><td>${esc(f.path)}</td><td class="r">${fmtBytes(f.length)}</td><td class="r">${f.sel ? (p * 100).toFixed(1) + '%' : '不下載'}</td></tr>`
      })
      .join('')}</table>`
    if (j.files.length > shown.length) html += `<div class="dim small">…還有 ${j.files.length - shown.length} 個檔案</div>`
  }
  // 只在內容有變時才換，使用者正在選取文字時不會被打斷
  if (d.dataset.html !== html) {
    d.dataset.html = html
    d.innerHTML = html
  }
}

// ───────────────────────────── 對話框 ─────────────────────────────

function openModal(title, html, width) {
  $('#modalTitle').textContent = title
  $('#modalBody').innerHTML = html
  $('.dialog').style.width = width ? `min(${width}px, calc(100% - 40px))` : ''
  $('#modal').classList.remove('hidden')
  applyIcons($('#modalBody'))
  return $('#modalBody')
}

function closeModal() {
  $('#modal').classList.add('hidden')
}

$('#modal').addEventListener('mousedown', (e) => {
  if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal()
})

function confirmRemove(list, withFile = false) {
  if (!list.length) return
  const body = openModal(
    '刪除任務',
    `<div class="form">
      <div>${list.length === 1 ? `確定要刪除「${esc(list[0].name)}」？` : `確定要刪除選取的 ${list.length} 個任務？`}</div>
      <label class="chk"><input type="checkbox" id="rmFile" ${withFile ? 'checked' : ''} />同時刪除已下載的檔案</label>
      <div class="inline" style="justify-content:flex-end"><button class="btn" data-close>取消</button><button class="btn primary" id="rmOk">刪除</button></div>
    </div>`,
    420,
  )
  $('#rmOk', body).onclick = async () => {
    const del = $('#rmFile', body).checked
    closeModal()
    for (const j of list) await gb.jobs.remove(j.id, del)
  }
}

function torrentDialog() {
  const body = openModal(
    '新增種子',
    `<div class="form">
      <div class="field"><label>磁力連結</label><input class="inp" id="mg" placeholder="magnet:?xt=urn:btih:…" /></div>
      <div class="inline" style="justify-content:space-between">
        <button class="btn" id="tfile"><i data-i="file"></i> 開啟 .torrent 檔…</button>
        <button class="btn primary" id="mgOk">下一步</button>
      </div>
      <div class="dim small">也可以直接把 .torrent 檔拖進主視窗，或在設定裡把 GrabBox 設為磁力連結的預設程式。</div>
    </div>`,
    500,
  )
  applyIcons(body)
  $('#tfile', body).onclick = () => {
    closeModal()
    gb.app.openTorrent()
  }
  const go = () => {
    const v = $('#mg', body).value.trim()
    if (!v) return
    closeModal()
    gb.app.newUrl(v)
  }
  $('#mgOk', body).onclick = go
  $('#mg', body).addEventListener('keydown', (e) => e.key === 'Enter' && go())
  $('#mg', body).focus()
}

async function settingsDialog() {
  const s = await gb.settings.get()
  const info = await gb.app.info()
  const body = openModal(
    '設定',
    `<div class="form">
      <div class="sec-h">一般</div>
      <div class="field"><label>預設下載資料夾</label>
        <div class="inline"><input class="inp" id="sDir" value="${esc(s.dir)}" /><button class="btn" id="sDirBtn">選擇…</button></div></div>
      <div class="grid2">
        <div class="field"><label>每個下載的連線數</label><input class="inp" id="sConn" type="number" min="1" max="32" value="${s.connections}" />
          <div class="hint">伺服器支援時會分段同時下載（1–32）</div></div>
        <div class="field"><label>同時下載幾個檔案</label><input class="inp" id="sMax" type="number" min="1" max="10" value="${s.maxActive}" />
          <div class="hint">種子不受這個限制</div></div>
      </div>
      <label class="chk"><input type="checkbox" id="sAsk" ${s.askOnBrowser ? 'checked' : ''} />從瀏覽器送來的下載先跳出確認視窗（可改檔名、選畫質）</label>
      <label class="chk"><input type="checkbox" id="sNotify" ${s.notify ? 'checked' : ''} />下載完成時顯示通知</label>
      <label class="chk"><input type="checkbox" id="sTray" ${s.closeToTray ? 'checked' : ''} />關閉視窗時縮到系統匣，繼續在背景下載</label>

      <div class="sec-h">種子（BT）</div>
      <label class="chk"><input type="checkbox" id="sSeed" ${s.seed ? 'checked' : ''} />下載完成後繼續做種（分享給其他人）</label>
      <div class="grid2">
        <div class="field"><label>分享率達到多少時停止做種</label><input class="inp" id="sRatio" type="number" min="0" step="0.1" value="${s.seedRatio}" /><div class="hint">0 = 一直做種</div></div>
        <div class="field"><label>連接埠</label><input class="inp" id="sPort" type="number" min="0" max="65535" value="${s.torrentPort}" /><div class="hint">0 = 隨機，重新啟動後生效</div></div>
        <div class="field"><label>上傳限速（KB/s）</label><input class="inp" id="sUp" type="number" min="0" value="${s.upLimit}" /><div class="hint">0 = 不限</div></div>
        <div class="field"><label>下載限速（KB/s）</label><input class="inp" id="sDown" type="number" min="0" value="${s.downLimit}" /><div class="hint">0 = 不限</div></div>
      </div>
      <div class="inline"><button class="btn" id="sMagnet">設為磁力連結預設程式</button><span class="dim small" id="sMagnetSt">${info.magnet ? '✓ 目前已是預設程式' : ''}</span></div>

      <div class="sec-h">HLS 串流</div>
      <div class="field"><label>ffmpeg 路徑（留空 = 使用內建）</label>
        <div class="inline"><input class="inp" id="sFf" value="${esc(s.ffmpeg)}" placeholder="內建 ffmpeg" /><button class="btn" id="sFfBtn">選擇…</button></div>
        <div class="hint">用來把下載好的串流片段轉成 MP4</div></div>

      <div class="inline" style="justify-content:space-between;margin-top:6px">
        <span class="dim small">GrabBox v${esc(info.version)} · 本機服務埠 ${info.port || '啟動失敗'}</span>
        <span class="inline"><button class="btn" data-close>取消</button><button class="btn primary" id="sSave">儲存</button></span>
      </div>
    </div>`,
    600,
  )
  $('#sDirBtn', body).onclick = async () => {
    const d = await gb.settings.chooseDir()
    if (d) $('#sDir', body).value = d
  }
  $('#sFfBtn', body).onclick = async () => {
    const f = await gb.settings.chooseFile()
    if (f) $('#sFf', body).value = f
  }
  $('#sMagnet', body).onclick = async () => {
    const ok = await gb.app.setMagnet()
    $('#sMagnetSt', body).textContent = ok ? '✓ 已設為預設程式' : '設定失敗（Windows 可能要你到「預設應用程式」裡手動選擇）'
  }
  $('#sSave', body).onclick = async () => {
    const num = (id) => Number($(id, body).value) || 0
    await gb.settings.set({
      dir: $('#sDir', body).value.trim(),
      connections: num('#sConn'),
      maxActive: num('#sMax'),
      askOnBrowser: $('#sAsk', body).checked,
      notify: $('#sNotify', body).checked,
      closeToTray: $('#sTray', body).checked,
      seed: $('#sSeed', body).checked,
      seedRatio: Math.max(0, num('#sRatio')),
      torrentPort: Math.max(0, Math.min(65535, num('#sPort'))),
      upLimit: Math.max(0, num('#sUp')),
      downLimit: Math.max(0, num('#sDown')),
      ffmpeg: $('#sFf', body).value.trim(),
    })
    closeModal()
  }
}

async function extensionDialog() {
  const info = await gb.app.info()
  const body = openModal(
    '安裝瀏覽器擴充功能',
    `<div class="form">
      <div>裝上擴充功能後，瀏覽器播放影片時會在影片右上角跳出 <b>「下載此影片」</b> 按鈕，點了就交給 GrabBox 多連線下載；磁力連結、.torrent 連結也會自動交給 GrabBox。</div>
      <ol class="steps">
        <li>按下面的 <b>開啟擴充資料夾</b>（路徑同時會複製到剪貼簿）。</li>
        <li>Chrome 網址列輸入 <code>chrome://extensions</code>（Edge 是 <code>edge://extensions</code>），打開右上角的 <b>開發人員模式</b>。</li>
        <li>按 <b>載入未封裝項目</b>，選剛剛開啟的 <code>extension</code> 資料夾。</li>
        <li>完成！打開任何有影片的網頁試試看。</li>
      </ol>
      <div class="dim small">本機服務：${info.port ? `127.0.0.1:${info.port} 運作中` : '啟動失敗（連接埠被佔用？）'}</div>
      <div class="inline" style="justify-content:flex-end"><button class="btn primary" id="extOpen"><i data-i="folder"></i> 開啟擴充資料夾</button></div>
    </div>`,
    560,
  )
  applyIcons(body)
  $('#extOpen', body).onclick = async () => {
    const dir = await gb.app.extensionDir()
    $('#extOpen', body).textContent = '已開啟，路徑已複製'
    $('#extOpen', body).title = dir
  }
}

// ───────────────────────────── 鍵盤、貼上、拖放 ─────────────────────────────

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return
  if (!$('#modal').classList.contains('hidden')) {
    if (e.key === 'Escape') closeModal()
    return
  }
  if (e.key === 'Delete' && selected.size) confirmRemove(selJobs())
  else if (e.ctrlKey && e.key.toLowerCase() === 'n') gb.app.newUrl()
  else if (e.ctrlKey && e.key.toLowerCase() === 'a') {
    e.preventDefault()
    for (const el of $$('#list .job')) selected.add(el.dataset.id)
    for (const [rid, el] of rows) el.classList.toggle('sel', selected.has(rid))
    updateToolbar()
    renderDetail()
  } else if (e.key === 'Enter' && selected.size === 1) {
    const j = selJobs()[0]
    if (j.status === 'done') gb.jobs.open(j.id)
  } else if (e.key === 'Escape') hideMenu()
})

document.addEventListener('paste', (e) => {
  if (e.target.matches('input, textarea')) return
  const t = (e.clipboardData.getData('text') || '').trim()
  if (/^(https?:\/\/|magnet:\?)\S+$/i.test(t)) gb.app.newUrl(t)
})

let dragDepth = 0
document.addEventListener('dragenter', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return
  dragDepth++
  $('#drop').classList.remove('hidden')
})
document.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0
    $('#drop').classList.add('hidden')
  }
})
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => {
  e.preventDefault()
  dragDepth = 0
  $('#drop').classList.add('hidden')
  const files = [...e.dataTransfer.files].filter((f) => /\.torrent$/i.test(f.name))
  if (files.length) gb.app.dropFiles(files)
  else {
    const t = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text') || '').trim().split(/\s+/)[0]
    if (/^(https?:\/\/|magnet:\?)/i.test(t)) gb.app.newUrl(t)
  }
})

// ───────────────────────────── 啟動 ─────────────────────────────

gb.jobs.onUpdate(upsert)
gb.jobs.onRemoved((id) => {
  jobs.delete(id)
  rows.get(id)?.remove()
  rows.delete(id)
  selected.delete(id)
  renderList()
})
gb.jobs.onTick((s) => {
  $('#totalSpeed').textContent = fmtBytes(s.speed) + '/s'
})

applyIcons()
;(async () => {
  for (const j of await gb.jobs.list()) jobs.set(j.id, j)
  renderList()
  const info = await gb.app.info()
  $('#conn').textContent = info.port ? `擴充連線埠 ${info.port}` : '本機服務啟動失敗'
})()
