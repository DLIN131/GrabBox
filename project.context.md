# GrabBox 專案脈絡

給之後接手的人（或 AI）看的技術細節與變更紀錄。改程式前先讀這份，改完補一筆變更紀錄。

## 技術選擇

- Electron 39（Node 22）：WebTorrent 3 要求 Node ≥ 22，所以不能用舊專案的 Electron 33。打包用 `@electron/packager` 18.4.4（本機 Node 是 18，新版 packager 不支援）。
- WebTorrent 3 是 ESM：在 CJS 主程序用 `await import('webtorrent')`。它會帶 `node-datachannel`、`utp-native` 原生模組，打包時 `asar.unpack: **/{*.node,*.dll,*.exe}`。
- ffmpeg 用 `ffmpeg-static`（約 79 MB），路徑要把 `app.asar\` 換成 `app.asar.unpacked\`。設定裡可以改用自己的 ffmpeg。
- 檔案操作一律用 `original-fs`（避開 Electron 的 asar 攔截）。

## 運作方式

- **擴充 → 程式**：`extension/background.js` 用 `webRequest.onHeadersReceived` 看 Content-Type / 副檔名 / 大小找影片；`onBeforeSendHeaders`（extraHeaders）記下 Referer / Origin；送出時用 `chrome.cookies` 組 Cookie，POST 到 `http://127.0.0.1:47321/add`（47321–47323 依序試）。
- **本機服務安全**：有 Origin 且不是 `chrome-extension://` 等就拒絕；`/add` 必須帶 `X-GrabBox: 1`（逼網頁走 CORS 預檢，預檢只放行擴充）。
- **程式沒開**：擴充把分頁導到 `grabbox://launch`（瀏覽器會詢問），程式啟動時註冊了這個協定；之後擴充每 1.5 秒 ping 一次再重送。
- **HLS 偵測**：背景程式會自己 fetch m3u8，master 的話記下子清單網址（子清單就不重複列）和最高解析度；有 SAMPLE-AES / skd:// 的視為 DRM 不列。
- **分段下載**：chunk 大小 = clamp(total/512, 1MB, 16MB)，進度字串 `job.chunks`（'0'/'1'），不支援 Range（probe 時 `Range: bytes=0-0` 沒回 206）就單連線、暫停後重來。401/403/404/410 不重試直接失敗。
- **種子**：新增視窗取得資訊時，磁力連結會用 `deselect:true` 加進 client 拿 metadata、存成 `userData/torrents/<infoHash>.torrent` 後馬上移除；真正開始時從存檔加入，並把磁力連結的 `tr=`、`x.pe=` 補回去（否則會找不到節點）。暫停 = destroy（保留檔案），每 30 秒存 bitfield，下次啟動用 `opts.bitfield` 只抽查不全部重算。
- **沒勾選的種子檔案**：會因邊界區塊被寫入而撐到接近原大小（內容幾乎是 0），種子停止（完成且不做種）時 `cleanupUnselected` 會刪掉。WebTorrent 的 `done` 事件要所有檔案完成才會觸發，所以完成判斷自己做（勾選的檔案都 done）。

## HLS 的廣告、中斷點、偽裝片段

- `hls.parse` 記下每個片段的中斷點段號（`period`，遇到 `#EXT-X-DISCONTINUITY` +1）和廣告標記（`cue`：`#EXT-X-CUE-OUT`～`CUE-IN`、CLASS 含 ad 的 `#EXT-X-DATERANGE` 到下一個中斷點）。
- `stripAds`（`load()` 裡自動套用）：拿掉 `cue` 片段；有多個中斷段時，若某段大部分片段網址「樣子」（主機 + 路徑、數字換成 #）跟正片（總長最長的樣子）不同、且 ≤ 150 秒、< 總長一半，就整段當廣告。全部都被判掉時照原樣下載。新增視窗顯示「已略過插播廣告」。
- `alignTs`：TS 片段開頭不是 0x47 時，找連續三個相隔 188 的 0x47 從那裡開始（有網站把片段偽裝成 PNG/JPEG，前面塞圖片標頭；沒對齊 ffmpeg 會把整個檔當 PNG，輸出沒有片長）。fMP4 不處理。
- 合併：TS 有多個中斷段時每段各自接成檔，用 ffmpeg concat demuxer（`-f concat -safe 0`，清單用正斜線、單引號跳脫）接起來重排時間戳。實測 ffmpeg 自己產生的「時間戳重來」直接接也不會變短，這是保險做法。
- 擴充：master 會再讀最高畫質子清單算片長；排序 整頁 → 長串流（片長長的先）→ 直連檔 → 不到 60 秒的串流（標「短片，可能是預告或廣告」、選單裡變淡）。以前照偵測時間排，後載入的預告 / 廣告會排在正片前面。

