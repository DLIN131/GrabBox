// 在影片上顯示「下載此影片」按鈕（滑鼠移到影片上、或剛偵測到影片時出現），
// 並把磁力連結 / .torrent 連結的點擊交給 GrabBox。介面放在 Shadow DOM 裡，不會被網頁樣式影響。
;(() => {
  // 擴充重新載入後，舊的這份會失去連線（chrome.runtime.id 變成 undefined），要讓新的接手
  const alive = () => {
    try {
      return !!chrome.runtime?.id
    } catch {
      return false
    }
  }
  if (window.__grabboxAlive?.()) return
  window.__grabboxAlive = alive

  let items = []
  let settings = { overlay: true, magnet: true }
  let current = null // 目前按鈕跟著的 <video>
  let showUntil = 0
  let linkUntil = 0
  let mouse = { x: -1, y: -1 }
  const dismissed = new WeakSet()

  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          void chrome.runtime.lastError
          resolve(r)
        })
      } catch {
        resolve(null) // 擴充重新載入後，舊頁面的 content script 已失效
      }
    })

  // ───── 介面 ─────
  const host = document.createElement('grabbox-ui')
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;left:0;top:0;width:0;height:0;'
  const root = host.attachShadow({ mode: 'closed' })
  root.innerHTML = `
  <style>
    :host { all: initial; }
    * { box-sizing: border-box; font-family: 'Segoe UI', 'Microsoft JhengHei', system-ui, sans-serif; }
    .wrap { position: fixed; display: none; flex-direction: column; align-items: flex-end; gap: 6px; }
    .wrap.on { display: flex; }
    .bar { display: flex; align-items: stretch; border-radius: 9px; overflow: hidden; box-shadow: 0 4px 16px rgba(0,0,0,.45); background: #4f8cff; }
    .bar button { border: 0; margin: 0; color: #fff; background: transparent; font-size: 13px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 6px; line-height: 1; }
    .main { padding: 8px 12px; }
    .main:hover, .more:hover, .x:hover { background: rgba(255,255,255,.16); }
    .more { padding: 0 8px; border-left: 1px solid rgba(255,255,255,.25) !important; }
    .x { padding: 0 9px; font-size: 15px !important; opacity: .8; border-left: 1px solid rgba(255,255,255,.25) !important; }
    svg { width: 15px; height: 15px; }
    .list { display: none; min-width: 250px; max-width: 380px; max-height: 300px; overflow: auto; background: #1b1f29; border: 1px solid #2d3341; border-radius: 10px; padding: 5px; box-shadow: 0 10px 30px rgba(0,0,0,.5); }
    .list.on { display: block; }
    .it { display: block; width: 100%; text-align: left; border: 0; background: none; color: #e6e8ee; padding: 8px 10px; border-radius: 7px; cursor: pointer; font-size: 13px; }
    .it:hover { background: #263352; }
    .it small { display: block; color: #8d93a3; font-size: 11px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .toast { display: none; background: #1b1f29; color: #e6e8ee; border: 1px solid #2d3341; border-radius: 9px; padding: 8px 12px; font-size: 12.5px; box-shadow: 0 6px 20px rgba(0,0,0,.45); max-width: 320px; }
    .toast.on { display: block; }
    .toast.err { border-color: #f87171; }
    .toast a { color: #7aa7ff; cursor: pointer; margin-left: 8px; text-decoration: underline; }
  </style>
  <div class="wrap">
    <div class="bar">
      <button class="main" title="用 GrabBox 下載"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M6.5 10l5.5 5.5 5.5-5.5M5 20h14"/></svg><span class="lbl">下載此影片</span></button>
      <button class="more" title="選擇其他來源">▾</button>
      <button class="x" title="這個影片不要再顯示">×</button>
    </div>
    <div class="list"></div>
    <div class="toast"></div>
  </div>`
  const $ = (s) => root.querySelector(s)
  const wrap = $('.wrap')
  const list = $('.list')
  const toast = $('.toast')

  function mount() {
    // 全螢幕時要放進全螢幕的元素裡才看得到
    const fs = document.fullscreenElement
    const parent = fs && fs.tagName !== 'VIDEO' ? fs : document.documentElement
    if (host.parentNode !== parent) parent.appendChild(host)
  }

  // ───── 找影片 ─────
  function videos() {
    return [...document.querySelectorAll('video')].filter((v) => {
      const r = v.getBoundingClientRect()
      return r.width >= 200 && r.height >= 110 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && getComputedStyle(v).visibility !== 'hidden'
    })
  }

  /** 頁面上的 <video src> 如果是一般網址，自己也算一個項目 */
  function directSrc(v) {
    const s = v.currentSrc || v.src || ''
    return /^https?:/i.test(s) ? s : ''
  }

  function choices() {
    const out = [...items]
    if (current) {
      const src = directSrc(current)
      if (src && !out.some((x) => x.url === src)) out.push({ url: src, label: '目前播放的影片', kind: /\.m3u8/i.test(src) ? 'hls' : 'http' })
    }
    return out
  }

  function pickVideo() {
    const vs = videos().filter((v) => !dismissed.has(v))
    if (!vs.length) return null
    // 滑鼠所在的影片優先，再來是正在播放的、最大的
    const hover = vs.find((v) => {
      const r = v.getBoundingClientRect()
      return mouse.x >= r.left && mouse.x <= r.right && mouse.y >= r.top && mouse.y <= r.bottom
    })
    if (hover) return hover
    const area = (v) => v.getBoundingClientRect().width * v.getBoundingClientRect().height
    return vs.sort((a, b) => (b.paused ? 0 : 1) - (a.paused ? 0 : 1) || area(b) - area(a))[0]
  }

  function update() {
    if (!alive()) {
      // 舊版本留下來的：把自己的介面拿掉，交給新載入的那份
      host.remove()
      clearInterval(timer)
      return
    }
    const bar = $('.bar')
    if (Date.now() < linkUntil) {
      // 點了磁力 / 種子連結：只在右上角顯示提示
      mount()
      bar.style.display = 'none'
      wrap.classList.add('on')
      wrap.style.top = '16px'
      wrap.style.right = '16px'
      return
    }
    bar.style.display = ''
    if (!settings.overlay) return hide()
    const v = pickVideo()
    current = v
    if (!v || !choices().length) return hide()
    const r = v.getBoundingClientRect()
    const over = mouse.x >= r.left && mouse.x <= r.right && mouse.y >= r.top && mouse.y <= r.bottom
    const pinned = list.classList.contains('on') || toast.classList.contains('on')
    if (!over && !pinned && Date.now() > showUntil) return hide()
    mount()
    wrap.classList.add('on')
    const top = Math.max(4, r.top + 10)
    const right = Math.max(4, innerWidth - r.right + 10)
    wrap.style.top = top + 'px'
    wrap.style.right = right + 'px'
    wrap.style.left = 'auto'
    const n = choices().length
    $('.more').style.display = n > 1 ? '' : 'none'
    $('.lbl').textContent = n > 1 ? `下載此影片（${n}）` : '下載此影片'
  }

  function hide() {
    wrap.classList.remove('on')
    list.classList.remove('on')
  }

  function showToast(html, err, ms = 3500) {
    toast.innerHTML = html
    toast.className = 'toast on' + (err ? ' err' : '')
    clearTimeout(showToast.t)
    showToast.t = setTimeout(() => {
      toast.className = 'toast'
      update()
    }, ms)
    showUntil = Date.now() + ms
    update()
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  }

  async function download(it) {
    list.classList.remove('on')
    showToast('正在送到 GrabBox…', false, 10000)
    const r = await send({ type: 'download', url: it.url, kind: it.kind, title: document.title })
    if (r && r.ok) showToast('✓ 已交給 GrabBox')
    else failToast(r?.error, () => download(it))
  }

  /** GrabBox 沒開：給一個「啟動」連結，啟動後自動重送 */
  function failToast(error, retry) {
    showToast(`${esc(error || 'GrabBox 沒有回應')}<a class="launch">啟動 GrabBox</a>`, true, 12000)
    const a = toast.querySelector('.launch')
    if (!a) return
    a.onclick = async () => {
      await send({ type: 'launch' })
      showToast('等待 GrabBox 啟動…', false, 20000)
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 1500))
        if (await send({ type: 'ping' })) return retry()
      }
      showToast('GrabBox 沒有啟動，請手動開啟後再試一次', true)
    }
  }

  $('.main').addEventListener('click', (e) => {
    e.stopPropagation()
    const c = choices()
    if (c.length === 1) download(c[0])
    else toggleList()
  })
  $('.more').addEventListener('click', (e) => {
    e.stopPropagation()
    toggleList()
  })
  $('.x').addEventListener('click', (e) => {
    e.stopPropagation()
    if (current) dismissed.add(current)
    hide()
  })

  function toggleList() {
    if (list.classList.toggle('on')) {
      list.innerHTML = choices()
        .map((it, i) => `<button class="it" data-i="${i}">${esc(it.label || it.url)}<small>${esc(it.url)}</small></button>`)
        .join('')
    }
  }
  list.addEventListener('click', (e) => {
    e.stopPropagation()
    const b = e.target.closest('.it')
    if (b) download(choices()[Number(b.dataset.i)])
  })
  // 按鈕上的點擊不要傳到網頁（很多播放器點一下就暫停）
  for (const ev of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick']) wrap.addEventListener(ev, (e) => e.stopPropagation())

  // ───── 事件 ─────
  document.addEventListener(
    'mousemove',
    (e) => {
      mouse = { x: e.clientX, y: e.clientY }
      schedule()
    },
    { passive: true, capture: true },
  )
  document.addEventListener('mouseleave', () => {
    mouse = { x: -1, y: -1 }
    schedule()
  })
  addEventListener('scroll', () => schedule(), { passive: true, capture: true })
  addEventListener('resize', () => schedule())
  document.addEventListener('fullscreenchange', () => schedule())
  document.addEventListener(
    'play',
    (e) => {
      if (e.target.tagName !== 'VIDEO') return
      const src = directSrc(e.target)
      if (src) send({ type: 'videoSrc', url: src, referer: location.href })
      showUntil = Date.now() + 5000
      schedule()
    },
    true,
  )
  document.addEventListener('click', (e) => {
    if (!e.composedPath().includes(host)) list.classList.remove('on')
  })

  let raf = 0
  function schedule() {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      update()
    })
  }
  // 版面會自己變（播放器展開、廣告插入），按鈕顯示時定期對齊位置
  const timer = setInterval(() => {
    if (wrap.classList.contains('on') || Date.now() < showUntil) update()
  }, 400)

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'items') {
      const had = items.length
      items = msg.items || []
      if (items.length > had) showUntil = Date.now() + 5000
      schedule()
    } else if (msg.type === 'toast') {
      if (msg.error) failToast(msg.error, () => {})
    }
  })

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return
    for (const k of ['overlay', 'magnet']) if (ch[k]) settings[k] = ch[k].newValue
    schedule()
  })

  send({ type: 'get' }).then((r) => {
    if (!r) return
    items = r.items || []
    settings = { ...settings, ...r.settings }
    schedule()
  })

  // ───── 磁力 / 種子連結 ─────
  document.addEventListener(
    'click',
    async (e) => {
      if (!settings.magnet || e.button !== 0 || e.ctrlKey || e.shiftKey || e.metaKey || e.altKey) return
      const a = e.target.closest?.('a[href]')
      if (!a) return
      const href = a.href
      let isTorrent = false
      try {
        isTorrent = /^https?:/i.test(href) && /\.torrent$/i.test(new URL(href).pathname)
      } catch {}
      if (!/^magnet:\?/i.test(href) && !isTorrent) return
      e.preventDefault()
      e.stopImmediatePropagation()
      const r = await send({ type: 'link', url: href, referer: location.href })
      if (r && r.ok) return showLinkToast('✓ 已交給 GrabBox')
      // GrabBox 沒開：照瀏覽器原本的方式處理
      location.href = href
    },
    true,
  )

  /** 連結不一定在影片旁邊，提示顯示在右上角 */
  function showLinkToast(text) {
    linkUntil = Date.now() + 3000
    showToast(esc(text), false, 3000)
  }
})()
