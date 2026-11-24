// Turning text into a QR matrix, so the plugin can draw a pairing code instead
// of asking anyone to go and read a log file.
//
// Only the byte mode is implemented, and only with error correction level M.
// A pairing code is ASCII/JSON about 300 bytes long; of the forty versions,
// eight of them at level M hold that much, and the mirror in
// packages/dsh_arkts can decode all of them, so the missing modes cost nothing
// here while the missing versions would.
//
// This file is deliberately self-contained: no `@deepseek-ai/*` imports, no
// third-party ones. The Host plugin is loaded from a directory junction into
// the DSH profile, where nothing else is on the module path.

const EC_LEVEL = 'M'

/** Total codewords (data + error correction) for a version. */
const TOTAL_CODEWORDS = [
  26, 44, 70, 100,
  134, 172, 196, 242,
  292, 346, 404, 466,
  532, 581, 655, 733,
  815, 901, 991, 1085,
  1156, 1258, 1364, 1474,
  1588, 1706, 1828, 1921,
  2051, 2185, 2323, 2465,
  2611, 2761, 2876, 3034,
  3196, 3362, 3532, 3706,
]

/**
 * Error correction codewords *per block*, indexed by version.
 *
 * Copied mechanically from packages/dsh_arkts/src/qr/tables.ts (see
 * probe/gen_qr_tables.mjs) so the encoder and the decoder cannot disagree
 * about how a symbol is split.
 */
const EC_PER_BLOCK = {
  L: [
  7, 10, 15, 20,
  26, 18, 20, 24,
  30, 18, 20, 24,
  26, 30, 22, 24,
  28, 30, 28, 28,
  28, 28, 30, 30,
  26, 28, 30, 30,
  30, 30, 30, 30,
  30, 30, 30, 30,
  30, 30, 30, 30,
  ],
  M: [
  10, 16, 26, 18,
  24, 16, 18, 22,
  22, 26, 30, 22,
  22, 24, 24, 28,
  28, 26, 26, 26,
  26, 28, 28, 28,
  28, 28, 28, 28,
  28, 28, 28, 28,
  28, 28, 28, 28,
  28, 28, 28, 28,
  ],
  Q: [
  13, 22, 18, 26,
  18, 24, 18, 22,
  20, 24, 28, 26,
  24, 20, 30, 24,
  28, 28, 26, 30,
  28, 30, 30, 30,
  30, 28, 30, 30,
  30, 30, 30, 30,
  30, 30, 30, 30,
  30, 30, 30, 30,
  ],
  H: [
  17, 28, 22, 16,
  22, 28, 26, 26,
  24, 28, 24, 28,
  22, 24, 24, 30,
  28, 28, 26, 28,
  30, 24, 30, 30,
  30, 30, 30, 30,
  30, 30, 30, 30,
  30, 30, 30, 30,
  30, 30, 30, 30,
  ],
}

/** Number of Reed-Solomon blocks, indexed by version. */
const EC_BLOCKS = {
  L: [
  1, 1, 1, 1,
  1, 2, 2, 2,
  2, 4, 4, 4,
  4, 4, 6, 6,
  6, 6, 7, 8,
  8, 9, 9, 10,
  12, 12, 12, 13,
  14, 15, 16, 17,
  18, 19, 19, 20,
  21, 22, 24, 25,
  ],
  M: [
  1, 1, 1, 2,
  2, 4, 4, 4,
  5, 5, 5, 8,
  9, 9, 10, 10,
  11, 13, 14, 16,
  17, 17, 18, 20,
  21, 23, 25, 26,
  28, 29, 31, 33,
  35, 37, 38, 40,
  43, 45, 47, 49,
  ],
  Q: [
  1, 1, 2, 2,
  4, 4, 6, 6,
  8, 8, 8, 10,
  12, 16, 12, 17,
  16, 18, 21, 20,
  23, 23, 25, 27,
  29, 34, 34, 35,
  38, 40, 43, 45,
  48, 51, 53, 56,
  59, 62, 65, 68,
  ],
  H: [
  1, 1, 2, 4,
  4, 4, 5, 6,
  8, 8, 11, 11,
  16, 16, 18, 16,
  19, 21, 25, 25,
  25, 34, 30, 32,
  35, 37, 40, 42,
  45, 48, 51, 54,
  57, 60, 63, 66,
  70, 74, 77, 81,
  ],
}

