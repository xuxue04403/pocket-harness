// Identifier helpers shared by the Host plugin.
//
// Device ids and frame ids must be UUIDv7 or ULID: the server-side contract (and
// the pairing ticket carried by the QR code) rejects anything else, and the two
// ends must agree on the shape before a byte crosses the wire.

import { randomBytes } from 'node:crypto'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Formats 16 random bytes as a 26-character Crockford base32 ULID. */
function ulid() {
  const bytes = randomBytes(16)
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  let out = ''
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(value & 31n)] + out
    value >>= 5n
  }
  return out
}

/**
 * Returns a UUIDv7 for the given instant.
 *
 * Layout: 48-bit big-endian milliseconds, version 7, the 12-bit rand_a, variant
 * 0b10, then 62 random bits. Monotonicity inside one millisecond is not
 * required here — the ids identify devices and frames, they do not sort a log.
 */
export function uuidV7(now = Date.now()) {
  const bytes = randomBytes(16)
  let time = BigInt(Math.floor(now))
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(time & 0xffn)
    time >>= 8n
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Buffer.from(bytes).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/

/** Reports whether [value] is a canonical UUIDv7 or a Crockford-base32 ULID. */
export function isDeviceId(value) {
  return typeof value === 'string' && (UUID_V7.test(value) || ULID.test(value))
}

/** New device id in the shape the protocol requires. */
export function newDeviceId() {
  return uuidV7()
}

/** New short frame/message id; ULID keeps it lexically sortable by creation. */
export function newMessageId() {
  return ulid()
}
