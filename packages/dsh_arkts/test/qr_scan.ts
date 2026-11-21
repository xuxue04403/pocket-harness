/**
 * 从相机帧里找二维码：定位图案、仿射采样、灰度预处理。
 *
 * 这一套的输入不是「渲染好的干净图片」，而是模拟出来的照片：模块落在非整数
 * 像素上、整张图被旋转过、场景亮度不均匀、码只占画面的一部分。金标仍然来自
 * `probe/qr_fixtures.json`，所以「解出来的文本对不对」有一个外部参照。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

import { decodeMatrix } from '../src/qr/decode'
import { grayFromLuma, grayFromRgba, shrinkGray, type LumaFrame } from '../src/qr/frame'
import {
  affineFromSymbol,
  arrangeCorners,
  binarize,
  findFinderPatterns,
  locateFrame,
  matrixFromFrame,
  otsuThreshold,
  type FinderPattern,
  type FrameGray,
} from '../src/qr/scan'

interface Fixture {
  readonly label: string
  readonly text: string
  readonly version: number
  readonly errorCorrectionLevel: string
  readonly mask: number
  readonly rows: readonly string[]
}

let failures = 0

function ok(label: string, condition: boolean): void {
  if (condition) {
    console.log('  ok   ' + label)
    return
  }
  failures += 1
  console.log('  FAIL ' + label)
}

function same(label: string, actual: string, expected: string): void {
  ok(label, actual === expected)
  if (actual !== expected) console.log('        got "' + actual + '" want "' + expected + '"')
}

function sameNumber(label: string, actual: number, expected: number): void {
  ok(label, actual === expected)
  if (actual !== expected) console.log('        got ' + actual + ' want ' + expected)
}

const here = dirname(fileURLToPath(import.meta.url))
const fixturePath = resolvePath(join(here, '..', '..', '..', 'probe', 'qr_fixtures.json'))
const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8')).fixtures as Fixture[]

/**
 * Render a fixture into a scene.
 *
 * `modulePixels` is deliberately allowed to be fractional and `angle` to be
 * non-zero, and the illumination ramps across the frame — the three things a
 * camera frame has that a rendered pairing code does not.
 */
function renderScene(fixture: Fixture, options: {
  side: number
  modulePixels: number
  angle: number
  offsetX: number
  offsetY: number
  gradient: number
}): FrameGray {
  const size = fixture.rows.length
  const side = options.side
  const pixels = new Uint8Array(side * side)
  const cos = Math.cos(options.angle)
  const sin = Math.sin(options.angle)
  const span = size * options.modulePixels
  const centreX = options.offsetX + span / 2
  const centreY = options.offsetY + span / 2

  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      // Inverse map: scene pixel → module coordinates.
      const dx = x - centreX
      const dy = y - centreY
      const rx = dx * cos + dy * sin
      const ry = -dx * sin + dy * cos
      const u = (rx + span / 2) / options.modulePixels
      const v = (ry + span / 2) / options.modulePixels
      let level = 255
      if (u >= 0 && v >= 0 && u < size && v < size) {
        const black = fixture.rows[Math.floor(v)].charAt(Math.floor(u)) === '1'
        level = black ? 24 : 231
      }
      // Uneven lighting: darker towards the bottom right.
      const shade = 1 - (options.gradient * (x + y)) / (2 * side)
      pixels[y * side + x] = Math.max(0, Math.min(255, Math.round(level * shade)))
    }
  }
  return { width: side, height: side, pixels: pixels }
}

function checkOtsu(): void {
  // A bimodal picture: Otsu must land between the two peaks.
  const pixels = new Uint8Array(1000)
  pixels.fill(30, 0, 500)
  pixels.fill(220, 500, 1000)
  const threshold = otsuThreshold(pixels)
  ok(`otsu lands between the two peaks (${threshold})`, threshold >= 30 && threshold < 220)

  // Shifting both peaks darker must shift the threshold with them.
  const dim = new Uint8Array(1000)
  dim.fill(5, 0, 500)
  dim.fill(90, 500, 1000)
  const dimThreshold = otsuThreshold(dim)
  ok(`otsu follows a darker scene (${dimThreshold})`, dimThreshold < threshold)

  ok('an empty picture still yields a threshold', otsuThreshold(new Uint8Array(0)) === 128)
}

