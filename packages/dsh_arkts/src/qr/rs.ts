// Reed-Solomon decoding over GF(256).
//
// The encoder is included as well: the decoder's own tests generate codewords
// with it and then corrupt them, which is the only way to exercise the
// corrector without shipping a second implementation of the same mistake.

import { divide, derivative, evaluate, multiply, powerOfAlpha, zeroes } from './gf256';

/** Error thrown when a codeword cannot be corrected. */
export class ReedSolomonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReedSolomonError';
  }
}

/**
 * The generator polynomial for `ecCount` parity bytes.
 *
 * Index 0 is the constant term, so the leading coefficient sits last.
 */
export function generatorPolynomial(ecCount: number): number[] {
  let poly: number[] = [1];
  for (let index = 0; index < ecCount; index += 1) {
    const next = zeroes(poly.length + 1);
    const root = powerOfAlpha(index);
    for (let term = 0; term < poly.length; term += 1) {
      next[term] ^= multiply(poly[term], root);
      next[term + 1] ^= poly[term];
    }
    poly = next;
  }
  return poly;
}

/** Append `ecCount` parity bytes to `data`, newest data byte first. */
export function encodeBlock(data: readonly number[], ecCount: number): number[] {
  const generator = generatorPolynomial(ecCount);
  const remainder = zeroes(ecCount);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    for (let index = 0; index < ecCount - 1; index += 1) {
      remainder[index] = remainder[index + 1] ^ multiply(generator[ecCount - 1 - index], factor);
    }
    remainder[ecCount - 1] = multiply(generator[0], factor);
  }
  return remainder;
}

/** Syndromes of a full codeword (data followed by parity). */
export function syndromes(codeword: readonly number[], ecCount: number): number[] {
  const out = zeroes(ecCount);
  for (let index = 0; index < ecCount; index += 1) {
    const at = powerOfAlpha(index);
    let accumulator = 0;
    for (const byte of codeword) accumulator = multiply(accumulator, at) ^ byte;
    out[index] = accumulator;
  }
  return out;
}

/**
 * Correct a codeword in place.
 *
 * Returns the number of bytes that were changed. Throws when the errors are
 * beyond what `ecCount` can repair, because returning a silently wrong message
 * is worse than failing: it would become a pairing code nobody can use.
 */
export function correct(codeword: number[], ecCount: number): number {
  const found = syndromes(codeword, ecCount);
  if (found.every((value) => value === 0)) return 0;

  // Berlekamp-Massey: find the error locator polynomial.
  let locator: number[] = [1];
  let previous: number[] = [1];
  let degree = 0;
  let shift = 1;
  let lastDiscrepancy = 1;

  for (let step = 0; step < ecCount; step += 1) {
    let discrepancy = found[step];
    for (let term = 1; term <= degree; term += 1) {
      const coefficient = term < locator.length ? locator[term] : 0;
      discrepancy ^= multiply(coefficient, found[step - term]);
    }
    if (discrepancy === 0) {
      shift += 1;
      continue;
    }
    const saved = locator.slice();
    const factor = divide(discrepancy, lastDiscrepancy);
    while (locator.length < previous.length + shift) locator.push(0);
    for (let index = 0; index < previous.length; index += 1) {
      locator[index + shift] ^= multiply(factor, previous[index]);
    }
    if (2 * degree <= step) {
      degree = step + 1 - degree;
      previous = saved;
      lastDiscrepancy = discrepancy;
      shift = 1;
    } else {
      shift += 1;
    }
  }

  if (degree === 0 || degree > ecCount / 2) {
    throw new ReedSolomonError(`too many errors: the locator has degree ${degree}`);
  }

  // Chien search: the roots name the damaged positions.
  const length = codeword.length;
  const positions: number[] = [];
  for (let index = 0; index < length; index += 1) {
    // Position `index` sits at exponent length-1-index, so its inverse is what
    // the locator is evaluated at.
    const at = powerOfAlpha(-(length - 1 - index));
    if (evaluate(locator, at) === 0) positions.push(index);
  }
  if (positions.length !== degree) {
    throw new ReedSolomonError(`the locator names ${positions.length} positions but has degree ${degree}`);
  }

  // Forney: the error evaluator is the syndrome series reduced by the locator.
  const evaluatorLength = Math.max(ecCount, locator.length);
  const evaluator = zeroes(evaluatorLength);
  for (let index = 0; index < ecCount; index += 1) {
    let total = 0;
    for (let term = 0; term <= index && term < locator.length; term += 1) {
      total ^= multiply(locator[term], found[index - term]);
    }
    evaluator[index] = total;
  }
  const slope = derivative(locator);

  for (const position of positions) {
    const exponent = length - 1 - position;
    const at = powerOfAlpha(-exponent);
    const numerator = evaluate(evaluator, at);
    const denominator = evaluate(slope, at);
    if (denominator === 0) throw new ReedSolomonError('the locator has a repeated root');
    // The sign of the correction depends on where the byte sits: QR codewords
    // start at alpha^0, so the first byte carries the smallest exponent.
    const magnitude = divide(multiply(numerator, powerOfAlpha(exponent)), denominator);
    codeword[position] ^= magnitude;
  }

  const after = syndromes(codeword, ecCount);
  if (!after.every((value) => value === 0)) {
    throw new ReedSolomonError('the correction left non-zero syndromes');
  }
  return positions.length;
}
