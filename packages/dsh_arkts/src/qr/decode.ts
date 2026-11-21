// Turning a square of dark/light modules into codewords, then into text.
//
// The input is a `BitMatrix`: a plain array of rows of booleans, dark = true.
// Reading pixels is somebody else's job (`sampler.ts`); this file only has to
// agree with the specification about where the bits sit.

import { correct } from './rs';
import {
  FORMAT_LEVELS,
  maskBit,
  readFormat,
  readVersionBits,
  versionBits,
} from './format';
import { alignmentCentres, layoutFor, sideLength } from './types';
import { TOTAL_CODEWORDS } from './tables';

/** Error thrown when a matrix cannot be decoded. */
export class QrDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QrDecodeError';
  }
}

/** Rows of booleans, dark = true. */
export type BitMatrix = boolean[][];

/** A decoded symbol. */
export interface QrResult {
  readonly text: string;
  readonly version: number;
  readonly level: string;
  readonly mask: number;
  /** Bytes that Reed-Solomon had to repair, summed over all blocks. */
  readonly repairedBytes: number;
}

function isDark(matrix: BitMatrix, row: number, col: number): boolean {
  if (row < 0 || col < 0 || row >= matrix.length) return false;
  const line = matrix[row];
  if (col >= line.length) return false;
  return line[col];
}

/**
 * Which modules belong to the symbol's fixed patterns.
 *
 * Data must be read around them, so the map is built once and reused. A finder
 * pattern is seven modules wide and its separator adds one more, which makes
 * the reserved corner an eight-by-eight square — marking nine would swallow a
 * row of data on each side and shift every following bit.
 */
function functionModules(version: number): boolean[][] {
  const size = sideLength(version);
  const map: boolean[][] = [];
  for (let row = 0; row < size; row += 1) map.push(new Array<boolean>(size).fill(false));
  const mark = (row: number, col: number): void => {
    if (row >= 0 && col >= 0 && row < size && col < size) map[row][col] = true;
  };
  const markSquare = (top: number, left: number, extent: number): void => {
    for (let row = 0; row < extent; row += 1) {
      for (let col = 0; col < extent; col += 1) mark(top + row, left + col);
    }
  };

  // Three finder patterns plus their separators: an eight-by-eight corner each.
  markSquare(0, 0, 8);
  markSquare(0, size - 8, 8);
  markSquare(size - 8, 0, 8);

  // Timing patterns: row six and column six, between the corners.
  for (let index = 8; index < size - 8; index += 1) {
    mark(6, index);
    mark(index, 6);
  }

  // The format field, one copy beside the top-left finder and one split
  // between the other two.
  for (let index = 0; index <= 8; index += 1) {
    mark(8, index);
    mark(index, 8);
  }
  for (let index = 0; index < 8; index += 1) {
    mark(8, size - 1 - index);
    mark(size - 1 - index, 8);
  }

  // Alignment patterns, except where they would overlap a finder.
  const centres = alignmentCentres(version);
  for (const row of centres) {
    for (const col of centres) {
      const nearFinder =
        (row === 6 && col === 6) ||
        (row === 6 && col === size - 7) ||
        (row === size - 7 && col === 6);
      if (nearFinder) continue;
      for (let deltaRow = -2; deltaRow <= 2; deltaRow += 1) {
        for (let deltaCol = -2; deltaCol <= 2; deltaCol += 1) mark(row + deltaRow, col + deltaCol);
      }
    }
  }

  // The dark module, and the version blocks for versions seven and up.
  mark(size - 8, 8);
  if (version >= 7) {
    for (let index = 0; index < 18; index += 1) {
      const row = Math.floor(index / 3);
      const col = size - 11 + (index % 3);
      mark(row, col);
      mark(col, row);
    }
  }
  return map;
}

