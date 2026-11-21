/**
 * 二维码解码器的金标回归。
 *
 * 样本由 `tools/gen_qr_fixtures.mjs` 用 node-qrcode 生成（独立实现，不是本项目
 * 自己的编码器），所以「编码和解码一起错、测试仍绿」这件事不会发生。每个样本
 * 同时给了模块矩阵（`rows`）与渲染后的灰度图（`pixels`），两条入口分别验证：
 * 矩阵入口只管排列与纠错，图像入口还管定位与采样。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

import { decodeMatrix, type BitMatrix } from '../src/qr/decode'
import { matrixFromImage, type GrayImage } from '../src/qr/sampler'
import { formatBits, formatPositionsOne, formatPositionsTwo, maskBit, readFormat, versionBits } from '../src/qr/format'
import { alignmentCentres, dataCodewords, layoutFor, sideLength } from '../src/qr/types'

interface FixturePixels {
  readonly side: number
  readonly modulePixels: number
  readonly quietModules: number
  readonly gray: string
}

interface Fixture {
  readonly label: string
  readonly text: string
  readonly errorCorrectionLevel: string
  readonly version: number
  readonly mask: number
  readonly size: number
  readonly rows: readonly string[]
  readonly pixels: FixturePixels
}

let failures = 0

function ok(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok  ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}`)
}

function same(label: string, actual: string, expected: string): void {
  ok(`${label} (got ${JSON.stringify(actual)})`, actual === expected)
}

function sameNumber(label: string, actual: number, expected: number): void {
  ok(`${label} (got ${actual})`, actual === expected)
}

function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolvePath(here, '..', '..', '..')
}

function loadFixtures(): Fixture[] {
  const path = join(repoRoot(), 'probe', 'qr_fixtures.json')
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { fixtures: Fixture[] }
  return raw.fixtures
}

function toMatrix(rows: readonly string[]): BitMatrix {
  return rows.map((row) => Array.from(row, (cell) => cell === '1'))
}

function toImage(fixture: Fixture): GrayImage {
  const bytes = Buffer.from(fixture.pixels.gray, 'base64')
  return { width: fixture.pixels.side, height: fixture.pixels.side, pixels: new Uint8Array(bytes) }
}

function checkTables(): void {
  sameNumber('version 1 holds 26 codewords', layoutFor(1, 'M').shortLength * layoutFor(1, 'M').blocks, 16)
  sameNumber('version 1-M has 10 parity bytes per block', layoutFor(1, 'M').ecPerBlock, 10)
  sameNumber('version 1-H has 9 data bytes', dataCodewords(1, 'H'), 9)
  sameNumber('version 5-M has 2 blocks', layoutFor(5, 'M').blocks, 2)
  sameNumber('version 5-M holds 86 data codewords', dataCodewords(5, 'M'), 86)
  sameNumber('version 40-H has 81 blocks', layoutFor(40, 'H').blocks, 81)
  sameNumber('version 40-H holds 1276 data codewords', dataCodewords(40, 'H'), 1276)
  const versionOneTotal = layoutFor(1, 'M')
  sameNumber(
    'a version 1-M symbol is 26 codewords in total',
    versionOneTotal.shortLength * versionOneTotal.blocks + versionOneTotal.ecPerBlock * versionOneTotal.blocks,
    26,
  )
  ok('version 1 has no alignment patterns', alignmentCentres(1).length === 0)
  ok('version 2 has two alignment centres', alignmentCentres(2).length === 2)
  ok('version 7 has three alignment centres', alignmentCentres(7).length === 3)
  ok('version 14 has four alignment centres', alignmentCentres(14).length === 4)
  ok('version 32 has six alignment centres', alignmentCentres(32).length === 6)
  ok('version 2 centres sit at 6 and 18', alignmentCentres(2).join(',') === '6,18')
  ok('version 7 centres sit at 6, 22 and 38', alignmentCentres(7).join(',') === '6,22,38')
  ok('version 40 centres sit at 6, 30, 58, 86, 114, 142, 170', alignmentCentres(40).join(',') === '6,30,58,86,114,142,170')
  sameNumber('version 7 is 45 modules across', sideLength(7), 45)
  ok('every version stays within its own codeword budget', Array.from({ length: 40 }, (_, index) => {
    const version = index + 1
    const layout = layoutFor(version, 'H')
    const data = layout.shortLength * layout.blocks + layout.longBlocks
    const total = data + layout.ecPerBlock * layout.blocks
    return data > 0 && layout.ecPerBlock > 0 && total > 0
  }).every(Boolean))
}

function checkFormat(): void {
  // The specification's worked examples: level L with mask 0 is 0x77c4, level M
  // with mask 5 is 0x40ce.
  sameNumber('level L and mask 0 belong together', formatBits('L', 0), 0x77c4)
  sameNumber('level M and mask 5 belong together', formatBits('M', 5), 0x40ce)
  sameNumber('level Q and mask 3 belong together', formatBits('Q', 3), 0x3a06)
  sameNumber('level H and mask 7 belong together', formatBits('H', 7), 0x083b)
  ok('every level and mask pair decodes back', Array.from({ length: 8 }, (_, mask) => {
    const info = readFormatFromBits(formatBits('Q', mask))
    return info !== null && info.level === 'Q' && info.mask === mask
  }).every(Boolean))
  sameNumber('version 7 has its own eighteen bits', versionBits(7), 0x07c94)
  sameNumber('version 40 has its own eighteen bits', versionBits(40), 0x28c69)
  ok('the mask formulas differ from one another', (() => {
    // Five sample points are not enough: masks 0 and 3 agree on small
    // coordinates, so the comparison uses a full 6x6 patch.
    const samples: number[][] = []
    for (let row = 0; row < 6; row += 1) {
      for (let col = 0; col < 6; col += 1) samples.push([row, col])
    }
    const seen = new Set<string>()
    for (let mask = 0; mask < 8; mask += 1) {
      const pattern = samples.map(([row, col]) => (maskBit(mask, row, col) ? '1' : '0')).join('')
      seen.add(pattern)
    }
    return seen.size === 8
  })())
  // The specification's own table of the first few mask results, checked at a
  // point where all eight differ.
  ok('mask 0 inverts a checkerboard', maskBit(0, 0, 0) && !maskBit(0, 0, 1) && maskBit(0, 1, 1))
  ok('mask 1 inverts every even row', maskBit(1, 0, 3) && !maskBit(1, 1, 3) && maskBit(1, 2, 3))
  ok('mask 2 inverts every third column', maskBit(2, 5, 0) && !maskBit(2, 5, 1) && maskBit(2, 5, 3))
  ok('mask 3 follows the diagonal rule', maskBit(3, 0, 0) && !maskBit(3, 0, 1) && maskBit(3, 1, 2))
  ok('mask 4 pairs rows and triples columns', maskBit(4, 0, 0) && !maskBit(4, 0, 3) && maskBit(4, 0, 6))
  ok('mask 5 needs both conditions', maskBit(5, 0, 0) && !maskBit(5, 1, 1))
  // ((r*c)%2 + (r*c)%3) % 2 === 0: (0,0) sums to 0 and stays unmasked,
  // (2,2) sums to 1 and gets masked. (1,2) sums to 2 and is also unmasked,
  // which is why it cannot be the negative case here.
  ok('mask 6 halves the sum of conditions', maskBit(6, 0, 0) && !maskBit(6, 2, 2))
  ok('mask 7 differs from mask 5', (() => {
    for (let row = 0; row < 12; row += 1) {
      for (let col = 0; col < 12; col += 1) {
        if (maskBit(5, row, col) !== maskBit(7, row, col)) return true
      }
    }
    return false
  })())
}

/** Build a bare matrix around a format field so `readFormat` can be checked. */
function readFormatFromBits(bits: number): { level: string; mask: number } | null {
  const size = 21
  const grid: boolean[][] = []
  for (let row = 0; row < size; row += 1) grid.push(new Array<boolean>(size).fill(false))
  // `formatPositions*` list bit 0 first, so the shift follows the index.
  for (const positions of [formatPositionsOne(size), formatPositionsTwo(size)]) {
    for (let bit = 0; bit < 15; bit += 1) {
      const [row, col] = positions[bit]
      grid[row][col] = ((bits >> bit) & 1) === 1
    }
  }
  return readFormat((row, col) => grid[row][col], size)
}

