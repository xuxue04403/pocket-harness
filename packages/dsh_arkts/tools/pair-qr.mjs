// 把一份配对码渲染成二维码 PNG，方便用手机直接扫。
//
// 手机端的扫码页读的就是 `pocketharness://pair?t=…` 这串文本，所以这里只是把
// 同一串文本画成图，不改协议、不碰密钥：ticket 文件里本来就含配对密钥，二维码
// 是它唯一的展示形式，因此产物必须落在 .gitignore 覆盖的路径里。
//
// 用法：
//   node tools/pair-qr.mjs [ticketFile] [outPng] [--size=760]
//
//   ticketFile  默认 probe/_live-ticket.txt（由 probe/live-ticket.mjs 生成）
//   outPng      默认 probe/_pairing.png
//
// 只在终端报告尺寸与字节数，绝不回显配对码本身。

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import QRCode from 'qrcode'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..', '..')

const args = process.argv.slice(2)
const sizeArg = args.find(arg => arg.startsWith('--size='))
const files = args.filter(arg => !arg.startsWith('--'))
const ticketFile = resolve(files[0] ?? resolve(repo, 'probe', '_live-ticket.txt'))
const outPng = resolve(files[1] ?? resolve(repo, 'probe', '_pairing.png'))
const width = sizeArg === undefined ? 760 : Number.parseInt(sizeArg.slice('--size='.length), 10)

const text = readFileSync(ticketFile, 'utf8').trim()
if (!text.startsWith('pocketharness://pair?')) {
  throw new Error(`${ticketFile} does not look like a pairing ticket`)
}

// 纠错等级 M 是扫码页的默认值；配对码最长约 340 字符，M 级仍落在版本 10 以内，
// 手机中距离扫得动。margin 留 4 个模块的静区，少了它会扫不出来。
const buffer = await QRCode.toBuffer(text, {
  type: 'png',
  errorCorrectionLevel: 'M',
  margin: 4,
  width: Number.isFinite(width) && width > 0 ? width : 760,
})

writeFileSync(outPng, buffer)
process.stderr.write(`rendered ${text.length} chars into ${outPng} (${buffer.length} bytes, ${width}px)\n`)
