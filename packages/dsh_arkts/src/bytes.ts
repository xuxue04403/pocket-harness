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

// UTF-8 编解码。
//
// ArkTS 里没有 `TextEncoder`/`TextDecoder`（它们不在鸿蒙的 lib 目标里），
// 所以这两段必须自己写。协议只在 prologue、hello 与信封 JSON 上用得到，
// 但用错一个字节就会让握手分叉。

/** 把字符串编成 UTF-8 字节。 */
export function utf8(text: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i)
    // 代理对拼成一个码点；孤立代理按 U+FFFD 处理，避免产生非法 UTF-8。
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
        i++
      } else {
        code = 0xfffd
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd
    }
    if (code < 0x80) {
      out.push(code)
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    }
  }
  return new Uint8Array(out)
}

/** 把 UTF-8 字节解回字符串。非法序列按 U+FFFD 处理。 */
export function fromUtf8(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  const continuation = (offset: number): number => {
    const byte = bytes[offset]
    if (byte === undefined || (byte & 0xc0) !== 0x80) return -1
    return byte & 0x3f
  }
  while (i < bytes.length) {
    const lead = bytes[i]
    if (lead < 0x80) {
      out += String.fromCharCode(lead)
      i += 1
      continue
    }
    if (lead >= 0xc0 && lead <= 0xdf) {
      const b1 = continuation(i + 1)
      if (b1 < 0) {
        out += '\uFFFD'
        i += 1
        continue
      }
      out += String.fromCharCode(((lead & 0x1f) << 6) | b1)
      i += 2
      continue
    }
    if (lead >= 0xe0 && lead <= 0xef) {
      const b1 = continuation(i + 1)
      const b2 = continuation(i + 2)
      if (b1 < 0 || b2 < 0) {
        out += '\uFFFD'
        i += 1
        continue
      }
      const code = ((lead & 0x0f) << 12) | (b1 << 6) | b2
      out += String.fromCharCode(code)
      i += 3
      continue
    }
    if (lead >= 0xf0 && lead <= 0xf4) {
      const b1 = continuation(i + 1)
      const b2 = continuation(i + 2)
      const b3 = continuation(i + 3)
      if (b1 < 0 || b2 < 0 || b3 < 0) {
        out += '\uFFFD'
        i += 1
        continue
      }
      const code = ((lead & 0x07) << 18) | (b1 << 12) | (b2 << 6) | b3
      const shifted = code - 0x10000
      out += String.fromCharCode(0xd800 + (shifted >> 10), 0xdc00 + (shifted & 0x3ff))
      i += 4
      continue
    }
    out += '\uFFFD'
    i += 1
  }
  return out
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

/** 标准 base64 的字母表：`+/` 而不是 `-_`。图片数据块用这个口径。 */
const BASE64_STANDARD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * 标准 base64 编码，**带 `=` 填充**。
 *
 * 图片内容块的 `data` 是标准 base64，不是 base64url：用 base64url 发过去，
 * Host 解出来是错的字节，而报错文本只会说图片读不出来。
 */
export function encodeBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += BASE64_STANDARD[b0 >> 2]
    out += BASE64_STANDARD[((b0 & 0x03) << 4) | (b1 >> 4)]
    out += i + 1 < bytes.length ? BASE64_STANDARD[((b1 & 0x0f) << 2) | (b2 >> 6)] : '='
    out += i + 2 < bytes.length ? BASE64_STANDARD[b2 & 0x3f] : '='
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

/**
 * 标准 base64 解码，带不带 `=` 填充都行。
 *
 * 与 `decodeBase64Url` 分开，是因为两者接受不同的字母表：把 `+/` 当 url 变体
 * 来解会抛「not base64url」，而把 `-_` 当标准 base64 来解会静默错位。图片回来
 * 的 `data` 是标准 base64，所以走这条。
 */
export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let bits = 0
  let accumulator = 0
  let index = 0
  for (let i = 0; i < clean.length; i++) {
    const value = BASE64_STANDARD.indexOf(clean[i])
    if (value < 0) throw new Error(`not base64: character ${clean[i]} at ${i}`)
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
