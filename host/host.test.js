// Unit checks for the Host-side pieces that do not need a running Harness.
//
// The link and plugin integration tests already cover the happy path end to end.
// These pin the smaller contracts those tests cannot reach cheaply: pairing-code
// expiry, identifier shape, fragment limits, and the record-key validation that
// has to match the credentials service without importing it.
//
// Run with: node --test host

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'

import { credentialKey, parseCredentialKey } from './credentials-key.js'
import { Fragment, Reassembler, decodeFrame, encodeFrame, FRAME_KIND } from './frames.js'
import { isDeviceId, newDeviceId, newMessageId } from './ids.js'
import { createTicket, decodeTicket, encodeTicket, isTicketValid } from './pairing.js'
import { NoiseIkResponder, createNoisePrologue, x25519PrivateToPublic } from './noise.js'
import { open, seal } from './chacha20_poly1305.js'
import { encodeEnvelope, envelope } from './envelope.js'
import { LinkServer } from './link.js'
import { RpcServer } from './rpc.js'

test('credential keys mirror the credentials service rules', () => {
  assert.equal(credentialKey('dsh-pocketharness-host', 'identity'), 'dsh-pocketharness-host/identity')
  assert.throws(() => credentialKey('Bad', 'x'), TypeError)
  assert.throws(() => credentialKey('a', 'UPPER'), TypeError)
  assert.deepEqual(parseCredentialKey('a-b/c-d'), { scope: 'a-b', id: 'c-d' })
  assert.throws(() => parseCredentialKey('no-slash'), TypeError)
  assert.throws(() => parseCredentialKey('a/b/c'), TypeError)
})

test('device ids are what a relay would accept', () => {
  const id = newDeviceId()
  assert.equal(isDeviceId(id), true)
  assert.equal(id[14], '7', 'a generated id must be UUIDv7')
  assert.equal(isDeviceId('not-an-id'), false)
  assert.equal(newMessageId().length, 26)
})

test('pairing codes round-trip and expire', () => {
  const publicKey = x25519PrivateToPublic(Buffer.alloc(32, 7))
  const ticket = createTicket({
    hostDeviceId: newDeviceId(),
    hostPublicKey: publicKey,
    hostName: 'Test Host',
    lanEndpoints: ['192.168.1.5:48100', '[::1]:48100'],
    pairingSecret: 'secret',
    ttlMs: 60_000,
  })
  const text = encodeTicket(ticket)
  assert.equal(text.startsWith('pocketharness://pair?t='), true)
  const decoded = decodeTicket(text)
  assert.equal(decoded.hostName, 'Test Host')
  assert.deepEqual(decoded.lanEndpoints, ticket.lanEndpoints)
  assert.equal(isTicketValid(decoded, Date.now()), true)
  assert.equal(isTicketValid(decoded, Date.now() + 61_000), false)
  assert.throws(() => decodeTicket('pocketharness://pair?t=%%%'))
})

test('frames round-trip every kind', () => {
  for (const kind of [FRAME_KIND.handshake, FRAME_KIND.secure, FRAME_KIND.fragment, FRAME_KIND.control]) {
    const decoded = decodeFrame(encodeFrame(kind, Buffer.from([1, 2, 3])))
    assert.equal(decoded.kind, kind)
    assert.deepEqual([...decoded.payload], [1, 2, 3])
  }
  assert.throws(() => decodeFrame(Buffer.alloc(0)))
})

test('fragments reassemble and refuse to grow past the ceiling', () => {
  const big = Buffer.alloc(120_000, 9)
  const parts = Fragment.split(big, 42)
  assert.ok(parts.length > 1)
  const reassembler = new Reassembler()
  let out = null
  for (const part of parts) out = reassembler.accept(Fragment.decode(part.encode())) ?? out
  assert.equal(out?.length, big.length)
  assert.equal(reassembler.pending, 0)
  assert.deepEqual(Fragment.split(Buffer.alloc(10), 1), [])
})

test('AEAD rejects a tampered tag', () => {
  const key = Buffer.alloc(32, 1)
  const nonce = Buffer.alloc(12, 2)
  const sealed = seal(key, nonce, Buffer.from('aad'), Buffer.from('hello'))
  assert.equal(Buffer.from(open(key, nonce, Buffer.from('aad'), sealed) ?? []).toString(), 'hello')
  const bad = Buffer.from(sealed)
  bad[bad.length - 1] ^= 0xff
  assert.equal(open(key, nonce, Buffer.from('aad'), bad), null)
})

