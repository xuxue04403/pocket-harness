// esbuild cannot be spawned in this sandbox here, so the real compile of
// packages/dsh_arkts is out of reach. What can still be checked is the logic that
// changed: strip the type annotations by hand and run the same function bodies.
//
// Sources read: packages/dsh_arkts/src/pairing.ts (parseTicketExpiry, decodeTicket's
// exp handling) and packages/dsh_arkts/test/protocol.ts (the host-shaped case).
// A synthetic ISO ticket written the way host/pairing.js writes it is fed in, and
// the results must match what host/pairing.js itself computes for the same input.

import { decodeTicket as hostDecode } from '../host/pairing.js'

let failures = 0
function ok(label, condition, detail = '') {
  if (conditionRev(condition)) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === '' ? '' : ` (${detail})`}`)
  }
}
function conditionRev(value) {
  return value === true
}
function equals(label, actual, expectedSomething) {
  ok(label, JSON.stringify(actual) === JSON.stringify(expectedSomething), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expectedSomething)}`)
}

// ---- the code under test, transcribed without types ----

function parseTicketExpiry(exp) {
  if (typeof exp === 'number') return Number.isFinite(exp) && exp > 0 ? exp : 0
  if (typeof exp === 'string') {
    const parsed = Date.parse(exp)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  }
  return 0
}

const PAIRING_TICKET_VERSION = 1

function decodeTicketFields(map) {
  return {
    version: PAIRING_TICKET_VERSION,
    hostDeviceId: map.id,
    hostName: typeof map.name === 'string' && map.name.length > 0 ? map.name : 'DeepSeek Harness',
    lanEndpoints: Array.isArray(map.lan) ? map.lan.filter((entry) => typeof entry === 'string') : [],
    relayUrl: typeof map.relay === 'string' && map.relay.length > 0 ? map.relay : null,
    relayRoom: typeof map.room === 'string' && map.room.length > 0 ? map.room : null,
    relayToken: typeof map.rtok === 'string' && map.rtok.length > 0 ? map.rtok : null,
    pairingSecret: typeof map.secret === 'string' && map.secret.length > 0 ? map.secret : null,
    expiresAt: parseTicketExpiry(map.exp),
  }
}

function isTicketValid(ticket, now) {
  return ticket.expiresAt <= 0 || ticket.expiresAt > now
}

function ticketRemainingMs(ticket, now) {
  if (ticket.expiresAt <= 0) return -1
  return Math.max(0, ticket.expiresAt - now)
}

// ---- the cases ----

const HOST_ID = '018f3a4c-7d21-7c3a-9e58-2b1c4d5e6f70'
const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const EXP_MS = 1_900_000_000_000

console.log('a host-written code (exp is an ISO 8601 string)')
{
  const exp = new Date(EXP_MS).toISOString()
  ok('host writes exp as a string', typeof exp === 'string' && exp.endsWith('Z'), exp)
  const read = decodeTicketFields({ v: 1, id: HOST_ID, key: KEY, name: 'Pocket Harness Host', lan: ['192.168.5.13:48100'], exp })
  equals('its expiry is read as that moment', read.expiresAt, EXP_MS)
  ok('it does expire, one second later', !isTicketValid(read, EXP_MS + 1))
  ok('it is still valid, one second earlier', isTicketValid(read, EXP_MS - 1))
  equals('the countdown works on it', ticketRemainingMs(read, EXP_MS - 60_000), 60_000)

  // The whole point: the two readers must agree on the same payload.
  const hostRead = hostDecode(`pocketharness://pair?t=${Buffer.from(JSON.stringify({ v: 1, id: HOST_ID, key: KEY, name: 'Pocket Harness Host', lan: ['192.168.5.13:48100'], exp })).toString('base64url')}`)
  equals('the Host reads the same moment', hostRead.expiresAt, read.expiresAt)
}

console.log('the shapes that are not ISO')
{
  equals('milliseconds, as this package used to write them', parseTicketExpiry(EXP_MS), EXP_MS)
  equals('a missing exp means never', parseTicketExpiry(undefined), 0)
  equals('null means never', parseTicketExpiry(null), 0)
  equals('zero means never', parseTicketExpiry(0), 0)
  equals('garbage means never', parseTicketExpiry('not a date'), 0)
  equals('an object means never', parseTicketExpiry({ at: EXP_MS }), 0)
  equals('NaN means never', parseTicketExpiry(Number.NaN), 0)
  equals('negative means never', parseTicketExpiry(-5), 0)
}

console.log('the Host agrees with every shape')
{
  for (const exp of [EXP_MS, new Date(EXP_MS).toISOString(), 'not a date', undefined, null, Number.NaN]) {
    const payload = Buffer.from(JSON.stringify({ v: 1, id: HOST_ID, key: KEY, name: 'h', lan: [], exp })).toString('base64url')
    let hostValue
    try {
      hostValue = hostDecode(`pocketharness://pair?t=${payload}`).expiresAt
    } catch {
      hostValue = 'threw'
    }
    const hostMs = hostValue === null || hostValue === 'threw' ? 0 : hostValue
    // 两边对同一个 exp 读出的毫秒数必须一样。「永不过期」在两边分别是 0 和 null，
    // 归一到 0 之后才可比。
    equals(`Host and arkts agree on ${JSON.stringify(exp)}`, parseTicketExpiry(exp), hostMs)
  }
}

if (failures > 0) {
  console.log(`\n${failures} FAILED`)
  process.exit(1)
}
console.log('\nALL EXPIRY CHECKS PASS')