## YouTube 等影音網站（yt-dlp）

- 一般偵測刻意過濾 googlevideo.com、.m4s、帶 range 參數的請求（DASH 片段接不起來），所以這些網站改成「整頁交給 yt-dlp」：擴充 `background.js` 的 `SITES` 在分頁網址符合時加一個 `kind: 'page'` 項目（排第一），`lib/ytdlp.js` 有同一份清單（兩邊要一起改）。
- yt-dlp.exe 不放進安裝包：第一次用時從 `github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe` 下載到 `userData/bin`，啟動 1 分鐘後若超過 7 天沒更新就跑 `yt-dlp -U`。設定可改成自訂路徑（就不自動更新）。
- YouTube 需要 JS runtime（Node ≥ 22，見 yt-dlp wiki 的 EJS 頁）：用 `--js-runtimes node:<process.execPath>` 加環境變數 `ELECTRON_RUN_AS_NODE=1`，讓 Electron 自己當 Node。官方 yt-dlp.exe 已內含 EJS 腳本。
- YouTube 不帶 Cookie（`noCookies`），其他網站把擴充送來的 Cookie 轉成 Netscape cookies.txt 暫存檔給 `--cookies`。
- 畫質選項 id：`v<高度>` → `-f bv*+ba/b -S res:<高度>,ext:mp4:m4a --merge-output-format mp4`；`a-m4a`、`a-mp3` 只要聲音。
- 進度：`--progress-template` 輸出 `GBPROG 格式|已下載|總量|估計`，影像、聲音分開累計；每次啟動 yt-dlp 會從頭回報（含續傳部分），所以 `job.done` 歸零重算、第一筆不算速度。`--print after_move:GBFILE %(filepath)s` 拿最終檔名。暫停用 `taskkill /T /F`（yt-dlp.exe 底下有子程序和 ffmpeg），續傳靠 yt-dlp 的 `.part`。
- 主視窗貼上一般網頁網址（Content-Type 是 HTML）時也會試 yt-dlp。

## 自動更新（v1.0.4 起）

- `lib/updater.js`（沿用 ReelBox 的做法）：主程序查 `api.github.com/repos/DLIN131/GrabBox/releases/latest`（頁面的 CSP 不能連外，所以不在頁面查）→ 下載 `GrabBox-Windows.zip` 到 `%TEMP%\GrabBox-update\<時間>` → PowerShell `Expand-Archive` 解壓 → 寫 `update.ps1`：`Wait-Process` 等程式結束 → `robocopy /E` 覆蓋安裝資料夾 → `Start-Process` 重開。log 在同一個暫存資料夾的 `update.log`。
- 坑（都在註解裡）：一定要 `original-fs`（app.asar 會被當資料夾）；PowerShell 要用 detached 的 `cmd /c start` 開（直接 detached 沒有主控台會立刻結束、不 detached 會跟著程式被關）；路徑用環境變數傳（中文資料夾不亂碼）。
- 啟動 20 秒後、之後每 6 小時檢查（設定可關）；主視窗右下角提示（立即更新 / 略過這個版本 / 稍後），視窗收在系統匣時跳系統通知。更新後第一次開啟顯示這版的更新內容（localStorage `lastSeenVersion`）。
- 擴充跟著更新：程式更新會覆蓋 exe 旁的 `extension` 資料夾；擴充背景程式醒來時（最多 10 分鐘一次）和打開彈出視窗時 ping 程式，程式版本比 manifest 新就 `chrome.runtime.reload()`，同一個版本只試一次（`reloadedFor`），避免從別的資料夾載入時一直重載；還是舊的就在彈出視窗提示改從 GrabBox 資料夾載入。
- 測試用環境變數：`GRABBOX_USER_DATA`（另一個資料夾、不註冊 grabbox:// 協定、不跟正在跑的 GrabBox 搶單一實例鎖）、`GRABBOX_UPDATE_API`（指到本機假的 GitHub）。實測流程：打包 A、B 兩份 → B 壓成 zip 由假 GitHub 提供 → A 用 `--hidden --remote-debugging-port` 啟動 → DevTools 協定呼叫 `gb.update.check/prepare/install` → 確認 A 的 version.txt 變成 B 的、新程序自動開起來。
- 本機打包時 `app.getVersion()` 來自 package.json（CI 會 `npm version`），`APP_VERSION` 只影響 exe 資訊和 version.txt。

