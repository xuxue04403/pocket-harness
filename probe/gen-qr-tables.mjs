// Extracts the QR block tables from packages/dsh_arkts/src/qr/tables.ts so the
// encoder in host/qr_encode.js uses the same numbers as the decoder instead of
// a hand-copied version of them.
//
// Run: node probe/gen-qr-tables.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const source = readFileSync(join(root, 'packages/dsh_arkts/src/qr/tables.ts'), 'utf8')

function numbers(name) {
  const start = source.indexOf(`export const ${name}`)
  if (start < 0) throw new Error(`${name} not found`)
  // `readonly number[]` puts a bracket before the literal, so the array opens
  // at the first '[' after the '=' rather than after the name.
  const equals = source.indexOf('=', start)
  const open = source.indexOf('[', equals)
  const close = source.indexOf(']', open)
  return source
    .slice(open + 1, close)
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0)
    .map(Number)
}

const total = numbers('TOTAL_CODEWORDS')
const blocks = numbers('EC_BLOCKS')
const ecTotal = numbers('EC_TOTAL')
if (total.length !== 40 || blocks.length !== 160 || ecTotal.length !== 160) {
  throw new Error(`unexpected table sizes: ${total.length}, ${blocks.length}, ${ecTotal.length}`)
}

// The tables are column-major over L, M, Q, H: slot = (version - 1) * 4 + level.
const LEVELS = ['L', 'M', 'Q', 'H']
const perLevel = { blocks: {}, ec: {} }
for (const [index, level] of LEVELS.entries()) {
  perLevel.blocks[level] = []
  perLevel.ec[level] = []
  for (let version = 1; version <= 40; version += 1) {
    const slot = (version - 1) * 4 + index
    perLevel.blocks[level].push(blocks[slot])
    perLevel.ec[level].push(ecTotal[slot])
  }
}

function rows(values, perLine = 4) {
  const out = []
  for (let index = 0; index < values.length; index += perLine) {
    out.push(`  ${values.slice(index, index + perLine).join(', ')},`)
  }
  return out.join('\n')
}

const lines = []
lines.push('/** Total codewords (data + error correction) for a version. */')
lines.push('const TOTAL_CODEWORDS = [')
lines.push(rows(total))
lines.push(']')
lines.push('')
lines.push('/**')
lines.push(' * Error correction codewords *per block*, indexed by version.')
lines.push(' *')
lines.push(' * Copied mechanically from packages/dsh_arkts/src/qr/tables.ts (see')
lines.push(' * probe/gen-qr-tables.mjs) so the encoder and the decoder cannot disagree')
lines.push(' * about how a symbol is split.')
lines.push(' */')
lines.push('const EC_PER_BLOCK = {')
for (const level of LEVELS) {
  const perBlock = perLevel.ec[level].map((ec, index) => ec / perLevel.blocks[level][index])
  lines.push(`  ${level}: [`)
  lines.push(rows(perBlock))
  lines.push('  ],')
}
lines.push('}')
lines.push('')
lines.push('/** Number of Reed-Solomon blocks, indexed by version. */')
lines.push('const EC_BLOCKS = {')
for (const level of LEVELS) {
  lines.push(`  ${level}: [`)
  lines.push(rows(perLevel.blocks[level]))
  lines.push('  ],')
}
lines.push('}')

const text = lines.join('\n') + '\n'
writeFileSync(join(here, '_qr_tables.txt'), text, 'utf8')
console.log(`wrote ${text.length} chars to probe/_qr_tables.txt`)

// Sanity: the four levels must give decreasing capacity, and every level's data
// codewords must be positive for every version.
for (const level of LEVELS) {
  for (let version = 1; version <= 40; version += 1) {
    const slot = (version - 1) * 4 + LEVELS.indexOf(level)
    const data = total[version - 1] - ecTotal[slot]
    if (data <= 0) throw new Error(`${level} v${version} has ${data} data codewords`)
    if (ecTotal[slot] % blocks[slot] !== 0) throw new Error(`${level} v${version} ec does not divide evenly`)
  }
}
console.log('tables look consistent')
