import { readFileSync, writeFileSync } from 'node:fs'

const fixturePath = 'D:/IDE/dsh-bot/probe/qr_fixtures.json'
const target = 'D:/IDE/dsh-bot/tools/ohos-probe/entry/src/main/ets/qr_samples.ts'

const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8')).fixtures
const wanted = ['one-char', 'pair-short', 'pair-typical']

const blocks = []
for (const fixture of fixtures) {
  if (!wanted.includes(fixture.label)) continue
  const rows = fixture.rows.map((row) => `    '${row}',`).join('\n')
  blocks.push(
    `  {\n` +
      `    label: '${fixture.label}',\n` +
      `    text: '${fixture.text.replace(/'/g, "\\'")}',\n` +
      `    version: ${fixture.version},\n` +
      `    level: '${fixture.errorCorrectionLevel}',\n` +
      `    mask: ${fixture.mask},\n` +
      `    rows: [\n${rows}\n    ],\n` +
      `  },`,
  )
}

const header = `/**
 * 三张二维码金标，供 \`selfcheck.ts\` 在 ArkTS 运行时里真解一遍。
 *
 * 为什么要把它们硬编码进来：\`core/qr/\` 能在 Node 里解出文本，只证明 TypeScript
 * 语义正确；手机上是 ArkTS 编译器 + ArkTS 运行时，整数运算、数组下标与字符串
 * 处理都可能与 V8 不同。这里放三张（v1 单块、v3 单块、v5 两块交织），版本与
 * 纠错等级都不一样，足以覆盖解码器里所有依赖版本的分支。
 *
 * 数据来自 \`probe/qr_fixtures.json\`（由 \`packages/dsh_arkts/tools/gen_qr_fixtures.mjs\`
 * 用 node-qrcode 生成，再用 jsQR 独立验证过），\`tools/gen_qr_samples.mjs\` 负责拷贝。
 */

/** 一张待解的样张。 */
export interface QrSample {
  readonly label: string
  readonly text: string
  readonly version: number
  readonly level: string
  readonly mask: number
  readonly rows: string[]
}

export const QR_SAMPLES: QrSample[] = [
${blocks.join('\n')}
]
`

writeFileSync(target, header)
console.log('wrote', target, header.length, 'chars')
