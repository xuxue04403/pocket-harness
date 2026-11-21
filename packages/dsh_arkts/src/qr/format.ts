// Format and version information, and the eight data masks.
//
// Both format copies are read and compared: a code photographed at an angle
// often has one corner clipped, and the second copy is exactly for that.

import { QR_FORMAT_EC_BITS } from './types';

/** Error correction level as it appears in the two-bit format field. */
export const FORMAT_LEVELS: readonly string[] = ['M', 'L', 'H', 'Q'];

const FORMAT_MASK = 0x5412;
const FORMAT_BITS = 15;
const FORMAT_DATA_BITS = 5;

/** BCH(15,5) remainder used by the format field. */
function formatRemainder(data: number): number {
  let value = data << (FORMAT_BITS - FORMAT_DATA_BITS);
  for (let bit = FORMAT_BITS - 1; bit >= FORMAT_DATA_BITS; bit -= 1) {
    if ((value & (1 << bit)) !== 0) value ^= 0x537 << (bit - (FORMAT_BITS - FORMAT_DATA_BITS));
  }
  return value & ((1 << (FORMAT_BITS - FORMAT_DATA_BITS)) - 1);
}

/** The fifteen stored bits for a level and mask, mask pattern already applied. */
export function formatBits(level: string, mask: number): number {
  const levelBits = QR_FORMAT_EC_BITS[level];
  if (levelBits === undefined) throw new Error(`unknown error correction level ${level}`);
  if (mask < 0 || mask > 7) throw new Error(`mask ${mask} is outside 0..7`);
  const data = (levelBits << 3) | mask;
  return ((data << (FORMAT_BITS - FORMAT_DATA_BITS)) | formatRemainder(data)) ^ FORMAT_MASK;
}

/** A decoded format field. */
export interface FormatInfo {
  readonly level: string;
  readonly mask: number;
}

// A flat table rather than a Map: ArkTS allows Map, but iterating one with
// `for...of` over destructured pairs is not portable across the two runtimes
// this file has to serve (Node for the vectors, ArkTS on the phone). Two
// parallel arrays keep the lookup a plain index walk.
const FORMAT_CODES: number[] = [];
const FORMAT_INFOS: FormatInfo[] = [];
for (const level of ['L', 'M', 'Q', 'H']) {
  for (let mask = 0; mask < 8; mask += 1) {
    FORMAT_CODES.push(formatBits(level, mask));
    FORMAT_INFOS.push({ level, mask });
  }
}

/**
 * The first format copy, one entry per bit, least significant bit first.
 *
 * This copy runs up column eight: six bits beside the top-left finder, one in
 * the gap below it, then the last seven up the edge of the bottom-left finder.
 *
 * The order is bit zero first because that is how the field is written; reading
 * it most-significant-first yields a different but still valid-looking codeword,
 * which is why the mistake survives a quick eyeball check.
 */
export function formatPositionsOne(size: number): number[][] {
  const out: number[][] = [];
  for (let row = 0; row <= 5; row += 1) out.push([row, 8]);
  out.push([7, 8]);
  out.push([8, 8]);
  for (let row = size - 7; row <= size - 1; row += 1) out.push([row, 8]);
  return out;
}

/**
 * The second format copy, one entry per bit, least significant bit first.
 *
 * This copy runs along row eight: eight bits beside the top-right finder, one
 * in the gap, then six in the top-left corner.
 */
export function formatPositionsTwo(size: number): number[][] {
  const out: number[][] = [];
  for (let col = size - 1; col >= size - 8; col -= 1) out.push([8, col]);
  out.push([8, 7]);
  for (let col = 5; col >= 0; col -= 1) out.push([8, col]);
  return out;
}

/**
 * Read the format field from a matrix.
 *
 * `at(row, col)` returns true for a dark module. Four readings are tried — both
 * copies, each interpreted bit-zero-first and bit-fourteen-first — and the one
 * closest to a valid codeword wins. Trying both orders is deliberate: the two
 * are only fifteen modules apart in the image, so a single transcription slip in
 * the position tables would otherwise decode to a plausible wrong level and mask
 * and send every following codeword through the wrong Reed-Solomon layout.
 *
 * BCH(15,5) corrects three bits, so anything further away is rejected rather
 * than guessed.
 */
export function readFormat(at: (row: number, col: number) => boolean, size: number): FormatInfo | null {
  const copies = [formatPositionsOne(size), formatPositionsTwo(size)];
  let best: FormatInfo | null = null;
  let bestDistance = FORMAT_BITS + 1;
  for (const positions of copies) {
    let forward = 0;
    let backward = 0;
    for (let index = 0; index < positions.length; index += 1) {
      const [row, col] = positions[index];
      if (!at(row, col)) continue;
      forward = (forward << 1) | 1;
      backward |= 1 << index;
    }
    for (const raw of [forward, backward]) {
      for (let entry = 0; entry < FORMAT_CODES.length; entry += 1) {
        let distance = 0;
        let difference = FORMAT_CODES[entry] ^ raw;
        while (difference !== 0) {
          difference &= difference - 1;
          distance += 1;
        }
        if (distance < bestDistance) {
          bestDistance = distance;
          best = FORMAT_INFOS[entry];
        }
      }
    }
  }
  return bestDistance <= 3 ? best : null;
}

/** The eighteen version bits for versions seven and up. */
export function versionBits(version: number): number {
  let value = version << 12;
  for (let bit = 17; bit >= 12; bit -= 1) {
    if ((value & (1 << bit)) !== 0) value ^= 0x1f25 << (bit - 12);
  }
  return ((version << 12) | (value & 0xfff)) >>> 0;
}

/** Version from a raw eighteen-bit field, or null when it is not a codeword. */
export function readVersionBits(raw: number): number | null {
  for (let version = 7; version <= 40; version += 1) {
    if (versionBits(version) === raw) return version;
  }
  return null;
}

/** True where the mask inverts a module. */
export function maskBit(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      throw new Error(`mask ${mask} is outside 0..7`);
  }
}
