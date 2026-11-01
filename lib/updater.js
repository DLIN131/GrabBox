// 程式內自動更新：查 GitHub 最新版 → 下載 zip → 解壓到暫存資料夾 → 程式關閉後由 PowerShell 覆蓋安裝資料夾 → 重新啟動。
// 做法沿用 ReelBox 的 updater（踩過的坑都註解在下面）
const { app } = require('electron')
const { spawn, execFile } = require('child_process')
// 一定要用 original-fs：Electron 的 fs 會把解壓出來的 app.asar 當成資料夾，刪不掉（ENOTEMPTY）還會一直開著它（之後 EBUSY）
const fs = require('original-fs')
const os = require('os')
const path = require('path')
const { request, fetchBuffer } = require('./util')

const REPO = 'DLIN131/GrabBox'
const ZIP_NAME = 'GrabBox-Windows.zip'
const root = path.join(os.tmpdir(), 'GrabBox-update')
const installDir = path.dirname(process.execPath)
let work = null
let extracted = null

function supported() {
  return app.isPackaged && process.platform === 'win32'
}

/** 版本比較：1.0.10 > 1.0.9 */
function newer(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
  }
  return false
}

/** release 說明只留更新內容（去掉固定下載網址那段和 Co-Authored-By） */
function cleanNotes(body) {
  return String(body || '')
    .split('\n---')[0]
    .split('\n')
    .filter((l) => !/^Co-Authored-By/i.test(l.trim()))
    .join('\n')
    .trim()
}

async function api(p) {
  // GRABBOX_UPDATE_API 只給測試用（指到本機假的 GitHub）
  const base = process.env.GRABBOX_UPDATE_API || 'https://api.github.com'
  const { buf } = await fetchBuffer(`${base}/repos/${REPO}${p}`, { headers: { Accept: 'application/vnd.github+json' }, timeout: 15000 }, 4 * 1024 * 1024)
  return JSON.parse(buf.toString('utf8'))
}

/** 有新版回傳 { version, notes, url, size }，沒有回傳 null */
async function check() {
  const r = await api('/releases/latest')
  const version = String(r.tag_name || '').replace(/^v/, '')
  const asset = (r.assets || []).find((a) => a.name === ZIP_NAME)
  if (!asset || !newer(version, app.getVersion())) return null
  return { version, notes: cleanNotes(r.body), url: asset.browser_download_url, size: asset.size }
}

/** 某一版的更新內容（更新完第一次開啟時顯示） */
async function notesFor(version) {
  try {
    const r = await api('/releases/tags/v' + version)
    return cleanNotes(r.body)
  } catch {
    return ''
  }
}

/**
 * 清掉以前的更新暫存；刪不掉的（被鎖住）就留著下次再清。
 * 正在用的那份、10 分鐘內建立的一律不碰（啟動後的清理曾經把剛開始下載的 zip 刪掉）
 */
