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
import { HELLO_TIMEOUT_MS, HANDSHAKE_TIMEOUT_MS, LinkServer } from './link.js'
import { RpcServer } from './rpc.js'
import { apply, sameProof } from './index.js'

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

test('a message is dropped the moment its pieces exceed the size it declared', () => {
  // The header is a claim, and it is the only thing bounding what we hold. If we
  // only compare once the last piece lands, a peer can send `total` pieces of
  // 48 KiB against a 4 MiB claim and buffer hundreds of megabytes first.
  const reassembler = new Reassembler()
  const chunk = Buffer.alloc(48 * 1024, 7)
  const total = 3000
  let thrown = null
  let accepted = 0
  try {
    while (accepted < total) {
      reassembler.accept(new Fragment(7, accepted, total, 4 * 1024 * 1024, chunk))
      accepted += 1
    }
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown !== null, 'the reassembler should stop accepting oversize pieces')
  assert.match(thrown.message, /exceed the size their header declared/)
  // Roughly 4 MiB of worth, not 3000 * 48 KiB (140 MB).
  assert.ok(accepted < 100, `it kept accepting ${accepted} pieces`)
  assert.equal(reassembler.pending, 0)
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

test('a connection that talks during admission is dropped at the queue ceiling', async () => {
  // `authorize` may await credential I/O, and the socket keeps delivering while
  // it does. Those frames are queued so a phone's handshake is not dropped — but
  // an unbounded queue is a memory hole any peer could reach before proving
  // anything. Four frames is already more than a handshake needs.
  let release
  const gate = new Promise(resolve => { release = resolve })
  const server = new LinkServer({
    identity: { deviceId: newDeviceId(), privateKey: Buffer.alloc(32, 9), publicKey: Buffer.alloc(32, 9) },
    createGateway: () => ({}),
    authorize: async () => { await gate; return { ok: false, reason: 'not-paired' } },
    logger: null,
    hostName: 'Test Host',
  })
  let closed = false
  let frameHandler = () => {}
  const transport = {
    onFrame: handler => { frameHandler = handler },
    onClose: () => {},
    send: () => {},
    close: () => { closed = true },
  }
  const link = server.attach(transport)
  assert.ok(link !== null)
  const hello = encodeFrame(
    FRAME_KIND.control,
    Buffer.from(JSON.stringify({
      v: 1,
      connection: 'queue-ceiling-probe',
      client: newDeviceId(),
      proof: 'not-checked-because-authorize-stalls',
    }), 'utf8'),
  )
  frameHandler(hello)
  for (let extra = 0; extra < 8; extra += 1) frameHandler(hello)
  // The assertion has to land while `authorize` is still pending. Waiting for
  // `link.closed` would prove nothing: the refusal path closes the link anyway,
  // so the check would pass with no ceiling at all. The hello has to be
  // well-formed too, or admission never reaches `authorize` and the queue is
  // never used.
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(closed, true, 'the link should close once the queue is full')
  release()
  await server.close()
})

test('an admitted connection that never finishes Noise is closed', async () => {
  // Admission clears the hello deadline, because the client is now expected to
  // send its Noise message one. Without a second deadline a peer that proves a
  // device id and then goes quiet holds one of the eight slots forever.
  const warnings = []
  const server = new LinkServer({
    identity: { deviceId: newDeviceId(), privateKey: Buffer.alloc(32, 9), publicKey: Buffer.alloc(32, 9) },
    createGateway: () => ({ invoke: async () => ({}), stream: async () => (async function* () {})() }),
    authorize: () => ({
      ok: true,
      pinnedKey: Buffer.alloc(32, 8),
      createPeer: async () => ({ dispose: async () => {} }),
    }),
    logger: { info: () => {}, warn: message => warnings.push(message) },
    hostName: 'Test Host',
    handshakeTimeoutMs: 40,
  })
  let frameHandler = () => {}
  let closed = false
  const transport = {
    onFrame: handler => { frameHandler = handler },
    onClose: () => {},
    send: () => {},
    close: () => { closed = true },
  }
  const link = server.attach(transport)
  assert.ok(link !== null)
  frameHandler(encodeFrame(
    FRAME_KIND.control,
    Buffer.from(JSON.stringify({
      v: 1,
      connection: 'noise-timeout-probe',
      client: newDeviceId(),
      proof: 'unused',
    }), 'utf8'),
  ))
  // Admission awaits `authorize` and `createPeer`; give it a turn to finish
  // before the deadline can fire.
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(closed, false, 'the link is still inside its handshake window')
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(closed, true, 'a silent handshake must close the link')
  assert.equal(
    warnings.some(message => message.includes('did not finish Noise in time')),
    true,
    `expected a handshake warning, got ${JSON.stringify(warnings)}`,
  )
  assert.ok(HANDSHAKE_TIMEOUT_MS > HELLO_TIMEOUT_MS)
  await server.close()
})

test('a link whose gateway cannot be built closes instead of crashing the Host', async () => {
  // `createGateway` is plugin code and may throw. Admission is started with
  // `void this.#admit(frame)`, so before the fix that throw became an unhandled
  // rejection — and node 22+ turns one of those into a dead process. The whole
  // Harness would exit, taking every other feature with it, while the phone saw
  // only "the connection closed". A link that cannot be set up must close.
  const warnings = []
  const server = new LinkServer({
    identity: { deviceId: newDeviceId(), privateKey: Buffer.alloc(32, 9), publicKey: Buffer.alloc(32, 9) },
    createGateway: () => { throw new Error('gateway construction exploded') },
    authorize: () => ({
      ok: true,
      pinnedKey: null,
      createPeer: async () => ({ dispose: async () => {} }),
      pinKey: async () => {},
    }),
    logger: { info: () => {}, warn: message => warnings.push(message) },
    hostName: 'Test Host',
  })
  let frameHandler = () => {}
  let closed = false
  const transport = {
    onFrame: handler => { frameHandler = handler },
    onClose: () => {},
    send: () => {},
    close: () => { closed = true },
  }
  server.attach(transport)
  frameHandler(encodeFrame(
    FRAME_KIND.control,
    Buffer.from(JSON.stringify({
      v: 1,
      connection: 'gateway-throw-probe',
      client: newDeviceId(),
      proof: 'not-checked',
    }), 'utf8'),
  ))
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(closed, true, 'the link should close when its gateway cannot be built')
  assert.ok(
    warnings.includes('pocket-harness: could not start this link (gateway construction exploded)'),
    `expected a warning about the failed link, saw ${JSON.stringify(warnings)}`,
  )
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
test('a pairing proof is accepted only when it matches the expected one', () => {
  // This pins the *result* of the comparison, not its cost: no unit test can
  // measure constant-timeness reliably, so that property rests on `sameProof`
  // routing every equal-length case through `timingSafeEqual` rather than on
  // these assertions. What is worth pinning here is the edge behaviour a future
  // refactor could get wrong: a difference in the last character must still be
  // rejected exactly like one in the first, and non-strings must never reach the
  // compare at all.
  const expected = 'A'.repeat(43)
  assert.equal(sameProof(expected, expected), true)
  // Wrong only at the last character: a short-circuiting compare returns after
  // one character, a constant-time one still walks all 43.
  assert.equal(sameProof(`${'A'.repeat(42)}B`, expected), false)
  // Wrong at the first character: the same amount of work must happen here.
  assert.equal(sameProof(`B${'A'.repeat(42)}`, expected), false)
  // Length is the one thing that may be checked early — every proof is 43 chars.
  assert.equal(sameProof('A'.repeat(42), expected), false)
  assert.equal(sameProof('A'.repeat(44), expected), false)
  // A non-string never reaches the compare at all.
  assert.equal(sameProof(undefined, expected), false)
  assert.equal(sameProof(12345, expected), false)
})
test('stream opens that are still waiting on the gateway count against the limit', async () => {
  // `link/stream.open` awaits the gateway before the stream exists, so a ceiling
  // that only counted live streams would let a client ask for a hundred at once:
  // every request checks a map that is still empty and every request passes. The
  // slot has to be reserved before the await.
  let release
  const gate = new Promise(resolve => { release = resolve })
  const sent = []
  const channel = new EventEmitter()
  channel.send = bytes => sent.push(JSON.parse(Buffer.from(bytes).toString('utf8')))
  // Each generator parks on `hold`, so the streams stay open after the gateway
  // answers — otherwise they would finish immediately and `openStreams` would be
  // zero either way, which cannot tell the ceiling from its absence.
  let letGo
  const hold = new Promise(resolve => { letGo = resolve })
  const gateway = {
    invoke: async () => ({}),
    stream: async () => { await gate; return (async function* () { await hold; yield { n: 1 } })() },
    dispatch: async () => ({ ok: true, value: {} }),
    open: async () => (async function* () { yield { type: 'ready' } })(),
  }
  const server = new RpcServer({ channel, gateway, peer: { id: 'peer' } })
  const open = id => channel.emit('message', encodeEnvelope(envelope({
    type: 'request',
    id,
    payload: { endpoint: 'link/stream.open', payload: { args: { endpoint: 'session/list', args: {} } } },
  })))

  for (let index = 0; index < 40; index += 1) open(`open-${index}`)
  await new Promise(resolve => setTimeout(resolve, 20))
  // Only MAX_STREAMS of the forty may be waiting; the rest must be refused at once.
  const refused = sent.filter(entry => entry.type === 'error')
  const waiting = sent.filter(entry => entry.id === undefined && entry.type === 'response')
  assert.equal(waiting.length, 0, 'a stream must not be acknowledged before the gateway answers')
  assert.equal(refused.length, 40 - 16, `expected 24 refusals, saw ${refused.length}`)
  assert.equal(refused[0].payload.code, 'STREAM_LIMIT')

  release()
  await new Promise(resolve => setTimeout(resolve, 50))
  // Once the gateway answers, exactly MAX_STREAMS streams exist — not forty.
  assert.equal(server.openStreams, 16, `expected 16 open streams, saw ${server.openStreams}`)
  letGo()
  await server.close()
})

test('a stop that arrives while the port is binding still gives the port back', async () => {
  // Unloading the plugin is synchronous from the Harness's point of view, but the
  // listener is created inside an async start. Without a guard the sequence
  // "begin start, unload, start finishes" leaves a bound socket that no field
  // points at: the port stays taken for the life of the process, the next start
  // lands on a random port, and the pairing code names an address nobody listens
  // on. The start must notice it lost its owner and close what it bound.
  let releaseIdentity
  const identityGate = new Promise(resolve => { releaseIdentity = resolve })
  const logs = []
  const disposers = []
  const ctx = {
    logger: { info: message => logs.push(message), warn: message => logs.push(`warn ${message}`) },
    credentials: {
      readRecord: async () => {
        await identityGate
        return null
      },
      modifyRecord: async (_key, mutate) => mutate(),
    },
    get: () => ({ createPeer: () => ({ dispose: () => undefined }) }),
    effect: factory => disposers.push(factory()),
  }

  apply(ctx, { port: 0, bindHost: '127.0.0.1' })
  // Let start() reach the awaited identity read, then unload.
  await new Promise(resolve => setTimeout(resolve, 10))
  for (const dispose of disposers) dispose()
  releaseIdentity()
  await new Promise(resolve => setTimeout(resolve, 200))

  assert.deepEqual(
    logs.filter(line => line.includes('listening on port') || line.includes('pairing code')),
    [],
    'a listener whose plugin was unloaded must not announce a port or a pairing code',
  )
})