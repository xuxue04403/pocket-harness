// 长度前缀切帧的自检。
//
// 这条逻辑两端都用（Node 的 test/live.ts 与鸿蒙的 platform.ohos.ts），而它最容易
// 出错的地方全在边界上：一次回调里来了半帧、一次来了两帧半、长度前缀声称的长度
// 超过上限。鸿蒙那边只能靠编译 + 设备运行验证，所以纯函数部分必须在这里钉死。

import { FrameSplitter, MAX_FRAMED_BYTES, frameWithLength } from '../src/framing'

const failures: string[] = []

function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures.push(label)
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

function bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i)
  return out
}

function text(value: Uint8Array): string {
  let out = ''
  for (let i = 0; i < value.length; i++) out += String.fromCharCode(value[i])
  return out
}

function joined(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function checkFraming(): void {
  const splitter = new FrameSplitter()
  const one = frameWithLength(bytes('hello'))
  const two = frameWithLength(bytes('world'))

  // 一整块里有两条帧。
  const both = splitter.push(joined([one, two]))
  ok('two frames in one chunk come out whole', both.length === 2, `saw ${both.length}`)
  ok('the first frame is decoded', both.length > 0 && text(both[0]) === 'hello')
  ok('the second frame is decoded', both.length > 1 && text(both[1]) === 'world')
  ok('nothing is left pending', splitter.pending === 0, `pending ${splitter.pending}`)

  // 一条帧被拆成三段喂进来。
  const drip = new FrameSplitter()
  const frame = frameWithLength(bytes('a longer payload to split'))
  const first = drip.push(frame.subarray(0, 2))
  const second = drip.push(frame.subarray(2, 10))
  const third = drip.push(frame.subarray(10))
  ok('a partial length prefix yields nothing', first.length === 0)
  ok('a partial body yields nothing', second.length === 0)
  ok('the last chunk completes the frame', third.length === 1, `saw ${third.length}`)
  ok('the reassembled frame matches', third.length === 1 && text(third[0]) === 'a longer payload to split')

  // 两条帧粘在一起但被任意切开：1 字节一喂也应当收敛。
  const byte = new FrameSplitter()
  const stream = joined([one, two])
  const collected: Uint8Array[] = []
  for (let i = 0; i < stream.length; i++) {
    for (const piece of byte.push(stream.subarray(i, i + 1))) collected.push(piece)
  }
  ok('a byte-by-byte stream still splits', collected.length === 2, `saw ${collected.length}`)

  // 长度前缀声称超限：必须抛错，且之后永久失败。
  const over = new FrameSplitter()
  const header = new Uint8Array(4)
  const declared = MAX_FRAMED_BYTES + 1
  header[0] = (declared >>> 24) & 0xff
  header[1] = (declared >>> 16) & 0xff
  header[2] = (declared >>> 8) & 0xff
  header[3] = declared & 0xff
  let threw = false
  try {
    over.push(header)
  } catch {
    threw = true
  }
  ok('an oversized length prefix is refused', threw)
  ok('the splitter remembers the failure', over.failure !== null, String(over.failure))
  let secondThrow = false
  try {
    over.push(header)
  } catch {
    secondThrow = true
  }
  ok('a broken splitter keeps failing', secondThrow)

  // 空帧是合法的（控制帧可以只带 kind 之外的空载荷）。
  const empty = new FrameSplitter()
  const emptyFrames = empty.push(frameWithLength(new Uint8Array(0)))
  ok('an empty frame survives', emptyFrames.length === 1 && emptyFrames[0].length === 0)

  // frameWithLength 自己也守上限。
  let refused = false
  try {
    frameWithLength(new Uint8Array(MAX_FRAMED_BYTES + 1))
  } catch {
    refused = true
  }
  ok('frameWithLength refuses an oversized payload', refused)

  // 长度前缀是大端：把 1 写成 0x00000001。
  const prefix = frameWithLength(bytes('x'))
  ok(
    'the length prefix is big endian',
    prefix[0] === 0 && prefix[1] === 0 && prefix[2] === 0 && prefix[3] === 1,
    `${prefix[0]},${prefix[1]},${prefix[2]},${prefix[3]}`,
  )
}

function main(): void {
  console.log('framing')
  checkFraming()
  if (failures.length > 0) {
    console.log(`\n${failures.length} FRAMING CHECK(S) FAILED`)
    process.exit(1)
  }
  console.log('\nALL FRAMING CHECKS PASS (typescript core)')
}

main()
