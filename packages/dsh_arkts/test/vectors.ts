// 金标向量：把 fixture 里的静态密钥、临时密钥、prologue 喂给本实现，
// 逐字节比对握手消息与传输密文。
//
// 这套向量来自 ds-harness-remote 的 fixtures/crypto/v1/noise-ik.json（MIT），
// 与 Dart 侧 `packages/dsh_link/test/noise_vector_test.dart`、Node 侧
// `probe/noise_vector.mjs` 读的是同一份数据 —— 三端同时绿，才说明协议真的互通。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { decodeBase64Url, encodeBase64Url, utf8 } from '../src/bytes'
import { NoiseIkSession, createNoisePrologue } from '../src/noise'
import { x25519PublicKey } from '../src/curve25519'

const here = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(here, '..', '..', '..', 'probe', 'noise-fixture.b64')

const failures: string[] = []

function check(label: string, actual: string, expected: string): void {
  if (actual === expected) {
    console.log(`  ok   ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL ${label}\n       actual   ${actual}\n       expected ${expected}`)
  }
}

function fixedRandom(bytesBase64Url: string) {
  const bytes = decodeBase64Url(bytesBase64Url)
  return (length: number): Uint8Array => {
    if (length !== bytes.length) throw new Error(`the fixture supplies ${bytes.length} bytes, asked for ${length}`)
    return bytes
  }
}

const raw = readFileSync(fixturePath, 'utf8').trim()
const fixture = JSON.parse(Buffer.from(decodeBase64Url(raw)).toString('utf8'))

console.log(`fixture ${fixture.fixtureFormat} v${fixture.fixtureFormatVersion}, suite ${fixture.suite}`)

for (const vector of fixture.vectors) {
  console.log(`\nvector ${vector.name}`)

  const prologue = createNoisePrologue(
    vector.prologue.connectionId,
    vector.prologue.hostDeviceId,
    vector.prologue.clientDeviceId,
  )
  check('prologue bytes', encodeBase64Url(prologue), vector.prologue.bytes)

  const initiatorPrivate = decodeBase64Url(vector.staticKeys.initiator.privateKey)
  const initiatorPublic = decodeBase64Url(vector.staticKeys.initiator.publicKey)
  const responderPrivate = decodeBase64Url(vector.staticKeys.responder.privateKey)
  const responderPublic = decodeBase64Url(vector.staticKeys.responder.publicKey)

  check('initiator public key', encodeBase64Url(x25519PublicKey(initiatorPrivate)), vector.staticKeys.initiator.publicKey)
  check('responder public key', encodeBase64Url(x25519PublicKey(responderPrivate)), vector.staticKeys.responder.publicKey)

  const initiator = new NoiseIkSession({
    role: 'initiator',
    localPrivateKey: initiatorPrivate,
    localPublicKey: initiatorPublic,
    remotePublicKey: responderPublic,
    prologue,
    random: fixedRandom(vector.ephemeralPrivateKeys.initiator),
  })
  const responder = new NoiseIkSession({
    role: 'responder',
    localPrivateKey: responderPrivate,
    localPublicKey: responderPublic,
    remotePublicKey: initiatorPublic,
    prologue,
    random: fixedRandom(vector.ephemeralPrivateKeys.responder),
  })

  const messageOne = initiator.writeHandshake(decodeBase64Url(vector.handshake.message1.payload))
  check('handshake message one', encodeBase64Url(messageOne), vector.handshake.message1.message)

  const payloadOne = responder.readHandshake(messageOne)
  check('message one payload', encodeBase64Url(payloadOne), vector.handshake.message1.payload)

  const messageTwo = responder.writeHandshake(decodeBase64Url(vector.handshake.message2.payload))
  check('handshake message two', encodeBase64Url(messageTwo), vector.handshake.message2.message)

  const payloadTwo = initiator.readHandshake(messageTwo)
  check('message two payload', encodeBase64Url(payloadTwo), vector.handshake.message2.payload)

  check('initiator complete', String(initiator.complete), 'true')
  check('responder complete', String(responder.complete), 'true')
  check('responder learned the initiator static', encodeBase64Url(responder.peerStatic!), vector.staticKeys.initiator.publicKey)

  const counters = vector.countersAfterHandshake
  check('initiator counters after handshake', `${initiator.sentCounter}/${initiator.receivedCounter}`, `${counters.initiatorSending}/${counters.initiatorReceiving}`)
  check('responder counters after handshake', `${responder.sentCounter}/${responder.receivedCounter}`, `${counters.responderSending}/${counters.responderReceiving}`)

  for (const step of vector.transport) {
    const plaintext = decodeBase64Url(step.plaintext)
    const sender = step.sender === 'initiator' ? initiator : responder
    const receiver = step.sender === 'initiator' ? responder : initiator
    const sealed = sender.encrypt(plaintext)
    check(`${step.sender} transport ciphertext`, encodeBase64Url(sealed), step.ciphertext)
    const opened = receiver.decrypt(sealed)
    check(`${step.sender} transport round trip`, encodeBase64Url(opened), step.plaintext)
    const after = step.countersAfter
    check(
      `${step.sender} counters after transport`,
      `${initiator.sentCounter}/${initiator.receivedCounter}/${responder.sentCounter}/${responder.receivedCounter}`,
      `${after.initiatorSending}/${after.initiatorReceiving}/${after.responderSending}/${after.responderReceiving}`,
    )
  }

  // 篡改必然被拒：这是 AEAD 的全部意义。
  const tampered = new Uint8Array(initiator.encrypt(utf8('tamper me')))
  tampered[tampered.length - 1] ^= 0x01
  let rejected = false
  try {
    responder.decrypt(tampered)
  } catch {
    rejected = true
  }
  check('a flipped bit is rejected', String(rejected), 'true')
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nALL NOISE VECTORS PASS (typescript core)')