## 發布

- Repo：github.com/DLIN131/GrabBox（公開）。推到 `main` 會跑 `.github/workflows/release.yml`：Node 22、`npm ci`、版本設成 `1.0.<run_number>`（package.json 和 extension/manifest.json 都改）、`node pack.js`、壓成 `GrabBox-Windows.zip` 發布到 Releases。
- 只改 `.md` 不會觸發發布。
- 固定下載網址：https://github.com/DLIN131/GrabBox/releases/latest/download/GrabBox-Windows.zip

## 測試

測試腳本不在專案裡（放在 scratchpad），做法：

- 引擎：用 Electron 執行腳本，`app.setPath('userData', 暫存)` 後直接 require `lib/manager.js`，自架 HTTP 伺服器（限速、Range、轉址、Referer 檢查）、用 ffmpeg-static 產生 HLS（TS+AES、fMP4+獨立音軌），WebTorrent 另開一個 client 做種，用帶 `x.pe=127.0.0.1:port` 的磁力連結下載。
- 介面：require `main.js` 前把 `app.setAsDefaultProtocolClient` 換成空函式（避免改到系統協定關聯），模擬擴充 POST /add，`capturePage` 截圖。被擋住的視窗 Chromium 不重畫，截圖前要 focus。
- 擴充：`background.js` 放進 Node `vm` 搭配假的 chrome API 測偵測；`content.js` 放在含假 chrome 物件的測試頁，用 Electron `sendInputEvent` 模擬滑鼠截圖。

## 變更紀錄

### v1.0.4（2026-11-01）

- 新增自動更新：啟動後和每 6 小時檢查 GitHub 新版，右下角提示，按「立即更新」會下載、關閉、覆蓋並自動重新開啟；更新後第一次開啟顯示更新內容。設定裡可以關閉自動檢查、手動檢查更新。
- 擴充在程式更新後自動重新載入自己；如果是從別的資料夾載入的，彈出視窗會提示改從 GrabBox 資料夾載入。
- 側邊欄顯示目前版本。

### v1.0.3（2026-11-01）

- 修正 HLS 只下載到幾秒：片段被偽裝成圖片（前面塞 PNG 標頭）時自動對齊到真正的 TS；有中斷點的串流分段重排時間戳再合併。
- 自動略過插播廣告（CUE-OUT / DATERANGE 標記、或中斷點隔開的短廣告段），新增視窗會顯示略過了多久；不到一分鐘的串流會提醒可能是預告或廣告。
- 擴充：偵測到的影片依片長排序（master 也會顯示片長），短片排最後並標示，不會再因為預告、廣告比較晚載入而排在正片前面。

### v1.0.2（2026-11-01）

- 支援 YouTube、Bilibili、X、Instagram、Facebook、TikTok、Vimeo、Twitch、Dailymotion、niconico：這些網站的影片頁，影片上的按鈕會出現「選擇畫質下載」，交給 yt-dlp（自動下載、每週更新），可選畫質或只要聲音（M4A / MP3）。
- 新增視窗：影音網站顯示縮圖、上傳者、畫質清單；長時間步驟（第一次下載 yt-dlp、解析）會顯示進度文字；視窗加高。
- 擴充：安裝 / 重新載入時自動注入到已開啟的分頁（新增 `scripting` 權限），舊版本留下的按鈕會自己移除。
- 設定：yt-dlp 路徑、立即更新 yt-dlp。

### v1.0.0（2026-11-01）

- 初版：多連線分段下載、HLS（AES-128、fMP4、獨立音軌、轉 MP4）、BT 種子（選檔、做種、限速）、Chrome / Edge 擴充（影片按鈕、彈出視窗、右鍵選單、磁力連結攔截、選用的接管瀏覽器下載）、系統匣、完成通知、工作列進度。
