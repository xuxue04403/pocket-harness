// A Host stand-in that joins a relay instead of listening on the LAN.
//
// Mirrors what the real plugin does when `relayUrl` is configured: dial out to
// the relay, hand each paired transport to the same link server the LAN path
// uses. Printing the ticket lets the Dart test connect with no LAN endpoint at
// all, which is the only way to prove the relay route really carries Noise.

import { randomBytes } from 'node:crypto'

import { LinkServer, pairingProof } from '../host/link.js'
import { encodeTicket } from '../host/pairing.js'
import { sha256, x25519PrivateToPublic } from '../host/noise.js'
import { newDeviceId } from '../host/ids.js'
import { RelayDialer } from '../host/relay-client.js'

const relayUrl = process.env.RELAY_URL
const relayToken = process.env.RELAY_TOKEN
if (typeof relayUrl !== 'string' || typeof relayToken !== 'string') {
  process.stderr.write('RELAY_URL and RELAY_TOKEN are required\n')
  process.exit(1)
}

const secret = 'test-pairing-secret'
const privateKey = sha256(Buffer.from('pocket-harness:test:host'))
const publicKey = x25519PrivateToPublic(privateKey)
const hostDeviceId = newDeviceId()
const hostName = 'Relay Host'
const room = randomBytes(16).toString('hex')

async function authorize({ connectionId, clientDeviceId, proof }) {
  if (typeof proof !== 'string') return { ok: false, reason: 'missing-proof' }
  const expected = pairingProof(secret, connectionId, clientDeviceId).toString('base64url')
  if (proof !== expected) return { ok: false, reason: 'bad-proof' }
  return {
    ok: true,
    pinnedKey: null,
    createPeer: async () => ({
      id: 'peer-under-test',
      principal: { kind: 'owner' },
      interactions: 'answer',
      signal: new AbortController().signal,
      dispose: async () => {},
    }),
    pinKey: async () => {},
  }
}

function createGateway(peer) {
  return {
    async invoke({ namespace, method, args }) {
      if (namespace === 'test' && method === 'echo') return { echoed: args, peer: peer.id }
      throw Object.assign(new Error(`no such endpoint ${namespace}/${method}`), { code: 'METHOD_NOT_FOUND' })
    },
    async stream({ namespace, method, args }) {
      if (namespace !== 'test' || method !== 'count') {
        throw Object.assign(new Error(`no such stream ${namespace}/${method}`), { code: 'METHOD_NOT_FOUND' })
      }
      const count = typeof args.count === 'number' ? args.count : 3
      return (async function* generate() {
        for (let index = 0; index < count; index++) yield { index }
      })()
    },
  }
}

const logger = {
  info: message => process.stderr.write(`${message}\n`),
  warn: message => process.stderr.write(`${message}\n`),
}

process.on('uncaughtException', error => process.stderr.write(`UNCAUGHT ${error?.stack ?? error}\n`))
process.on('unhandledRejection', error => process.stderr.write(`UNHANDLED ${error?.stack ?? error}\n`))

const server = new LinkServer({
  identity: { deviceId: hostDeviceId, privateKey, publicKey },
  createGateway,
  authorize,
  logger,
  hostName,
})

let served = 0
const dialer = new RelayDialer({
  url: relayUrl,
  room,
  token: relayToken,
  logger,
  onTransport: transport => {
    served += 1
    server.attach(transport)
  },
})
dialer.start()

// No LAN endpoint at all: the phone must go through the relay.
const ticket = encodeTicket({
  hostDeviceId,
  hostPublicKey: publicKey,
  hostName,
  lanEndpoints: [],
  relayUrl,
  relayRoom: room,
  relayToken,
  pairingSecret: secret,
  expiresAt: Date.now() + 10 * 60 * 1000,
})

process.stdout.write(`${JSON.stringify({ ticket, room })}\n`)

const shutdown = async () => {
  await dialer.close()
  await server.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
setTimeout(shutdown, Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000))

void served
