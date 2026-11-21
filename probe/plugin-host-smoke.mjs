// A Host stand-in that runs the *real* plugin entry point.
//
// `probe/link-host-smoke.mjs` proves the link layer works. This script goes one
// level up: it hands `host/index.js` a stand-in Cordis context, so the Dart test
// exercises the code that actually ships — identity persistence in the
// credentials service, ticket creation, proof checking, key pinning, and the
// adapter that forwards to the Typert gateway — instead of a hand-written
// imitation of it.
//
// The stand-in is deliberately small: it implements exactly the surface
// `host/index.js` touches, so a new dependency there fails loudly instead of
// being silently faked.

import { apply } from '../host/index.js'

/** In-memory replacement for `ctx.credentials`, keyed like the real service. */
const records = new Map()
const cleanups = []
let announce
const announced = new Promise(resolve => {
  announce = resolve
})

/** The Peer the plugin asks the connection service for. */
function createPeer({ principal, interactions }) {
  return {
    id: 'peer-under-test',
    principal,
    interactions,
    signal: new AbortController().signal,
    dispose: async () => {},
  }
}

/** A gateway that echoes what it was given, so the wire round trip is visible. */
const gateway = {
  async invoke({ namespace, method, args, peer }) {
    if (namespace === 'test' && method === 'echo') {
      return { echoed: args, peer: peer.id, principal: peer.principal.kind, interactions: peer.interactions }
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

apply(ctx, { port: 0, bindHost: '127.0.0.1', hostName: 'Plugin Smoke Host' })

const ticket = await Promise.race([
  announced,
  new Promise((_, reject) => setTimeout(() => reject(new Error('the plugin never announced a pairing code')), 15_000)),
])

process.stdout.write(`${JSON.stringify({ ticket })}\n`)

const shutdown = async () => {
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup?.()
    } catch {
      // A cleanup that fails must not keep the process alive.
    }
  }
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
setTimeout(shutdown, Number(process.env.SMOKE_TIMEOUT_MS ?? 90_000))
