// Pairing tickets: what the Host renders as a QR code and the phone scans.
//
// Byte-compatible with packages/dsh_link/lib/src/pairing/pairing.dart. The ticket
// carries the Host's static X25519 key and its address in one code, which is what
// lets the phone trust a Host it has never met: the first key it sees is the only
// one it will ever accept, because the code cannot be substituted in transit.

import { randomBytes } from 'node:crypto'

import { newDeviceId } from './ids.js'

export const PAIRING_SCHEME = 'pocketharness'
export const PAIRING_TICKET_VERSION = 1

/** Default lifetime of a ticket rendered on screen. */
export const PAIRING_TICKET_TTL_MS = 10 * 60 * 1000

/** A one-time secret that proves the scan happened while the Host was pairing. */
export function newPairingSecret() {
  return randomBytes(24).toString('base64url')
}

/** Encodes a ticket as the text to render into a QR code. */
export function encodeTicket(ticket) {
  const json = ticketToJson(ticket)
  const payload = Buffer.from(JSON.stringify(json), 'utf8').toString('base64url')
  return `${PAIRING_SCHEME}://pair?t=${payload}`
}

/** Parses a scanned ticket; throws when the text is not one. */
export function decodeTicket(text) {
  const trimmed = String(text).trim()
  const prefix = `${PAIRING_SCHEME}://pair`
  if (!trimmed.startsWith(prefix)) throw new Error('not a Pocket Harness pairing code')
  const separator = trimmed.indexOf('?t=')
  if (separator < 0) throw new Error('the pairing code has no payload')
  let json
  try {
    json = JSON.parse(Buffer.from(trimmed.slice(separator + 3), 'base64url').toString('utf8'))
  } catch {
    throw new Error('the pairing code payload is not valid base64url JSON')
  }
  if (json === null || typeof json !== 'object') throw new Error('the pairing code payload is not an object')
  if (json.v !== PAIRING_TICKET_VERSION) throw new Error(`unsupported pairing code version: ${json.v}`)
  if (typeof json.id !== 'string' || json.id.length === 0) throw new Error('the pairing code has no host id')
  if (typeof json.key !== 'string') throw new Error('the pairing code has no host key')
  if (typeof json.name !== 'string') throw new Error('the pairing code has no host name')
  const hostPublicKey = Buffer.from(json.key, 'base64url')
  if (hostPublicKey.length !== 32) throw new Error('the host key must be 32 bytes')
  return {
    version: json.v,
    hostDeviceId: json.id,
    hostPublicKey,
    hostName: json.name,
    lanEndpoints: Array.isArray(json.lan) ? json.lan.filter(value => typeof value === 'string') : [],
    relayUrl: typeof json.relay === 'string' && json.relay.length > 0 ? json.relay : null,
    relayRoom: typeof json.room === 'string' && json.room.length > 0 ? json.room : null,
    relayToken: typeof json.rtok === 'string' && json.rtok.length > 0 ? json.rtok : null,
    pairingSecret: typeof json.secret === 'string' && json.secret.length > 0 ? json.secret : null,
    expiresAt: typeof json.exp === 'string' ? Date.parse(json.exp) : null,
  }
}

/** Whether the ticket is still usable at [now]. */
export function isTicketValid(ticket, now = Date.now()) {
  return ticket.expiresAt === null || ticket.expiresAt === undefined || now < ticket.expiresAt
}

/** Serializes a ticket into the wire object. */
export function ticketToJson(ticket) {
  const out = {
    v: PAIRING_TICKET_VERSION,
    id: ticket.hostDeviceId,
    key: Buffer.from(ticket.hostPublicKey).toString('base64url'),
    name: ticket.hostName,
  }
  if (ticket.lanEndpoints !== undefined && ticket.lanEndpoints.length > 0) out.lan = [...ticket.lanEndpoints]
  if (ticket.relayUrl !== null && ticket.relayUrl !== undefined) out.relay = ticket.relayUrl
  if (ticket.relayRoom !== null && ticket.relayRoom !== undefined) out.room = ticket.relayRoom
  if (ticket.relayToken !== null && ticket.relayToken !== undefined) out.rtok = ticket.relayToken
  if (ticket.pairingSecret !== null && ticket.pairingSecret !== undefined) out.secret = ticket.pairingSecret
  if (ticket.expiresAt !== null && ticket.expiresAt !== undefined) {
    out.exp = new Date(ticket.expiresAt).toISOString()
  }
  return out
}

/** Builds a fresh ticket for one Host, valid for [ttlMs]. */
export function createTicket({
  hostDeviceId = newDeviceId(),
  hostPublicKey,
  hostName,
  lanEndpoints = [],
  relayUrl = null,
  relayRoom = null,
  relayToken = null,
  pairingSecret = newPairingSecret(),
  ttlMs = PAIRING_TICKET_TTL_MS,
  now = Date.now(),
}) {
  return {
    hostDeviceId,
    hostPublicKey,
    hostName,
    lanEndpoints,
    relayUrl,
    relayRoom,
    relayToken,
    pairingSecret,
    expiresAt: now + ttlMs,
  }
}

/** Parses `host:port`, tolerating brackets around an IPv6 literal. */
export function parseEndpoint(endpoint) {
  const trimmed = String(endpoint).trim()
  if (trimmed.length === 0) return null
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']')
    if (close < 0) return null
    const host = trimmed.slice(1, close)
    const rest = trimmed.slice(close + 1)
    if (!rest.startsWith(':')) return null
    const port = Number.parseInt(rest.slice(1), 10)
    return Number.isInteger(port) ? { host, port } : null
  }
  const separator = trimmed.lastIndexOf(':')
  if (separator <= 0) return null
  const port = Number.parseInt(trimmed.slice(separator + 1), 10)
  if (!Number.isInteger(port)) return null
  return { host: trimmed.slice(0, separator), port }
}

/** Formats a `host:port` endpoint, bracketing IPv6 literals. */
export function formatEndpoint(host, port) {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
}
