// 历史消息里的图片引用。
//
// 这些断言钉的是三个来自实测的形状：图片块里只有引用没有字节、取字节要带
// sessionId、回来的 data 是标准 base64。界面上「图片显示不出来」几乎都源于这里
// 读错了字段，而不是渲染。
//
// 另外把 `decodeBase64` 与 `decodeBase64Url` 的分工也钉住：两者字母表不同，
// 混用会一边抛错、一边静默错位。

import { decodeBase64, decodeBase64Url, encodeBase64, encodeBase64Url } from '../src/bytes'
import {
  attachmentData,
  attachmentRequest,
  imageRefsOf,
  imageRefsOfData,
  imageSummary,
  hasImages,
  readImageRef,
  type ImageRef,
} from '../src/images'
import type { JsonObject } from '../src/json'

const failures: string[] = []

function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures.push(label)
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

function eq(label: string, actual: string, expected: string): void {
  ok(label, actual === expected, `got ${actual}, expected ${expected}`)
}

function same(label: string, actual: Object, expected: Object): void {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  ok(label, left === right, `got ${left}, expected ${right}`)
}

/** Host 真正发回来的引用形状（取自 probe/samples/follow_activated.json）。 */
const LIVE_REF: JsonObject = {
  attachmentId: 'att-abc123',
  mediaType: 'image/png',
  bytes: 408,
  width: 64,
  height: 64,
  name: 'tiny.png',
}

function imageBlock(attachment: Object): JsonObject {
  return { type: 'image', attachment }
}

function checkReadRef(): void {
  const ref = readImageRef(LIVE_REF)
  ok('a full reference is read', ref !== null)
  if (ref !== null) {
    eq('the id survives', ref.attachmentId, 'att-abc123')
    eq('the media type survives', ref.mediaType, 'image/png')
    ok('the byte count survives', ref.bytes === 408, `${ref.bytes}`)
    ok('the width survives', ref.width === 64, `${ref.width}`)
    ok('the height survives', ref.height === 64, `${ref.height}`)
    eq('the name survives', ref.name, 'tiny.png')
  }

  // 没有 id 的块就没法取字节，留着是个点了没反应的空盒子。
  ok('a reference without an id is dropped',
    readImageRef({ mediaType: 'image/png', bytes: 1 }) === null)
  ok('a non-object reference is dropped', readImageRef(null) === null)
  ok('an array reference is dropped', readImageRef([]) === null)

  // 有些 Host 版本不给 size/name，缺省必须是 0/空串而不是 NaN。
  const sparse = readImageRef({ attachmentId: 'x', mediaType: 'image/jpeg' })
  ok('a sparse reference still reads', sparse !== null)
  if (sparse !== null) {
    ok('a missing byte count becomes zero', sparse.bytes === 0, `${sparse.bytes}`)
    eq('a missing name becomes an empty string', sparse.name, '')
  }
}

function checkRefsOf(): void {
  const content: Object[] = [
    { type: 'text', text: '看看这张' },
    imageBlock(LIVE_REF),
    imageBlock({ attachmentId: 'att-2', mediaType: 'image/jpeg' }),
    imageBlock({ mediaType: 'image/png' }),
    'not a block',
    { type: 'text', text: '结束' },
  ]
  const refs = imageRefsOf(content)
  ok('only real references survive', refs.length === 2, `${refs.length}`)
  eq('they keep their order', refs.map((ref: ImageRef): string => ref.attachmentId).join(','),
    'att-abc123,att-2')
  ok('a body without images has none', imageRefsOf([{ type: 'text', text: 'x' }]).length === 0)
  ok('a non-array body has none', imageRefsOf('nope').length === 0)
  ok('hasImages agrees', hasImages(content) && !hasImages([]))
}

