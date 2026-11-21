// The Host stand-in again, but joined to a relay instead of a LAN listener.
//
// `plugin-host-smoke.mjs` proves the plugin works over a socket this process
// accepted. This script proves the *outbound* half: the same plugin entry point
// dials a relay, the relay hands the paired phone to the link server, and the
// whole ticket — room, token, endpoint — is what a phone needs when there is no
// route between the two networks.
//
// The relay is the real one from `relay/server.mjs`, listening on an ephemeral
// port in this same process, so the test does not need a deployed server to
// cover the code path a deployed server would exercise.

import { apply } from '../host/index.js'
import { createRelay } from '../relay/server.mjs'

const records = new Map()
const cleanups = []
let announce
const announced = new Promise(resolve => {
  announce = resolve
})

function createPeer({ principal, interactions }) {
  return {
    id: 'peer-under-test',
    principal,
    interactions,
    signal: new AbortController().signal,
    dispose: async () => {},
  }
}

const gateway = {
  async invoke({ namespace, method, args, peer }) {
    if (namespace === 'test' && method === 'echo') {
      return { echoed: args, peer: peer.id, principal: peer.principal.kind }
    }
    if (namespace === 'test' && method === 'fail') {
      throw Object.assign(new Error('the requested method failed on purpose'), {
        code: 'TEST_FAILURE',
        details: { hint: 'expected' },
      })
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
}

const RELAY_TOKEN = 'plugin-relay-smoke-token-0123456789'

const relay = createRelay({ token: RELAY_TOKEN })
const relayPort = await relay.listen({ port: 0, host: process.env.RELAY_BIND ?? '127.0.0.1' })

const ctx = {
  logger: {
    info: message => {
      process.stderr.write(`${message}\n`)
      const start = message.indexOf('pocketharness://')
      if (start >= 0) announce(message.slice(start).trim())
    },
    warn: message => process.stderr.write(`${message}\n`),
  },
  credentials: {
    async readRecord(key) {
      return records.get(key)
    },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key))
      if (next !== undefined) records.set(key, next)
      return records.get(key)
    },
  },
  get(name) {
    if (name === 'connection') return { createPeer }
    return undefined
  },
  typertGateway: gateway,
  effect(register) {
    const dispose = register()
    cleanups.push(dispose)
    return dispose
  },
}

process.on('uncaughtException', error => {
  process.stderr.write(`UNCAUGHT ${error?.stack ?? error}\n`)
})
process.on('unhandledRejection', error => {
  process.stderr.write(`UNHANDLED ${error?.stack ?? error}\n`)
})

// `OMIT_RELAY_TOKEN=1` reproduces the misconfiguration: an address without the
// shared secret. The plugin must keep the LAN listener and refuse to advertise a
// relay, instead of inventing a token the relay would reject forever.
const misconfigured = process.env.OMIT_RELAY_TOKEN === '1'
apply(ctx, {
  port: 0,
  bindHost: '127.0.0.1',
  hostName: 'Plugin Relay Host',
  relayUrl: `ws://${process.env.RELAY_BIND ?? "127.0.0.1"}:${relayPort}/relay`,
  ...(misconfigured ? {} : { relayToken: RELAY_TOKEN }),
})

const ticket = await Promise.race([
  announced,
  new Promise((_, reject) => setTimeout(() => reject(new Error('the plugin never announced a pairing code')), 15_000)),
])

process.stdout.write(`${JSON.stringify({ ticket, relayPort })}\n`)

const shutdown = async () => {
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup?.()
    } catch {
      // A cleanup that fails must not keep the process alive.
    }
  }
  await relay.close().catch(() => {})
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
setTimeout(shutdown, Number(process.env.SMOKE_TIMEOUT_MS ?? 90_000))
