// ChaCha20-Poly1305 (RFC 8439) in plain JavaScript.
//
// The Host plugin runs inside the Harness Electron process, whose bundled
// BoringSSL exposes only 28 ciphers — `crypto.getCiphers()` there lists AES and
// the legacy DES/RC4 family but no `chacha20-poly1305`, so `node:crypto` cannot
// provide the AEAD the Noise suite requires. Implementing it here keeps the
// plugin dependency-free and byte-identical to the phone's Dart implementation.
//
// Only the operations Noise needs are exposed: seal (ciphertext||tag) and open.

const BLOCK_BYTES = 64
export const TAG_BYTES = 16
export const KEY_BYTES = 32

const SIGMA = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574])

function readUint32LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
}

function writeUint32LE(out, offset, value) {
  out[offset] = value & 0xff
  out[offset + 1] = (value >>> 8) & 0xff
  out[offset + 2] = (value >>> 16) & 0xff
  out[offset + 3] = (value >>> 24) & 0xff
}

function quarterRound(state, a, b, c, d) {
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

/** Writes one 64-byte keystream block for [counter] into [out]. */
function chacha20Block(key, nonce, counter, out) {
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

/** XORs [input] with the ChaCha20 keystream starting at [counter]. */
export function chacha20Xor(key, nonce, counter, input) {
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

function readBigIntLE(bytes) {
  let value = 0n
  for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i])
  return value
}

function writeBigIntLE(value, length) {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    out[i] = Number(value & 0xffn)
    value >>= 8n
  }
  return out
}

/** Computes the Poly1305 tag of [message] under the one-time [key]. */
export function poly1305(key, message) {
  const r = readBigIntLE(key.subarray(0, 16)) & CLAMP
  const s = readBigIntLE(key.subarray(16, 32))
  let acc = 0n
  for (let offset = 0; offset < message.length; offset += 16) {
    const chunk = message.subarray(offset, Math.min(offset + 16, message.length))
    // Every block carries a trailing 1 byte beyond its 128-bit value.
    const block = readBigIntLE(chunk) + (1n << BigInt(chunk.length * 8))
    acc = ((acc + block) * r) % P1305
  }
  return writeBigIntLE((acc + s) % (1n << 128n), TAG_BYTES)
}

function pad16(length) {
  const remainder = length % 16
  return remainder === 0 ? 0 : 16 - remainder
}

/** Builds the RFC 8439 Poly1305 input: aad, padding, ciphertext, padding, lengths. */
function aeadMacInput(aad, ciphertext) {
  const total = aad.length + pad16(aad.length) + ciphertext.length + pad16(ciphertext.length) + 16
  const out = new Uint8Array(total)
  let offset = 0
  out.set(aad, offset)
  offset += aad.length + pad16(aad.length)
  out.set(ciphertext, offset)
  offset += ciphertext.length + pad16(ciphertext.length)
  const lengths = new Uint8Array(16)
  // RFC 8439 §2.8.1 encodes both lengths in BYTES, unlike AES-GCM's bit counts:
  // the §2.8.2 vector carries 12 and 114 as 0c / 72.
  lengths.set(writeBigIntLE(BigInt(aad.length), 8), 0)
  lengths.set(writeBigIntLE(BigInt(ciphertext.length), 8), 8)
  out.set(lengths, offset)
  return out
}

function oneTimeKey(key, nonce) {
  return chacha20Xor(key, nonce, 0, new Uint8Array(32))
}

/** Seals [plaintext], returning ciphertext||tag. */
export function seal(key, nonce, aad, plaintext) {
  const ciphertext = chacha20Xor(key, nonce, 1, plaintext)
  const tag = poly1305(oneTimeKey(key, nonce), aeadMacInput(aad, ciphertext))
  const out = new Uint8Array(ciphertext.length + TAG_BYTES)
  out.set(ciphertext, 0)
  out.set(tag, ciphertext.length)
  return out
}

/** Opens ciphertext||tag, returning null when authentication fails. */
export function open(key, nonce, aad, sealed) {
  if (sealed.length < TAG_BYTES) return null
  const ciphertext = sealed.subarray(0, sealed.length - TAG_BYTES)
  const tag = sealed.subarray(sealed.length - TAG_BYTES)
  const expected = poly1305(oneTimeKey(key, nonce), aeadMacInput(aad, ciphertext))
  let diff = 0
  for (let i = 0; i < TAG_BYTES; i++) diff |= expected[i] ^ tag[i]
  if (diff !== 0) return null
  return chacha20Xor(key, nonce, 1, ciphertext)
}
