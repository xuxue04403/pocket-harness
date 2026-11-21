// 生成「二维码 → 模块矩阵 + 灰度像素」的金标，供 `packages/dsh_arkts` 的解码器核对。
//
// 背景：鸿蒙 SDK 里没有条码 API（见 docs/harmony-packaging.md），扫码只能自己做。
// 解码器一旦自己写，就需要一个「换实现也必须仍然成立」的锚点 —— 就是这里的矩阵。
// 矩阵用 Node 的 qrcode 生成（互不相关的实现），我们的解码器必须把它还原成同一串文本。
//
// 用法：
//   node tools/gen_qr_fixtures.mjs          # 写到 probe/qr_fixtures.json
//
// 产物同时含两种原料：
//   - rows：模块矩阵（'1'/'0' 字符串数组），用来测矩阵层；
//   - pixels：把矩阵放大成 4 像素一模块的灰度图（0/255 字节的 base64），
//     四周留 4 模块静区，用来测图像层（定位图案 → 采样 → 解码）。
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import QRCode from 'qrcode'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', '..', '..', 'probe', 'qr_fixtures.json')

// 四个样本各有理由：
//   pair-short   真实形状最短的一种（配对码前缀 + 极短载荷）
//   pair-typical 真实长度的配对码（约 60 字符，版本 4 上下）
//   url-utf8     含非 ASCII，用来验证「按字节算长度、按 UTF-8 还原」
//   one-char     单字符，最小的真实载荷（qrcode 不接受空文本，所以退一格）
const samples = [
  { label: 'pair-short', text: 'pocketharness://pair?t=AAAA', ec: 'M' },
  { label: 'pair-typical', text: 'pocketharness://pair?t=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ', ec: 'M' },
  { label: 'url-utf8', text: 'https://example.com/配对?q=手机', ec: 'L' },
  { label: 'one-char', text: '7', ec: 'H' },
]

const MODULE_PIXELS = 4
const QUIET_MODULES = 4

function rowsOf(qr) {
  const size = qr.modules.size
  const rows = []
  for (let y = 0; y < size; y += 1) {
    let row = ''
    // BitMatrix.get 的参数顺序是 (row, col)；写成 get(x, y) 会得到转置矩阵，
    // 而转置后的 QR 依然「看起来像二维码」（两个定位图案对调后仍是定位图案），
    // 所以这个错只有在解码出乱码时才会暴露。
    for (let x = 0; x < size; x += 1) row += qr.modules.get(y, x) ? '1' : '0'
    rows.push(row)
  }
  return rows
}

function pixelsOf(rows) {
  const size = rows.length
  const side = (size + QUIET_MODULES * 2) * MODULE_PIXELS
  const bytes = Buffer.alloc(side * side, 255)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (rows[y][x] !== '1') continue
      const left = (x + QUIET_MODULES) * MODULE_PIXELS
      const top = (y + QUIET_MODULES) * MODULE_PIXELS
      for (let dy = 0; dy < MODULE_PIXELS; dy += 1) {
        const base = (top + dy) * side + left
        bytes.fill(0, base, base + MODULE_PIXELS)
      }
    }
  }
  return { side, modulePixels: MODULE_PIXELS, quietModules: QUIET_MODULES, gray: bytes.toString('base64') }
}

const fixtures = samples.map(({ label, text, ec }) => {
  const qr = QRCode.create(text, { errorCorrectionLevel: ec })
  const rows = rowsOf(qr)
  return {
    label,
    text,
    errorCorrectionLevel: ec,
    version: qr.version,
    mask: qr.maskPattern,
    size: qr.modules.size,
    rows,
    pixels: pixelsOf(rows),
  }
})

writeFileSync(out, `${JSON.stringify({ source: 'node-qrcode', fixtures }, null, 2)}\n`, 'utf8')
process.stdout.write(`wrote ${fixtures.length} fixtures to ${out}\n`)
for (const fixture of fixtures) {
  process.stdout.write(`  ${fixture.label}: v${fixture.version} ${fixture.size}x${fixture.size} mask ${fixture.mask} ec ${fixture.errorCorrectionLevel}\n`)
}
