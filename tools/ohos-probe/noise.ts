// Noise IK 双角色实现，纯 TypeScript。
//
// 与 Dart 侧的 `NoiseIkSession` 逐字节同构：同一套 prologue、同一套计数器状态机、
// 同一套 split 顺序。手机（initiator）与 Host（responder）共用这个类，只是
// `role` 不同 —— 让两端跑同一份代码，是这套协议能被金标向量钉住的前提。

import { concat, equalBytes, nonceBytes, utf8 } from './bytes'
import { open as aeadOpen, seal as aeadSeal, TAG_BYTES } from './chacha20_poly1305'
import { x25519, x25519PublicKey } from './curve25519'
import { hmacSha256, sha256 } from './sha256'

/** 这个协议版本唯一协商的密码套件。 */
export const NOISE_PROTOCOL = 'Noise_IK_25519_ChaChaPoly_SHA256'

const KEY_BYTES = 32
const ZERO = new Uint8Array(0)

// 用字符串字面量而不是 enum：ArkTS 的 enum 与 TS 的 const enum 语义不完全一致，
// 而这三端只需要一个能比较的标识。
export type NoiseRole = 'initiator' | 'responder'

export class NoiseSessionError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'NoiseSessionError'
    this.code = code
  }
}

/**
 * 构造把一条安全通道绑定到某一次配对、某一次连接的 prologue。
 *
 * 两端必须推出逐字节相同的 prologue，否则第一次 mix 就分叉，握手必然失败 ——
 * 这正是中继无法把两条连接拼接起来的原因。
 */
export function createNoisePrologue(connectionId: string, hostDeviceId: string, clientDeviceId: string): Uint8Array {
  const parts: readonly (readonly [string, string])[] = [
    ['connectionId', connectionId],
    ['hostDeviceId', hostDeviceId],
    ['clientDeviceId', clientDeviceId],
  ]
  for (const [label, value] of parts) {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) {
      throw new TypeError(`${label} is not safe for a Noise prologue`)
    }
  }
  return utf8(
    `DSH-REMOTE\u0000v=1\u0000connection=${connectionId}\u0000host=${hostDeviceId}\u0000client=${clientDeviceId}`,
  )
}

function requireKey(key: Uint8Array | null | undefined, label: string): Uint8Array {
  if (key === null || key === undefined || key.length !== KEY_BYTES) {
    throw new NoiseSessionError('INVALID_KEY', `${label} must be a 32-byte X25519 key.`)
  }
  return new Uint8Array(key)
}

/** 一次性把 32 字节随机数写成 32 字节数组。 */
export type RandomBytes = (length: number) => Uint8Array

/** Noise IK 握手状态，以及由它导出的传输密钥。 */
export class NoiseIkSession {
  private readonly role: NoiseRole
  private readonly localPrivate: Uint8Array
  private readonly localPublic: Uint8Array
  private readonly expectedRemoteStatic: Uint8Array
  private readonly random: RandomBytes

  private h = new Uint8Array(KEY_BYTES)
  private ck = new Uint8Array(KEY_BYTES)
  private key = new Uint8Array(KEY_BYTES)
  private nonce = 0

  private sendingKey: Uint8Array | null = null
  private receivingKey: Uint8Array | null = null
  private sendingCounter = 0
  private receivingCounter = 0

  private remoteStatic: Uint8Array | null = null
  private ephemeralPrivate: Uint8Array | null = null
  private remoteEphemeral: Uint8Array | null = null

  private writes = 0
  private reads = 0
  private destroyed = false

  constructor(options: {
    readonly role: NoiseRole
    readonly localPrivateKey: Uint8Array
    readonly localPublicKey: Uint8Array
    readonly remotePublicKey: Uint8Array
    readonly prologue: Uint8Array
    readonly random: RandomBytes
  }) {
    this.role = options.role
    this.localPrivate = requireKey(options.localPrivateKey, 'local private key')
    this.localPublic = requireKey(options.localPublicKey, 'local public key')
    this.expectedRemoteStatic = requireKey(options.remotePublicKey, 'remote public key')
    this.random = options.random

    this.initSymmetric()
    this.mixHash(options.prologue)
    // IK 的 premessage 是 "<- s"：两端都 mix **responder** 的静态公钥。
    this.mixHash(this.isInitiator ? this.expectedRemoteStatic : this.localPublic)
    if (this.isInitiator) this.remoteStatic = new Uint8Array(this.expectedRemoteStatic)
  }

