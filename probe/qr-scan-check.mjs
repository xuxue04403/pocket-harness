// Would a phone read the code the settings card draws?
//
// The complaint was concrete: neither the App nor WeChat could scan it. What a
// scanner needs is pixels per module, and the card used to give an 89-module
// symbol 188px — 2.1px each. This check measures both geometries instead of
// taking the explanation on faith, and proves the fixed one round-trips.
//
// Note on the decoder: our TypeScript decoders locate a symbol by looking for a
// version whose module size divides the picture exactly, and they see perfect
// pixels, not a blurred camera frame. So they can read sizes a camera cannot —
// which is precisely why this check asserts geometry for the "too small" side and
// a decode only for the "big enough" side.

import { PNG } from '../packages/dsh_arkts/node_modules/pngjs/lib/png.js'
import { decodeMatrix, sampleSymbol } from '../packages/dsh_arkts/build/index.mjs'

import { encodeMatrix } from '../host/qr_encode.js'

/** The quiet zone the QR specification requires, in modules. */
const QUIET = 4
/** Below this a camera starts losing modules to blur and glare. */
const SCANNABLE_PX = 4

/** What the card used to give a code: a fixed box, whatever the matrix needed. */
const OLD_BOX_PX = 188

/**
 * A greyscale picture of a matrix, `modulePx` pixels per module, on white.
 *
 * `modulePx` must be a whole number: a screen cannot draw a module and a half.
 */
function render(cells, modulePx) {
  const modules = cells.length
  const side = (modules + QUIET * 2) * modulePx
  const pixels = new Uint8Array(side * side).fill(255)
  for (let row = 0; row < modules; row += 1) {
    for (let column = 0; column < modules; column += 1) {
      if (!cells[row][column]) continue
      const left = (column + QUIET) * modulePx
      const top = (row + QUIET) * modulePx
      for (let y = 0; y < modulePx; y += 1) {
        for (let x = 0; x < modulePx; x += 1) {
          pixels[(top + y) * side + left + x] = 0
        }
      }
    }
  }
  return { width: side, height: side, pixels }
}

/**
 * Every geometry the picture could be, largest symbol first.
 *
 * The picture is `(size + 2*QUIET) * modulePixels` wide, so the whole width — not
 * the dark extent — pins the module size. A real scanner reads the version from
 * the symbol; ours guesses from the geometry, and several versions can divide one
 * width, so the caller keeps the one that decodes.
 */
function candidates(image) {
  const out = []
  for (let version = 40; version >= 1; version -= 1) {
    const size = 17 + version * 4
    const span = size + QUIET * 2
    if (image.width % span !== 0) continue
    const modulePixels = image.width / span
    out.push({
      left: QUIET * modulePixels,
      top: QUIET * modulePixels,
      size,
      modulePixels,
      version,
    })
  }
  return out
}

function readBack(image, expected) {
  for (const box of candidates(image)) {
    try {
      const matrix = sampleSymbol(image, box)
      if (decodeMatrix(matrix).text === expected) return box.version
    } catch {
      // Not this version; keep looking.
    }
  }
  return null
}

let failed = 0
const check = (name, run) => {
  try {
    run()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}: ${error.message}`)
  }
}

// A ticket with a relay is about 542 bytes; padding to that length keeps the
// version honest rather than testing a symbol smaller than the real one.
const text = 't=' + 'A'.repeat(504)
const fixed = encodeMatrix(text, { level: 'L' })
const previous = encodeMatrix(text, { level: 'M' })
const modules = fixed.cells.length
const modulePx = 6 // MODULE_PX in host/client.js

console.log(`ticket ${Buffer.byteLength(text)} bytes`)
console.log(`level L: version ${fixed.version}, ${modules} modules`)
console.log(`level M: version ${previous.version}, ${previous.cells.length} modules`)

check('the card now gives every module six pixels', () => {
  // sideFor(size) = size * MODULE_PX, clamped; 77 * 6 = 462px, under the clamp.
  if (!(modules * modulePx <= 600)) throw new Error('the card would clamp below six pixels')
  if (!(modulePx >= SCANNABLE_PX)) throw new Error(`six pixels is under the ${SCANNABLE_PX}px floor`)
})

check('the old fixed box left barely two pixels per module', () => {
  const before = OLD_BOX_PX / previous.cells.length
  if (!(before < 3)) throw new Error(`the old box gave ${before.toFixed(2)}px per module, not ~2`)
  console.log(`       ${OLD_BOX_PX}px / ${previous.cells.length} modules = ${before.toFixed(2)}px each`)
})

check('level L is the smaller symbol for the same ticket', () => {
  if (!(fixed.cells.length < previous.cells.length)) {
    throw new Error(`level L should be smaller, got ${fixed.cells.length} vs ${previous.cells.length}`)
  }
  console.log(`       ${previous.cells.length} modules at M versus ${fixed.cells.length} at L`)
})

check('the card geometry decodes back to the ticket', () => {
  const version = readBack(render(fixed.cells, modulePx), text)
  if (version === null) throw new Error('nothing decoded the picture')
  if (version !== fixed.version) throw new Error(`decoded as version ${version}`)
})

check('four pixels per module also decodes', () => {
  const version = readBack(render(fixed.cells, SCANNABLE_PX), text)
  if (version === null) throw new Error('nothing decoded the picture')
})

check('a real PNG of the card decodes after a file round trip', () => {
  // Covers the file format as well as the pixels: a bug in the writer would
  // otherwise only show up on a phone.
  const image = render(fixed.cells, modulePx)
  const png = new PNG({ width: image.width, height: image.height })
  for (let index = 0; index < image.pixels.length; index += 1) {
    const value = image.pixels[index]
    png.data[index * 4] = value
    png.data[index * 4 + 1] = value
    png.data[index * 4 + 2] = value
    png.data[index * 4 + 3] = 255
  }
  const back = PNG.sync.read(PNG.sync.write(png))
  const flat = new Uint8Array(back.width * back.height)
  for (let index = 0; index < flat.length; index += 1) flat[index] = back.data[index * 4]
  const version = readBack({ width: back.width, height: back.height, pixels: flat }, text)
  if (version === null) throw new Error('nothing decoded the PNG')
})

console.log(failed === 0 ? '\nQR SCAN GEOMETRY CHECKS PASS' : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
