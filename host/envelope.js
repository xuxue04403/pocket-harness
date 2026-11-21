// Message envelope carried inside the sealed channel.
//
// Byte-compatible with packages/dsh_link/lib/src/rpc/envelope.dart: `v` is always
// 1, `id` is present only on request/response pairs, and the payload is whatever
// the endpoint or the link layer puts there.

export const PROTOCOL_VERSION = 1

/** Builds one envelope object; `timestamp` is informational only. */
export function envelope({ type, id, payload }) {
  const out = { v: PROTOCOL_VERSION }
  if (id !== undefined && id !== null) out.id = id
  out.type = type
  out.timestamp = Date.now()
  out.payload = payload
  return out
}

export function responseEnvelope(id, payload) {
  return envelope({ type: 'response', id, payload })
}

export function errorEnvelope(id, code, message, details = {}) {
  return envelope({ type: 'error', id, payload: { code, message, details } })
}

export function eventEnvelope(payload) {
  return envelope({ type: 'event', payload })
}

/** Serializes one envelope as UTF-8 JSON. */
export function encodeEnvelope(value) {
  return Buffer.from(JSON.stringify(value), 'utf8')
}

/** Parses and validates an inbound envelope. */
export function decodeEnvelope(bytes) {
  const text = Buffer.from(bytes).toString('utf8')
  const value = JSON.parse(text)
  if (value === null || typeof value !== 'object') throw new Error('an envelope must be an object')
  if (value.v !== PROTOCOL_VERSION) throw new Error(`unsupported envelope version ${value.v}`)
  if (typeof value.type !== 'string') throw new Error('the envelope has no type')
  if (value.payload === null || typeof value.payload !== 'object') {
    throw new Error('the envelope has no payload')
  }
  return {
    id: typeof value.id === 'string' ? value.id : undefined,
    type: value.type,
    payload: value.payload,
  }
}
