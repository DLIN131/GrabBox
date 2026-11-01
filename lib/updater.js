// 程式內自動更新：查 GitHub 最新版 → 下載 zip → 解壓到安裝資料夾裡的 .gbupdate → 程式關閉後由 PowerShell 換檔 → 重新啟動。
// 做法沿用 ReelBox 的 updater（踩過的坑都註解在下面）。
// 換檔不用複製：以前用 robocopy 從 %TEMP%（C 槽）複製到安裝資料夾，200 MB 的 GrabBox.exe 複製到一半就被執行
// （或複製失敗）會變成「此應用程式無法在您的電腦上執行」。現在解壓在同一顆磁碟，舊檔改名成 .gbold、新檔搬進去（同磁碟只是改名，
// 一瞬間完成；執行中的 exe 也可以改名），搬完核對大小，有任何一個失敗就全部還原成舊版
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
// 新版先解壓到這裡（跟安裝資料夾同一顆磁碟，換檔時才能直接改名）
const staging = path.join(installDir, '.gbupdate')
const failedMark = path.join(staging, 'failed.txt')
let work = null
let extracted = null
let preparing = false // 下載 / 解壓中：啟動時的清理不能碰 .gbupdate（曾經解壓到一半被刪掉一部分）

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
  } catch {}
  for (const n of names) {
    const dir = path.join(root, n)
    if (dir === work || Date.now() - Number(n) < 10 * 60 * 1000) continue
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
  if (!supported() || extracted || preparing) return
  // 安裝資料夾裡上次換下來的舊檔（當時還被佔用、刪不掉的）和沒用完的解壓資料夾。更新失敗的紀錄留給 lastFailure() 讀
  try {
    if (!fs.existsSync(failedMark)) fs.rmSync(staging, { recursive: true, force: true })
  } catch {}
  const walk = (dir) => {
    let list = []
    try {
      list = fs.readdirSync(dir, { withFileTypes: true })
    } catch {}
    for (const d of list) {
      const p = path.join(dir, d.name)
      if (d.isDirectory()) {
        if (p !== staging) walk(p)
      } else if (d.name.endsWith('.gbold')) {
        try {
          fs.rmSync(p, { force: true })
        } catch {}
      }
    }
  }
  walk(installDir)
}