/** How the format field spells the level: two bits, and *not* the table order. */
const EC_LEVEL_BITS = { L: 1, M: 0, Q: 3, H: 2 }

const PAD_BYTE_ONE = 0xec
const PAD_BYTE_TWO = 0x11

// ---------------------------------------------------------------------------
// The field, and Reed-Solomon over it.

const FIELD_EXP = new Uint8Array(512)
const FIELD_LOG = new Uint8Array(256)
{
  let value = 1
  for (let index = 0; index < 255; index += 1) {
    FIELD_EXP[index] = value
    FIELD_LOG[value] = index
    value <<= 1
    if ((value & 0x100) !== 0) value ^= 0x11d
  }
  for (let index = 255; index < 512; index += 1) FIELD_EXP[index] = FIELD_EXP[index - 255]
}

function fieldMultiply(left, right) {
  if (left === 0 || right === 0) return 0
  return FIELD_EXP[FIELD_LOG[left] + FIELD_LOG[right]]
}

/** The generator polynomial for `ecCount` parity bytes, leading term last. */
function generatorPolynomial(ecCount) {
  let poly = [1]
  for (let index = 0; index < ecCount; index += 1) {
    const next = new Array(poly.length + 1).fill(0)
    const root = FIELD_EXP[index]
    for (let term = 0; term < poly.length; term += 1) {
      next[term] ^= fieldMultiply(poly[term], root)
      next[term + 1] ^= poly[term]
    }
    poly = next
  }
  return poly
}

/** The `ecCount` parity bytes for one block. */
function reedSolomonParity(data, ecCount) {
  const generator = generatorPolynomial(ecCount)
  const remainder = new Array(ecCount).fill(0)
  for (const byte of data) {
    const factor = byte ^ remainder[0]
    for (let index = 0; index < ecCount - 1; index += 1) {
      remainder[index] = remainder[index + 1] ^ fieldMultiply(generator[ecCount - 1 - index], factor)
    }
    remainder[ecCount - 1] = fieldMultiply(generator[0], factor)
  }
  return remainder
}

// ---------------------------------------------------------------------------
// The tables a version needs.

function sideLength(version) {
  return 17 + version * 4
}

/** This file only ever encodes level M, so the slot is a plain lookup. */
function slotFor(version) {
  return version - 1
}

function dataCodewords(version) {
  const slot = slotFor(version)
  const blocks = EC_BLOCKS[EC_LEVEL][slot]
  return TOTAL_CODEWORDS[slot] - EC_PER_BLOCK[EC_LEVEL][slot] * blocks
}

/** The block split for a version: short data length, long blocks, ec per block. */
function blockLayout(version) {
  const slot = slotFor(version)
  const blocks = EC_BLOCKS[EC_LEVEL][slot]
  const ecPerBlock = EC_PER_BLOCK[EC_LEVEL][slot]
  const dataBytes = TOTAL_CODEWORDS[slot] - ecPerBlock * blocks
  const shortLength = Math.floor(dataBytes / blocks)
  return {
    blocks,
    ecPerBlock,
    shortLength,
    longBlocks: dataBytes - shortLength * blocks,
  }
}

/** Character-count field width for byte mode, which grows at version ten. */
function lengthBits(version) {
  if (version <= 9) return 8
  if (version <= 26) return 16
  return 16
}

/** The smallest version at level M that holds `byteLength` bytes. */
function versionFor(byteLength) {
  for (let version = 1; version <= 40; version += 1) {
    // 4 bits of mode, then the length field, then the bytes themselves.
    const needed = 4 + lengthBits(version) + byteLength * 8
    if (needed <= dataCodewords(version) * 8) return version
  }
  throw new Error(`a ${byteLength}-byte payload does not fit in any QR version at level M`)
}

/** Centre coordinates of the alignment patterns for a version, ascending. */
function alignmentCentres(version) {
  if (version < 2) return []
  const size = sideLength(version)
  const count = Math.floor(version / 7) + 2
  // Version 32 is the one case where the even-spacing rule does not fit.
  const step = version === 32 ? 26 : Math.ceil((size - 13) / (count * 2 - 2)) * 2
  const out = [6]
  for (let position = size - 7; out.length < count; position -= step) out.splice(1, 0, position)
  return out
}

const FORMAT_MASK = 0x5412

