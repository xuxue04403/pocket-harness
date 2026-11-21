// RFC 7748 X25519，用 BigInt 做字段运算。
//
// 一次握手只做十几次标量乘法，BigInt 足够快；换成查表实现会把代码放大二十倍，
// 而这段代码要在三端保持一致，可读性比常数因子更重要。

const P = (1n << 255n) - 19n
const A24 = 121665n
const MASK255 = (1n << 255n) - 1n

function leToBigInt(bytes: Uint8Array): bigint {
  let value = 0n
  for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i])
  return value
}

function bigIntToLe(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length)
  let rest = value
  for (let i = 0; i < length; i++) {
    out[i] = Number(rest & 0xffn)
    rest >>= 8n
  }
  return out
}

function mod(value: bigint): bigint {
  const reduced = value % P
  return reduced < 0n ? reduced + P : reduced
}

function modPow(base: bigint, exponent: bigint): bigint {
  let result = 1n
  let b = mod(base)
  let e = exponent
  while (e > 0n) {
    if (e & 1n) result = mod(result * b)
    b = mod(b * b)
    e >>= 1n
  }
  return result
}

/** X25519 基点（u = 9）。 */
export const X25519_BASE_POINT: Uint8Array = (() => {
  const point = new Uint8Array(32)
  point[0] = 9
  return point
})()

/** 由私钥导出公钥。 */
export function x25519PublicKey(privateKey: Uint8Array): Uint8Array {
  return x25519(privateKey, X25519_BASE_POINT)
}

/** X25519 共享密钥。 */
export function x25519(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  if (privateKey.length !== 32) throw new Error('an X25519 private key must be 32 bytes')
  if (publicKey.length !== 32) throw new Error('an X25519 public key must be 32 bytes')

  const scalar = new Uint8Array(privateKey)
  scalar[0] &= 248
  scalar[31] &= 127
  scalar[31] |= 64

  const k = leToBigInt(scalar)
  const u = leToBigInt(publicKey) & MASK255

  let x1 = u
  let x2 = 1n
  let z2 = 0n
  let x3 = u
  let z3 = 1n
  let swap = 0

  for (let t = 254; t >= 0; t--) {
    const bit = Number((k >> BigInt(t)) & 1n)
    swap ^= bit
    if (swap === 1) {
      const tx = x2
      x2 = x3
      x3 = tx
      const tz = z2
      z2 = z3
      z3 = tz
    }
    swap = bit

    const a = mod(x2 + z2)
    const aa = mod(a * a)
    const b = mod(x2 - z2)
    const bb = mod(b * b)
    const e = mod(aa - bb)
    const cc = mod(x3 + z3)
    const d = mod(x3 - z3)
    const da = mod(d * a)
    const cb = mod(cc * b)
    const daPlusCb = mod(da + cb)
    x3 = mod(daPlusCb * daPlusCb)
    const diff = mod(da - cb)
    z3 = mod(x1 * mod(diff * diff))
    x2 = mod(aa * bb)
    z2 = mod(e * mod(aa + A24 * e))
  }

  if (swap === 1) {
    const tx = x2
    x2 = x3
    x3 = tx
    const tz = z2
    z2 = z3
    z3 = tz
  }

  return bigIntToLe(mod(x2 * modPow(z2, P - 2n)), 32)
}
