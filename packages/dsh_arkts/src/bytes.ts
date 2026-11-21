// 字节工具：协议核心只依赖 Uint8Array，不碰任何平台 API。
//
// 这一层的存在理由和 Dart 侧那份一样：鸿蒙的 Dart AOT 需要 macOS arm64，
// 所以 App 侧迟早要有一条纯 ArkTS 的实现。把它写成纯函数，就能先在 Node 上
// 跑金标向量，再原样拷进鸿蒙工程。

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let different = 0
  for (let i = 0; i < left.length; i++) different |= left[i] ^ right[i]
  return different === 0
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function utf8(text: string): Uint8Array {
  return textEncoder.encode(text)
}

export function fromUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes)
}

/** base64url 编码，不带填充 —— 配对码与金标向量都用这个口径。 */
export function encodeBase64Url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += BASE64URL[b0 >> 2]
    out += BASE64URL[((b0 & 0x03) << 4) | (b1 >> 4)]
    if (i + 1 < bytes.length) out += BASE64URL[((b1 & 0x0f) << 2) | (b2 >> 6)]
    if (i + 2 < bytes.length) out += BASE64URL[b2 & 0x3f]
  }
  return out
}

export function decodeBase64Url(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let bits = 0
  let accumulator = 0
  let index = 0
  for (let i = 0; i < clean.length; i++) {
    const value = BASE64URL.indexOf(clean[i])
    if (value < 0) throw new Error(`not base64url: character ${clean[i]} at ${i}`)
    accumulator = (accumulator << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[index++] = (accumulator >> bits) & 0xff
    }
  }
  return out.subarray(0, index)
}

/** 定长小端写入，X25519 的字段元素用这个口径。 */
export function writeUint32LE(out: Uint8Array, offset: number, value: number): void {
  out[offset] = value & 0xff
  out[offset + 1] = (value >>> 8) & 0xff
  out[offset + 2] = (value >>> 16) & 0xff
  out[offset + 3] = (value >>> 24) & 0xff
}

/**
 * Noise 的 AEAD 计数器：12 字节，前 4 字节为 0，后 8 字节是 64 位小端。
 *
 * 拆成两个 32 位写入，而不是用 64 位整数，是因为 ArkTS 的 Number 就是双精度，
 * 长时间运行的通道计数会超过 2^53 之前先撞上安全整数的边界。
 */
export function nonceBytes(counter: number): Uint8Array {
  const out = new Uint8Array(12)
  writeUint32LE(out, 0, 0)
  writeUint32LE(out, 4, counter >>> 0)
  writeUint32LE(out, 8, Math.floor(counter / 0x100000000) >>> 0)
  return out
}
