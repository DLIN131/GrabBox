const $ = (s) => document.querySelector(s)
let tab = null

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

function isNewer(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
  return false
}

function setStatus(app) {
  const st = $('#st')
  if (app) {
    st.className = 'st ok'
    st.textContent = `● 已連線 v${app.version}`
    // 程式已更新、擴充還是舊的（而且自動重載過了還是舊的）：多半是從別的資料夾載入
    if (app.ext && isNewer(app.version, app.ext)) {
      $('#hint').textContent = `擴充是 v${app.ext}、程式是 v${app.version}。請到 chrome://extensions 移除 GrabBox 擴充，再「載入未封裝項目」選 GrabBox 資料夾裡的 extension，之後程式更新時擴充會自動跟著更新。`
      $('#hint').style.display = ''
    }
  } else {
    st.className = 'st err'
    st.innerHTML = '● 程式沒有開啟<a id="launch">啟動</a>'
    $('#launch').onclick = async () => {
      await chrome.runtime.sendMessage({ type: 'launch', tabId: tab.id })
      st.className = 'st'
      st.textContent = '等待啟動…'
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 1500))
        const a = await chrome.runtime.sendMessage({ type: 'ping' })
        if (a) return setStatus(a)
      }
      setStatus(null)
    }
  }
}

function render(items) {
  $('#empty').style.display = items.length ? 'none' : ''
  $('#list').innerHTML = items
    .map((it, i) => `<div class="item"><div class="t"><div class="l">${esc(it.label)}</div><div class="u" title="${esc(it.url)}">${esc(it.url)}</div></div><button data-i="${i}">下載</button></div>`)
    .join('')
  for (const b of document.querySelectorAll('.item button')) {
    b.onclick = async () => {
      const it = items[Number(b.dataset.i)]
      b.disabled = true
      b.textContent = '傳送中…'
      const r = await chrome.runtime.sendMessage({ type: 'download', tabId: tab.id, url: it.url, kind: it.kind, title: tab.title })
      b.textContent = r && r.ok ? '✓ 已送出' : '失敗'
      if (!(r && r.ok)) {
        b.disabled = false
        setStatus(null)
      }
    }
  }
}

;(async () => {
  ;[tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const r = await chrome.runtime.sendMessage({ type: 'popup', tabId: tab.id })
  setStatus(r?.app)
  render(r?.items || [])
  for (const k of ['overlay', 'magnet', 'takeover']) {
    const el = $('#' + k)
    el.checked = !!r?.settings?.[k]
    el.onchange = () => chrome.storage.local.set({ [k]: el.checked })
  }
})()
