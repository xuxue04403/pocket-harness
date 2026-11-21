// Finding the symbol in a grayscale picture, and sampling it into modules.
//
// Scope, stated honestly: this locates a code that is axis-aligned and whose
// module grid is a whole number of pixels, which is what a rendered pairing
// code (or an emulator preview) gives. A photograph held at an angle needs a
// perspective transform this project has no rig to test, so it is not claimed.

import type { BitMatrix } from './decode';
import { QrDecodeError } from './decode';

/** 8-bit grayscale pixels, `width * height` bytes, 0 = black. */
export interface GrayImage {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

/** A located symbol: where it sits and how wide one module is. */
export interface SymbolBox {
  readonly left: number;
  readonly top: number;
  readonly size: number;
  readonly modulePixels: number;
  readonly version: number;
}

const BLACK_THRESHOLD = 128;

function at(image: GrayImage, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return 255;
  return image.pixels[y * image.width + x];
}

/**
 * Locate the symbol.
 *
 * The dark bounding box of a QR code is exactly the symbol's own box: the
 * finder patterns sit in the three corners and their outer ring is dark, and
 * the quiet zone around them is white. So the search is a bounding box scan,
 * and the only real question is which version makes `span / size` a whole
 * number of pixels per module.
 */
export function locateSymbol(image: GrayImage): SymbolBox {
  if (image.width < 21 || image.height < 21) throw new QrDecodeError('the picture is too small');

  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (at(image, x, y) >= BLACK_THRESHOLD) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new QrDecodeError('the picture is entirely white');

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  if (width !== height) {
    throw new QrDecodeError(`the symbol is ${width}x${height}, which is not square`);
  }

  // The module size must be a whole number of pixels and the version has to be
  // one the size admits; both constraints together pin the version.
  for (let version = 1; version <= 40; version += 1) {
    const size = 17 + version * 4;
    if (width % size !== 0) continue;
    const modulePixels = width / size;
    if (modulePixels < 1) continue;
    return { left: minX, top: minY, size, modulePixels, version };
  }
  throw new QrDecodeError(`no version has ${width} modules across at a whole pixel size`);
}

/**
 * Sample a located symbol into modules.
 *
 * Each module is the majority of its pixel square. The majority vote, rather
 * than the centre pixel, is what survives the resampling an emulator applies
 * when it scales a preview.
 */
export function sampleSymbol(image: GrayImage, box: SymbolBox): BitMatrix {
  const matrix: BitMatrix = [];
  for (let row = 0; row < box.size; row += 1) {
    const line: boolean[] = [];
    for (let col = 0; col < box.size; col += 1) {
      const startX = box.left + col * box.modulePixels;
      const startY = box.top + row * box.modulePixels;
      let dark = 0;
      let total = 0;
      for (let dy = 0; dy < box.modulePixels; dy += 1) {
        for (let dx = 0; dx < box.modulePixels; dx += 1) {
          total += 1;
          if (at(image, startX + dx, startY + dy) < BLACK_THRESHOLD) dark += 1;
        }
      }
      line.push(dark * 2 > total);
    }
    matrix.push(line);
  }
  return matrix;
}

/** Locate, sample, and hand back the matrix in one step. */
export function matrixFromImage(image: GrayImage): BitMatrix {
  return sampleSymbol(image, locateSymbol(image));
}