function checkBinarize(): void {
  const image: FrameGray = {
    width: 4,
    height: 2,
    pixels: new Uint8Array([0, 10, 200, 250, 120, 121, 122, 123]),
  }
  const binary = binarize(image, 121)
  ok('dark pixels become true', binary[0][0] && binary[0][1])
  ok('bright pixels become false', !binary[0][2] && !binary[0][3])
  ok('the threshold itself is dark', binary[1][0] && binary[1][1])
  ok('just past the threshold is bright', !binary[1][2] && !binary[1][3])
}

function checkLuma(): void {
  // Tightly packed: the copy must be the pixels and nothing else.
  const packed = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
  const straight = grayFromLuma({
    luma: packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength),
    width: 4,
    height: 2,
    rowStride: 4,
    pixelStride: 1,
  } as LumaFrame)
  ok('a packed frame is copied byte for byte', straight.pixels.length === 8 && straight.pixels[5] === 6)

  // Strided: each row has padding, which must be dropped rather than read as
  // pixels — reading it as pixels shears the picture.
  const source = new Uint8Array([
    10, 11, 12, 0, 0, 0,
    20, 21, 22, 0, 0, 0,
  ])
  const strided = grayFromLuma({
    luma: source.buffer.slice(0),
    width: 3,
    height: 2,
    rowStride: 6,
    pixelStride: 1,
  } as LumaFrame)
  sameNumber('a strided frame drops the padding', strided.pixels.length, 6)
  ok('the second row starts at the stride', strided.pixels[3] === 20 && strided.pixels[5] === 22)

  // Pixel stride 2: only every other byte is luma.
  const interleaved = new Uint8Array([10, 99, 11, 99, 12, 99, 20, 99, 21, 99, 22, 99])
  const spread = grayFromLuma({
    luma: interleaved.buffer.slice(0),
    width: 3,
    height: 2,
    rowStride: 6,
    pixelStride: 2,
  } as LumaFrame)
  ok('pixel stride 2 reads every other byte', spread.pixels[0] === 10 && spread.pixels[1] === 11 && spread.pixels[3] === 20)

  // A short buffer must be refused, not read past the end.
  let refused = false
  try {
    grayFromLuma({ luma: new Uint8Array(8).buffer, width: 4, height: 4, rowStride: 4, pixelStride: 1 } as LumaFrame)
  } catch {
    refused = true
  }
  ok('a short luma plane is refused', refused)
}

function checkRgba(): void {
  // Pure white, pure black and a red patch: luma must follow the eye, not the
  // average of the channels.
  const pixels = new Uint8Array(3 * 4)
  pixels.set([255, 255, 255, 255], 0)
  pixels.set([0, 0, 0, 255], 4)
  pixels.set([255, 0, 0, 255], 8)
  const gray = grayFromRgba(pixels, 3, 1, 3)
  sameNumber('white stays white', gray.pixels[0], 255)
  sameNumber('black stays black', gray.pixels[1], 0)
  sameNumber('pure red is a dark grey (76)', gray.pixels[2], 76)

  // A stride wider than the picture: the padding between rows must be skipped.
  const wide = new Uint8Array(4 * 2 * 4)
  for (let index = 0; index < wide.length; index += 4) {
    wide.set([0, 0, 0, 255], index)
  }
  // Paint the padding column white; a strided read must never see it.
  wide.set([255, 255, 255, 255], 3 * 4)
  wide.set([255, 255, 255, 255], 7 * 4)
  const strided = grayFromRgba(wide, 3, 2, 4)
  sameNumber('a wide stride yields a 3x2 picture', strided.pixels.length, 6)
  ok('the row padding is skipped, so every pixel is still black', strided.pixels[2] === 0 && strided.pixels[5] === 0)

  // A short buffer must be refused rather than read past the end.
  let refused = false
  try {
    grayFromRgba(new Uint8Array(8), 4, 4, 4)
  } catch {
    refused = true
  }
  ok('a short RGBA buffer is refused', refused)
}

