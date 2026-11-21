// Shared QR constants: error correction levels, alignment patterns, and the
// mapping from a version to its block layout.

import { EC_BLOCKS, EC_TOTAL, TOTAL_CODEWORDS } from './tables';

/** The two-bit encoding of each error correction level in the format field. */
export const QR_FORMAT_EC_BITS: Record<string, number> = { L: 1, M: 0, Q: 3, H: 2 };

/**
 * The four levels in increasing strength. The tables store them in this order,
 * so `index` below is not the format bit pattern: the format field uses its own
 * two-bit code and mixing the two up silently swaps Q and H.
 */
export const EC_LEVELS: readonly string[] = ['L', 'M', 'Q', 'H'];

/** Centre coordinates of the alignment patterns for a version, ascending. */
export function alignmentCentres(version: number): number[] {
  if (version < 2) return [];
  const size = sideWidth(version);
  const count = Math.floor(version / 7) + 2;
  // Version 32 is the one case where the even spacing rule does not fit.
  const step = version === 32 ? 26 : Math.ceil((size - 13) / (count * 2 - 2)) * 2;
  const out: number[] = [6];
  for (let position = size - 7; out.length < count; position -= step) out.splice(1, 0, position);
  return out;
}

/** Internal alias so the constant can be named below without a cycle. */
function sideWidth(version: number): number {
  return 17 + version * 4;
}

/** One Reed-Solomon block: how many data bytes it holds. */
export interface BlockLayout {
  readonly version: number;
  readonly level: string;
  readonly ecPerBlock: number;
  /** Data bytes in each short block. */
  readonly shortLength: number;
  /** How many blocks carry one extra data byte. */
  readonly longBlocks: number;
  /** Total number of blocks. */
  readonly blocks: number;
}

const LAYOUT_CACHE: BlockLayout[][] = (() => {
  const out: BlockLayout[][] = [];
  for (let version = 1; version <= 40; version += 1) {
    const row: BlockLayout[] = [];
    for (let levelIndex = 0; levelIndex < 4; levelIndex += 1) {
      const slot = (version - 1) * 4 + levelIndex;
      const blocks = EC_BLOCKS[slot];
      const ecTotal = EC_TOTAL[slot];
      const ecPerBlock = ecTotal / blocks;
      const total = TOTAL_CODEWORDS[version - 1];
      const dataBytes = total - ecTotal;
      const shortLength = Math.floor(dataBytes / blocks);
      const longBlocks = dataBytes - shortLength * blocks;
      row.push({ version, level: EC_LEVELS[levelIndex], ecPerBlock, shortLength, longBlocks, blocks });
    }
    out.push(row);
  }
  return out;
})();

/** The block layout for a version and level. */
export function layoutFor(version: number, level: string): BlockLayout {
  if (version < 1 || version > 40) throw new Error(`version ${version} is outside 1..40`);
  const levelIndex = EC_LEVELS.indexOf(level);
  if (levelIndex < 0) throw new Error(`unknown error correction level ${level}`);
  return LAYOUT_CACHE[version - 1][levelIndex];
}

/** Data codewords the version holds at a level. */
export function dataCodewords(version: number, level: string): number {
  const layout = layoutFor(version, level);
  return layout.shortLength * layout.blocks + layout.longBlocks;
}

/** Matrix side length, in modules, for a version. */
export function sideLength(version: number): number {
  return 17 + version * 4;
}
