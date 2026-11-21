// 线上帧、分片与信封。
//
// 与 Dart 侧 `wire/{frame,fragment,envelope}.dart` 逐字节一致：帧是
// `[kind][payload]`，分片头 17 字节 DSHF，信封是 JSON。

import { concat, utf8 } from './bytes'
import { JsonObject, parseJsonBytes } from './json'

/** 帧类型。数据面不走 JSON，只有 control 帧是明文。 */
export const FRAME_KIND = {
  handshake: 0x01,
  secure: 0x02,
  fragment: 0x03,
  control: 0x04,
} as const

export type FrameKind = (typeof FRAME_KIND)[keyof typeof FRAME_KIND]

export interface Frame {
  readonly kind: FrameKind
  readonly payload: Uint8Array
}

export function frame(kind: FrameKind, payload: Uint8Array): Frame {
  return { kind, payload }
}

export function encodeFrame(value: Frame): Uint8Array {
  return concat([new Uint8Array([value.kind]), value.payload])
}

export function decodeFrame(bytes: Uint8Array): Frame {
  if (bytes.length === 0) throw new Error('empty frame')
  const kind = bytes[0]
  if (kind !== 0x01 && kind !== 0x02 && kind !== 0x03 && kind !== 0x04) {
    throw new Error(`unknown frame kind 0x${kind.toString(16)}`)
  }
  return { kind: kind as FrameKind, payload: bytes.subarray(1) }
}

/** 单条 Noise 传输消息能装的最大明文。 */
export const MAX_SEALED_PAYLOAD = 48 * 1024
/** 重组后允许的最大消息。 */
export const MAX_REASSEMBLED_BYTES = 4 * 1024 * 1024
/** 同时重组的消息条数上限。 */
export const MAX_CONCURRENT_REASSEMBLY = 8

const FRAGMENT_HEADER_BYTES = 17
const FRAGMENT_MAGIC = [0x44, 0x53, 0x48, 0x46] // 'DSHF'
const FRAGMENT_VERSION = 1

/** 一条超长密文的一个片段。 */
export interface Fragment {
  readonly messageId: number
  readonly index: number
  readonly total: number
  readonly totalBytes: number
  readonly payload: Uint8Array
}

export function encodeFragment(value: Fragment): Uint8Array {
  const out = new Uint8Array(FRAGMENT_HEADER_BYTES + value.payload.length)
  out.set(FRAGMENT_MAGIC, 0)
  out[4] = FRAGMENT_VERSION
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(5, value.messageId, false)
  view.setUint16(9, value.index, false)
  view.setUint16(11, value.total, false)
  view.setUint32(13, value.totalBytes, false)
  out.set(value.payload, FRAGMENT_HEADER_BYTES)
  return out
}

export function decodeFragment(bytes: Uint8Array): Fragment {
  if (bytes.length < FRAGMENT_HEADER_BYTES) throw new Error('fragment is shorter than its header')
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== FRAGMENT_MAGIC[i]) throw new Error('fragment magic mismatch')
  }
  if (bytes[4] !== FRAGMENT_VERSION) throw new Error(`unsupported fragment version ${bytes[4]}`)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return {
    messageId: view.getUint32(5, false),
    index: view.getUint16(9, false),
    total: view.getUint16(11, false),
    totalBytes: view.getUint32(13, false),
    payload: bytes.subarray(FRAGMENT_HEADER_BYTES),
  }
}

/** 把超长消息切成片段；能装进一条时返回空数组。 */
export function splitFragments(message: Uint8Array, messageId: number): Fragment[] {
  if (message.length <= MAX_SEALED_PAYLOAD) return []
  if (message.length > MAX_REASSEMBLED_BYTES) throw new Error('message exceeds the reassembly limit')
  const total = Math.ceil(message.length / MAX_SEALED_PAYLOAD)
  if (total > 0xffff) throw new Error('total exceeds the fragment count limit')
  const out: Fragment[] = []
  for (let index = 0; index < total; index++) {
    const start = index * MAX_SEALED_PAYLOAD
    const end = Math.min(start + MAX_SEALED_PAYLOAD, message.length)
    out.push({ messageId, index, total, totalBytes: message.length, payload: message.subarray(start, end) })
  }
  return out
}

