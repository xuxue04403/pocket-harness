// Unit checks for the Host-side pieces that do not need a running Harness.
//
// The link and plugin integration tests already cover the happy path end to end.
// These pin the smaller contracts those tests cannot reach cheaply: pairing-code
// expiry, identifier shape, fragment limits, and the record-key validation that
// has to match the credentials service without importing it.
//
// Run with: node --test host

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { credentialKey, parseCredentialKey } from './credentials-key.js'
import { Fragment, Reassembler, decodeFrame, encodeFrame, FRAME_KIND } from './frames.js'
import { isDeviceId, newDeviceId, newMessageId } from './ids.js'
import { createTicket, decodeTicket, encodeTicket, isTicketValid } from './pairing.js'
import { NoiseIkResponder, createNoisePrologue, x25519PrivateToPublic } from './noise.js'
import { open, seal } from './chacha20_poly1305.js'

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
