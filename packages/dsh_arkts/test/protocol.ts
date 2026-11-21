// 帧、分片、信封、配对票据的自检。
//
// 这些是协议里"看起来只是格式"的部分，但每一条都曾让两端对不上，
// 所以全部钉成断言。

import {
  Reassembler,
  decodeEnvelope,
  decodeFrame,
  decodeFragment,
  encodeEnvelope,
  encodeFrame,
  encodeFragment,
  errorEnvelope,
  eventEnvelope,
  requestEnvelope,
  responseEnvelope,
  splitFragments,
  FRAME_KIND,
  MAX_SEALED_PAYLOAD,
} from '../src/wire'
import {
  decodeTicket,
  encodeTicket,
  formatEndpoint,
  hasRelay,
  isTicketValid,
  parseEndpoint,
  ticketFingerprint,
  PAIRING_TICKET_VERSION,
} from '../src/pairing'
import { decodeBase64Url, encodeBase64Url } from '../src/bytes'
import { NoiseIkSession, createNoisePrologue } from '../src/noise'
import { x25519PublicKey } from '../src/curve25519'

const failures: string[] = []

function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === '' ? '' : ` (${detail})`}`)
  }
}

function equals(label: string, actual: unknown, expected: unknown): void {
  ok(label, JSON.stringify(actual) === JSON.stringify(expected), `actual ${JSON.stringify(actual)}`)
}

console.log('frames')
{
  const payload = new TextEncoder().encode('hello')
  const encoded = encodeFrame({ kind: FRAME_KIND.secure, payload })
  equals('kind byte leads the frame', encoded[0], FRAME_KIND.secure)
  const decoded = decodeFrame(encoded)
  ok('payload survives the round trip', decodeBase64Url(encodeBase64Url(decoded.payload)).length === 5)
  let rejected = false
  try {
    decodeFrame(new Uint8Array([0x09, 1, 2]))
  } catch {
    rejected = true
  }
  ok('an unknown kind is rejected', rejected)
  let emptyRejected = false
  try {
    decodeFrame(new Uint8Array(0))
  } catch {
    emptyRejected = true
  }
  ok('an empty frame is rejected', emptyRejected)
}

console.log('fragments')
{
  ok('a small message is not fragmented', splitFragments(new Uint8Array(100), 7).length === 0)
  const big = new Uint8Array(MAX_SEALED_PAYLOAD * 2 + 5)
  for (let i = 0; i < big.length; i++) big[i] = i & 0xff
  const parts = splitFragments(big, 0x01020304)
  equals('a large message is split into three', parts.length, 3)
  equals('the header carries the total count', parts[0].total, 3)
  equals('the header carries the byte count', parts[0].totalBytes, big.length)

  const reassembler = new Reassembler()
  let whole: Uint8Array | null = null
  for (const part of parts) {
    const decoded = decodeFragment(encodeFragment(part))
    const made = reassembler.accept(decoded)
    if (made !== null) whole = made
  }
  ok('the message reassembles exactly', whole !== null && encodeBase64Url(whole) === encodeBase64Url(big))
  equals('nothing is left pending', reassembler.pending, 0)

  // 乱序到达也必须能重组。
  const shuffled = new Reassembler()
  let fromShuffle: Uint8Array | null = null
  for (const part of [parts[2], parts[0], parts[1]]) {
    const made = shuffled.accept(part)
    if (made !== null) fromShuffle = made
  }
  ok('out of order fragments still reassemble', fromShuffle !== null && encodeBase64Url(fromShuffle) === encodeBase64Url(big))

  let mismatched = false
  const guard = new Reassembler()
  try {
    guard.accept({ messageId: 1, index: 0, total: 2, totalBytes: 10, payload: new Uint8Array(5) })
    guard.accept({ messageId: 1, index: 1, total: 3, totalBytes: 10, payload: new Uint8Array(5) })
  } catch {
    mismatched = true
  }
  ok('fragments that disagree are rejected', mismatched)
}

console.log('envelopes')
{
  const request = requestEnvelope('r1', { endpoint: 'session/list', payload: { args: { _request: {} } } })
  const decoded = decodeEnvelope(encodeEnvelope(request))
  equals('type survives', decoded.type, 'request')
  equals('id survives', decoded.id, 'r1')
  ok('payload survives', decoded.payload.endpoint === 'session/list')

  equals('a response keeps its type', decodeEnvelope(encodeEnvelope(responseEnvelope('r1', { ok: true }))).type, 'response')
  const failure = decodeEnvelope(encodeEnvelope(errorEnvelope('r1', 'HOST_ERROR', 'boom', { hint: 'x' })))
  equals('an error keeps its code', failure.payload.code, 'HOST_ERROR')
  equals('an event has no id', decodeEnvelope(encodeEnvelope(eventEnvelope({ hello: 1 }))).id, undefined)

  let badVersion = false
  try {
    decodeEnvelope(new TextEncoder().encode(JSON.stringify({ v: 99, type: 'request', payload: {} })))
  } catch {
    badVersion = true
  }
  ok('a wrong version is rejected', badVersion)

  let badJson = false
  try {
    decodeEnvelope(new TextEncoder().encode('not json'))
  } catch {
    badJson = true
  }
  ok('non-JSON is rejected', badJson)
}

console.log('pairing')
{
  const hostPrivate = new Uint8Array(32).fill(9)
  const hostPublic = x25519PublicKey(hostPrivate)
  const ticket = {
    version: PAIRING_TICKET_VERSION,
    hostDeviceId: '018f3a4c-7d21-7c3a-9e58-2b1c4d5e6f70',
    hostPublicKey: hostPublic,
    hostName: 'Pocket Harness Host',
    lanEndpoints: ['192.168.5.13:48100', '[fe80::1]:48100'],
    relayUrl: 'wss://relay.example/relay',
    relayRoom: 'f2d1ad69',
    relayToken: 'relay-token-0123456789',
    pairingSecret: 'secret-value',
    expiresAt: 1_900_000_000_000,
  }
  const code = encodeTicket(ticket)
  ok('the code carries the scheme', code.startsWith('pocketharness://pair?t='))
  const decoded = decodeTicket(code)
  equals('the host id survives', decoded.hostDeviceId, ticket.hostDeviceId)
  equals('the public key survives', encodeBase64Url(decoded.hostPublicKey), encodeBase64Url(hostPublic))
  equals('the lan endpoints survive', decoded.lanEndpoints, ticket.lanEndpoints)
  equals('the relay coordinates survive', hasRelay(decoded), true)
  equals('the secret survives', decoded.pairingSecret, 'secret-value')
  equals('the expiry survives', decoded.expiresAt, ticket.expiresAt)
  equals('a ticket without a relay is not relayed', hasRelay(decodeTicket(encodeTicket({ ...ticket, relayUrl: null, relayRoom: null, relayToken: null }))), false)

  ok('a fresh ticket is valid', isTicketValid(decoded, 1_800_000_000_000))
  ok('an expired ticket is not', !isTicketValid(decoded, 1_900_000_000_001))
  ok('an endless ticket never expires', isTicketValid({ ...decoded, expiresAt: 0 }, 9_999_999_999_999))

  let badScheme = false
  try {
    decodeTicket('https://example.com')
  } catch {
    badScheme = true
  }
  ok('a wrong scheme is rejected', badScheme)

  equals('endpoints parse', parseEndpoint('192.168.5.13:48100'), { host: '192.168.5.13', port: 48100 })
  equals('IPv6 endpoints parse', parseEndpoint('[fe80::1]:48100'), { host: 'fe80::1', port: 48100 })
  equals('IPv6 endpoints format back', formatEndpoint('fe80::1', 48100), '[fe80::1]:48100')
  ok('a fingerprint is readable', ticketFingerprint(decoded).length === 19)

  let badPort = false
  try {
    parseEndpoint('host:0')
  } catch {
    badPort = true
  }
  ok('port zero is rejected', badPort)
}

console.log('prologue')
{
  const prologue = createNoisePrologue('c1', 'h1', 'd1')
  equals(
    'the prologue is pinned byte for byte',
    new TextDecoder().decode(prologue),
    'DSH-REMOTE\u0000v=1\u0000connection=c1\u0000host=h1\u0000client=d1',
  )
  let emptyRejected = false
  try {
    createNoisePrologue('', 'h1', 'd1')
  } catch {
    emptyRejected = true
  }
  ok('an empty connection id is rejected', emptyRejected)

  let nulRejected = false
  try {
    createNoisePrologue('c1', 'h\u00001', 'd1')
  } catch {
    nulRejected = true
  }
  ok('a NUL in an id is rejected', nulRejected)
}

console.log('handshake ordering')
{
  const privateKey = new Uint8Array(32).fill(3)
  const publicKey = x25519PublicKey(privateKey)
  const otherPrivate = new Uint8Array(32).fill(4)
  const otherPublic = x25519PublicKey(otherPrivate)
  const prologue = createNoisePrologue('c1', 'h1', 'd1')

  const session = new NoiseIkSession({
    role: 'initiator',
    localPrivateKey: privateKey,
    localPublicKey: publicKey,
    remotePublicKey: otherPublic,
    prologue,
    random: () => new Uint8Array(32).fill(5),
  })
  ok('the initiator writes first', session.isWriteTurn)
  let prematureRead = false
  try {
    session.readHandshake(new Uint8Array(48))
  } catch {
    prematureRead = true
  }
  ok('reading out of turn is rejected', prematureRead)

  const message = session.writeHandshake()
  let doubleWrite = false
  try {
    session.writeHandshake()
  } catch {
    doubleWrite = true
  }
  ok('writing twice is rejected', doubleWrite)

  let earlyTransport = false
  try {
    session.encrypt(new Uint8Array(1))
  } catch {
    earlyTransport = true
  }
  ok('transport before the handshake is rejected', earlyTransport)
  ok('the message carries the ephemeral key', message.length >= 32)
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nALL PROTOCOL CHECKS PASS (typescript core)')
