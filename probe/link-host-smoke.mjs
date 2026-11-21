// A Host stand-in for the integration test.
//
// Starts the real link server from host/link.js with a fake gateway, prints the
// pairing ticket as one JSON line, and serves the phone connection that follows.
// Using the real link server (not a stub) is the point: the Dart test then proves
// the two production implementations — packages/dsh_link and host/*.js — agree on
// the wire format, the Noise handshake and the RPC envelope.

import { randomBytes } from 'node:crypto'

import { LinkServer, pairingProof } from '../host/link.js'
import { encodeTicket } from '../host/pairing.js'
import { sha256, x25519PrivateToPublic } from '../host/noise.js'
import { newDeviceId } from '../host/ids.js'

const secret = 'test-pairing-secret'
const privateKey = sha256(Buffer.from('pocket-harness:test:host'))
const publicKey = x25519PrivateToPublic(privateKey)
const hostDeviceId = newDeviceId()
const hostName = 'Smoke Host'

/** Proof-checking admission, mirroring what the real plugin does. */
async function authorize({ connectionId, clientDeviceId, proof }) {
  if (typeof proof !== 'string') return { ok: false, reason: 'missing-proof' }
  const expected = pairingProof(secret, connectionId, clientDeviceId).toString('base64url')
  if (proof !== expected) return { ok: false, reason: 'bad-proof' }
  let disposed = false
  return {
    ok: true,
    pinnedKey: null,
    createPeer: async () => ({
      id: 'peer-under-test',
      principal: { kind: 'owner' },
      interactions: 'answer',
      signal: new AbortController().signal,
      dispose: async () => {
        disposed = true
      },
      get disposed() {
        return disposed
      },
    }),
    pinKey: async () => {},
  }
}

/** Every outcome the phone sent back for a forwarded question. */
const outcomes = []

/** A question the phone is expected to answer, standing in for an approval. */
const question = {
  type: 'waterfall',
  event: 'approval/request',
  eventId: 'evt-1',
  agentId: 'agent-under-test',
  request: { toolName: 'shell', reason: 'run a command' },
}

/**
 * Echo gateway: proves args and results survive both directions intact.
 *
 * The `dispatch`/`open` pair covers the Gateway's own `$events` endpoints, which
 * is how a phone answers approvals. `test/outcome` reads back what it answered.
 */
function createGateway(peer) {
  return {
    async invoke({ namespace, method, args }) {
      if (namespace === 'test' && method === 'echo') return { echoed: args, peer: peer.id }
      if (namespace === 'test' && method === 'outcome') return { outcomes: [...outcomes] }
      if (namespace === 'test' && method === 'fail') {
        const error = new Error('the requested method failed on purpose')
        error.code = 'TEST_FAILURE'
        error.details = { hint: 'expected' }
        throw error
      }
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
    async dispatch(endpoint, payload) {
      if (endpoint !== '$events/result') {
        return { ok: false, error: { code: 'METHOD_NOT_FOUND', message: `no such endpoint ${endpoint}`, details: {} } }
      }
      outcomes.push(payload.args)
      return { ok: true, value: { accepted: true } }
    },
    async open(endpoint) {
      if (endpoint !== '$events') throw new Error(`no such stream ${endpoint}`)
      return (async function* generate() {
        yield { type: 'ready', clientId: 'client-under-test', host: { home: '/home/test' } }
        yield question
      })()
    },
  }
}

const logger = {
  info: message => process.stderr.write(`${message}\n`),
  warn: message => process.stderr.write(`${message}\n`),
}

// A crash here would look like "connection refused" in the client, so make the
// real reason visible instead of letting the process die silently.
process.on('uncaughtException', error => {
  process.stderr.write(`UNCAUGHT ${error?.stack ?? error}\n`)
})
process.on('unhandledRejection', error => {
  process.stderr.write(`UNHANDLED ${error?.stack ?? error}\n`)
})

const server = new LinkServer({
  identity: { deviceId: hostDeviceId, privateKey, publicKey },
  createGateway,
  authorize,
  logger,
  hostName,
})

const port = await server.listen({ port: 0, host: '127.0.0.1' })
const ticket = encodeTicket({
  hostDeviceId,
  hostPublicKey: publicKey,
  hostName,
  lanEndpoints: [`127.0.0.1:${port}`],
  relayUrl: null,
  pairingSecret: secret,
  expiresAt: Date.now() + 10 * 60 * 1000,
})

process.stdout.write(`${JSON.stringify({ port, ticket })}\n`)

const shutdown = async () => {
  await server.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
setTimeout(shutdown, Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000))

// Silence the unused-import lint that a plain node script would otherwise trip.
void randomBytes
