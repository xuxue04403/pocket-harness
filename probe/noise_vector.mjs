// Replays fixtures/crypto/v1/noise-ik.json against host/noise.js.
//
// The fixture is the shared golden vector for the secure channel: it lists a
// deterministic handshake and deterministic transport messages. If the Host's
// responder produces different bytes, no client can open its channel, so this
// probe is the guard rail for every future edit of host/noise.js.
//
// Run with the DSH electron binary in node mode:
//   ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" probe/noise_vector.mjs

import { readFileSync } from 'node:fs'
import { NoiseIkResponder, createNoisePrologue, sha256 } from '../host/noise.js'

const fixturePath = new URL('../ref/ds-harness-remote/fixtures/crypto/v1/noise-ik.json', import.meta.url)
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
const vector = fixture.vectors[0]

const b64 = value => Buffer.from(value, 'base64url')
const b64u = bytes => Buffer.from(bytes).toString('base64url')

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) {
    failures += 1
    console.log(`FAIL ${label}\n  expected ${expected}\n  actual   ${actual}`)
  } else {
    console.log(`ok   ${label}`)
  }
}

// The prologue is derived, not stored, so derivation itself is under test.
check(
  'prologue bytes',
  b64u(createNoisePrologue(
    vector.prologue.connectionId,
    vector.prologue.hostDeviceId,
    vector.prologue.clientDeviceId,
  )),
  vector.prologue.bytes,
)

const responderEphemeral = b64(vector.ephemeralPrivateKeys.responder)
const responder = new NoiseIkResponder({
  localPrivateKey: b64(vector.staticKeys.responder.privateKey),
  localPublicKey: b64(vector.staticKeys.responder.publicKey),
  expectedRemoteStatic: b64(vector.staticKeys.initiator.publicKey),
  prologue: createNoisePrologue(
    vector.prologue.connectionId,
    vector.prologue.hostDeviceId,
    vector.prologue.clientDeviceId,
  ),
  // The fixture's ephemeral is what makes message two reproducible.
  random: length => {
    if (length !== responderEphemeral.length) throw new Error(`unexpected random request of ${length} bytes`)
    return responderEphemeral
  },
})

const payloadOne = responder.readHandshakeMessage(b64(vector.handshake.message1.message))
check('message one payload', b64u(payloadOne), vector.handshake.message1.payload)

const messageTwo = responder.writeHandshakeMessage(b64(vector.handshake.message2.payload))
check('message two bytes', b64u(messageTwo), vector.handshake.message2.message)
check('responder sending counter', String(responder.sendingCounter), vector.countersAfterHandshake.responderSending)
check('responder receiving counter', String(responder.receivingCounter), vector.countersAfterHandshake.responderReceiving)

// Each transport entry names its sender, and the sending and receiving keys are
// different: initiator-sent ciphertext is opened here, responder-sent ciphertext
// is reproduced here. Both directions must match the fixture byte for byte.
for (const [index, item] of vector.transport.entries()) {
  if (item.sender === 'initiator') {
    const opened = responder.decrypt(b64(item.ciphertext))
    check(`transport ${index} plaintext`, b64u(opened), item.plaintext)
  } else {
    const sealed = responder.encrypt(b64(item.plaintext))
    check(`transport ${index} ciphertext`, b64u(sealed), item.ciphertext)
  }
  const counters = item.countersAfter
  check(
    `transport ${index} counters`,
    `${responder.sendingCounter}/${responder.receivingCounter}`,
    `${counters.responderSending}/${counters.responderReceiving}`,
  )
}

check(
  'fixture suite',
  fixture.suite,
  'Noise_IK_25519_ChaChaPoly_SHA256',
)

// A tampered message must fail authentication rather than yield garbage.
const tampered = Buffer.from(b64(vector.handshake.message1.message))
tampered[tampered.length - 1] ^= 0xff
const second = new NoiseIkResponder({
  localPrivateKey: b64(vector.staticKeys.responder.privateKey),
  localPublicKey: b64(vector.staticKeys.responder.publicKey),
  expectedRemoteStatic: b64(vector.staticKeys.initiator.publicKey),
  prologue: createNoisePrologue(
    vector.prologue.connectionId,
    vector.prologue.hostDeviceId,
    vector.prologue.clientDeviceId,
  ),
})
let rejected = false
try {
  second.readHandshakeMessage(tampered)
} catch (error) {
  rejected = error.code === 'NOISE_DECRYPT_FAILED'
}
check('tampered message rejected', String(rejected), 'true')

// A responder that pins a different static key must refuse the initiator.
const third = new NoiseIkResponder({
  localPrivateKey: b64(vector.staticKeys.responder.privateKey),
  localPublicKey: b64(vector.staticKeys.responder.publicKey),
  expectedRemoteStatic: sha256(Buffer.alloc(32)),
  prologue: createNoisePrologue(
    vector.prologue.connectionId,
    vector.prologue.hostDeviceId,
    vector.prologue.clientDeviceId,
  ),
})
let mismatched = false
try {
  third.readHandshakeMessage(b64(vector.handshake.message1.message))
} catch (error) {
  mismatched = error.code === 'PEER_IDENTITY_MISMATCH'
}
check('pinned identity enforced', String(mismatched), 'true')

console.log(failures === 0 ? 'ALL NOISE VECTORS PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
