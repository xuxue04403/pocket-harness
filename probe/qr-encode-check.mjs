// Round-trips the encoder through the decoder that already ships.
//
// An encoder is easy to write in a way that produces a pretty square no phone
// can read: a shifted format field, a mask applied to the wrong modules, or two
// padding bytes in the wrong order all look fine. The only credible check is to
// decode the result with an implementation that was written from the other end
// of the specification, which is what packages/dsh_arkts/src/qr/decode.ts is.
//
// Run with:
//   node --experimental-strip-types probe/qr-encode-check.mjs
// or, when the packaged build is present:
//   node probe/qr-encode-check.mjs

import { encodeMatrix } from '../host/qr_encode.js'

let decodeMatrix = null
let source = null
for (const candidate of [
  '../packages/dsh_arkts/build/index.mjs',
  '../packages/dsh_arkts/build/qr_decode.mjs',
]) {
  try {
    const module = await import(candidate)
    if (typeof module.decodeMatrix === 'function') {
      decodeMatrix = module.decodeMatrix
      source = candidate
      break
    }
  } catch {
    // Not built; try the next candidate.
  }
}

if (decodeMatrix === null) {
  console.error('no decoder available: build packages/dsh_arkts first (node build.mjs)')
  process.exit(2)
}
console.log(`decoder: ${source}`)

let failures = 0
function check(what, ok) {
  if (ok) {
    console.log(`  ok   ${what}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${what}`)
}

/** The matrix shape the decoder expects. */
function toBitMatrix(cells) {
  return cells.map(row => row.map(value => value === true))
}

const cases = [
  ['short ascii', 'HELLO'],
  ['digits', '0123456789'],
  ['a url', 'https://example.com/a/b?c=1'],
  ['mixed case', 'Pocket Harness v0.1.0-beta'],
  ['chinese', '用手机远程操控电脑上的 DeepSeek Harness'],
  // A pairing ticket is the real payload: ~330 characters of base64url.
  [
    'a pairing ticket',
    'pocketharness://pair?t=' +
      'eyJ2IjoxLCJpZCI6Img3ZjJxNXB4eG0iLCJrZXkiOiJqM3Q0bXZ4d2FiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6MDEyMzQ1Njc4OSIsIm5hbWUiOiJQb2NrZXQgSGFybmVzcyBIb3N0IiwibGFuIjpbIjEyNy4wLjAuMTo0ODEwMCIsIjE5Mi4xNjguNDMuNDg6NDgxMDAiXSwic2VjcmV0IjoiYTFiMmMzZDRlNWY2ZzdoOGk5ajBrbG0iLCJleHAiOiIyMDI2LTExLTIzVDE4OjA1OjA1LjM5NVoifQ',
  ],
  ['exactly 150 bytes', 'x'.repeat(150)],
  ['exactly 300 bytes', 'y'.repeat(300)],
  ['a long one', 'z'.repeat(900)],
]

for (const [name, text] of cases) {
  const { version, mask, cells } = encodeMatrix(text)
  let decoded = null
  let error = null
  try {
    decoded = decodeMatrix(toBitMatrix(cells))
  } catch (thrown) {
    error = thrown
  }
  check(`${name} (v${version} mask ${mask}, ${cells.length}x${cells.length})`, decoded !== null)
  if (decoded !== null) {
    check(`${name}: decoded text matches`, decoded.text === text)
  } else {
    console.log(`       ${error && error.message}`)
  }
}

// Every mask has to be readable, not just the one the penalty picks: the choice
// is a heuristic, and a mask that only works when the heuristic agrees with
// itself is not evidence.
console.log('all eight masks')
for (let mask = 0; mask < 8; mask += 1) {
  const text = 'mask sweep 0123456789'
  const { cells } = encodeMatrix(text, { mask })
  const decoded = decodeMatrix(toBitMatrix(cells))
  check(`mask ${mask} decodes`, decoded !== null && decoded.text === text)
}

console.log('')
if (failures === 0) {
  console.log('ALL QR ENCODE CHECKS PASS')
} else {
  console.log(`${failures} CHECK(S) FAILED`)
  process.exitCode = 1
}