/** Read the version, from the blocks for 7 and up, or from the size below. */
function detectVersion(matrix: BitMatrix): number {
  const size = matrix.length;
  if (size < 21) throw new QrDecodeError(`a ${size}x${size} matrix is too small to be a QR code`);
  if ((size - 17) % 4 !== 0) throw new QrDecodeError(`a ${size}x${size} matrix is not a QR size`);
  const fromSize = (size - 17) / 4;
  if (fromSize < 7) return fromSize;

  // Two copies of the eighteen version bits, top-right and bottom-left.
  let rawA = 0;
  let rawB = 0;
  for (let index = 0; index < 18; index += 1) {
    const row = Math.floor(index / 3);
    const col = size - 11 + (index % 3);
    rawA = (rawA << 1) | (isDark(matrix, row, col) ? 1 : 0);
    rawB = (rawB << 1) | (isDark(matrix, col, row) ? 1 : 0);
  }
  const fromBits = readVersionBits(rawA) ?? readVersionBits(rawB);
  if (fromBits !== null && fromBits === fromSize) return fromBits;

  // A damaged version block is survivable when the size already agrees with one
  // of the two copies, which is why the mismatch above is only a warning.
  if (fromBits !== null) return fromBits;
  const expected = versionBits(fromSize);
  const distance = (left: number, right: number): number => {
    let count = 0;
    let difference = left ^ right;
    while (difference !== 0) {
      difference &= difference - 1;
      count += 1;
    }
    return count;
  };
  if (distance(rawA, expected) <= 3 || distance(rawB, expected) <= 3) return fromSize;
  throw new QrDecodeError('the version blocks do not match the matrix size');
}

/** Walk the data zig-zag and return the raw codewords, mask removed. */
function readCodewords(matrix: BitMatrix, version: number, mask: number): number[] {
  const size = sideLength(version);
  const reserved = functionModules(version);
  const bits: number[] = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    // Column six is the vertical timing pattern: skip it entirely.
    if (right === 6) right = 5;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (let pair = 0; pair < 2; pair += 1) {
        const col = right - pair;
        if (reserved[row][col]) continue;
        const dark = isDark(matrix, row, col);
        bits.push(dark !== maskBit(mask, row, col) ? 1 : 0);
      }
    }
    upward = !upward;
  }

  // The number of codewords is a property of the version alone: the level only
  // decides how they are split between data and parity.
  const totalCodewords = TOTAL_CODEWORDS[version - 1];
  const expected = totalCodewords * 8;
  // The trailing bits are padding and are shorter than a codeword.
  const usable = Math.min(bits.length, expected);
  const out: number[] = [];
  for (let index = 0; index + 8 <= usable; index += 8) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit += 1) byte = (byte << 1) | bits[index + bit];
    out.push(byte);
  }
  return out;
}

/** Undo the block interleaving and repair each block. */
function deinterleave(codewords: readonly number[], version: number, level: string): { data: number[]; repaired: number } {
  const layout = layoutFor(version, level);
  const totalBlocks = layout.blocks;
  const shortCount = totalBlocks - layout.longBlocks;
  const blocks: number[][] = [];
  for (let index = 0; index < totalBlocks; index += 1) {
    const length = layout.shortLength + (index >= shortCount ? 1 : 0) + layout.ecPerBlock;
    blocks.push(new Array<number>(length).fill(0));
  }

  let cursor = 0;
  const longestData = layout.shortLength + (layout.longBlocks > 0 ? 1 : 0);
  for (let position = 0; position < longestData; position += 1) {
    for (let index = 0; index < totalBlocks; index += 1) {
      const isShort = index < shortCount;
      if (position >= layout.shortLength + (isShort ? 0 : 1)) continue;
      if (cursor >= codewords.length) throw new QrDecodeError('the symbol ran out of codewords');
      blocks[index][position] = codewords[cursor];
      cursor += 1;
    }
  }
  for (let position = 0; position < layout.ecPerBlock; position += 1) {
    for (let index = 0; index < totalBlocks; index += 1) {
      if (cursor >= codewords.length) throw new QrDecodeError('the symbol ran out of codewords');
      blocks[index][layout.shortLength + (index >= shortCount ? 1 : 0) + position] = codewords[cursor];
      cursor += 1;
    }
  }

  const data: number[] = [];
  let repaired = 0;
  for (const block of blocks) repaired += correct(block, layout.ecPerBlock);
  for (let index = 0; index < totalBlocks; index += 1) {
    const length = layout.shortLength + (index >= shortCount ? 1 : 0);
    for (let position = 0; position < length; position += 1) data.push(blocks[index][position]);
  }
  return { data, repaired };
}

