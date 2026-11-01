// 產生程式與擴充功能的圖示（PNG / ICO），不需要任何繪圖套件：node tools/icons.js
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const root = path.join(__dirname, '..')

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cx = Math.min(Math.max(x, x0 + r), x1 - r)
  const cy = Math.min(Math.max(y, y0 + r), y1 - r)
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}

function inTri(x, y, [ax, ay], [bx, by], [cx, cy]) {
  const s = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry)
  const d1 = s(x, y, ax, ay, bx, by)
  const d2 = s(x, y, bx, by, cx, cy)
  const d3 = s(x, y, cx, cy, ax, ay)
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
}

/** 單位座標 (0..1) 的圖案：藍色圓角方塊 + 白色下載箭頭 */
function sample(x, y) {
  if (!inRoundRect(x, y, 0.04, 0.04, 0.96, 0.96, 0.22)) return null
  const white =
    inRoundRect(x, y, 0.425, 0.17, 0.575, 0.52, 0.03) ||
    inTri(x, y, [0.24, 0.45], [0.76, 0.45], [0.5, 0.72]) ||
    inRoundRect(x, y, 0.24, 0.76, 0.76, 0.85, 0.04)
  if (white) return [255, 255, 255]
  // 上亮下暗的漸層
  const t = y
  return [Math.round(0x5b + (0x2a - 0x5b) * t), Math.round(0x9b + (0x5c - 0x9b) * t), Math.round(0xff + (0xd8 - 0xff) * t)]
}

function render(size) {
  const ss = size <= 32 ? 6 : 4
  const px = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size)
          if (!c) continue
          r += c[0]
          g += c[1]
          b += c[2]
          a++
        }
      }
      const i = (y * size + x) * 4
      if (a) {
        px[i] = Math.round(r / a)
        px[i + 1] = Math.round(g / a)
        px[i + 2] = Math.round(b / a)
        px[i + 3] = Math.round((a / (ss * ss)) * 255)
      }
    }
  }
  return png(size, px)
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

function png(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

function ico(images) {
  const head = Buffer.alloc(6)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(images.length, 4)
  let offset = 6 + images.length * 16
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size
    e[1] = size >= 256 ? 0 : size
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += data.length
    return e
  })
  return Buffer.concat([head, ...entries, ...images.map((i) => i.data)])
}

const out = (p, d) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, d)
  console.log('寫入', path.relative(root, p))
}

const sizes = [16, 24, 32, 48, 64, 128, 256]
const imgs = sizes.map((size) => ({ size, data: render(size) }))
const get = (s) => imgs.find((i) => i.size === s).data
out(path.join(root, 'src', 'icon.png'), get(256))
out(path.join(root, 'src', 'icon.ico'), ico(imgs))
for (const s of [16, 32, 48, 128]) out(path.join(root, 'extension', 'icons', s + '.png'), get(s))