function cleanOld() {
  let names = []
  try {
    names = fs.readdirSync(root)
  } catch {
    return
  }
  for (const n of names) {
    const dir = path.join(root, n)
    if (dir === work || Date.now() - Number(n) < 10 * 60 * 1000) continue
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
}

/** 安裝資料夾能不能寫入（放在 Program Files 之類的地方就不行） */
function canWrite() {
  try {
    const probe = path.join(installDir, '.update-probe')
    fs.writeFileSync(probe, '')
    fs.unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

async function download(url, size, onProgress) {
  cleanOld()
  work = path.join(root, String(Date.now()))
  fs.mkdirSync(work, { recursive: true })
  const zip = path.join(work, 'update.zip')
  const { res } = await request(url, { timeout: 60000 })
  if (res.statusCode !== 200) {
    res.resume()
    throw new Error('HTTP ' + res.statusCode)
  }
  const total = Number(res.headers['content-length']) || size || 0
  let got = 0
  let last = -1
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(zip)
    res.on('data', (c) => {
      got += c.length
      const p = total ? Math.floor((got * 100) / total) : -1
      if (p !== last) {
        last = p
        onProgress(p)
      }
    })
    res.on('error', reject)
    out.on('error', reject)
    out.on('finish', resolve)
    res.pipe(out)
  })
  let real = -1
  try {
    real = fs.statSync(zip).size
  } catch {}
  if (real < 0) throw new Error('下載的更新檔不見了（可能被防毒軟體移除），請再試一次')
  if (total && real !== total) throw new Error(`更新檔下載不完整（${real} / ${total} bytes），請再試一次`)
  return zip
}

function unzip(zip, dest) {
  // PowerShell 錯誤訊息預設用系統編碼（Big5）輸出，改成 UTF-8 才不會變亂碼
  const q = (s) => `'${s.replace(/'/g, "''")}'`
  const cmd = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference='Stop'; try { Expand-Archive -LiteralPath ${q(zip)} -DestinationPath ${q(dest)} -Force } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { windowsHide: true, encoding: 'utf8' }, (err, _out, stderr) =>
      err ? reject(new Error(`解壓縮失敗：${(stderr || err.message).trim()}`)) : resolve(),
    )
  })
}

/** 下載並解壓新版，完成後才可以 install() */
async function prepare(info, onProgress) {
  if (!supported()) throw new Error('開發模式不能更新')
  if (!canWrite()) throw new Error('程式所在的資料夾沒有寫入權限，請把 GrabBox 資料夾移到桌面或文件夾後再更新')
  const zip = await download(info.url, info.size, onProgress)
  onProgress(101) // 解壓縮中
  const dest = path.join(work, 'files')
  await unzip(zip, dest)
  if (!fs.existsSync(path.join(dest, path.basename(process.execPath)))) throw new Error('更新檔內容不正確')
  extracted = dest
}

/** 關閉程式、覆蓋檔案、重新開啟。呼叫後程式會結束 */
function install(quit) {
  if (!extracted) throw new Error('還沒下載更新')
  const exe = path.join(installDir, path.basename(process.execPath))
  // 用 PowerShell 等程式結束（批次檔在沒有主控台時 tasklist | find 會卡住）；
  // 腳本只放英數字，路徑全部用環境變數（Unicode）傳進去，資料夾名稱有中文也不會變亂碼
  const script = path.join(work, 'update.ps1')
  fs.writeFileSync(
    script,
    [
      '$log = $env:GB_LOG',
      '"start $(Get-Date -Format o)" | Set-Content -LiteralPath $log',
      'Wait-Process -Id ([int]$env:GB_PID) -ErrorAction SilentlyContinue',
      'Start-Sleep -Milliseconds 800',
      '"app exited $(Get-Date -Format o)" | Add-Content -LiteralPath $log',
      '& robocopy.exe $env:GB_SRC $env:GB_DST /E /R:10 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null',
      '"robocopy $LASTEXITCODE $(Get-Date -Format o)" | Add-Content -LiteralPath $log',
      'Start-Process -FilePath $env:GB_EXE -WorkingDirectory $env:GB_DST',
      '',
    ].join('\r\n'),
    'ascii',
  )
  // 非 detached 的子程序會被放進「父程序結束就一起關掉」的 job，所以一定要 detached；
  // 但 detached 的程序沒有主控台，PowerShell 會直接結束：detached 的 cmd 再用 start 開 PowerShell，讓它有自己的隱藏主控台
  spawn('cmd.exe', ['/d', '/c', `start "" /min powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}"`], {
    detached: true,
    windowsVerbatimArguments: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      GB_PID: String(process.pid),
      GB_SRC: extracted,
      GB_DST: installDir,
      GB_EXE: exe,
      GB_LOG: path.join(work, 'update.log'),
    },
  }).unref()
  setTimeout(quit, 300)
}

module.exports = { supported, check, notesFor, prepare, install, cleanOld, newer }