  get isInitiator(): boolean {
    return this.role === 'initiator'
  }

  get protocol(): string {
    return NOISE_PROTOCOL
  }

  /** 握手完成、可以收发传输消息。 */
  get complete(): boolean {
    return this.writes > 0 && this.reads > 0
  }

  /** 本端下一步是否该写握手消息。 */
  get isWriteTurn(): boolean {
    if (this.isInitiator) return this.writes === 0
    return this.reads === 1 && this.writes === 0
  }

  get canWriteHandshake(): boolean {
    this.assertLive()
    return !this.complete && this.isWriteTurn
  }

  /** 已学到（responder）或已配置（initiator）的对端静态公钥。 */
  get peerStatic(): Uint8Array | null {
    return this.remoteStatic
  }

  get sentCounter(): number {
    return this.sendingKey === null ? 0 : this.sendingCounter
  }

  get receivedCounter(): number {
    return this.receivingKey === null ? 0 : this.receivingCounter
  }

  /** 写下一帧握手消息，payload 追加在末尾。 */
  writeHandshake(payload: Uint8Array = ZERO): Uint8Array {
    this.assertHandshake(false)
    const parts: Uint8Array[] = []
    if (this.isInitiator) {
      // IK 消息一：e, es, s, ss。
      parts.push(this.writeEphemeral())
      this.mixKey(x25519(this.ephemeralPrivate!, this.expectedRemoteStatic)) // es
      parts.push(this.encryptAndHash(this.localPublic)) // s
      this.mixKey(x25519(this.localPrivate, this.expectedRemoteStatic)) // ss
    } else {
      // IK 消息二：e, ee, se。
      parts.push(this.writeEphemeral())
      this.mixKey(x25519(this.ephemeralPrivate!, this.remoteEphemeral!)) // ee
      this.mixKey(x25519(this.ephemeralPrivate!, this.remoteStatic!)) // se
    }
    // Noise 永远追加 payload 的密文，哪怕 payload 为空：那仍然是对运行中哈希
    // 算出的 16 字节 tag，而对端会无条件认证 token 之后的所有内容。
    parts.push(this.encryptAndHash(payload))
    this.writes += 1
    this.finishIfReady()
    return concat(parts)
  }

  /** 读下一帧握手消息，返回解密后的 payload。 */
  readHandshake(message: Uint8Array): Uint8Array {
    this.assertHandshake(true)
    let offset = 0
    const take = (length: number): Uint8Array => {
      if (offset + length > message.length) {
        throw new NoiseSessionError('NOISE_HANDSHAKE_ORDER', 'The Noise handshake message is truncated.')
      }
      const slice = message.subarray(offset, offset + length)
      offset += length
      return new Uint8Array(slice)
    }

    if (this.isInitiator) {
      // responder 的消息二：e, ee, se。
      const ephemeral = take(KEY_BYTES)
      this.remoteEphemeral = ephemeral
      this.mixHash(ephemeral)
      this.mixKey(x25519(this.ephemeralPrivate!, ephemeral)) // ee
      this.mixKey(x25519(this.localPrivate, ephemeral)) // se
      // se 的发送方是 initiator，所以这里用它自己的私钥（responder 分支则用
      // 自己的私钥配 initiator 的临时公钥）。
    } else {
      // initiator 的消息一：e, es, s, ss。
      const ephemeral = take(KEY_BYTES)
      this.remoteEphemeral = ephemeral
      this.mixHash(ephemeral)
      this.mixKey(x25519(this.localPrivate, ephemeral)) // es
      this.remoteStatic = this.decryptAndHash(take(KEY_BYTES + TAG_BYTES)) // s
      this.mixKey(x25519(this.localPrivate, this.remoteStatic)) // ss
      this.verifyRemoteStatic()
    }
    const payload = this.decryptAndHash(message.subarray(offset))
    this.reads += 1
    this.finishIfReady()
    return payload
  }