/** The fifteen stored format bits for level M and a mask, already XORed. */
function formatBits(mask) {
  const data = (EC_LEVEL_BITS[EC_LEVEL] << 3) | mask
  let remainder = data << 10
  for (let bit = 14; bit >= 10; bit -= 1) {
    if ((remainder & (1 << bit)) !== 0) remainder ^= 0x537 << (bit - 10)
  }
  return ((data << 10) | (remainder & 0x3ff)) ^ FORMAT_MASK
}

/** The eighteen version bits for versions seven and up. */
function versionBits(version) {
  let remainder = version << 12
  for (let bit = 17; bit >= 12; bit -= 1) {
    if ((remainder & (1 << bit)) !== 0) remainder ^= 0x1f25 << (bit - 12)
  }
  return ((version << 12) | (remainder & 0xfff)) >>> 0
}

/** True where a mask inverts a module. */
function maskBit(mask, row, col) {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0
    case 1:
      return row % 2 === 0
    case 2:
      return col % 3 === 0
    case 3:
      return (row + col) % 3 === 0
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0
    case 7:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0
    default:
      throw new Error(`mask ${mask} is outside 0..7`)
  }
}

// ---------------------------------------------------------------------------
// Codewords.

/** The 4-bit mode indicator, the length, the bytes, then the padding. */
function dataCodewordBytes(bytes, version) {
  const capacity = dataCodewords(version)
  const bits = []
  const push = (value, width) => {
    for (let bit = width - 1; bit >= 0; bit -= 1) bits.push((value >> bit) & 1)
  }
  push(0b0100, 4)
  push(bytes.length, lengthBits(version))
  for (const byte of bytes) push(byte, 8)

  // Terminator: up to four zero bits, then pad to a whole codeword.
  const capacityBits = capacity * 8
  const terminator = Math.min(4, capacityBits - bits.length)
  for (let index = 0; index < terminator; index += 1) bits.push(0)
  while (bits.length % 8 !== 0) bits.push(0)

  const out = []
  for (let index = 0; index < bits.length; index += 8) {
    let byte = 0
    for (let bit = 0; bit < 8; bit += 1) byte = (byte << 1) | bits[index + bit]
    out.push(byte)
  }
  // The two padding bytes alternate; the order is part of the specification and
  // phones notice when it is reversed.
  let next = 0
  while (out.length < capacity) {
    out.push(next === 0 ? PAD_BYTE_ONE : PAD_BYTE_TWO)
    next = 1 - next
  }
  return out
}

/** Split the data into blocks, add parity to each, then interleave. */
function interleave(dataBytes, version) {
  const layout = blockLayout(version)
  const shortCount = layout.blocks - layout.longBlocks
  const blocks = []
  let cursor = 0
  for (let index = 0; index < layout.blocks; index += 1) {
    const length = layout.shortLength + (index >= shortCount ? 1 : 0)
    const body = dataBytes.slice(cursor, cursor + length)
    cursor += length
    blocks.push({ data: body, parity: reedSolomonParity(body, layout.ecPerBlock) })
  }

  const out = []
  const longestData = layout.shortLength + (layout.longBlocks > 0 ? 1 : 0)
  for (let position = 0; position < longestData; position += 1) {
    for (const block of blocks) {
      if (position < block.data.length) out.push(block.data[position])
    }
  }
  for (let position = 0; position < layout.ecPerBlock; position += 1) {
    for (const block of blocks) out.push(block.parity[position])
  }
  return out
}

// ---------------------------------------------------------------------------
// The matrix.

/** A square of modules: `true` is dark, `null` is not yet decided. */
function blankMatrix(version) {
  const size = sideLength(version)
  const cells = []
  for (let row = 0; row < size; row += 1) cells.push(new Array(size).fill(null))
  return cells
}