interface Partial {
  readonly total: number
  readonly totalBytes: number
  readonly pieces: Map<number, Uint8Array>
}

/** 收齐片段再交出一条完整消息。 */
export class Reassembler {
  private readonly partials = new Map<number, Partial>()

  get pending(): number {
    return this.partials.size
  }

  accept(value: Fragment): Uint8Array | null {
    if (value.total === 0 || value.index >= value.total) {
      throw new Error(`fragment ${value.index}/${value.total} is out of range`)
    }
    if (value.totalBytes > MAX_REASSEMBLED_BYTES) {
      throw new Error(`reassembled message of ${value.totalBytes}B exceeds the limit`)
    }
    let partial = this.partials.get(value.messageId)
    if (partial === undefined) {
      if (this.partials.size >= MAX_CONCURRENT_REASSEMBLY) {
        // 丢掉最早的一条在建消息，而不是让表无限增长。
        const oldest = this.partials.keys().next()
        if (!oldest.done) this.partials.delete(oldest.value)
      }
      partial = { total: value.total, totalBytes: value.totalBytes, pieces: new Map() }
      this.partials.set(value.messageId, partial)
    }
    if (partial.total !== value.total || partial.totalBytes !== value.totalBytes) {
      this.partials.delete(value.messageId)
      throw new Error('fragments disagree about their message shape')
    }
    partial.pieces.set(value.index, value.payload)
    if (partial.pieces.size < partial.total) return null

    const out = new Uint8Array(partial.totalBytes)
    let offset = 0
    for (let i = 0; i < partial.total; i++) {
      const piece = partial.pieces.get(i)
      if (piece === undefined) return null
      if (offset + piece.length > partial.totalBytes) {
        this.partials.delete(value.messageId)
        throw new Error('fragments overflow the declared message size')
      }
      out.set(piece, offset)
      offset += piece.length
    }
    this.partials.delete(value.messageId)
    if (offset !== partial.totalBytes) throw new Error('fragments do not cover the declared message size')
    return out
  }
}

/** 唯一会说的协议版本。 */
export const PROTOCOL_VERSION = 1

/** 密封通道里的消息信封。 */
export interface Envelope {
  readonly type: string
  readonly id?: string
  readonly payload: JsonObject
}

export function requestEnvelope(id: string, payload: JsonObject): Envelope {
  return { type: 'request', id, payload }
}

export function responseEnvelope(id: string, payload: JsonObject): Envelope {
  return { type: 'response', id, payload }
}

export function errorEnvelope(id: string, code: string, message: string, details: JsonObject = {}): Envelope {
  return { type: 'error', id, payload: { code, message, details } }
}

export function eventEnvelope(payload: JsonObject): Envelope {
  return { type: 'event', payload }
}

export function encodeEnvelope(value: Envelope): Uint8Array {
  const body: JsonObject = { v: PROTOCOL_VERSION }
  if (value.id !== undefined) body.id = value.id
  body.type = value.type
  body.timestamp = Date.now()
  body.payload = value.payload
  return utf8(JSON.stringify(body))
}

export function decodeEnvelope(bytes: Uint8Array): Envelope {
  let map: JsonObject
  try {
    map = parseJsonBytes(bytes)
  } catch {
    throw new Error('the envelope is not a JSON object')
  }
  const version = map.v
  if (version !== PROTOCOL_VERSION) throw new Error(`unsupported envelope version ${String(version)}`)
  const type = map.type
  if (typeof type !== 'string') throw new Error('envelope is missing a type')
  const payload = map.payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('envelope is missing a payload')
  }
  const id = map.id
  return { type, id: typeof id === 'string' ? id : undefined, payload: payload as JsonObject }
}
