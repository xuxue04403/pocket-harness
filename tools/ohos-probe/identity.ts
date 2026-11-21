// 设备身份与 id 生成。
//
// 与 Dart 侧 `pairing.dart` 的 `newDeviceId`/`isUuidV7OrUlid` 同构：UUIDv7 形状，
// 时间前缀保证可排序，随机尾保证不可猜。中继对形状不合的 id 直接 4008 关闭，
// 所以形状是协议的一部分，不是风格问题。

import { encodeBase64Url, decodeBase64Url } from './bytes'
import { x25519PublicKey } from './curve25519'
import type { DeviceIdentity } from './pairing'

/** 32 字节密码学随机数。调用方必须提供，`dsh_arkts` 不绑定任何平台的 RNG。 */
export type RandomSource = (length: number) => Uint8Array

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * 生成一个 UUIDv7 形状的设备 id。
 *
 * 前 6 字节是毫秒时间戳，第 7 字节高 4 位固定为 7，第 9 字节高 2 位是 variant。
 */
export function newDeviceId(random: RandomSource, now = Date.now()): string {
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 6; i++) bytes[i] = Math.floor(now / 2 ** (40 - 8 * i)) & 0xff
  bytes.set(random(10), 6)
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const text = hex(bytes)
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`
}

const UUID_V7 = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/

export function isUuidV7OrUlid(value: string): boolean {
  if (value.length === 26) return ULID.test(value)
  if (value.length !== 36) return false
  return UUID_V7.test(value)
}

/** 生成一个新的设备身份。 */
export function newDeviceIdentity(random: RandomSource): DeviceIdentity {
  const privateKey = random(32)
  return {
    deviceId: newDeviceId(random),
    privateKey,
    publicKey: x25519PublicKey(privateKey),
  }
}

/** 从已有私钥恢复身份（手机上私钥存在 keystore 里）。 */
export function identityFromPrivateKey(deviceId: string, privateKey: Uint8Array): DeviceIdentity {
  if (deviceId.length === 0) throw new Error('a device id must not be empty')
  if (privateKey.length !== 32) throw new Error('an X25519 private key must be 32 bytes')
  return { deviceId, privateKey, publicKey: x25519PublicKey(privateKey) }
}

/** 身份的序列化形态（与 Dart `HostStore` 存的两个键一致）。 */
export function encodeIdentityPrivateKey(identity: DeviceIdentity): string {
  return encodeBase64Url(identity.privateKey)
}

export function decodeIdentityPrivateKey(text: string): Uint8Array {
  const bytes = decodeBase64Url(text)
  if (bytes.length !== 32) throw new Error('a stored private key must be 32 bytes')
  return bytes
}
