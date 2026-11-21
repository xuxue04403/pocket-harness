// Noise IK responder, implemented on top of node:crypto only.
//
// The suite is Noise_IK_25519_ChaChaPoly_SHA256 with the mobile client as
// initiator and this Host as responder. Writing it out by hand (instead of
// pulling a dependency) keeps the plugin installable with zero runtime
// dependencies, which matters because it is installed into the user's profile
// and must not drag a tree of packages along.
//
// The byte layout below is pinned by fixtures/crypto/v1/noise-ik.json in the
// reference repository; `probe/node_noise_vector.mjs` replays that fixture
// against this file, so any deviation fails a test rather than silently
// producing a channel the phone cannot open.

import { createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, randomBytes } from 'node:crypto'

import { TAG_BYTES, open as chachaOpen, seal as chachaSeal } from './chacha20_poly1305.js'

export const NOISE_PROTOCOL = 'Noise_IK_25519_ChaChaPoly_SHA256'

const KEY_BYTES = 32
const ZERO = Buffer.alloc(0)

/** Wraps a raw 32-byte X25519 private key in the fixed PKCS#8 envelope. */
function privateKeyObject(raw) {
  if (raw.length !== KEY_BYTES) throw new Error('an X25519 private key must be 32 bytes')
  const der = Buffer.concat([
    Buffer.from('302e020100300506032b656e04220420', 'hex'),
    Buffer.from(raw),
  ])
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
}

/** Wraps a raw 32-byte X25519 public key in the fixed SPKI envelope. */
function publicKeyObject(raw) {
  if (raw.length !== KEY_BYTES) throw new Error('an X25519 public key must be 32 bytes')
  const der = Buffer.concat([
    Buffer.from('302a300506032b656e032100', 'hex'),
    Buffer.from(raw),
  ])
  return createPublicKey({ key: der, format: 'der', type: 'spki' })
}

export function x25519PrivateToPublic(raw) {
  const der = createPublicKey(privateKeyObject(raw)).export({ format: 'der', type: 'spki' })
  return Buffer.from(der.subarray(der.length - KEY_BYTES))
}

export function x25519(privateKey, publicKey) {
  return Buffer.from(diffieHellman({ privateKey: privateKeyObject(privateKey), publicKey: publicKeyObject(publicKey) }))
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest()
}

export function hmacSha256(key, bytes) {
  return createHmac('sha256', key).update(bytes).digest()
}

/** Seals with ChaCha20-Poly1305, returning ciphertext||tag as a Buffer. */
export function seal(key, nonce, aad, plaintext) {
  return Buffer.from(chachaSeal(key, nonce, aad, plaintext))
}

/** Opens ciphertext||tag, returning null when authentication fails. */
export function open(key, nonce, aad, ciphertext) {
  const plaintext = chachaOpen(key, nonce, aad, ciphertext)
  return plaintext === null ? null : Buffer.from(plaintext)
}

/**
 * The prologue binds a secure channel to one pairing and one connection, so a
 * relay that splices two connections together cannot make the halves agree.
 *
 * Kept byte-identical to the reference implementation so this Host can be
 * paired with clients that speak the same secure channel.
 */
export function createNoisePrologue(connectionId, hostDeviceId, clientDeviceId) {
  for (const [label, value] of [['connectionId', connectionId], ['hostDeviceId', hostDeviceId], ['clientDeviceId', clientDeviceId]]) {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) {
      throw new TypeError(`${label} is not safe for a Noise prologue`)
    }
  }
  return Buffer.from(`DSH-REMOTE\u0000v=1\u0000connection=${connectionId}\u0000host=${hostDeviceId}\u0000client=${clientDeviceId}`, 'utf8')
}

export class NoiseSessionError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'NoiseSessionError'
    this.code = code
  }
}

function nonceBytes(counter) {
  const out = Buffer.alloc(12)
  out.writeUInt32LE(0, 0)
  out.writeUInt32LE(counter >>> 0, 4)
  out.writeUInt32LE(Math.floor(counter / 0x100000000) >>> 0, 8)
  return out
}

/** One responder-side Noise IK handshake plus the transport keys it derives. */
export class NoiseIkResponder {
  constructor({ localPrivateKey, localPublicKey, expectedRemoteStatic = null, prologue, random = randomBytes }) {
    if (localPrivateKey.length !== KEY_BYTES) throw new NoiseSessionError('INVALID_KEY', 'the local private key must be 32 bytes')
    if (localPublicKey.length !== KEY_BYTES) throw new NoiseSessionError('INVALID_KEY', 'the local public key must be 32 bytes')
    this.localPrivateKey = Buffer.from(localPrivateKey)
    this.localPublicKey = Buffer.from(localPublicKey)
    this.expectedRemoteStatic = expectedRemoteStatic === null ? null : Buffer.from(expectedRemoteStatic)
    this.random = random

    this.h = Buffer.alloc(KEY_BYTES)
    this.ck = Buffer.alloc(KEY_BYTES)
    this.key = Buffer.alloc(KEY_BYTES)
    this.nonce = 0
    this.read = 0
    this.written = 0
    this.sendingKey = null
    this.receivingKey = null
    this.sendingCounter = 0
    this.receivingCounter = 0
    this.remoteEphemeral = null
    this.remoteStatic = null
    this.destroyed = false

    this.#initialise(prologue)
  }

  get complete() {
    return this.sendingKey !== null && this.receivingKey !== null
  }

  get canWriteHandshake() {
    return !this.complete && this.read === 1 && this.written === 0
  }

  /**
   * Whether the next handshake frame must go out from here rather than come in.
   *
   * The responder owes message two as soon as message one landed, and only then;
   * deriving the turn from counters (instead of a message index) keeps `complete`
   * from turning true before the responder has actually written.
   */
  get isWriteTurn() {
    return this.read === 1 && this.written === 0
  }

