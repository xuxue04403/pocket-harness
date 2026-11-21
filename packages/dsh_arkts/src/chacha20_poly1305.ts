// ChaCha20-Poly1305 (RFC 8439)，纯 TypeScript 实现。
//
// 三端都不能指望平台的 AEAD：Electron 的 BoringSSL 只暴露 28 个密码学算法、
// 里面没有 chacha20-poly1305；鸿蒙的 crypto framework 同样没有。既然必须
// 自己写，就写一份三端共用。
//
// 只暴露 Noise 用到的两个操作：seal（ciphertext||tag）与 open。

import { writeUint32LE } from './bytes'

const BLOCK_BYTES = 64
export const TAG_BYTES = 16
export const KEY_BYTES = 32

const SIGMA = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574])

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
}

function quarterRound(state: Uint32Array, a: number, b: number, c: number, d: number): void {
  state[a] = (state[a] + state[b]) >>> 0
  state[d] ^= state[a]
  state[d] = ((state[d] << 16) | (state[d] >>> 16)) >>> 0
  state[c] = (state[c] + state[d]) >>> 0
  state[b] ^= state[c]
  state[b] = ((state[b] << 12) | (state[b] >>> 20)) >>> 0
  state[a] = (state[a] + state[b]) >>> 0
  state[d] ^= state[a]
  state[d] = ((state[d] << 8) | (state[d] >>> 24)) >>> 0
  state[c] = (state[c] + state[d]) >>> 0
  state[b] ^= state[c]
  state[b] = ((state[b] << 7) | (state[b] >>> 25)) >>> 0
}

function chacha20Block(key: Uint8Array, nonce: Uint8Array, counter: number, out: Uint8Array): void {
  const state = new Uint32Array(16)
  state[0] = SIGMA[0]
  state[1] = SIGMA[1]
  state[2] = SIGMA[2]
  state[3] = SIGMA[3]
  for (let i = 0; i < 8; i++) state[4 + i] = readUint32LE(key, i * 4)
  state[12] = counter >>> 0
  for (let i = 0; i < 3; i++) state[13 + i] = readUint32LE(nonce, i * 4)

  const working = new Uint32Array(state)
  for (let round = 0; round < 10; round++) {
    quarterRound(working, 0, 4, 8, 12)
    quarterRound(working, 1, 5, 9, 13)
    quarterRound(working, 2, 6, 10, 14)
    quarterRound(working, 3, 7, 11, 15)
    quarterRound(working, 0, 5, 10, 15)
    quarterRound(working, 1, 6, 11, 12)
    quarterRound(working, 2, 7, 8, 13)
    quarterRound(working, 3, 4, 9, 14)
  }
  for (let i = 0; i < 16; i++) writeUint32LE(out, i * 4, (working[i] + state[i]) >>> 0)
}

/** 用 ChaCha20 密钥流异或 [input]，计数器从 [counter] 起。 */
export function chacha20Xor(key: Uint8Array, nonce: Uint8Array, counter: number, input: Uint8Array): Uint8Array {
  const out = new Uint8Array(input.length)
  const block = new Uint8Array(BLOCK_BYTES)
  let offset = 0
  while (offset < input.length) {
    chacha20Block(key, nonce, counter, block)
    counter = (counter + 1) >>> 0
    const take = Math.min(BLOCK_BYTES, input.length - offset)
    for (let i = 0; i < take; i++) out[offset + i] = input[offset + i] ^ block[i]
    offset += take
  }
  return out
}

const P1305 = (1n << 130n) - 5n
const CLAMP = 0x0ffffffc0ffffffc0ffffffc0fffffffn

function readBigIntLE(bytes: Uint8Array): bigint {
  let value = 0n
  for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i])
  return value
}

function writeBigIntLE(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    out[i] = Number(value & 0xffn)
    value >>= 8n
  }
  return out
}

/** 计算 [message] 在一次性密钥 [key] 下的 Poly1305 标签。 */
export function poly1305(key: Uint8Array, message: Uint8Array): Uint8Array {
  const r = readBigIntLE(key.subarray(0, 16)) & CLAMP
  const s = readBigIntLE(key.subarray(16, 32))
  let acc = 0n
  for (let offset = 0; offset < message.length; offset += 16) {
    const chunk = message.subarray(offset, Math.min(offset + 16, message.length))
    // 每个块都要在 128 位数值之外再补一个 1 字节。
    const block = readBigIntLE(chunk) + (1n << BigInt(chunk.length * 8))
    acc = ((acc + block) * r) % P1305
  }
  return writeBigIntLE((acc + s) % (1n << 128n), TAG_BYTES)
}

function pad16(length: number): number {
  const remainder = length % 16
  return remainder === 0 ? 0 : 16 - remainder
}

/** 组装 RFC 8439 的 Poly1305 输入：aad、填充、密文、填充、长度。 */
function aeadMacInput(aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const total = aad.length + pad16(aad.length) + ciphertext.length + pad16(ciphertext.length) + 16
  const out = new Uint8Array(total)
  let offset = 0
  out.set(aad, offset)
  offset += aad.length + pad16(aad.length)
  out.set(ciphertext, offset)
  offset += ciphertext.length + pad16(ciphertext.length)
  const lengths = new Uint8Array(16)
  // RFC 8439 §2.8.1 里两个长度都是**字节数**，不是 AES-GCM 那样的比特数：
  // §2.8.2 的向量把 12 和 114 编成 0c / 72。这个错曾让所有 AAD 非空的 tag 全错。
  lengths.set(writeBigIntLE(BigInt(aad.length), 8), 0)
  lengths.set(writeBigIntLE(BigInt(ciphertext.length), 8), 8)
  out.set(lengths, offset)
  return out
}

function oneTimeKey(key: Uint8Array, nonce: Uint8Array): Uint8Array {
  return chacha20Xor(key, nonce, 0, new Uint8Array(32))
}

/** 封装 [plaintext]，返回 ciphertext||tag。 */
export function seal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const ciphertext = chacha20Xor(key, nonce, 1, plaintext)
  const tag = poly1305(oneTimeKey(key, nonce), aeadMacInput(aad, ciphertext))
  const out = new Uint8Array(ciphertext.length + TAG_BYTES)
  out.set(ciphertext, 0)
  out.set(tag, ciphertext.length)
  return out
}

/** 打开 ciphertext||tag，认证失败返回 null。 */
export function open(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Uint8Array | null {
  if (sealed.length < TAG_BYTES) return null
  const ciphertext = sealed.subarray(0, sealed.length - TAG_BYTES)
  const tag = sealed.subarray(sealed.length - TAG_BYTES)
  const expected = poly1305(oneTimeKey(key, nonce), aeadMacInput(aad, ciphertext))
  let diff = 0
  for (let i = 0; i < TAG_BYTES; i++) diff |= expected[i] ^ tag[i]
  if (diff !== 0) return null
  return chacha20Xor(key, nonce, 1, ciphertext)
}