test('the responder rejects a prologue that names another connection', () => {
  assert.throws(() => createNoisePrologue('', 'host', 'client'))
  const prologue = createNoisePrologue('conn', 'host', 'client')
  assert.ok(prologue.includes(Buffer.from('connection=conn')))
  assert.equal(typeof new NoiseIkResponder({
    localPrivateKey: Buffer.alloc(32, 3),
    localPublicKey: x25519PrivateToPublic(Buffer.alloc(32, 3)),
    prologue,
  }).readHandshakeMessage, 'function')
})

test('gateway endpoints reach the carrier seam, business ones do not', async () => {
  const sent = []
  const channel = new EventEmitter()
  channel.send = bytes => sent.push(JSON.parse(Buffer.from(bytes).toString('utf8')))
  const seen = []
  const gateway = {
    invoke: async request => { seen.push(['invoke', request.namespace, request.method]); return { echoed: true } },
    stream: async request => { seen.push(['stream', request.namespace, request.method]); return (async function* () { yield { n: 1 } })() },
    dispatch: async (endpoint, payload) => { seen.push(['dispatch', endpoint, payload.args]); return { ok: true, value: { clientId: 'c1' } } },
    open: async (endpoint, payload) => { seen.push(['open', endpoint, payload.args]); return (async function* () { yield { type: 'ready', clientId: 'c1' } })() },
  }
  const server = new RpcServer({ channel, gateway, peer: { id: 'peer' } })
  const request = async (id, endpoint, args) => {
    channel.emit('message', encodeEnvelope(envelope({ type: 'request', id, payload: { endpoint, payload: { args } } })))
    await new Promise(resolve => setTimeout(resolve, 20))
    return sent.find(entry => entry.id === id)
  }

  const unary = await request('r1', '$events/result', { clientId: 'c1', eventId: 'e1', outcome: { kind: 'next' } })
  assert.deepEqual(unary.payload, { clientId: 'c1' })
  assert.deepEqual(seen.at(-1), ['dispatch', '$events/result', { clientId: 'c1', eventId: 'e1', outcome: { kind: 'next' } }])

  const opened = await request('r2', 'link/stream.open', { endpoint: '$events', args: {} })
  assert.equal(typeof opened.payload.streamId, 'number')
  assert.deepEqual(seen.at(-1), ['open', '$events', {}])
  const frame = sent.find(entry => entry.type === 'event' && entry.payload.streamId === opened.payload.streamId)
  assert.deepEqual(frame.payload.value, { type: 'ready', clientId: 'c1' })

  await request('r3', 'session/list', { _request: {} })
  assert.deepEqual(seen.at(-1), ['invoke', 'session', 'list'])
  await server.close()
})

/** A LinkServer that never accepts anything: these tests only care about binds. */
function idleServer(port = 0) {
  const server = new LinkServer({
    identity: { deviceId: newDeviceId(), privateKey: Buffer.alloc(32, 9), publicKey: Buffer.alloc(32, 9) },
    createGateway: () => ({}),
    authorize: () => ({ ok: false, reason: 'not-paired' }),
    logger: null,
    hostName: 'Test Host',
  })
  return { server, wanted: port }
}

test('a busy default port moves to a free one instead of serving nobody', async () => {
  // 48100 is the shipped default. Two Harnesses on one machine, or a leftover
  // process, must not leave the second plugin listening on nothing while its log
  // still says it started.
  const first = idleServer()
  const taken = await first.server.listen({ port: 0, host: '127.0.0.1' })
  const second = idleServer()
  try {
    const moved = await second.server.listen({ port: taken, host: '127.0.0.1', fallbackToAnyPort: true })
    assert.notEqual(moved, taken)
    assert.ok(moved > 0)
  } finally {
    await second.server.close()
    await first.server.close()
  }
})

test('an explicitly configured port fails loudly when it is taken', async () => {
  // The opposite choice, and deliberate: an operator who opened one port in a
  // firewall wants to hear that the Host cannot have it, not to find the phone
  // pairing with a port nothing can reach.
  const first = idleServer()
  const taken = await first.server.listen({ port: 0, host: '127.0.0.1' })
  const second = idleServer()
  try {
    await assert.rejects(
      second.server.listen({ port: taken, host: '127.0.0.1' }),
      error => error.code === 'EADDRINUSE',
    )
  } finally {
    await second.server.close()
    await first.server.close()
  }
})
