// Does anybody else's QR writer produce the same symbol as ours?
//
// This exists because of a bug that survived every other test in the tree. Our
// encoder wrote the eighteen version-information modules least-significant bit
// last, and our decoder read them the same way, so encoding and decoding agreed
// with each other for a year of releases while every phone and WeChat refused
// the code for any version from seven up. A round trip through our own code can
// never catch that: both halves share the mistake.
//
// So the referee here is `qrcode`, the npm package the TypeScript tools already
// depend on, which is known to produce symbols that phones read. For each
// payload we encode with our writer, ask the reference writer for the same
// version, level and mask, and demand the matrices be identical module for
// module. If they are, no scanner can prefer one over the other.
//
// When jsQR happens to be installed we also decode our own render, which catches
// the opposite mistake: a matrix that matches the reference but is drawn wrong.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { encodeMatrix } from '../host/qr_encode.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const arktsModules = join(root, 'packages', 'dsh_arkts', 'node_modules')

const reference = (await import(`file:///${join(arktsModules, 'qrcode', 'lib', 'index.js').replaceAll('\\', '/')}`)).default
const { PNG } = await import(`file:///${join(arktsModules, 'pngjs', 'lib', 'png.js').replaceAll('\\', '/')}`)

let jsQR = null
try {
  const loaded = await import(`file:///${join(root, 'probe', '_publisher', 'node_modules', 'jsqr', 'dist', 'jsQR.js').replaceAll('\\', '/')}`)
  jsQR = loaded.default ?? loaded
} catch {
  // Optional on purpose: the matrix comparison below is the check that matters.
  jsQR = null
}

let failed = 0
const check = (name, run) => {
  try {
    const detail = run()
    console.log(`  ok   ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name} — ${error.message}`)
  }
}

/**
 * A payload of `bytes` characters, so versions are easy to hit exactly.
 *
 * The seed has to contain characters that only byte mode can carry. A seed of
 * digits or capitals lets the reference writer pack the same text into numeric
 * or alphanumeric mode and choose a much smaller version, which makes this
 * comparison fail for a reason that has nothing to do with the encoder.
 */
const payload = (bytes, seed) => {
  const safe = `${seed.toLowerCase()}~_`
  let text = ''
  for (let index = 0; index < bytes; index += 1) text += safe[index % safe.length]
  return text
}

/** Render a matrix the way the page does and hand it to jsQR. */
function decodesWithJsQR(cells) {
  const side = cells.length
  const scale = 8
  const quiet = 4 * scale
  const width = side * scale + quiet * 2
  const png = new PNG({ width, height: width })
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4
      const column = Math.floor((x - quiet) / scale)
      const row = Math.floor((y - quiet) / scale)
      const dark = row >= 0 && column >= 0 && row < side && column < side && cells[row][column]
      const value = dark ? 0 : 255
      png.data[at] = value
      png.data[at + 1] = value
      png.data[at + 2] = value
      png.data[at + 3] = 255
    }
  }
  const result = jsQR(new Uint8ClampedArray(png.data), width, width)
  return result === null ? null : result.data
}

console.log(`jsQR ${jsQR === null ? 'is not installed, matrix comparison only' : 'is installed and will also decode'}`)

// One point in every version band, weighted towards seven and up because that
// is where the version blocks live and where the old bug hid.
const cases = [
  ['v1 一个短词', 'hello'],
  ['v2 配对前缀', 'pocketharness://pair?t=abc'],
  ['v3 一个网址', 'https://example.com/a/b/c/d/e/f/g'],
  ['v5 中文', '手机配对二维码，扫一次就够了，之后换个网络也能连上这台电脑。'.repeat(2)],
  ['v7 第一个带版本块的', payload(110, 'abcdefg')],
  ['v9 版本块加长数据', payload(200, 'bytes~_mode')],
  ['v12 更宽', payload(320, 'qwertyuiop')],
  ['v16 真实票据大小', payload(543, 'ticket-payload-')],
  ['v20 再宽一些', payload(800, 'ZYXWVUTSRQ')],
  ['v26 接近上限', payload(1300, 'longer-payload-')],
]

