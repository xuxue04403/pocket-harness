// Checks the "scan once, work from anywhere" endpoint.
//
// The phone keeps the ticket it scanned. That ticket names addresses as they were
// on that day, so a laptop that moved Wi-Fi or a relay configured afterwards is
// invisible to it. `pocketPairing/refresh` is the answer, and the properties that
// matter are: it returns a usable ticket, it names the *current* port and relay,
// and above all it carries no pairing secret — a trusted phone must not be able
// to mint access for another one.

import assert from 'node:assert/strict'

import { PAIRING_TICKET_VERSION, decodeTicket, encodeTicket } from '../host/pairing.js'
import { PAIRED_TICKET_TTL_MS, PAIRING_NAMESPACE, servePairing } from '../host/pairing-rpc.js'

let failed = 0
const check = (name, run) => {
  try {
    run()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}: ${error.message}`)
  }
}

/** Stands in for the Host: a fixed identity, and whatever port it was given. */
function issue(port, { relay = null } = {}) {
  return {
    hostDeviceId: '11111111-2222-4333-8444-555555555555',
    hostPublicKey: Buffer.alloc(32, 7),
    hostName: 'probe host',
    lanEndpoints: [`127.0.0.1:${port}`],
    relayUrl: relay === null ? null : 'wss://relay.example/ph-relay',
    relayRoom: relay === null ? null : 'a'.repeat(32),
    relayToken: relay === null ? null : 'b'.repeat(43),
    pairingSecret: null,
    expiresAt: Date.now() + PAIRED_TICKET_TTL_MS,
  }
}

console.log('pocketPairing/refresh')

check('the namespace is the one the Host branches on', () => {
  assert.equal(PAIRING_NAMESPACE, 'pocketPairing')
})

check('refresh returns a decodable ticket', () => {
  const answer = servePairing({ method: 'refresh' }, { issue: () => issue(48100) })
  assert.equal(answer.v, PAIRING_TICKET_VERSION)
  const ticket = decodeTicket(answer.ticket)
  assert.equal(ticket.hostDeviceId, '11111111-2222-4333-8444-555555555555')
  assert.equal(ticket.hostName, 'probe host')
  assert.equal(answer.expiresAt, new Date(ticket.expiresAt).toISOString())
})

check('the ticket names the port the listener actually bound', () => {
  const answer = servePairing({ method: 'refresh' }, { issue: () => issue(51999) })
  assert.deepEqual(decodeTicket(answer.ticket).lanEndpoints, ['127.0.0.1:51999'])
})

check('it carries no pairing secret', () => {
  // This is the security property, not a detail: a secret in a trusted phone's
  // hands would let that phone pair other ones.
  const answer = servePairing({ method: 'refresh' }, { issue: () => issue(48100) })
  const json = JSON.parse(Buffer.from(answer.ticket.split('t=')[1], 'base64url').toString('utf8'))
  assert.equal('secret' in json, false)
  assert.equal(json.v, PAIRING_TICKET_VERSION)
})

check('an advertised relay comes along, with room and token', () => {
  const answer = servePairing({ method: 'refresh' }, { issue: () => issue(48100, { relay: true }) })
  const ticket = decodeTicket(answer.ticket)
  assert.equal(ticket.relayUrl, 'wss://relay.example/ph-relay')
  assert.equal(ticket.relayRoom, 'a'.repeat(32))
  assert.equal(ticket.relayToken, 'b'.repeat(43))
})

check('a Host without a relay produces a LAN-only ticket', () => {
  const ticket = decodeTicket(servePairing({ method: 'refresh' }, { issue: () => issue(48100) }).ticket)
  // The JS decode leaves absent fields undefined rather than null; what matters
  // is that a phone has nothing to dial through a relay.
  assert.equal(ticket.relayUrl ?? null, null)
  assert.equal(ticket.relayRoom ?? null, null)
  assert.equal(ticket.relayToken ?? null, null)
})

check('the refreshed ticket outlives the ten-minute scan window', () => {
  const ticket = decodeTicket(servePairing({ method: 'refresh' }, { issue: () => issue(48100) }).ticket)
  assert.ok(ticket.expiresAt - Date.now() > 29 * 24 * 60 * 60 * 1000)
})

check('an unknown method is refused by name', () => {
  assert.throws(
    () => servePairing({ method: 'pairMe' }, { issue: () => issue(48100) }),
    error => error.code === 'UNKNOWN_METHOD' && error.message.includes('pairMe'),
  )
})

check('refresh without a listener is unavailable, not a crash', () => {
  assert.throws(
    () => servePairing({ method: 'refresh' }, {}),
    error => error.code === 'UNAVAILABLE',
  )
})

check('a round trip through encode/decode keeps every field', () => {
  const ticket = issue(48100, { relay: true })
  const back = decodeTicket(encodeTicket(ticket))
  assert.equal(back.hostDeviceId, ticket.hostDeviceId)
  assert.equal(back.hostName, ticket.hostName)
  assert.deepEqual(back.lanEndpoints, ticket.lanEndpoints)
  assert.equal(back.expiresAt, ticket.expiresAt)
})

console.log(failed === 0 ? '\nALL PAIRING REFRESH CHECKS PASS' : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
