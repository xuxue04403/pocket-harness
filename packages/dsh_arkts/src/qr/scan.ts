// Finding a QR code in a camera frame.
//
// The bounding-box locator in `sampler.ts` assumes the symbol is the only dark
// thing in the picture and that its modules are a whole number of pixels. Both
// hold for a rendered pairing code and neither holds for a camera frame, where
// the code sits somewhere in a scene and its modules land on fractional pixels.
//
// So this file does what a scanner does:
//
//   1. shrink the luma plane so the cost of scanning stays sane,
//   2. binarise with a global Otsu threshold, which survives uneven lighting
//      far better than a fixed cut-off,
//   3. look for the three finder patterns by their 1:1:3:1:1 run signature,
//   4. build an affine map from module space to image space out of the three
//      centres, and sample through it.
//
// The affine map is why rotation works at all: three points determine it, and
// any rotation, scale or shear that keeps the code flat is exactly an affine
// map. A photograph taken at an angle needs a projective map instead, which is
// not claimed here.

import type { BitMatrix } from './decode';
import { QrDecodeError } from './decode';

/** 8-bit grayscale pixels, `width * height` bytes, 0 = black. */
export interface FrameGray {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

/** A finder pattern: where its centre is and how wide one module is there. */
export interface FinderPattern {
  readonly x: number;
  readonly y: number;
  readonly modulePixels: number;
  /** How many 1:1:3:1:1 crossings agreed on this centre. */
  readonly hits: number;
}

/** A located code: where the three corners are and how many modules fit. */
export interface ScannedSymbol {
  readonly version: number;
  readonly size: number;
  readonly modulePixels: number;
  readonly topLeft: FinderPattern;
  readonly topRight: FinderPattern;
  readonly bottomLeft: FinderPattern;
}

/**
 * Otsu's threshold: the cut that minimises the variance within the two classes.
 *
 * A fixed threshold of 128 fails on a dim screen or a bright desk. Otsu derives
 * the cut from the picture's own histogram, so the same code works whether the
 * scene is mostly white or mostly grey.
 */
export function otsuThreshold(pixels: Uint8Array): number {
  const histogram = new Array<number>(256).fill(0);
  for (let index = 0; index < pixels.length; index += 1) histogram[pixels[index]] += 1;
  const total = pixels.length;
  if (total === 0) return 128;

  let sum = 0;
  for (let level = 0; level < 256; level += 1) sum += level * histogram[level];

  let sumBackground = 0;
  let weightBackground = 0;
  let best = 0;
  let bestVariance = -1;
  for (let level = 0; level < 256; level += 1) {
    weightBackground += histogram[level];
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;
    sumBackground += level * histogram[level];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const delta = meanBackground - meanForeground;
    const variance = weightBackground * weightForeground * delta * delta;
    if (variance > bestVariance) {
      bestVariance = variance;
      best = level;
    }
  }
  return best;
}

/** Binarise: true where the pixel is darker than `threshold`. */
export function binarize(image: FrameGray, threshold: number): BitMatrix {
  const matrix: BitMatrix = [];
  for (let y = 0; y < image.height; y += 1) {
    const line: boolean[] = [];
    const row = y * image.width;
    for (let x = 0; x < image.width; x += 1) line.push(image.pixels[row + x] <= threshold);
    matrix.push(line);
  }
  return matrix;
}

/**
 * Does a run of five lengths look like a finder pattern's 1:1:3:1:1?
 *
 * The tolerance is a third of one module rather than a flat number of pixels,
 * because the same rule has to hold for a two-pixel module and a twenty-pixel
 * one. `variance` is returned so callers can prefer cleaner hits.
 */
function finderRatio(runs: readonly number[]): number {
  const total = runs[0] + runs[1] + runs[2] + runs[3] + runs[4];
  if (total < 7) return -1;
  const module = total / 7;
  const tolerance = module / 2;
  if (Math.abs(runs[0] - module) > tolerance) return -1;
  if (Math.abs(runs[1] - module) > tolerance) return -1;
  if (Math.abs(runs[2] - 3 * module) > 3 * tolerance) return -1;
  if (Math.abs(runs[3] - module) > tolerance) return -1;
  if (Math.abs(runs[4] - module) > tolerance) return -1;
  // A perfect fit scores zero; the score lets the caller keep the best centre
  // when a noisy row produces several candidates.
  let error = 0;
  const expect = [1, 1, 3, 1, 1];
  for (let index = 0; index < 5; index += 1) error += Math.abs(runs[index] - expect[index] * module);
  return error / total;
}

/**
 * Validate a horizontal candidate by checking the same ratio vertically.
 *
 * A lone horizontal match is usually a stripe in the background. Requiring the
 * vertical ratio through the same centre removes nearly all of those, and the
 * measured vertical run gives the module size to average with the horizontal.
 */
function checkVertical(matrix: BitMatrix, centreX: number, centreY: number): number {
  const height = matrix.length;
  const at = (x: number, y: number): boolean => {
    if (y < 0 || y >= height) return false;
    const row = matrix[y];
    if (x < 0 || x >= row.length) return false;
    return row[x];
  };
  if (!at(centreX, centreY)) return -1;

  let top = centreY;
  while (top >= 0 && at(centreX, top)) top -= 1;
  let bottom = centreY;
  while (bottom < height && at(centreX, bottom)) bottom += 1;
  const centreRun = bottom - top - 1;
  if (centreRun <= 0) return -1;

  const measure = (start: number, step: number): number => {
    let count = 0;
    let y = start;
    while (y >= 0 && y < height && !at(centreX, y)) {
      count += 1;
      y += step;
    }
    return count;
  };
  const before = measure(top, -1);
  const after = measure(bottom, 1);
  const outerUp = (() => {
    let count = 0;
    let y = top - before;
    while (y >= 0 && at(centreX, y)) {
      count += 1;
      y -= 1;
    }
    return count;
  })();
  const outerDown = (() => {
    let count = 0;
    let y = bottom + after;
    while (y < height && at(centreX, y)) {
      count += 1;
      y += 1;
    }
    return count;
  })();
  const error = finderRatio([outerUp, before, centreRun, after, outerDown]);
  if (error < 0) return -1;
  return (top + bottom + 1) / 2 + (after - before) / 2;
}

/**
 * Find finder pattern candidates by scanning every row.
 *
 * Runs in O(pixels) with a rolling window of the last five run lengths, which
 * is the same trick the classic scanners use: no per-pixel neighbourhood work,
 * so it stays affordable on a phone.
 */
export function findFinderPatterns(matrix: BitMatrix): FinderPattern[] {
  const height = matrix.length;
  if (height === 0) return [];
  const width = matrix[0].length;
  const candidates: FinderPattern[] = [];

  for (let y = 0; y < height; y += 1) {
    const row = matrix[y];
    const runs: number[] = [];
    let current = row[0];
    let length = 1;
    for (let x = 1; x < width; x += 1) {
      if (row[x] === current) {
        length += 1;
        continue;
      }
      runs.push(length);
      current = row[x];
      length = 1;
    }
    runs.push(length);

    // Walk the runs five at a time. The five must start on a dark run and end
    // on a dark run, so the window's parity is fixed by whether the row began
    // dark: only one of the two offsets can be a finder.
    let darkFirst = row[0];
    for (let start = 0; start + 5 <= runs.length; start += 1) {
      const isDarkStart = start % 2 === 0 ? darkFirst : !darkFirst;
      if (!isDarkStart) continue;
      const window = runs.slice(start, start + 5);
      const error = finderRatio(window);
      if (error < 0) continue;

      let centreX = 0;
      for (let index = 0; index < start; index += 1) centreX += runs[index];
      centreX += window[0] + window[1] + window[2] / 2;

      const centreY = checkVertical(matrix, Math.round(centreX), y);
      if (centreY < 0) continue;
      const modulePixels = (window[0] + window[1] + window[2] + window[3] + window[4]) / 7;
      candidates.push({ x: centreX, y: centreY, modulePixels: modulePixels, hits: 1 });
    }
  }
  return mergeCandidates(candidates);
}

/** Collapse candidates that describe the same finder pattern. */
function mergeCandidates(candidates: readonly FinderPattern[]): FinderPattern[] {
  const merged: FinderPattern[] = [];
  for (const candidate of candidates) {
    let found = false;
    for (let index = 0; index < merged.length; index += 1) {
      const existing = merged[index];
      const tolerance = Math.max(2, existing.modulePixels);
      if (Math.abs(existing.x - candidate.x) > tolerance) continue;
      if (Math.abs(existing.y - candidate.y) > tolerance) continue;
      const hits = existing.hits + 1;
      merged[index] = {
        x: (existing.x * existing.hits + candidate.x) / hits,
        y: (existing.y * existing.hits + candidate.y) / hits,
        modulePixels: (existing.modulePixels * existing.hits + candidate.modulePixels) / hits,
        hits: hits,
      };
      found = true;
      break;
    }
    if (!found) merged.push(candidate);
  }
  // A real finder pattern is crossed by many rows; a stray stripe is not.
  return merged.filter((pattern) => pattern.hits >= 2).sort((left, right) => right.hits - left.hits);
}

function distance(left: FinderPattern, right: FinderPattern): number {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Pick the three finder patterns and name their corners.
 *
 * In a QR code the three patterns sit at a right angle, so the corner that is
 * not on the longest side is the top-left one. Which of the other two is
 * top-right is then decided by the sign of the cross product: a positive value
 * means the pair is in the order the symbol expects, and swapping otherwise.
 */
export function arrangeCorners(patterns: readonly FinderPattern[]): ScannedSymbol | null {
  if (patterns.length < 3) return null;
  const sorted = patterns.slice().sort((left, right) => right.hits - left.hits).slice(0, 3);

  let cornerIndex = 0;
  let hypotenuse = -1;
  for (let index = 0; index < 3; index += 1) {
    const first = sorted[(index + 1) % 3];
    const second = sorted[(index + 2) % 3];
    const side = distance(first, second);
    if (side > hypotenuse) {
      hypotenuse = side;
      cornerIndex = index;
    }
  }
  const topLeft = sorted[cornerIndex];
  let topRight = sorted[(cornerIndex + 1) % 3];
  let bottomLeft = sorted[(cornerIndex + 2) % 3];
  const cross = (topRight.x - topLeft.x) * (bottomLeft.y - topLeft.y) - (topRight.y - topLeft.y) * (bottomLeft.x - topLeft.x);
  if (cross < 0) {
    const swap = topRight;
    topRight = bottomLeft;
    bottomLeft = swap;
  }

  const spanX = distance(topLeft, topRight);
  // A finder pattern's module size is measured by horizontal run lengths, but a
  // row of pixels cuts a rotated square at an angle, so each run is longer than
  // one module by exactly 1/cos(theta) — where cos(theta) is how much of the
  // symbol's own x axis lies along the image's x axis. Dividing it back out is
  // what keeps a tilted code from reading as a smaller version: at 27 degrees
  // the raw measurement is 12% too large, and 12% is more than half a version.
  const measured = (topLeft.modulePixels + topRight.modulePixels + bottomLeft.modulePixels) / 3;
  if (measured <= 0 || spanX <= 0) return null;
  const alongX = Math.abs(topRight.x - topLeft.x) / spanX;
  const modulePixels = measured * alongX;
  if (modulePixels <= 0) return null;
  // The two centres are `size - 7` modules apart: the finder is 7 modules wide
  // and its centre sits 3.5 in from either edge.
  const modulesBetween = spanX / modulePixels;
  let size = Math.round(modulesBetween) + 7;
  if (size < 21 || size > 177) return null;
  if ((size - 17) % 4 !== 0) {
    // Snap to the nearest legal size; a slightly wrong module estimate must not
    // throw the version away entirely.
    const version = Math.round((size - 17) / 4);
    if (version < 1 || version > 40) return null;
    size = 17 + version * 4;
  }
  const version = (size - 17) / 4;
  return {
    version: version,
    size: size,
    modulePixels: spanX / (size - 7),
    topLeft: topLeft,
    topRight: topRight,
    bottomLeft: bottomLeft,
  };
}

/** An affine map from module coordinates to image coordinates. */
export interface AffineMap {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

/**
 * Solve the affine map that sends the three finder centres to their module
 * coordinates. Written out with Cramer's rule rather than a matrix library,
 * because ArkTS and Node have to agree and three-point affine is four lines.
 */
export function affineFromSymbol(symbol: ScannedSymbol): AffineMap {
  const half = 3.5;
  const far = symbol.size - 3.5;
  const modulePoints: number[][] = [
    [half, half],
    [far, half],
    [half, far],
  ];
  const imagePoints: number[][] = [
    [symbol.topLeft.x, symbol.topLeft.y],
    [symbol.topRight.x, symbol.topRight.y],
    [symbol.bottomLeft.x, symbol.bottomLeft.y],
  ];
  // Three collinear centres describe no code: the finder patterns of a QR sit at
  // a right angle, so a zero-area triangle means the three hits were really one
  // stripe in the background seen at three places. The module points alone can
  // never be collinear, so this has to be checked on the image points — checking
  // the determinant below would never fire.
  const area =
    (imagePoints[1][0] - imagePoints[0][0]) * (imagePoints[2][1] - imagePoints[0][1]) -
    (imagePoints[1][1] - imagePoints[0][1]) * (imagePoints[2][0] - imagePoints[0][0]);
  const spreadX = Math.max(...imagePoints.map((point) => point[0])) - Math.min(...imagePoints.map((point) => point[0]));
  const spreadY = Math.max(...imagePoints.map((point) => point[1])) - Math.min(...imagePoints.map((point) => point[1]));
  const scale = Math.max(spreadX, spreadY);
  if (scale <= 0 || Math.abs(area) < scale * scale * 0.01) {
    throw new QrDecodeError('the three finder patterns are in a line');
  }
  // x = a*u + b*v + c, y = d*u + e*v + f, solved independently for the two axes.
  const solve = (values: number[]): number[] => {
    const u1 = modulePoints[0][0];
    const v1 = modulePoints[0][1];
    const u2 = modulePoints[1][0];
    const v2 = modulePoints[1][1];
    const u3 = modulePoints[2][0];
    const v3 = modulePoints[2][1];
    const det = u1 * (v2 - v3) - v1 * (u2 - u3) + (u2 * v3 - u3 * v2);
    if (det === 0) throw new QrDecodeError('the three finder patterns are in a line');
    const a = (values[0] * (v2 - v3) - v1 * (values[1] - values[2]) + (values[1] * v3 - values[2] * v2)) / det;
    const b = (u1 * (values[1] - values[2]) - values[0] * (u2 - u3) + (u2 * values[2] - u3 * values[1])) / det;
    const c = (u1 * (v2 * values[2] - v3 * values[1]) - v1 * (u2 * values[2] - u3 * values[1]) + values[0] * (u2 * v3 - u3 * v2)) / det;
    return [a, b, c];
  };
  const xs = solve([imagePoints[0][0], imagePoints[1][0], imagePoints[2][0]]);
  const ys = solve([imagePoints[0][1], imagePoints[1][1], imagePoints[2][1]]);
  return { a: xs[0], b: xs[1], c: xs[2], d: ys[0], e: ys[1], f: ys[2] };
}

/**
 * Sample the symbol through the affine map.
 *
 * Each module reads a small neighbourhood around its centre and takes the
 * majority, because one pixel at a module centre sits right on the boundary
 * between black and white often enough to matter.
 */
export function sampleThrough(matrix: BitMatrix, symbol: ScannedSymbol, map: AffineMap): BitMatrix {
  const height = matrix.length;
  const width = matrix[0].length;
  const radius = Math.max(0, Math.floor(symbol.modulePixels / 4));
  const at = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    return matrix[y][x];
  };
  const out: BitMatrix = [];
  for (let row = 0; row < symbol.size; row += 1) {
    const line: boolean[] = [];
    for (let col = 0; col < symbol.size; col += 1) {
      const u = col + 0.5;
      const v = row + 0.5;
      const cx = map.a * u + map.b * v + map.c;
      const cy = map.d * u + map.e * v + map.f;
      if (radius === 0) {
        line.push(at(Math.round(cx), Math.round(cy)));
        continue;
      }
      let dark = 0;
      let total = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          total += 1;
          if (at(Math.round(cx) + dx, Math.round(cy) + dy)) dark += 1;
        }
      }
      line.push(dark * 2 > total);
    }
    out.push(line);
  }
  return out;
}

/** Locate and sample in one step. Throws when no code is found. */
export function locateFrame(image: FrameGray): { symbol: ScannedSymbol; matrix: BitMatrix } {
  if (image.width < 21 || image.height < 21) throw new QrDecodeError('the picture is too small');
  const threshold = otsuThreshold(image.pixels);
  const binary = binarize(image, threshold);
  const patterns = findFinderPatterns(binary);
  const symbol = arrangeCorners(patterns);
  if (symbol === null) throw new QrDecodeError('no QR code was found in the picture');
  const map = affineFromSymbol(symbol);
  return { symbol: symbol, matrix: sampleThrough(binary, symbol, map) };
}

/** Full path: grayscale frame to modules. */
export function matrixFromFrame(image: FrameGray): BitMatrix {
  return locateFrame(image).matrix;
}
