/**
 * 配对码文本的断言。
 *
 * 这里要钉住的是「脏输入」：从电脑日志里复制出来的整行、带引号的、带标点的、
 * 只复制了一半的。每一种在界面上的说法都不一样，说错就会让用户以为码坏了。
 */

import { encodeTicket, type PairingTicket } from '../src/pairing'
import {
  describeTicket,
  findTicket,
  looksLikeTicket,
  readTicketText,
  remainingLabel,
  ticketRemainingMs,
  TICKET_PREFIX,
} from '../src/pairing_text'

let failures = 0

function eq(label: string, actual: string, expected: string): void {
  if (actual === expected) {
    console.log(`  ok  ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`)
}

function ok(label: string, condition: boolean): void {
  eq(label, condition ? 'true' : 'false', 'true')
}

const NOW = 1_800_000_000_000

function ticket(overrides: Partial<PairingTicket> = {}): PairingTicket {
  return {
    version: 1,
    hostDeviceId: '018f3a1c-4d2b-7c3e-8f00-2b4d6e8a0c1d',
    hostPublicKey: new Uint8Array(32).fill(9),
    hostName: 'Pocket Harness Host',
    lanEndpoints: ['192.168.1.5:48100'],
    relayUrl: null,
    relayRoom: null,
    relayToken: null,
    pairingSecret: 'secret-value',
    expiresAt: NOW + 5 * 60 * 1000,
    ...overrides,
  }
}

function checkFind(): void {
  const code = encodeTicket(ticket())

  eq('a bare code is found', findTicket(code) ?? '', code)
  eq('surrounding words do not matter', findTicket(`pair me with ${code} please`) ?? '', code)

  // 真实日志行的形状：整行复制是最常见的情形。
  const logLine = `2026-11-22T04:00:00.000+08:00 INFO  pocket-harness pocket-harness: pairing code ${code}`
  eq('a whole log line yields just the code', findTicket(logLine) ?? '', code)

  // 行尾标点必须被截掉：用它当载荷会解出乱码，报错还指不到真正的原因。
  eq('trailing punctuation is dropped', findTicket(`${code}.`) ?? '', code)
  eq('a closing quote is dropped', findTicket(`"${code}"`) ?? '', code)
  eq('a trailing comma is dropped', findTicket(`${code},`) ?? '', code)

  eq('no prefix means no code', findTicket('hello') ?? '', '')
  eq('an empty payload is not a code', findTicket(TICKET_PREFIX) ?? '', '')
  eq('an empty string yields nothing', findTicket('') ?? '', '')

  // 第一个码优先：两个码接在一起时，不能把它们粘成一个。
  const two = `${code} ${code}`
  eq('the first of two codes wins', findTicket(two) ?? '', code)

  ok('looksLikeTicket sees a code', looksLikeTicket(code))
  ok('looksLikeTicket rejects prose', !looksLikeTicket('just some words'))
}

function checkRead(): void {
  const code = encodeTicket(ticket())
  const read = readTicketText(`pairing code ${code}`)
  ok('a good code decodes', read.ticket !== null)
  eq('a good code reports no problem', read.problem, '')
  eq('the decoded host name survives', read.ticket?.hostName ?? '', 'Pocket Harness Host')
  eq('the decoded LAN endpoint survives', read.ticket?.lanEndpoints[0] ?? '', '192.168.1.5:48100')

  const missing = readTicketText('I copied the wrong thing')
  ok('missing text yields no ticket', missing.ticket === null)
  ok('missing text explains the prefix', missing.problem.includes('pocketharness://pair?t='))

  // 截断：把末几位切掉，base64 解出来的不是合法 JSON。
  const truncated = readTicketText(code.slice(0, code.length - 12))
  ok('a truncated code yields no ticket', truncated.ticket === null)
  ok('a truncated code says it is half-copied', truncated.problem.includes('只复制到一半'))

  // 形状对但内容被改：解出 JSON，缺 id。
  const broken = `${TICKET_PREFIX}aGVsbG8`
  const wrong = readTicketText(broken)
  ok('a non-ticket payload yields no ticket', wrong.ticket === null)
  ok('a non-ticket payload says it is unreadable', wrong.problem.length > 0)
}

function checkDescribe(): void {
  const live = ticket()
  eq(
    'a live ticket names the host and the address',
    describeTicket(live, NOW),
    'Pocket Harness Host · 192.168.1.5:48100 · 配对码现在有效',
  )

  const expired = ticket({ expiresAt: NOW - 1000 })
  ok(
    'an expired ticket still names the host',
    describeTicket(expired, NOW).includes('配对码已过期，但已配对的手机仍能连'),
  )

  const relayOnly = ticket({ lanEndpoints: [], relayUrl: 'ws://relay.example/relay' })
  ok('a relay-only ticket says so', describeTicket(relayOnly, NOW).includes('经中继'))

  const nowhere = ticket({ lanEndpoints: [], relayUrl: null })
  ok('a ticket with no address says so', describeTicket(nowhere, NOW).includes('没有可用地址'))
}

function checkCountdown(): void {
  eq('a live ticket counts down', remainingLabel(ticketRemainingMs(ticket(), NOW)), '还剩 5 分钟')
  eq('under a minute shows seconds', remainingLabel(ticketRemainingMs(ticket({ expiresAt: NOW + 42_000 }), NOW)), '还剩 42 秒')
  eq('a lapsed ticket says expired', remainingLabel(ticketRemainingMs(ticket({ expiresAt: NOW - 1 }), NOW)), '已过期')
  eq('a never-expiring ticket says so', remainingLabel(ticketRemainingMs(ticket({ expiresAt: 0 }), NOW)), '不过期')
}

function main(): void {
  console.log('pairing text')
  checkFind()
  checkRead()
  checkDescribe()
  checkCountdown()
  if (failures > 0) {
    console.log(`FAILED: ${failures} pairing text check(s)`)
    process.exit(1)
  }
  console.log('ALL PAIRING TEXT CHECKS PASS (typescript core)')
}

main()