/** A bit stream over the data codewords. */
class BitStream {
  private byteIndex = 0;
  private bitIndex = 0;
  private readonly bytes: readonly number[];

  constructor(bytes: readonly number[]) {
    this.bytes = bytes;
  }

  get remaining(): number {
    return this.bytes.length * 8 - (this.byteIndex * 8 + this.bitIndex);
  }

  read(count: number): number {
    if (count > this.remaining) throw new QrDecodeError('the payload asked for more bits than the symbol holds');
    let value = 0;
    for (let index = 0; index < count; index += 1) {
      const byte = this.bytes[this.byteIndex];
      value = (value << 1) | ((byte >> (7 - this.bitIndex)) & 1);
      this.bitIndex += 1;
      if (this.bitIndex === 8) {
        this.bitIndex = 0;
        this.byteIndex += 1;
      }
    }
    return value;
  }
}

const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

/**
 * How many bits the character count occupies, per mode and version.
 *
 * The count is not a fixed width: numeric is 10/12/14 bits, alphanumeric
 * 9/11/13, byte 8/16/16 and kanji 8/10/12 for the three version bands
 * (1–9, 10–26, 27–40). Reading a fixed width works for small byte-only codes
 * and then silently shifts every later bit out of place.
 */
function countBits(mode: number, version: number): number {
  const band = version < 10 ? 0 : version < 27 ? 1 : 2;
  switch (mode) {
    case 0x1:
      return band === 0 ? 10 : band === 1 ? 12 : 14;
    case 0x2:
      return band === 0 ? 9 : band === 1 ? 11 : 13;
    case 0x4:
      return band === 0 ? 8 : 16;
    case 0x8:
      return band === 0 ? 8 : band === 1 ? 10 : 12;
    default:
      return 0;
  }
}

/** Decode the segment stream into text. */
function decodePayload(data: readonly number[], version: number): string {
  const stream = new BitStream(data);
  let out = '';
  while (stream.remaining >= 4) {
    const mode = stream.read(4);
    if (mode === 0x0) break; // terminator
    if (mode === 0x1) {
      // Numeric: 10 bits per three digits.
      const count = stream.read(countBits(mode, version));
      let remaining = count;
      while (remaining >= 3) {
        const value = stream.read(10);
        if (value >= 1000) throw new QrDecodeError(`numeric group ${value} is out of range`);
        out += String(value).padStart(3, '0');
        remaining -= 3;
      }
      if (remaining === 2) out += String(stream.read(7)).padStart(2, '0');
      else if (remaining === 1) out += String(stream.read(4));
      continue;
    }
    if (mode === 0x2) {
      // Alphanumeric: 11 bits per two characters, 6 for a trailing one.
      const count = stream.read(countBits(mode, version));
      let remaining = count;
      while (remaining >= 2) {
        const value = stream.read(11);
        const first = Math.floor(value / 45);
        const second = value % 45;
        if (first >= ALPHANUMERIC.length || second >= ALPHANUMERIC.length) {
          throw new QrDecodeError('an alphanumeric pair is out of range');
        }
        out += ALPHANUMERIC[first] + ALPHANUMERIC[second];
        remaining -= 2;
      }
      if (remaining === 1) {
        const value = stream.read(6);
        if (value >= ALPHANUMERIC.length) throw new QrDecodeError('an alphanumeric character is out of range');
        out += ALPHANUMERIC[value];
      }
      continue;
    }
    if (mode === 0x4) {
      // Byte: eight bits each, in whatever encoding the payload names.
      const count = stream.read(countBits(mode, version));
      const bytes: number[] = [];
      for (let index = 0; index < count; index += 1) bytes.push(stream.read(8));
      out += decodeBytes(bytes);
      continue;
    }
    if (mode === 0x8) {
      // Kanji: thirteen bits per character, Shift JIS.
      const count = stream.read(countBits(mode, version));
      for (let index = 0; index < count; index += 1) {
        out += String.fromCharCode(kanjiValue(stream.read(13)));
      }
      continue;
    }
    if (mode === 0x7) {
      // ECI: the designator names the byte encoding of later segments. The
      // pairing code is ASCII, so the assignment only has to be consumed.
      const first = stream.read(8);
      if ((first & 0xc0) === 0xc0) stream.read(8);
      else if ((first & 0xe0) === 0xe0) stream.read(8);
      continue;
    }
    if (mode === 0x3) {
      // Structured append: the header binds several symbols together and the
      // phone has no use for a fragment on its own.
      throw new QrDecodeError('this code is one part of a structured-append set');
    }
    throw new QrDecodeError(`unknown segment mode 0x${mode.toString(16)}`);
  }
  return out;
}