for (const [name, text] of cases) {
  const ours = encodeMatrix(text, { level: 'L' })
  const size = ours.cells.length
  const version = (size - 17) / 4

  check(`${name} (v${version} ${size}x${size} mask ${ours.mask}) matches the reference writer`, () => {
    const theirs = reference.create(text, { errorCorrectionLevel: 'L', maskPattern: ours.mask })
    if (theirs.modules.size !== size) {
      throw new Error(`the reference chose ${theirs.modules.size} modules, we chose ${size}`)
    }
    const differing = []
    for (let row = 0; row < size; row += 1) {
      for (let column = 0; column < size; column += 1) {
        const mine = ours.cells[row][column] ? 1 : 0
        // modules.get(row, column): the first argument is the row.
        const theirsBit = theirs.modules.get(row, column) ? 1 : 0
        if (mine !== theirsBit) differing.push([row, column])
      }
    }
    if (differing.length > 0) {
      const few = differing.slice(0, 8).map(([row, column]) => `r${row}c${column}`).join(' ')
      throw new Error(`${differing.length} modules differ (${few}${differing.length > 8 ? ' …' : ''})`)
    }
    return 'identical to the module'
  })

  if (jsQR === null) continue
  check(`${name} renders to something jsQR can read`, () => {
    const decoded = decodesWithJsQR(ours.cells)
    if (decoded === null) throw new Error('jsQR found no code in the render')
    if (decoded !== text) throw new Error(`jsQR read ${decoded.length} characters, expected ${text.length}`)
    return `${text.length} characters back`
  })
}

// The version block is eighteen modules and the old bug flipped all of them, so
// assert on it directly rather than trusting the whole-matrix comparison to
// happen to catch it.
check('the version block of v7 and up agrees with the reference, bit for bit', () => {
  /** Grows a payload until our writer lands on the version we want to check. */
  const textAtVersion = (version) => {
    for (let bytes = 40; bytes < 3000; bytes += 1) {
      const text = payload(bytes, 'version')
      if ((encodeMatrix(text, { level: 'L' }).cells.length - 17) / 4 === version) return text
    }
    throw new Error(`no payload length between 40 and 3000 bytes lands on version ${version}`)
  }
  const seen = []
  for (const version of [7, 9, 12, 16, 20, 26]) {
    const text = textAtVersion(version)
    const ours = encodeMatrix(text, { level: 'L' })
    const size = ours.cells.length
    if ((size - 17) / 4 !== version) throw new Error(`wanted v${version}, the writer chose v${(size - 17) / 4}`)
    const theirs = reference.create(text, { errorCorrectionLevel: 'L', maskPattern: ours.mask })
    const base = size - 11
    for (let row = 0; row < 6; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        const index = row * 3 + column
        const mine = ours.cells[row][base + column] ? 1 : 0
        const theirsBit = theirs.modules.get(row, base + column) ? 1 : 0
        if (mine !== theirsBit) {
          throw new Error(`v${version} module ${index} of the top-right block says ${mine}, the reference says ${theirsBit}`)
        }
        const mineBelow = ours.cells[base + column][row] ? 1 : 0
        const theirsBelow = theirs.modules.get(base + column, row) ? 1 : 0
        if (mineBelow !== theirsBelow) {
          throw new Error(`v${version} module ${index} of the bottom-left block says ${mineBelow}, the reference says ${theirsBelow}`)
        }
      }
    }
    seen.push(`v${version}`)
  }
  return seen.join(' ')
})

// Every mask has to survive too: a mask that is only right for the mask the
// writer happens to pick would fail on another payload.
check('all eight masks match the reference at version ten', () => {
  const text = payload(240, 'mask-check-')
  for (let mask = 0; mask < 8; mask += 1) {
    const ours = encodeMatrix(text, { level: 'L', mask })
    if (ours.mask !== mask) throw new Error(`asked for mask ${mask}, got ${ours.mask}`)
    const size = ours.cells.length
    const theirs = reference.create(text, { errorCorrectionLevel: 'L', maskPattern: mask })
    for (let row = 0; row < size; row += 1) {
      for (let column = 0; column < size; column += 1) {
        const mine = ours.cells[row][column] ? 1 : 0
        const theirsBit = theirs.modules.get(row, column) ? 1 : 0
        if (mine !== theirsBit) throw new Error(`mask ${mask} differs at r${row}c${column}`)
      }
    }
  }
  return '8 masks'
})

// Reading the same file the Host writes keeps this honest about the real path.
check('the ticket the live page is serving encodes to a readable code', () => {
  const path = join(root, 'probe', '_live-ticket.txt')
  let text = null
  try {
    text = readFileSync(path, 'utf8').trim()
  } catch {
    return 'skipped, no probe/_live-ticket.txt'
  }
  if (text.length === 0) return 'skipped, the ticket file is empty'
  const ours = encodeMatrix(text, { level: 'L' })
  const theirs = reference.create(text, { errorCorrectionLevel: 'L', maskPattern: ours.mask })
  const size = ours.cells.length
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const mine = ours.cells[row][column] ? 1 : 0
      const theirsBit = theirs.modules.get(row, column) ? 1 : 0
      if (mine !== theirsBit) throw new Error(`differs at r${row}c${column}`)
    }
  }
  return `${text.length} characters, v${(size - 17) / 4}`
})

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nQR EXTERNAL CHECKS PASS')
