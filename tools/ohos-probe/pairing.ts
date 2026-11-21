// 配对票据与设备身份。
//
// 票据键名与 Dart 侧 `pairing.dart` 完全一致（v/id/key/name/lan/relay/room/rtok/
// secret/exp），因为它是手机与 Host 之间唯一的共享格式。

import { decodeBase64Url, encodeBase64Url, equalBytes, utf8 } from './bytes'
import { JsonObject, parseJsonBytes } from './json'

/** 配对码的 URL scheme。 */
export const PAIRING_SCHEME = 'pocketharness'
/** 票据格式版本。 */
export const PAIRING_TICKET_VERSION = 1
/** 配对码有效期。 */
export const PAIRING_TICKET_TTL_MS = 10 * 60 * 1000

export interface PairingTicket {
  readonly version: number
  readonly hostDeviceId: string
  readonly hostPublicKey: Uint8Array
  readonly hostName: string
  readonly lanEndpoints: readonly string[]
  readonly relayUrl: string | null
  readonly relayRoom: string | null
  readonly relayToken: string | null
  readonly pairingSecret: string | null
  readonly expiresAt: number
}

export interface DeviceIdentity {
  readonly deviceId: string
  readonly privateKey: Uint8Array
  readonly publicKey: Uint8Array
}

export function hasRelay(ticket: PairingTicket): boolean {
  return ticket.relayUrl !== null && ticket.relayRoom !== null && ticket.relayToken !== null
}

export function ticketToJson(ticket: PairingTicket): JsonObject {
  return {
    v: ticket.version,
    id: ticket.hostDeviceId,
    key: encodeBase64Url(ticket.hostPublicKey),
    name: ticket.hostName,
    lan: ticket.lanEndpoints,
    ...(ticket.relayUrl === null ? {} : { relay: ticket.relayUrl }),
    ...(ticket.relayRoom === null ? {} : { room: ticket.relayRoom }),
    ...(ticket.relayToken === null ? {} : { rtok: ticket.relayToken }),
    ...(ticket.pairingSecret === null ? {} : { secret: ticket.pairingSecret }),
    exp: ticket.expiresAt,
  }
}

/** 编码成 `pocketharness://pair?t=<base64url json>`。 */
export function encodeTicket(ticket: PairingTicket): string {
  const body = encodeBase64Url(utf8(JSON.stringify(ticketToJson(ticket))))
  return `${PAIRING_SCHEME}://pair?t=${body}`
}

export function decodeTicket(text: string): PairingTicket {
  const trimmed = text.trim()
  const prefix = `${PAIRING_SCHEME}://pair?t=`
  if (!trimmed.startsWith(prefix)) {
    throw new Error(`a pairing code starts with ${prefix}`)
  }
  let map: JsonObject
  try {
    map = parseJsonBytes(decodeBase64Url(trimmed.slice(prefix.length)))
  } catch {
    throw new Error('the pairing code is not readable')
  }
  if (map.v !== PAIRING_TICKET_VERSION) throw new Error(`unsupported pairing code version ${String(map.v)}`)

  const id = map.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('the pairing code has no Host id')
  const key = map.key
  if (typeof key !== 'string') throw new Error('the pairing code has no Host public key')
  const publicKey = decodeBase64Url(key)
  if (publicKey.length !== 32) throw new Error('the Host public key must be 32 bytes')
  const name = map.name
  const lan = map.lan
  const exp = map.exp
  const relay = map.relay
  const room = map.room
  const rtok = map.rtok
  const secret = map.secret

  return {
    version: PAIRING_TICKET_VERSION,
    hostDeviceId: id,
    hostPublicKey: publicKey,
    hostName: typeof name === 'string' && name.length > 0 ? name : 'DeepSeek Harness',
    lanEndpoints: Array.isArray(lan) ? (lan as Object[]).filter((entry): entry is string => typeof entry === 'string') : [],
    relayUrl: typeof relay === 'string' && relay.length > 0 ? relay : null,
    relayRoom: typeof room === 'string' && room.length > 0 ? room : null,
    relayToken: typeof rtok === 'string' && rtok.length > 0 ? rtok : null,
    pairingSecret: typeof secret === 'string' && secret.length > 0 ? secret : null,
    expiresAt: typeof exp === 'number' ? exp : 0,
  }
}

export function isTicketValid(ticket: PairingTicket, now: number): boolean {
  return ticket.expiresAt <= 0 || ticket.expiresAt > now
}

/** 拆 `host:port`，IPv6 用方括号。 */
export function parseEndpoint(endpoint: string): { host: string; port: number } {
  const trimmed = endpoint.trim()
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']')
    if (close < 0) throw new Error(`not an endpoint: ${endpoint}`)
    const host = trimmed.slice(1, close)
    const rest = trimmed.slice(close + 1)
    if (!rest.startsWith(':')) throw new Error(`not an endpoint: ${endpoint}`)
    const port = Number.parseInt(rest.slice(1), 10)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`not a port: ${rest.slice(1)}`)
    return { host, port }
  }
  const colon = trimmed.lastIndexOf(':')
  if (colon <= 0) throw new Error(`not an endpoint: ${endpoint}`)
  const port = Number.parseInt(trimmed.slice(colon + 1), 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`not a port: ${trimmed.slice(colon + 1)}`)
  }
  return { host: trimmed.slice(0, colon), port }
}

export function formatEndpoint(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
}

/** 票据指纹：只用于在 UI 上区分不同 Host，不能当身份凭证。 */
export function ticketFingerprint(ticket: PairingTicket): string {
  const hex = Array.from(ticket.hostPublicKey.slice(0, 8))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return hex.match(/.{1,4}/g)!.join(' ')
}

export function samePublicKey(left: Uint8Array, right: Uint8Array): boolean {
  return equalBytes(left, right)
}
