# GrabBox

Windows 下載管理器，類似 IDM：

- **瀏覽器影片偵測**：裝上擴充功能後，網頁播放影片時影片右上角會跳出「下載此影片」按鈕，點了就交給 GrabBox，並跳出確認視窗（可改檔名、選畫質）。
- **多連線分段下載**：伺服器支援 Range 時，一個檔案用多條連線同時下載（預設 8 條），可暫停、續傳，關掉程式再開會接著下。
- **HLS 串流（m3u8）**：自動選畫質、AES-128 解密、獨立音軌合併，下載完用內建 ffmpeg 轉成 MP4。
- **YouTube 等影音網站**：YouTube、Bilibili、X、Instagram、Facebook、TikTok、Vimeo、Twitch… 交給 [yt-dlp](https://github.com/yt-dlp/yt-dlp) 解析，可選畫質（最高 4K）或只要聲音（M4A / MP3）。yt-dlp 第一次用到時會從官方 GitHub 自動下載，之後每週自動更新；在主視窗貼上其他網站的影片網頁網址也會試著用它解析。
- **BT 種子**：磁力連結、.torrent 檔（開檔、拖進視窗、網頁上點連結都可以），可只勾選部分檔案，下載完可繼續做種（分享率上限、上傳 / 下載限速）。

## 下載

最新版：[GrabBox-Windows.zip](https://github.com/DLIN131/GrabBox/releases/latest/download/GrabBox-Windows.zip)（解壓縮後執行 `GrabBox.exe`，瀏覽器擴充在同一個資料夾的 `extension` 裡）。

每次推到 `main` 都會由 GitHub Actions 自動打包並發布新版（v1.0.<編號>）。

## 開發

```bash
npm install
```

```bash
npm start
```

打包 Windows 版（輸出到 `dist/GrabBox-win32-x64`，擴充功能會一起放在 `extension` 資料夾）：

```bash
node pack.js
```

## 安裝瀏覽器擴充（Chrome / Edge）

1. GrabBox 主視窗右上角的拼圖按鈕 →「開啟擴充資料夾」（路徑會複製到剪貼簿）。
2. 網址列輸入 `chrome://extensions`（Edge 是 `edge://extensions`），打開「開發人員模式」。
3. 按「載入未封裝項目」，選 `extension` 資料夾。

擴充功能的彈出視窗可以開關：影片上的下載按鈕、磁力 / 種子連結交給 GrabBox、接管瀏覽器下載。

## 架構

| 檔案 | 用途 |
| --- | --- |
| `main.js` | 視窗、系統匣、新增下載視窗、IPC、`grabbox://` / `magnet:` 協定 |
| `lib/manager.js` | 任務清單、排程、設定、新增視窗的探測（判斷一般檔案 / HLS / 種子） |
| `lib/httpdl.js` | 多連線分段下載（`.gbpart` + 每段完成記號） |
| `lib/hls.js` | m3u8 解析、片段下載與解密、合併、ffmpeg 轉 MP4（片段暫存在 `.gbhls` 資料夾） |
| `lib/torrent.js` | WebTorrent 包裝：取得種子資訊、選檔、做種、校驗快照 |
| `lib/ytdlp.js` | yt-dlp 包裝：自動下載 / 更新、解析畫質、下載進度、暫停續傳 |
| `lib/server.js` | `127.0.0.1:47321` 本機服務，只接受擴充功能送來的請求 |
| `extension/` | Chrome MV3 擴充：`background.js` 偵測、`content.js` 影片按鈕、`popup.*` 彈出視窗 |

資料存在 `%APPDATA%\GrabBox`（`settings.json`、`jobs.json`、`torrents\`）。

## 限制

- 有 DRM 的影片（Netflix、Disney+ 等）不支援。
- 直播的 HLS 只會下載按下時已經有的片段；YouTube 直播中的影片要等直播結束。
- YouTube 不會帶你的登入 Cookie（避免帳號被標記），所以會員限定、年齡限制的影片下載不了。
