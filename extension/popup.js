const $ = (s) => document.querySelector(s)
let tab = null

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

function setStatus(app) {
  const st = $('#st')
  if (app) {
    st.className = 'st ok'
    st.textContent = `● 已連線 v${app.version}`
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