/** Shift JIS kanji from a thirteen-bit value. */
function kanjiValue(raw: number): number {
  const adjusted = Math.floor(raw / 0xc0) * 0x100 + (raw % 0xc0);
  return adjusted + (adjusted < 0x1f00 ? 0x8140 : 0xc140);
}

/**
 * Bytes to text, strictly.
 *
 * UTF-8 is the only encoding accepted: every pairing code is UTF-8 and a
 * mojibake pairing code is worse than a refused one. The decoder is written out
 * by hand because ArkTS has no `TextDecoder`, and because the built-in one in
 * Node is lenient about overlong forms that a QR payload should never contain.
 */
function decodeBytes(bytes: readonly number[]): string {
  let out = '';
  let index = 0;
  const continuation = (offset: number): number => {
    if (offset >= bytes.length) return -1;
    const byte = bytes[offset];
    return (byte & 0xc0) === 0x80 ? byte & 0x3f : -1;
  };
  while (index < bytes.length) {
    const lead = bytes[index];
    if (lead < 0x80) {
      out += String.fromCharCode(lead);
      index += 1;
      continue;
    }
    if (lead >= 0xc2 && lead <= 0xdf) {
      const b1 = continuation(index + 1);
      if (b1 < 0) throw new QrDecodeError('the payload is not UTF-8 text');
      out += String.fromCharCode(((lead & 0x1f) << 6) | b1);
      index += 2;
      continue;
    }
    if (lead >= 0xe0 && lead <= 0xef) {
      const b1 = continuation(index + 1);
      const b2 = continuation(index + 2);
      if (b1 < 0 || b2 < 0) throw new QrDecodeError('the payload is not UTF-8 text');
      const code = ((lead & 0x0f) << 12) | (b1 << 6) | b2;
      // Reject the overlong and surrogate forms the lead range still admits.
      if (code < 0x800 || (code >= 0xd800 && code <= 0xdfff)) {
        throw new QrDecodeError('the payload is not UTF-8 text');
      }
      out += String.fromCharCode(code);
      index += 3;
      continue;
    }
    if (lead >= 0xf0 && lead <= 0xf4) {
      const b1 = continuation(index + 1);
      const b2 = continuation(index + 2);
      const b3 = continuation(index + 3);
      if (b1 < 0 || b2 < 0 || b3 < 0) throw new QrDecodeError('the payload is not UTF-8 text');
      const code = ((lead & 0x07) << 18) | (b1 << 12) | (b2 << 6) | b3;
      if (code < 0x10000 || code > 0x10ffff) throw new QrDecodeError('the payload is not UTF-8 text');
      const shifted = code - 0x10000;
      out += String.fromCharCode(0xd800 + (shifted >> 10), 0xdc00 + (shifted & 0x3ff));
      index += 4;
      continue;
    }
    throw new QrDecodeError('the payload is not UTF-8 text');
  }
  return out;
}

/** Decode a matrix into text. */
export function decodeMatrix(matrix: BitMatrix): QrResult {
  const size = matrix.length;
  if (size === 0) throw new QrDecodeError('the matrix is empty');
  for (const row of matrix) {
    if (row.length !== size) throw new QrDecodeError('the matrix is not square');
  }

  const version = detectVersion(matrix);
  if (sideLength(version) !== size) {
    throw new QrDecodeError(`version ${version} should be ${sideLength(version)} modules, not ${size}`);
  }

  const format = readFormat((row, col) => isDark(matrix, row, col), size);
  if (format === null) throw new QrDecodeError('the format field is unreadable');

  const codewords = readCodewords(matrix, version, format.mask);
  const { data, repaired } = deinterleave(codewords, version, format.level);
  const text = decodePayload(data, version);
  return { text, version, level: format.level, mask: format.mask, repairedBytes: repaired };
}

/** The levels in the order the format field stores them, for callers that print. */
export { FORMAT_LEVELS };