  /** 加密一条传输消息。每个方向有独立的计数器。 */
  encrypt(plaintext: Uint8Array): Uint8Array {
    this.assertLive()
    if (this.sendingKey === null) {
      throw new NoiseSessionError('NOISE_NOT_READY', 'The Noise handshake is not complete.')
    }
    const out = aeadSeal(this.sendingKey, nonceBytes(this.sendingCounter), ZERO, plaintext)
    this.sendingCounter += 1
    return out
  }

  /** 解密一条传输消息，认证失败即抛错。 */
  decrypt(ciphertext: Uint8Array): Uint8Array {
    this.assertLive()
    if (this.receivingKey === null) {
      throw new NoiseSessionError('NOISE_NOT_READY', 'The Noise handshake is not complete.')
    }
    const plaintext = aeadOpen(this.receivingKey, nonceBytes(this.receivingCounter), ZERO, ciphertext)
    if (plaintext === null) {
      throw new NoiseSessionError('NOISE_DECRYPT_FAILED', 'The Noise transport message failed authentication.')
    }
    this.receivingCounter += 1
    return plaintext
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.sendingKey = null
    this.receivingKey = null
    this.remoteStatic = null
    this.ephemeralPrivate = null
    this.remoteEphemeral = null
  }

  private initSymmetric(): void {
    const name = utf8(NOISE_PROTOCOL)
    if (name.length <= KEY_BYTES) {
      this.h = new Uint8Array(KEY_BYTES)
      this.h.set(name, 0)
    } else {
      this.h = sha256(name)
    }
    this.ck = new Uint8Array(this.h)
  }

  private mixHash(data: Uint8Array): void {
    this.h = sha256(concat([this.h, data]))
  }

  private mixKey(inputKeyMaterial: Uint8Array): void {
    const tempKey = hmacSha256(this.ck, inputKeyMaterial)
    const out1 = hmacSha256(tempKey, new Uint8Array([0x01]))
    const out2 = hmacSha256(tempKey, concat([out1, new Uint8Array([0x02])]))
    this.ck = out1
    this.key = out2
    this.nonce = 0
  }

  private encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = aeadSeal(this.key, nonceBytes(this.nonce), this.h, plaintext)
    this.nonce += 1
    this.mixHash(ciphertext)
    return ciphertext
  }

  private decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = aeadOpen(this.key, nonceBytes(this.nonce), this.h, ciphertext)
    if (plaintext === null) {
      throw new NoiseSessionError('NOISE_DECRYPT_FAILED', 'A Noise handshake message failed authentication.')
    }
    this.nonce += 1
    this.mixHash(ciphertext)
    return plaintext
  }

  private writeEphemeral(): Uint8Array {
    const privateKey = this.random(KEY_BYTES)
    const publicKey = x25519PublicKey(privateKey)
    this.ephemeralPrivate = privateKey
    this.mixHash(publicKey)
    return publicKey
  }

  private finishIfReady(): void {
    // 双方各写一次、各读一次就算完成；split 密钥只在那一刻导出一次。
    if (this.sendingKey !== null || this.writes === 0 || this.reads === 0) return
    const tempKey = hmacSha256(this.ck, ZERO)
    const out1 = hmacSha256(tempKey, new Uint8Array([0x01]))
    const out2 = hmacSha256(tempKey, concat([out1, new Uint8Array([0x02])]))
    if (this.isInitiator) {
      this.sendingKey = out1
      this.receivingKey = out2
    } else {
      this.sendingKey = out2
      this.receivingKey = out1
    }
    this.sendingCounter = 0
    this.receivingCounter = 0
  }

  private verifyRemoteStatic(): void {
    if (this.remoteStatic === null || !equalBytes(this.remoteStatic, this.expectedRemoteStatic)) {
      this.destroy()
      throw new NoiseSessionError('PEER_IDENTITY_MISMATCH', 'The Noise peer static key does not match local trust.')
    }
  }

  private assertHandshake(reading: boolean): void {
    this.assertLive()
    if (this.complete) {
      throw new NoiseSessionError('NOISE_ALREADY_READY', 'The Noise handshake is already complete.')
    }
    if (this.isWriteTurn === reading) {
      throw new NoiseSessionError('NOISE_HANDSHAKE_ORDER', 'The Noise handshake message arrived out of order.')
    }
  }

  private assertLive(): void {
    if (this.destroyed) throw new NoiseSessionError('NOISE_DESTROYED', 'The Noise session is closed.')
  }
}
