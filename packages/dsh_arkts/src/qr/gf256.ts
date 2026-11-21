// Arithmetic in GF(256) with the QR field polynomial 0x11d.
//
// Everything the decoder needs about Reed-Solomon lives here: the log and
// antilog tables, multiplication, and polynomial helpers. Keeping it in one
// file means the table construction happens once, at import time, and the
// rest of the decoder can stay readable.

const PRIMITIVE = 0x11d;
const FIELD_SIZE = 256;

const EXP: Uint8Array = new Uint8Array(512);
const LOG: Uint8Array = new Uint8Array(FIELD_SIZE);

let value = 1;
for (let index = 0; index < 255; index += 1) {
  EXP[index] = value;
  LOG[value] = index;
  value <<= 1;
  if ((value & 0x100) !== 0) value ^= PRIMITIVE;
}
for (let index = 255; index < 512; index += 1) EXP[index] = EXP[index - 255];

/** Error thrown when a caller asks for something the field cannot express. */
export class GfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GfError';
  }
}

/** Multiply two field elements. */
export function multiply(left: number, right: number): number {
  if (left === 0 || right === 0) return 0;
  return EXP[LOG[left] + LOG[right]];
}

/** Divide two field elements. */
export function divide(left: number, right: number): number {
  if (right === 0) throw new GfError('cannot divide by zero in GF(256)');
  if (left === 0) return 0;
  return EXP[(LOG[left] + 255 - LOG[right]) % 255];
}

/** The field element for alpha raised to a power, wrapping at 255. */
export function powerOfAlpha(exponent: number): number {
  const wrapped = ((exponent % 255) + 255) % 255;
  return EXP[wrapped];
}

/** The multiplicative inverse of a non-zero element. */
export function inverse(element: number): number {
  if (element === 0) throw new GfError('zero has no inverse');
  return EXP[255 - LOG[element]];
}

/** Evaluate a polynomial whose index 0 is the constant term. */
export function evaluate(poly: readonly number[], at: number): number {
  let result = 0;
  for (let index = poly.length - 1; index >= 0; index -= 1) {
    result = multiply(result, at) ^ poly[index];
  }
  return result;
}

/** A zeroed array of the requested length. */
export function zeroes(length: number): number[] {
  const out: number[] = [];
  for (let index = 0; index < length; index += 1) out.push(0);
  return out;
}

/** Multiply two polynomials whose index 0 is the constant term. */
export function multiplyPoly(left: readonly number[], right: readonly number[]): number[] {
  const out = zeroes(left.length + right.length - 1);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    if (left[leftIndex] === 0) continue;
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      if (right[rightIndex] === 0) continue;
      out[leftIndex + rightIndex] ^= multiply(left[leftIndex], right[rightIndex]);
    }
  }
  return out;
}

/** Formal derivative, used by the Forney step. */
export function derivative(poly: readonly number[]): number[] {
  const out = zeroes(Math.max(1, poly.length - 1));
  for (let index = 1; index < poly.length; index += 1) {
    // A coefficient in an even position drops out: x is char 2, so 2a = 0.
    out[index - 1] = index % 2 === 0 ? 0 : poly[index];
  }
  return out;
}
