// Starts the relay from the environment, for a small VPS or a spare box.
//
// Required:
//   POCKET_HARNESS_RELAY_TOKEN  shared secret the Host and phone both hold
// Optional:
//   PORT                        default 8080
//   HOST                        default 0.0.0.0
//
// The token is what stops a stranger who guessed a room name from taking the
// slot, so there is no default: refusing to start is safer than starting open.

import { createRelay } from './server.mjs'

const token = process.env.POCKET_HARNESS_RELAY_TOKEN
if (typeof token !== 'string' || token.length < 16) {
  process.stderr.write('POCKET_HARNESS_RELAY_TOKEN must be at least 16 characters\n')
  process.exit(1)
}

const port = Number.parseInt(process.env.PORT ?? '8080', 10)
const host = process.env.HOST ?? '0.0.0.0'

const relay = createRelay({
  token,
  // Log only room labels and joins: no addresses, no identities, no payloads.
  log: message => process.stdout.write(`${new Date().toISOString()} ${message}\n`),
})

const bound = await relay.listen({ port, host })
process.stdout.write(`${new Date().toISOString()} relay listening on ${host}:${bound}\n`)

const shutdown = async signal => {
  process.stdout.write(`${new Date().toISOString()} ${signal}, closing\n`)
  await relay.close()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
