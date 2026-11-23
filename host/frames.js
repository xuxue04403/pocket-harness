// Frame and fragment encoding for the Pocket Harness link.
//
// This mirrors packages/dsh_link/lib/src/wire/{frame,fragment}.dart exactly: the
// two ends are independent implementations of one wire format, so any change
// here has to be made there too (and vice versa). The layout is deliberately
// tiny — one kind byte in front of each payload, and a 17-byte DSHF header only
// for messages that outgrow a single Noise message.

export const FRAME_KIND = {
  handshake: 0x01,
  secure: 0x02,
  fragment: 0x03,
  control: 0x04,
}

/** Largest plaintext a single Noise message may carry. */
export const MAX_SEALED_PAYLOAD = 48 * 1024
/** Largest message the reassembler will rebuild. */
export const MAX_REASSEMBLED_BYTES = 4 * 1024 * 1024
/** How many partial messages the reassembler keeps at once. */
export const MAX_CONCURRENT_REASSEMBLY = 8

const FRAGMENT_MAGIC = [0x44, 0x53, 0x48, 0x46] // 'DSHF'
const FRAGMENT_VERSION = 1
const FRAGMENT_HEADER_BYTES = 17

/** Encodes `[kind][payload]`. */
export function encodeFrame(kind, payload) {
  const out = Buffer.allocUnsafe(1 + payload.length)
  out[0] = kind
  out.set(payload, 1)
  return out
}

/** Splits one received frame into its kind and payload. */
export function decodeFrame(bytes) {
  if (bytes.length < 1) throw new Error('a frame needs at least its kind byte')
  const kind = bytes[0]
  if (!Object.values(FRAME_KIND).includes(kind)) {
    throw new Error(`unknown frame kind ${kind}`)
  }
  return { kind, payload: bytes.subarray(1) }
}

/** One piece of a fragmented message. */
export class Fragment {
  constructor(messageId, index, total, totalBytes, payload) {
    this.messageId = messageId >>> 0
    this.index = index
    this.total = total
    this.totalBytes = totalBytes
    this.payload = payload
  }

  encode() {
    const out = Buffer.allocUnsafe(FRAGMENT_HEADER_BYTES + this.payload.length)
    out.set(FRAGMENT_MAGIC, 0)
    out[4] = FRAGMENT_VERSION
    out.writeUInt32BE(this.messageId, 5)
    out.writeUInt16BE(this.index, 9)
    out.writeUInt16BE(this.total, 11)
    out.writeUInt32BE(this.totalBytes, 13)
    out.set(this.payload, FRAGMENT_HEADER_BYTES)
    return out
  }

  static decode(bytes) {
    if (bytes.length < FRAGMENT_HEADER_BYTES) throw new Error('a fragment header needs 17 bytes')
    for (let i = 0; i < 4; i++) {
      if (bytes[i] !== FRAGMENT_MAGIC[i]) throw new Error('bad fragment magic')
    }
    if (bytes[4] !== FRAGMENT_VERSION) throw new Error(`unsupported fragment version ${bytes[4]}`)
    const messageId = bytes.readUInt32BE(5)
    const index = bytes.readUInt16BE(9)
    const total = bytes.readUInt16BE(11)
    const totalBytes = bytes.readUInt32BE(13)
    if (total === 0 || index >= total) throw new Error('inconsistent fragment index')
    if (totalBytes === 0 || totalBytes > MAX_REASSEMBLED_BYTES) {
      throw new Error('a reassembled message would exceed the size limit')
    }
    return new Fragment(messageId, index, total, totalBytes, bytes.subarray(FRAGMENT_HEADER_BYTES))
  }

  /** Splits [message] into fragments, or returns [] when it fits in one frame. */
  static split(message, messageId) {
    if (message.length <= MAX_SEALED_PAYLOAD) return []
    const total = Math.ceil(message.length / MAX_SEALED_PAYLOAD)
    if (total > 0xffff) throw new Error('a message this size cannot be fragmented')
    const pieces = []
    for (let index = 0; index < total; index++) {
      const start = index * MAX_SEALED_PAYLOAD
      const end = Math.min(start + MAX_SEALED_PAYLOAD, message.length)
      pieces.push(new Fragment(messageId, index, total, message.length, message.subarray(start, end)))
    }
    return pieces
  }
}

/** Rebuilds fragmented messages, keeping at most a few in flight. */
export class Reassembler {
  #partials = new Map()

  /** Returns the whole message once its last fragment lands, else null. */
  accept(fragment) {
    let partial = this.#partials.get(fragment.messageId)
    if (partial === undefined) {
      while (this.#partials.size >= MAX_CONCURRENT_REASSEMBLY) {
        // Drop the oldest partial rather than growing without bound: a stalled
        // sender must not be able to pin memory here.
        const oldest = this.#partials.keys().next().value
        this.#partials.delete(oldest)
      }
      partial = { total: fragment.total, totalBytes: fragment.totalBytes, pieces: new Map(), bytes: 0 }
      this.#partials.set(fragment.messageId, partial)
    }
    if (partial.total !== fragment.total || partial.totalBytes !== fragment.totalBytes) {
      throw new Error('fragments of one message disagree about its shape')
    }
    // Count as we go rather than only at the end. The header's totalBytes is the
    // sender's claim, and it is the only thing bounding what we hold; checking it
    // only once the last piece lands lets a peer with `total` pieces of 48 KiB and
    // a 4 MiB claim buffer hundreds of megabytes first.
    const previous = partial.pieces.get(fragment.index)
    partial.bytes += fragment.payload.length - (previous === undefined ? 0 : previous.length)
    if (partial.bytes > partial.totalBytes) {
      this.#partials.delete(fragment.messageId)
      throw new Error('fragments exceed the size their header declared')
    }
    partial.pieces.set(fragment.index, fragment.payload)
    if (partial.pieces.size !== partial.total) return null
    this.#partials.delete(fragment.messageId)
    const parts = []
    for (let index = 0; index < partial.total; index++) {
      const piece = partial.pieces.get(index)
      if (piece === undefined) return null
      parts.push(piece)
    }
    if (partial.bytes !== partial.totalBytes) throw new Error('reassembled size does not match its header')
    return Buffer.concat(parts)
  }

  get pending() {
    return this.#partials.size
  }
}