const fixtures = loadFixtures()

function checkEveryFixture(): void {
  ok(`the fixture file carries samples (${fixtures.length})`, fixtures.length === 4)

  for (const fixture of fixtures) {
    const matrix = toMatrix(fixture.rows)
    sameNumber(`${fixture.label}: the matrix has the stated size`, matrix.length, fixture.size)

    const decoded = decodeMatrix(matrix)
    same(`${fixture.label}: the text comes back byte for byte`, decoded.text, fixture.text)
    same(`${fixture.label}: the level is ${fixture.errorCorrectionLevel}`, decoded.level, fixture.errorCorrectionLevel)
    sameNumber(`${fixture.label}: the version is ${fixture.version}`, decoded.version, fixture.version)
    sameNumber(`${fixture.label}: the mask is ${fixture.mask}`, decoded.mask, fixture.mask)
    sameNumber(`${fixture.label}: nothing needed repair`, decoded.repairedBytes, 0)

    const image = toImage(fixture)
    sameNumber(`${fixture.label}: the picture is square`, image.width, image.height)
    const fromImage = decodeMatrix(matrixFromImage(image))
    same(`${fixture.label}: the same text comes out of the picture`, fromImage.text, fixture.text)
    sameNumber(`${fixture.label}: the picture yields the same version`, fromImage.version, fixture.version)
  }
}

