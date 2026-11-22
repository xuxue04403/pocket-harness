// 把二维码金标里挑出来的几张，转成鸿蒙工程能直接 import 的 TypeScript 常量。
//
// 用途：`tools/ohos-probe/` 的自检按钮要在 ArkTS 运行时里真解一遍二维码，
// 所以矩阵必须是字面量（鸿蒙侧读不到仓库里的 json）。
//
// 用法：node tools/gen_qr_samples.mjs
//
// 路径都从本文件反推，不写死绝对路径 —— 写死的那版换台电脑就找不到输入。

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(here, '..', '..', '..', 'probe', 'qr_fixtures.json')
const target = join(here, '..', '..', '..', 'tools', 'ohos-probe', 'entry', 'src', 'main', 'ets', 'qr_samples.ts')

const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8')).fixtures
const wanted = ['one-char', 'pair-short', 'pair-typical']

/** 单引号字符串，与本仓库其余 TS 一致（JSON.stringify 会给双引号）。 */
function quoted(text) {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

const blocks = []
for (const fixture of fixtures) {
  if (!wanted.includes(fixture.label)) continue
  const rows = fixture.rows.map((row) => `    '${row}',`).join('\n')
  blocks.push(
    '  {\n' +
      `    label: '${fixture.label}',\n` +
      `    text: ${quoted(fixture.text)},\n` +
      `    version: ${fixture.version},\n` +
      `    level: '${fixture.errorCorrectionLevel}',\n` +
      `    mask: ${fixture.mask},\n` +
      '    rows: [\n' +
      rows +
      '\n    ],\n' +
      '  },',
  )
}

const file =
  '/**\n' +
  ' * 三张二维码金标，供 `selfcheck.ts` 在 ArkTS 运行时里真解一遍。\n' +
  ' *\n' +
  ' * 为什么要把它们硬编码进来：`core/qr/` 能在 Node 里解出文本，只证明 TypeScript\n' +
  ' * 语义正确；手机上是 ArkTS 编译器 + ArkTS 运行时，整数运算、数组下标与字符串\n' +
  ' * 处理都可能与 V8 不同。这里放三张（v1 单块、v3 单块、v5 两块交织），版本与\n' +
  ' * 纠错等级都不一样，足以覆盖解码器里所有依赖版本的分支。\n' +
  ' *\n' +
  ' * 数据来自 `probe/qr_fixtures.json`（由 `packages/dsh_arkts/tools/gen_qr_fixtures.mjs`\n' +
  ' * 用 node-qrcode 生成，再用 jsQR 独立验证过），本文件由\n' +
  ' * `packages/dsh_arkts/tools/gen_qr_samples.mjs` 生成，不要手改。\n' +
  ' */\n' +
  '\n' +
  '/** 一张待解的样张。 */\n' +
  'export interface QrSample {\n' +
  '  readonly label: string\n' +
  '  readonly text: string\n' +
  '  readonly version: number\n' +
  '  readonly level: string\n' +
  '  readonly mask: number\n' +
  '  readonly rows: string[]\n' +
  '}\n' +
  '\n' +
  'export const QR_SAMPLES: QrSample[] = [\n' +
  blocks.join('\n') +
  '\n]\n'

writeFileSync(target, file, 'utf8')
console.log(`wrote ${blocks.length} sample(s) to ${target} (${file.length} chars)`)