/** Which modules belong to the fixed patterns, so data can step around them. */
function reservedMap(version) {
  const size = sideLength(version)
  const map = []
  for (let row = 0; row < size; row += 1) map.push(new Array(size).fill(false))
  const mark = (row, col) => {
    if (row >= 0 && col >= 0 && row < size && col < size) map[row][col] = true
  }
  const markSquare = (top, left, extent) => {
    for (let row = 0; row < extent; row += 1) {
      for (let col = 0; col < extent; col += 1) mark(top + row, left + col)
    }
  }
  // An eight-by-eight corner: the seven-module finder plus its separator.
  markSquare(0, 0, 8)
  markSquare(0, size - 8, 8)
  markSquare(size - 8, 0, 8)
  for (let index = 8; index < size - 8; index += 1) {
    mark(6, index)
    mark(index, 6)
  }
  for (let index = 0; index <= 8; index += 1) {
    mark(8, index)
    mark(index, 8)
  }
  for (let index = 0; index < 8; index += 1) {
    mark(8, size - 1 - index)
    mark(size - 1 - index, 8)
  }
  for (const row of alignmentCentres(version)) {
    for (const col of alignmentCentres(version)) {
      const nearFinder =
        (row === 6 && col === 6) || (row === 6 && col === size - 7) || (row === size - 7 && col === 6)
      if (nearFinder) continue
      for (let deltaRow = -2; deltaRow <= 2; deltaRow += 1) {
        for (let deltaCol = -2; deltaCol <= 2; deltaCol += 1) mark(row + deltaRow, col + deltaCol)
      }
    }
  }
  mark(size - 8, 8)
  if (version >= 7) {
    for (let index = 0; index < 18; index += 1) {
      const row = Math.floor(index / 3)
      const col = size - 11 + (index % 3)
      mark(row, col)
      mark(col, row)
    }
  }
  return map
}

function drawFinder(cells, top, left) {
  // The separator is written too: a dark module leaning on the finder shifts
  // the sampler's estimate of where the symbol starts.
  for (let row = -1; row <= 7; row += 1) {
    for (let col = -1; col <= 7; col += 1) {
      const atRow = top + row
      const atCol = left + col
      if (atRow < 0 || atCol < 0 || atRow >= cells.length || atCol >= cells.length) continue
      const onEdge = row === 0 || row === 6 || col === 0 || col === 6
      const inCore = row >= 2 && row <= 4 && col >= 2 && col <= 4
      const inside = row >= 0 && row <= 6 && col >= 0 && col <= 6
      cells[atRow][atCol] = inside && (onEdge || inCore)
    }
  }
}

function drawTiming(cells) {
  const size = cells.length
  for (let index = 8; index < size - 8; index += 1) {
    const dark = index % 2 === 0
    cells[6][index] = dark
    cells[index][6] = dark
  }
}

function drawAlignment(cells, version) {
  const size = cells.length
  const centres = alignmentCentres(version)
  for (const row of centres) {
    for (const col of centres) {
      const nearFinder =
        (row === 6 && col === 6) || (row === 6 && col === size - 7) || (row === size - 7 && col === 6)
      if (nearFinder) continue
      for (let deltaRow = -2; deltaRow <= 2; deltaRow += 1) {
        for (let deltaCol = -2; deltaCol <= 2; deltaCol += 1) {
          const onEdge = Math.abs(deltaRow) === 2 || Math.abs(deltaCol) === 2
          const isCentre = deltaRow === 0 && deltaCol === 0
          cells[row + deltaRow][col + deltaCol] = onEdge || isCentre
        }
      }
    }
  }
}

function drawFormat(cells, mask) {
  const size = cells.length
  const bits = formatBits(mask)
  const bit = index => ((bits >> index) & 1) === 1

  // First copy: down column eight beside the top-left finder, then the seven
  // modules above the bottom-left one.
  for (let row = 0; row <= 5; row += 1) cells[row][8] = bit(row)
  cells[7][8] = bit(6)
  cells[8][8] = bit(7)
  for (let row = size - 7; row <= size - 1; row += 1) cells[row][8] = bit(14 - (size - 1 - row))

  // Second copy: along row eight under the top-right finder, then the corner.
  for (let col = size - 1; col >= size - 8; col -= 1) cells[8][col] = bit(size - 1 - col)
  cells[8][7] = bit(8)
  cells[8][6] = bit(9)
  for (let col = 5; col >= 0; col -= 1) cells[8][col] = bit(14 - col)
  // The dark module is always set, whatever the format says.
  cells[size - 8][8] = true
}

function drawVersion(cells, version) {
  if (version < 7) return
  const size = cells.length
  const bits = versionBits(version)
  for (let index = 0; index < 18; index += 1) {
    // The field is read most-significant bit first, so the highest bit goes in
    // the first module. Writing it the other way round produces a symbol whose
    // size looks right and whose version block disagrees with it.
    const dark = ((bits >> (17 - index)) & 1) === 1
    const row = Math.floor(index / 3)
    const col = size - 11 + (index % 3)
    cells[row][col] = dark
    cells[col][row] = dark
  }
}

