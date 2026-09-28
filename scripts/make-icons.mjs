// 生成 PWA 图标（纯 Node，不装依赖）：纸上一个人形，腿上两枚派工标记。
// 用法：npm run icons
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const outDir = path.join(root, "client", "public", "icons")

const CRC_TABLE = new Int32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c
}

function crc32(buf) {
  let c = -1
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, "ascii")
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

const BG = [243, 234, 223]
const INK = [74, 59, 50]
const CHIEF = [196, 92, 38]
const MARKED = [31, 107, 74]
const WHITE = [255, 255, 255]

const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r

function inRound(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const dx = Math.max(x0 + r - x, x - (x1 - r), 0)
  const dy = Math.max(y0 + r - y, y - (y1 - r), 0)
  return dx * dx + dy * dy <= r * r
}

// fx/fy 是整个图形坐标 0..1；s 是图形占满画布的比例（遮罩图标要留边）。
// 圆点从内往外判，先彩色圆心，再白描边。
function shade(fx, fy) {
  if (inCircle(fx, fy, 0.555, 0.63, 0.05)) return CHIEF
  if (inCircle(fx, fy, 0.555, 0.63, 0.065)) return WHITE
  if (inCircle(fx, fy, 0.555, 0.79, 0.036)) return MARKED
  if (inCircle(fx, fy, 0.555, 0.79, 0.049)) return WHITE
  if (inCircle(fx, fy, 0.5, 0.155, 0.078)) return INK
  if (inRound(fx, fy, 0.4, 0.25, 0.6, 0.505, 0.045)) return INK
  if (inRound(fx, fy, 0.332, 0.265, 0.372, 0.5, 0.02)) return INK
  if (inRound(fx, fy, 0.628, 0.265, 0.668, 0.5, 0.02)) return INK
  if (inRound(fx, fy, 0.412, 0.52, 0.478, 0.9, 0.03)) return INK
  if (inRound(fx, fy, 0.522, 0.52, 0.588, 0.9, 0.03)) return INK
  return BG
}

function render(size, figureScale) {
  const rgba = Buffer.alloc(size * size * 4)
  const samples = 4
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0
      let g = 0
      let b = 0
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const nx = (px + (sx + 0.5) / samples) / size
          const ny = (py + (sy + 0.5) / samples) / size
          const fx = (nx - 0.5) / figureScale + 0.5
          const fy = (ny - 0.5) / figureScale + 0.5
          const color = shade(fx, fy)
          r += color[0]
          g += color[1]
          b += color[2]
        }
      }
      const at = (py * size + px) * 4
      rgba[at] = Math.round(r / (samples * samples))
      rgba[at + 1] = Math.round(g / (samples * samples))
      rgba[at + 2] = Math.round(b / (samples * samples))
      rgba[at + 3] = 255
    }
  }
  return encodePng(size, size, rgba)
}

fs.mkdirSync(outDir, { recursive: true })
const outputs = [
  ["icon-192.png", render(192, 0.86)],
  ["icon-512.png", render(512, 0.86)],
  ["maskable-512.png", render(512, 0.66)],
  ["apple-touch-icon.png", render(180, 0.86)],
]
for (const [name, png] of outputs) {
  fs.writeFileSync(path.join(outDir, name), png)
  console.log(`icons/${name} ${Math.round(png.length / 1024)}KB`)
}
