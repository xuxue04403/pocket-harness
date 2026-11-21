/**
 * 中继协议的断言。
 *
 * 这些用例全部来自实测：每一条都对应一次真实的中继行为（或一次真实的误判）。
 * 它们存在的理由是——中继协议的一部分活在 `platform.ohos.ts` 里，而那份代码
 * 只能在鸿蒙设备上跑；把不依赖平台的那半段（编码与控制消息解析）搬到这里，
 * 才能在 CI 里钉住。
 */

import {
  MAX_RELAY_FRAME_BYTES,
  MAX_RELAY_TOKEN_LENGTH,
  RELAY_ERROR,
  RELAY_IGNORED,
  RELAY_JOINED,
  RELAY_PEER_GONE,
  RELAY_READY,
  describeRelayClose,
  describeRelayRefusal,
  encodeRelayHello,
  readRelayControl,
} from '../src/relay_protocol'
import type { JsonObject } from '../src/json'

let failures = 0
function check(name: string, run: () => void): void {
  try {
    run()
  } catch (error) {
    failures += 1
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`FAILED ${name}: ${message}\n`)
  }
}
function equal<T>(actual: T, expected: T, what: string): void {
  if (actual !== expected) throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`)
}
function throws(run: () => void, needle: string): void {
  try {
    run()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes(needle)) throw new Error(`wrong message: ${message}`)
    return
  }
  throw new Error('expected a throw')
}

// hello 的形状：中继只认这三个字段加版本号，多发字段它不介意，少发就分不到房间。
check('hello carries the version, role, room and token', () => {
  const text = encodeRelayHello('client', 'room-1', 'token-1')
  const parsed = JSON.parse(text) as JsonObject
  equal(parsed['v'], 1, 'version')
  equal(parsed['role'], 'client', 'role')
  equal(parsed['room'], 'room-1', 'room')
  equal(parsed['token'], 'token-1', 'token')
})

// Host 与手机说的是同一句话，只有 role 不同。
check('the host says the same hello with its own role', () => {
  const parsed = JSON.parse(encodeRelayHello('host', 'room-2', 'token-2')) as JsonObject
  equal(parsed['role'], 'host', 'role')
})

// 空房间名 / 空 token 是配置错误，不该发出去再被中继关掉。
check('an empty room or token is refused before sending', () => {
  throws(() => encodeRelayHello('client', '', 'token'), 'room must not be empty')
  throws(() => encodeRelayHello('client', 'room', ''), 'token must not be empty')
})

check('an over-long room or token is refused', () => {
  throws(() => encodeRelayHello('client', 'r'.repeat(129), 'token'), 'at most 128')
  throws(() => encodeRelayHello('client', 'room', 't'.repeat(MAX_RELAY_TOKEN_LENGTH + 1)), 'at most 256')
})

// 进房回执与配对成功是两件事——把它们混为一谈会让空房间自我重连。
check('ok:true is the joined receipt, not readiness', () => {
  const control = readRelayControl('{"v":1,"ok":true,"role":"client","paired":false}')
  equal(control.kind, RELAY_JOINED, 'kind')
})

check('type:ready is the peer arriving', () => {
  const control = readRelayControl('{"v":1,"type":"ready"}')
  equal(control.kind, RELAY_READY, 'kind')
})

check('type:peer-gone ends the link', () => {
  const control = readRelayControl('{"v":1,"type":"peer-gone"}')
  equal(control.kind, RELAY_PEER_GONE, 'kind')
})

// 拒绝**不在** JSON 通道上：中继用关闭帧。这条断言防止再为不存在的形状写分支。
check('a JSON refusal shape is not invented', () => {
  equal(readRelayControl('{"v":1,"ok":false,"code":4403,"message":"bad token"}').kind, RELAY_IGNORED, 'ok:false')
  equal(readRelayControl('{"v":1,"type":"error","message":"room full"}').kind, RELAY_IGNORED, 'type:error')
})

// 关闭帧是拒绝唯一到达的方式，必须带出码与原因。
check('a close frame carries the refusal', () => {
  const bad = describeRelayClose(4403, 'bad token')
  equal(bad.kind, RELAY_ERROR, 'kind')
  equal(bad.code, 4403, 'code')
  equal(bad.message, 'bad token', 'message')

  const busy = describeRelayClose(4409, 'a client is already in this room')
  equal(busy.code, 4409, 'code')

  const junk = describeRelayClose(4400, 'the first message must be a hello')
  equal(junk.code, 4400, 'code')
})

// 正常收尾不是错误，否则用户关掉电脑上的中继会看到"连接失败"。
check('a normal close is not an error', () => {
  equal(describeRelayClose(1000, '').kind, RELAY_PEER_GONE, 'code 1000')
  equal(describeRelayClose(1005, '').kind, RELAY_PEER_GONE, 'code 1005')
  equal(describeRelayClose(0, '').kind, RELAY_PEER_GONE, 'no code')
})

// 控制通道上的噪音不该变成用户可见的错误。
check('noise on the control channel is ignored, not fatal', () => {
  equal(readRelayControl('not json').kind, RELAY_IGNORED, 'plain text')
  equal(readRelayControl('[]').kind, RELAY_IGNORED, 'array')
  equal(readRelayControl('null').kind, RELAY_IGNORED, 'null')
  equal(readRelayControl('{"v":1}').kind, RELAY_IGNORED, 'no fields')
})

// 用户看到的那句话必须是能行动的。
check('every refusal code has actionable advice', () => {
  const bad = describeRelayRefusal({ kind: RELAY_ERROR, message: '', code: 4403 })
  const busy = describeRelayRefusal({ kind: RELAY_ERROR, message: '', code: 4409 })
  const slow = describeRelayRefusal({ kind: RELAY_ERROR, message: '', code: 4408 })
  const junk = describeRelayRefusal({ kind: RELAY_ERROR, message: '', code: 4400 })
  if (!bad.includes('relayToken')) throw new Error(`4403 advice: ${bad}`)
  if (!busy.includes('另一部手机')) throw new Error(`4409 advice: ${busy}`)
  if (!slow.includes('超时')) throw new Error(`4408 advice: ${slow}`)
  if (!junk.includes('版本')) throw new Error(`4400 advice: ${junk}`)
})

// 未知码要回落到中继自己给的话，而不是吞掉它。
check('an unknown code falls back to the relay message', () => {
  const text = describeRelayRefusal({ kind: RELAY_ERROR, message: 'go away', code: 4999 })
  equal(text, 'go away', 'fallback')
})

// 帧上限必须与中继一致，否则大消息会在中继那侧被切断而手机毫不知情。
check('the frame limit matches the relay', () => {
  equal(MAX_RELAY_FRAME_BYTES, 4 * 1024 * 1024 + 64, 'limit')
})

if (failures > 0) {
  process.stderr.write(`${failures} relay protocol checks failed\n`)
  process.exit(1)
}
process.stdout.write('ALL RELAY PROTOCOL CHECKS PASS (typescript core)\n')
