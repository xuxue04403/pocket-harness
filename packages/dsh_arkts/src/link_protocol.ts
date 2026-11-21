// Host 侧的握手逻辑（responder 视角），用于 Node 里的端到端验证。
//
// 真正跑在手机上的 ArkTS 版本只需要这个文件的对称部分（initiator），但两端共用
// 同一套 hello / prologue / 分片逻辑，所以先在这里把两端都写出来，让测试能
// 在一个进程里跑通一整个握手。

import { NOISE_PROTOCOL, NoiseIkSession } from './noise'
import { hmacSha256, sha256 } from './sha256'
import { decodeBase64Url, encodeBase64Url, utf8 } from './bytes'
import type { FrameTransport } from './secure_channel'

/** 明文 hello 的版本号，与 `host/link.js` 一致。 */
export const LINK_HELLO_VERSION = 1

/** 配对证明：`HMAC-SHA256(secret, "v1\0<connectionId>\0<clientDeviceId>")`。 */
export function pairingProof(secret: string, connectionId: string, clientDeviceId: string): Uint8Array {
  return hmacSha256(utf8(secret), utf8(`v1\u0000${connectionId}\u0000${clientDeviceId}`))
}

export interface HelloMessage {
  readonly v: number
  readonly connection: string
  readonly client: string
  readonly proof?: string
}

export function encodeHello(message: HelloMessage): Uint8Array {
  return utf8(JSON.stringify(message))
}

export function decodeHello(bytes: Uint8Array): HelloMessage {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new Error('the hello frame is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the hello frame is not a JSON object')
  }
  const map = parsed as Record<string, unknown>
  if (map.v !== LINK_HELLO_VERSION) throw new Error(`unsupported hello version ${String(map.v)}`)
  const connection = map.connection
  const client = map.client
  if (typeof connection !== 'string' || connection.length === 0) throw new Error('the hello frame has no connection id')
  if (typeof client !== 'string' || client.length === 0) throw new Error('the hello frame has no client id')
  const proof = map.proof
  return { v: LINK_HELLO_VERSION, connection, client, ...(typeof proof === 'string' ? { proof } : {}) }
}

/** 校验客户端给出的 proof，常量时间比较。 */
export function verifyHelloProof(hello: HelloMessage, secret: string): boolean {
  if (hello.proof === undefined) return false
  let provided: Uint8Array
  try {
    provided = decodeBase64Url(hello.proof)
  } catch {
    return false
  }
  const expected = pairingProof(secret, hello.connection, hello.client)
  if (provided.length !== expected.length) return false
  let different = 0
  for (let i = 0; i < expected.length; i++) different |= expected[i] ^ provided[i]
  return different === 0
}

/** 供日志与排障用的协议名。 */
export const LINK_PROTOCOL = NOISE_PROTOCOL

/** 计算一段字节的短指纹，便于在日志里比对而不用打印全文。 */
export function shortFingerprint(bytes: Uint8Array): string {
  const digest = sha256(bytes)
  return Array.from(digest.slice(0, 6))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/** 把 proof 编码成线上形态。 */
export function encodeProof(secret: string, connectionId: string, clientDeviceId: string): string {
  return encodeBase64Url(pairingProof(secret, connectionId, clientDeviceId))
}