  #initialise(prologue) {
    const name = Buffer.from(NOISE_PROTOCOL, 'utf8')
    this.h = name.length <= KEY_BYTES ? Buffer.concat([name, Buffer.alloc(KEY_BYTES - name.length)]) : sha256(name)
    this.ck = Buffer.from(this.h)
    this.#mixHash(prologue)
    // IK premessage is "<- s": the responder mixes its own static key.
    this.#mixHash(this.localPublicKey)
  }

  #mixHash(bytes) {
    this.h = sha256(Buffer.concat([this.h, bytes]))
  }

  #mixKey(input) {
    const temp = hmacSha256(this.ck, input)
    const out1 = hmacSha256(temp, Buffer.from([0x01]))
    const out2 = hmacSha256(temp, Buffer.concat([out1, Buffer.from([0x02])]))
    this.ck = out1
    this.key = out2
    this.nonce = 0
  }

  #encryptAndHash(plaintext) {
    const ciphertext = seal(this.key, nonceBytes(this.nonce), this.h, plaintext)
    this.nonce += 1
    this.#mixHash(ciphertext)
    return ciphertext
  }

  #decryptAndHash(ciphertext) {
    const plaintext = open(this.key, nonceBytes(this.nonce), this.h, ciphertext)
    if (plaintext === null) {
      throw new NoiseSessionError('NOISE_DECRYPT_FAILED', 'a Noise handshake message failed authentication')
    }
    this.nonce += 1
    this.#mixHash(ciphertext)
    return plaintext
  }

  /** Reads the initiator's message one and returns its payload. */
  readHandshakeMessage(message) {
    if (this.destroyed) throw new NoiseSessionError('NOISE_DESTROYED', 'the Noise session is closed')
    if (this.read !== 0 || this.written !== 0) {
      throw new NoiseSessionError('NOISE_HANDSHAKE_ORDER', 'message one was already handled')
    }
    if (message.length < KEY_BYTES + KEY_BYTES + TAG_BYTES + TAG_BYTES) {
      throw new NoiseSessionError('NOISE_HANDSHAKE_ORDER', 'the Noise handshake message is truncated')
    }
    let offset = 0
    const take = length => {
      const slice = message.subarray(offset, offset + length)
      offset += length
      return slice
    }

    const ephemeral = Buffer.from(take(KEY_BYTES))
    this.remoteEphemeral = ephemeral
    this.#mixHash(ephemeral)
    this.#mixKey(x25519(this.localPrivateKey, ephemeral)) // es
    this.remoteStatic = Buffer.from(this.#decryptAndHash(take(KEY_BYTES + TAG_BYTES))) // s
    this.#mixKey(x25519(this.localPrivateKey, this.remoteStatic)) // ss
    this.#verifyRemoteStatic()

    const payload = this.#decryptAndHash(message.subarray(offset))
    this.read += 1
    return payload
  }

  /** Writes the responder's message two, appending [payload]. */
  writeHandshakeMessage(payload = ZERO) {
    if (this.destroyed) throw new NoiseSessionError('NOISE_DESTROYED', 'the Noise session is closed')
    if (this.read !== 1 || this.written !== 0) {
      throw new NoiseSessionError('NOISE_HANDSHAKE_ORDER', 'the responder writes exactly one message, after reading one')
    }
    const ephemeralPrivate = Buffer.from(this.random(KEY_BYTES))
    const ephemeralPublic = x25519PrivateToPublic(ephemeralPrivate)
    const out = [ephemeralPublic]
    this.#mixHash(ephemeralPublic)
    this.#mixKey(x25519(ephemeralPrivate, this.remoteEphemeral)) // ee
    this.#mixKey(x25519(ephemeralPrivate, this.remoteStatic)) // se
    out.push(this.#encryptAndHash(payload))
    this.written += 1
    this.#split()
    return Buffer.concat(out)
  }

  #split() {
    const temp = hmacSha256(this.ck, ZERO)
    const out1 = hmacSha256(temp, Buffer.from([0x01]))
    const out2 = hmacSha256(temp, Buffer.concat([out1, Buffer.from([0x02])]))
    // The initiator sends on out1, the responder on out2.
    this.sendingKey = out2
    this.receivingKey = out1
    this.sendingCounter = 0
    this.receivingCounter = 0
  }

  #verifyRemoteStatic() {
    if (this.expectedRemoteStatic === null) return
    if (!this.remoteStatic.equals(this.expectedRemoteStatic)) {
      this.destroy()
      throw new NoiseSessionError('PEER_IDENTITY_MISMATCH', 'the Noise peer static key does not match local trust')
    }
  }

  /** Seals one transport message. */
  encrypt(plaintext) {
    if (this.sendingKey === null) throw new NoiseSessionError('NOISE_NOT_READY', 'the Noise handshake is not complete')
    const out = seal(this.sendingKey, nonceBytes(this.sendingCounter), ZERO, plaintext)
    this.sendingCounter += 1
    return out
  }

  /** Opens one transport message. */
  decrypt(ciphertext) {
    if (this.receivingKey === null) throw new NoiseSessionError('NOISE_NOT_READY', 'the Noise handshake is not complete')
    const plaintext = open(this.receivingKey, nonceBytes(this.receivingCounter), ZERO, ciphertext)
    if (plaintext === null) {
      throw new NoiseSessionError('NOISE_DECRYPT_FAILED', 'the Noise transport message failed authentication')
    }
    this.receivingCounter += 1
    return plaintext
  }

  destroy() {
    this.destroyed = true
    this.sendingKey = null
    this.receivingKey = null
    this.remoteStatic = null
    this.remoteEphemeral = null
  }
}