function checkShrink(): void {
  // A 4x4 picture of four 2x2 quadrants shrinks to two pixels.
  const image = {
    width: 4,
    height: 4,
    pixels: new Uint8Array([
      0, 0, 200, 200,
      0, 0, 200, 200,
      120, 120, 255, 255,
      120, 120, 255, 255,
    ]),
  }
  const half = shrinkGray(image, 2)
  sameNumber('shrinking halves both sides', half.width, 2)
  ok('the average of a dark quadrant stays dark', half.pixels[0] === 0)
  ok('the average of a bright quadrant stays bright', half.pixels[1] === 200)
  ok('grey averages, it does not pick one pixel', half.pixels[2] === 120)
  ok('a factor of one changes nothing', shrinkGray(image, 1) === image)
}

function checkFinderOnRenderedSymbol(): void {
  // The largest fixture, rendered at a fractional scale, is the hardest case for
  // the run-length test: a module edges across pixel boundaries all the way out.
  const fixture = fixtures.reduce((best, item) => (item.rows.length > best.rows.length ? item : best), fixtures[0])
  const scene = renderScene(fixture, {
    side: 320,
    modulePixels: 6.4,
    angle: 0,
    offsetX: 40,
    offsetY: 40,
    gradient: 0,
  })
  const threshold = otsuThreshold(scene.pixels)
  const binary = binarize(scene, threshold)
  const patterns = findFinderPatterns(binary)
  ok(`three finder patterns are found (${patterns.length})`, patterns.length >= 3)

  const symbol = arrangeCorners(patterns)
  ok('the three corners are identified', symbol !== null)
  if (symbol === null) return
  sameNumber(`the version comes out as ${fixture.version}`, symbol.version, fixture.version)
  ok(`the module size is near 6.4 (${symbol.modulePixels.toFixed(2)})`, Math.abs(symbol.modulePixels - 6.4) < 0.5)

  const decoded = decodeMatrix(matrixFromFrame(scene))
  same('the text survives location and sampling', decoded.text, fixture.text)
}

function checkRotation(): void {
  const fixture = fixtures.reduce((best, item) => (item.rows.length > best.rows.length ? item : best), fixtures[0])
  // A small angle first: a pairing code held by hand is rarely more than a few
  // degrees off, and small angles are where a nearest-pixel sampler quietly wins.
  for (const degrees of [4, 12, 27]) {
    const scene = renderScene(fixture, {
      side: 360,
      modulePixels: 6.2,
      angle: (degrees * Math.PI) / 180,
      offsetX: 50,
      offsetY: 50,
      gradient: 0,
    })
    let text = ''
    try {
      text = decodeMatrix(matrixFromFrame(scene)).text
    } catch (error) {
      text = 'threw: ' + error
    }
    same(`a ${degrees} degree tilt still decodes`, text, fixture.text)
  }
}

function checkUnevenLight(): void {
  const fixture = fixtures.reduce((best, item) => (item.rows.length > best.rows.length ? item : best), fixtures[0])
  const scene = renderScene(fixture, {
    side: 320,
    modulePixels: 6.4,
    angle: 0,
    offsetX: 40,
    offsetY: 40,
    gradient: 0.55,
  })
  let text = ''
  try {
    text = decodeMatrix(matrixFromFrame(scene)).text
  } catch (error) {
    text = 'threw: ' + error
  }
  same('a shaded scene still decodes, because the threshold follows it', text, fixture.text)
}