/** 上次更新失敗（已還原成舊版）的話回傳記錄檔的位置，只回報一次 */
function lastFailure() {
  if (!supported()) return null
  try {
    const log = fs.readFileSync(failedMark, 'utf8').trim()
    fs.rmSync(staging, { recursive: true, force: true })
    return { log }
  } catch {
    return null
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
  // PowerShell 錯誤訊息預設用系統編碼（Big5）輸出，改成 UTF-8 才不會變亂碼。
  // 解完逐一核對 zip 裡每個檔案都在、大小一樣，少一個就算失敗（還沒關程式，失敗了也不影響現在這份）
  const q = (s) => `'${s.replace(/'/g, "''")}'`
  const check =
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z = [IO.Compression.ZipFile]::OpenRead(${q(zip)}); ` +
    `try { foreach ($e in $z.Entries) { if (-not $e.Name) { continue }; $p = Join-Path ${q(dest)} ($e.FullName -replace '/', '\\'); ` +
    `if (-not (Test-Path -LiteralPath $p) -or (Get-Item -LiteralPath $p).Length -ne $e.Length) { throw ('incomplete: ' + $e.FullName) } } } finally { $z.Dispose() }`
  const cmd = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference='Stop'; try { Expand-Archive -LiteralPath ${q(zip)} -DestinationPath ${q(dest)} -Force; ${check} } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`
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
  preparing = true
  try {
    const zip = await download(info.url, info.size, onProgress)
    onProgress(101) // 解壓縮中
    // 解壓到安裝資料夾裡（同一顆磁碟），之後換檔只要改名
    const dest = path.join(staging, 'files')
    fs.rmSync(staging, { recursive: true, force: true })
    await unzip(zip, dest)
    const exe = path.join(dest, path.basename(process.execPath))
    if (!fs.existsSync(exe) || fs.statSync(exe).size < 1024 * 1024) throw new Error('更新檔內容不正確')
    extracted = dest
    try {
      fs.rmSync(zip, { force: true })
    } catch {}
  } finally {
    preparing = false
  }
}

/** 關閉程式、覆蓋檔案、重新開啟。呼叫後程式會結束 */
function install(quit) {
  if (!extracted) throw new Error('還沒下載更新')
  const exe = path.join(installDir, path.basename(process.execPath))
  // 用 PowerShell 等程式結束（批次檔在沒有主控台時 tasklist | find 會卡住）；
  // 腳本只放英數字，路徑全部用環境變數（Unicode）傳進去，資料夾名稱有中文也不會變亂碼。
  // 換檔：舊檔改名 .gbold → 新檔搬進去（同磁碟只是改名；執行中的 exe、載入中的 dll 也能改名，所以不怕還沒結束的子程序）。
  // 全部搬完再核對大小，任何一步失敗就把搬過的全部還原、寫 failed.txt，開回舊版
  const script = path.join(work, 'update.ps1')
  fs.writeFileSync(
    script,
    [
      '$ErrorActionPreference = "Stop"',
      '$log = $env:GB_LOG',
      'function Log($m) { try { "$(Get-Date -Format o) $m" | Add-Content -LiteralPath $log } catch {} }',
      'Log "start"',
      'try { Wait-Process -Id ([int]$env:GB_PID) -Timeout 60 -ErrorAction SilentlyContinue } catch {}',
      '$exe = $env:GB_EXE',
      '$dst = $env:GB_DST',
      // 舊版的 GPU / 網路 / crashpad 子程序也是 GrabBox.exe，等它們結束（最多 3 秒；沒結束也沒關係，改名照樣可以。
      // 等太久的話，視窗不見了使用者會以為當掉、自己再點開）
      'for ($i = 0; $i -lt 6; $i++) {',
      '  try { $left = @(Get-Process -Name $env:GB_NAME -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }) } catch { $left = @() }',
      '  if ($left.Count -eq 0) { break }',
      '  Start-Sleep -Milliseconds 500',
      '}',
      'Log "app exited, helpers left: $($left.Count)"',
      // 還沒結束的就收掉：exe 可以邊跑邊改名，但它們開著的資料檔（v8_context_snapshot.bin 等）不行
      'if ($left.Count) { try { $left | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 800 } catch {} }',
      '$done = New-Object System.Collections.ArrayList',
      'function Rollback {',
      '  for ($k = $done.Count - 1; $k -ge 0; $k--) {',
      '    $d = $done[$k]',
      '    try {',
      '      Remove-Item -LiteralPath $d.target -Force',
      '      if ($d.old) { Move-Item -LiteralPath ($d.target + ".gbold") -Destination $d.target -Force }',
      '    } catch { Log "ROLLBACK FAILED $($d.target): $($_.Exception.Message)" }',
      '  }',
      '  try { [IO.File]::WriteAllText($env:GB_FAILED, $log) } catch {}',
      '  Log "rolled back"',
      '}',
      'try {',
      '  $src = (Get-Item -LiteralPath $env:GB_SRC).FullName',
      '  foreach ($f in @(Get-ChildItem -LiteralPath $src -Recurse -File -Force)) {',
      '    $rel = $f.FullName.Substring($src.Length).TrimStart([char]92)',
      '    $target = Join-Path $dst $rel',
      '    $moved = $false',
      '    for ($t = 0; $t -lt 20 -and -not $moved; $t++) {',
      '      $old = $false',
      '      try {',
      '        $dir = Split-Path -Parent $target',
      '        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }',
      '        if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination ($target + ".gbold") -Force; $old = $true }',
      '        Move-Item -LiteralPath $f.FullName -Destination $target -Force',
      '        [void]$done.Add(@{ target = $target; old = $old; size = $f.Length })',
      '        $moved = $true',
      '      } catch {',
      '        if ($old) { try { Move-Item -LiteralPath ($target + ".gbold") -Destination $target -Force } catch {} }',
      '        Log "retry $rel : $($_.Exception.Message)"',
      '        Start-Sleep -Milliseconds 500',
      '      }',
      '    }',
      '    if (-not $moved) { throw "cannot replace $rel" }',
      '  }',
      '  foreach ($d in $done) {',
      '    if ((Get-Item -LiteralPath $d.target).Length -ne $d.size) { throw "size mismatch $($d.target)" }',
      '  }',
      '  foreach ($d in $done) { if ($d.old) { Remove-Item -LiteralPath ($d.target + ".gbold") -Force -ErrorAction SilentlyContinue } }',
      '  Remove-Item -LiteralPath $env:GB_STAGE -Recurse -Force -ErrorAction SilentlyContinue',
      '  Log "installed $($done.Count) files"',
      '} catch {',
      '  Log "ERROR $($_.Exception.Message)"',
      '  Rollback',
      '}',
      'Start-Process -FilePath $exe -WorkingDirectory $dst',
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
      GB_NAME: path.basename(exe, '.exe'),
      GB_SRC: extracted,
      GB_STAGE: staging,
      GB_FAILED: failedMark,
      GB_DST: installDir,
      GB_EXE: exe,
      GB_LOG: path.join(work, 'update.log'),
    },
  }).unref()
  setTimeout(quit, 300)
}

module.exports = { supported, check, notesFor, prepare, install, cleanOld, lastFailure, newer }
