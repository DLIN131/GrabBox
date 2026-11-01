// 打包 Windows 版：node pack.js [輸出資料夾]
const { packager } = require('@electron/packager')
const path = require('path')
const fs = require('fs')

const out = process.argv[2] || 'dist'
const version = process.env.APP_VERSION || require('./package.json').version

packager({
  dir: __dirname,
  name: 'GrabBox',
  platform: 'win32',
  arch: 'x64',
  out,
  overwrite: true,
  // ffmpeg.exe、原生模組（.node / .dll）不能放在 asar 裡執行
  asar: { unpack: '**/{*.node,*.dll,*.exe}' },
  icon: path.join(__dirname, 'src', 'icon.ico'),
  appVersion: version,
  win32metadata: { CompanyName: 'GrabBox', FileDescription: 'GrabBox 下載管理器', ProductName: 'GrabBox' },
  // 只排除專案根目錄的東西（路徑以 / 開頭、相對於專案資料夾）
  ignore: [/^\/\.github($|\/)/, /^\/dist($|\/)/, /^\/out($|\/)/, /^\/tools($|\/)/, /^\/extension($|\/)/, /^\/pack\.js$/, /^\/\.gitignore$/, /^\/README\.md$/, /^\/project\.context\.md$/],
})
  .then(([appPath]) => {
    // 瀏覽器擴充放在 GrabBox.exe 旁邊，使用者用「載入未封裝項目」選這個資料夾
    fs.cpSync(path.join(__dirname, 'extension'), path.join(appPath, 'extension'), { recursive: true })
    fs.writeFileSync(path.join(appPath, 'version.txt'), version)
    console.log(`打包完成：${appPath}（v${version}）`)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