function checkCornerOrder(): void {
  // Three synthetic patterns at a right angle: the corner opposite the
  // hypotenuse is the top-left, and the cross product decides the other two.
  const topLeft: FinderPattern = { x: 100, y: 100, modulePixels: 4, hits: 5 }
  const topRight: FinderPattern = { x: 200, y: 100, modulePixels: 4, hits: 5 }
  const bottomLeft: FinderPattern = { x: 100, y: 200, modulePixels: 4, hits: 5 }
  const straight = arrangeCorners([topRight, bottomLeft, topLeft])
  ok('the top-left corner is the one off the hypotenuse', straight !== null && straight.topLeft.x === 100 && straight.topLeft.y === 100)
  ok('the corners are named in symbol order', straight !== null && straight.topRight.x === 200 && straight.bottomLeft.y === 200)

  // Feeding them in the mirrored order must be corrected, not trusted.
  const mirrored = arrangeCorners([topLeft, bottomLeft, topRight])
  ok('a mirrored order is corrected', mirrored !== null && mirrored.topRight.x === 200 && mirrored.bottomLeft.y === 200)

  // Two patterns are not enough.
  ok('two patterns are refused', arrangeCorners([topLeft, topRight]) === null)

  // A degenerate line must not divide by zero.
  let refused = false
  try {
    affineFromSymbol({
      version: 1,
      size: 21,
      modulePixels: 4,
      topLeft: { x: 0, y: 0, modulePixels: 4, hits: 3 },
      topRight: { x: 10, y: 10, modulePixels: 4, hits: 3 },
      bottomLeft: { x: 20, y: 20, modulePixels: 4, hits: 3 },
    })
  } catch {
    refused = true
  }
  ok('three patterns in a line are refused', refused)
}

function checkAffine(): void {
  // A pure translation: the map is the identity plus a shift, and the module
  // coordinates of the three centres must land on the image coordinates.
  const symbol = {
    version: 1,
    size: 21,
    modulePixels: 4,
    topLeft: { x: 50, y: 60, modulePixels: 4, hits: 3 },
    topRight: { x: 50 + 14 * 4, y: 60, modulePixels: 4, hits: 3 },
    bottomLeft: { x: 50, y: 60 + 14 * 4, modulePixels: 4, hits: 3 },
  }
  const map = affineFromSymbol(symbol)
  const project = (u: number, v: number): number[] => [map.a * u + map.b * v + map.c, map.d * u + map.e * v + map.f]
  const corner = project(3.5, 3.5)
  ok(`the top-left centre maps to itself (${corner[0].toFixed(1)}, ${corner[1].toFixed(1)})`, Math.abs(corner[0] - 50) < 0.01 && Math.abs(corner[1] - 60) < 0.01)
  const far = project(17.5, 17.5)
  ok(`the far corner maps by the module size (${far[0].toFixed(1)}, ${far[1].toFixed(1)})`, Math.abs(far[0] - 106) < 0.01 && Math.abs(far[1] - 116) < 0.01)
  ok(`the module pitch is recovered (${map.a.toFixed(2)})`, Math.abs(map.a - 4) < 0.01 && Math.abs(map.e - 4) < 0.01)
}

function checkFailures(): void {
  const blank: FrameGray = { width: 64, height: 64, pixels: new Uint8Array(64 * 64).fill(255) }
  let refused = false
  try {
    locateFrame(blank)
  } catch {
    refused = true
  }
  ok('a blank frame is refused', refused)

  const tiny: FrameGray = { width: 8, height: 8, pixels: new Uint8Array(64) }
  refused = false
  try {
    locateFrame(tiny)
  } catch {
    refused = true
  }
  ok('a frame smaller than a symbol is refused', refused)
}

console.log('QR scan (finders, affine sampling, luma and RGBA preprocessing)')
checkOtsu()
checkBinarize()
checkLuma()
checkRgba()
checkShrink()
checkFinderOnRenderedSymbol()
checkRotation()
checkUnevenLight()
checkCornerOrder()
checkAffine()
checkFailures()

if (failures > 0) {
  console.log(`${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('ALL QR SCAN CHECKS PASS (typescript core)')