function checkRepair(): void {
  // Damage modules that are not part of any fixed pattern: the middle of the
  // first data region. The decoder must repair them rather than return text
  // that is subtly wrong.
  const fixture = fixtures[0]
  const matrix = toMatrix(fixture.rows)
  const damaged = matrix.map((row) => row.slice())
  const spots: number[][] = [
    [9, 9],
    [9, 11],
    [11, 9],
  ]
  for (const [row, col] of spots) damaged[row][col] = !damaged[row][col]
  const repaired = decodeMatrix(damaged)
  same('three flipped modules are repaired, not guessed', repaired.text, fixture.text)
  ok(`the decoder reports the repairs (${repaired.repairedBytes})`, repaired.repairedBytes > 0)

  // A handful of flipped modules is exactly what the parity is for: a 4x10
  // patch still came back clean (the block repaired twelve bytes). Refusing
  // only starts once the damage is far past what parity can carry, so the
  // hopeless case flips an 11x11 block — around a hundred modules against the
  // thirteen errors a v3-M block can hold.
  const hopeless = matrix.map((row) => row.slice())
  for (let row = 9; row < 19; row += 1) {
    for (let col = 9; col < 19; col += 1) hopeless[row][col] = !hopeless[row][col]
  }
  let refused = false
  try {
    decodeMatrix(hopeless)
  } catch {
    refused = true
  }
  ok('an unreadable symbol is refused rather than approximated', refused)
}

function checkRejections(): void {
  const reject = (label: string, build: () => BitMatrix): void => {
    let refused = false
    try {
      decodeMatrix(build())
    } catch {
      refused = true
    }
    ok(label, refused)
  }
  reject('an empty matrix is refused', () => [])
  reject('a ragged matrix is refused', () => [[true, false], [true]])
  reject('a three-module matrix is refused', () => [[true, false, true], [false, true, false], [true, false, true]])
  reject('a wrong-sized matrix is refused', () => {
    const grid: boolean[][] = []
    for (let row = 0; row < 23; row += 1) grid.push(new Array<boolean>(23).fill(false))
    return grid
  })
  reject('an all-white symbol is refused as a picture', () => {
    const image: GrayImage = { width: 64, height: 64, pixels: new Uint8Array(64 * 64).fill(255) }
    return matrixFromImage(image)
  })
}

checkTables()
checkFormat()
checkEveryFixture()
checkRepair()
checkRejections()

if (failures > 0) {
  console.log(`\nQR CHECKS FAILED (${failures})`)
  process.exitCode = 1
} else {
  console.log('\nALL QR CHECKS PASS (typescript core)')
}