/**
 * Write the codewords into the free modules, zig-zagging up and down the symbol
 * in two-module-wide columns from the bottom-right corner.
 */
function placeData(cells, codewords, reserved, version, mask) {
  const size = sideLength(version)
  const bits = []
  for (const byte of codewords) {
    for (let bit = 7; bit >= 0; bit -= 1) bits.push((byte >> bit) & 1)
  }
  let cursor = 0
  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    // Column six is the vertical timing pattern; the pairing jumps over it
    // rather than reading it.
    if (right === 6) right = 5
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step
      for (let pair = 0; pair < 2; pair += 1) {
        const col = right - pair
        if (reserved[row][col]) continue
        const raw = cursor < bits.length ? bits[cursor] === 1 : false
        cursor += 1
        // The remainder bits at the end of the symbol are zero, and they get
        // masked like everything else.
        cells[row][col] = raw !== maskBit(mask, row, col)
      }
    }
    upward = !upward
  }
}

/** The four penalty rules from the specification, used to pick a mask. */
function penaltyScore(cells) {
  const size = cells.length
  let score = 0

  const runPenalty = line => {
    let total = 0
    let run = 1
    for (let index = 1; index < line.length; index += 1) {
      if (line[index] === line[index - 1]) {
        run += 1
      } else {
        if (run >= 5) total += run - 2
        run = 1
      }
    }
    if (run >= 5) total += run - 2
    return total
  }

  for (let row = 0; row < size; row += 1) {
    score += runPenalty(cells[row])
    score += runPenalty(cells.map(line => line[row]))
  }

  for (let row = 0; row < size - 1; row += 1) {
    for (let col = 0; col < size - 1; col += 1) {
      const value = cells[row][col]
      if (value === cells[row][col + 1] && value === cells[row + 1][col] && value === cells[row + 1][col + 1]) {
        score += 3
      }
    }
  }

  // The finder-like pattern 1:1:3:1:1 with four light modules on either side.
  const first = [true, false, true, true, true, false, true, false, false, false, false]
  const second = [false, false, false, false, true, false, true, true, true, false, true]
  const matches = line => {
    let total = 0
    for (let index = 0; index + 11 <= line.length; index += 1) {
      let firstHit = true
      let secondHit = true
      for (let offset = 0; offset < 11; offset += 1) {
        if (line[index + offset] !== first[offset]) firstHit = false
        if (line[index + offset] !== second[offset]) secondHit = false
      }
      if (firstHit) total += 40
      if (secondHit) total += 40
    }
    return total
  }
  for (let row = 0; row < size; row += 1) {
    score += matches(cells[row])
    score += matches(cells.map(line => line[row]))
  }

  let dark = 0
  for (const line of cells) for (const value of line) if (value) dark += 1
  const percent = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(percent - 50) / 5) * 10
  return score
}

/**
 * Encode text as a QR matrix.
 *
 * Returns rows of booleans, dark = true — the same shape
 * `packages/dsh_arkts/src/qr/decode.ts` reads, so the two can be checked
 * against each other instead of each other's bugs.
 */
export function encodeMatrix(text, { mask: forcedMask } = {}) {
  const bytes = Buffer.from(String(text), 'utf8')
  const version = versionFor(bytes.length)
  const data = dataCodewordBytes([...bytes], version)
  const codewords = interleave(data, version)
  const reserved = reservedMap(version)

  const build = mask => {
    const size = sideLength(version)
    const cells = blankMatrix(version)
    drawFinder(cells, 0, 0)
    drawFinder(cells, 0, size - 7)
    drawFinder(cells, size - 7, 0)
    drawTiming(cells)
    drawAlignment(cells, version)
    drawVersion(cells, version)
    placeData(cells, codewords, reserved, version, mask)
    drawFormat(cells, mask)
    return cells
  }

  if (forcedMask !== undefined) {
    if (!Number.isInteger(forcedMask) || forcedMask < 0 || forcedMask > 7) {
      throw new Error(`mask ${forcedMask} is outside 0..7`)
    }
    return { version, mask: forcedMask, cells: build(forcedMask) }
  }

  let best = null
  for (let mask = 0; mask < 8; mask += 1) {
    const cells = build(mask)
    const score = penaltyScore(cells)
    if (best === null || score < best.score) best = { mask, cells, score }
  }
  return { version, mask: best.mask, cells: best.cells }
}