function checkRequest(): void {
  const ref = readImageRef(LIVE_REF) as ImageRef
  const body = attachmentRequest('session-1', ref)
  const request = body['request'] as JsonObject
  eq('the session id is in the request', `${request['sessionId']}`, 'session-1')
  const attachment = request['attachment'] as JsonObject
  eq('the reference is forwarded verbatim', `${attachment['attachmentId']}`, 'att-abc123')
  eq('the media type comes along', `${attachment['mediaType']}`, 'image/png')
  ok('the byte count comes along', attachment['bytes'] === 408, `${attachment['bytes']}`)

  // 参数是 `{request:{...}}` 而不是扁平命名参数：workspaceFiles 才是扁平的，
  // 这两者混过一次，报的是「args fields do not match the descriptor」。
  ok('the session id is not a top-level argument', body['sessionId'] === undefined)
  eq('the answer hands back base64', attachmentData({ data: 'iVBORw0KGgo=' }), 'iVBORw0KGgo=')
  eq('an answer without data is empty', attachmentData({}), '')
}

function checkSummary(): void {
  eq('a named picture shows its name', imageSummary(readImageRef(LIVE_REF) as ImageRef), 'tiny.png')
  const unnamed = readImageRef({ attachmentId: 'x', mediaType: 'image/png', bytes: 408 }) as ImageRef
  eq('an unnamed picture shows its size', imageSummary(unnamed), '408 B')
  const big = readImageRef({ attachmentId: 'x', mediaType: 'image/png', bytes: 3 * 1024 * 1024 }) as ImageRef
  eq('a big picture shows megabytes', imageSummary(big), '3.0 MB')
  const bare = readImageRef({ attachmentId: 'x', mediaType: 'image/png' }) as ImageRef
  eq('a picture with nothing to say says so', imageSummary(bare), '一张图片')
}

function checkDataSources(): void {
  // 用户消息：content 直接在 data 上。
  const user = { content: [imageBlock(LIVE_REF)] }
  ok('a user message exposes its pictures', imageRefsOfData(user).length === 1)

  // 助手消息：content 在 message 里。
  const assistant = { message: { content: [imageBlock(LIVE_REF)] } }
  ok('an assistant message exposes its pictures', imageRefsOfData(assistant).length === 1)

  ok('a message with nothing has none', imageRefsOfData({}).length === 0)
}

function checkBase64Pair(): void {
  // 标准 base64 与 base64url 只在最后两字符不同；两者不能互换。
  const high = new Uint8Array([0xfb, 0xff])
  eq('standard base64 uses +/', encodeBase64(high), '+/8=')
  eq('base64url uses -_ without padding', encodeBase64Url(high), '-_8')
  same('decoding standard gives the bytes back', Array.from(decodeBase64('+/8=')), [0xfb, 0xff])
  same('decoding url gives the bytes back', Array.from(decodeBase64Url('-_8')), [0xfb, 0xff])

  // 用错字母表必须报错，而不是安静地解出错字节。
  let urlRejected = false
  try {
    decodeBase64Url('+/8=')
  } catch {
    urlRejected = true
  }
  ok('a standard string is rejected by the url decoder', urlRejected)

  // 填充可带可不带，两种都接受。
  eq('padding is optional for the standard decoder', `${decodeBase64('aGk=').length}`, '2')
  eq('unpadded standard still decodes', `${decodeBase64('aGk').length}`, '2')

  // PNG 的魔数：发出去的图片必须以此开头，否则 Host 会当成坏图。
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  eq('a PNG header survives a round trip', encodeBase64(png), 'iVBORw0KGgo=')
  same('and decodes back to the magic bytes', Array.from(decodeBase64(encodeBase64(png))),
    Array.from(png))
}

function main(): void {
  console.log('images')
  checkReadRef()
  checkRefsOf()
  checkRequest()
  checkSummary()
  checkDataSources()
  checkBase64Pair()
  if (failures.length > 0) {
    console.log(`\n${failures.length} IMAGE CHECK(S) FAILED`)
    process.exit(1)
  }
  console.log('\nALL IMAGE CHECKS PASS (typescript core)')
}

main()
