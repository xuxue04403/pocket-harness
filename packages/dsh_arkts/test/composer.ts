// 发出去的内容块：文字、图片、以及为什么有些东西不能发。
//
// 这些断言对应的是「看起来发出去了但电脑没收到」这类故障：base64 用了 url 变体、
// mediaType 写成 image/jpg、把空 content 当成空消息发出去（Host 会理解成
// 「继续上一轮」并真的让电脑跑一遍）。

import { encodeBase64, decodeBase64Url } from '../src/bytes'
import {
  buildContent,
  describePromptError,
  hasContent,
  imagePart,
  IMAGE_MEDIA_TYPES,
  mediaTypeFor,
  outgoingImage,
  promptRequest,
  PROMPT_MODE_QUEUE,
  PROMPT_MODE_STEER,
  textPart,
} from '../src/composer'

const failures: string[] = []

function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures.push(label)
  console.log(`  FAIL ${label}${detail.length > 0 ? ` -- ${detail}` : ''}`)
}

function eq(label: string, actual: string, expected: string): void {
  ok(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function throws(label: string, run: () => void): void {
  let threw = false
  try {
    run()
  } catch {
    threw = true
  }
  ok(label, threw, 'expected an error')
}

/** 一张 1×1 的 PNG（67 字节），用来验证 base64 口径而不是图片编解码。 */
const TINY_PNG: Uint8Array = decodeBase64Url(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg',
)

console.log('composer: base64 口径')
{
  // 标准 base64 带填充；base64url 不带。用已知向量钉住字母表。
  eq('hello -> aGVsbG8=', encodeBase64(new Uint8Array([104, 101, 108, 108, 111])), 'aGVsbG8=')
  eq('两个字节补一个 =', encodeBase64(new Uint8Array([104, 105])), 'aGk=')
  eq('一个字节补两个 =', encodeBase64(new Uint8Array([104])), 'aA==')
  eq('空数组是空串', encodeBase64(new Uint8Array(0)), '')
  // 关键：0xfb 0xff 在标准表里是 "+/"，在 url 表里是 "-_"。
  eq('高位字节用 + 与 /', encodeBase64(new Uint8Array([251, 255])), '+/8=')
  ok('不含 url 变体字符', encodeBase64(new Uint8Array([251, 255])).indexOf('-') < 0
    && encodeBase64(new Uint8Array([251, 255])).indexOf('_') < 0)
  ok('PNG 编码后以 iVBORw0KGgo 开头', encodeBase64(TINY_PNG).startsWith('iVBORw0KGgo'))
  // 与 Node 的 Buffer 对一遍（覆盖三个余数分支）。
  for (const length of [0, 1, 2, 3, 4, 5, 31, 32, 33, 64]) {
    const bytes = new Uint8Array(length)
    for (let i = 0; i < length; i++) bytes[i] = (i * 37 + 11) & 0xff
    const expected = Buffer.from(bytes).toString('base64')
    ok(`与 Buffer 一致（${length} 字节）`, encodeBase64(bytes) === expected, expected)
  }
}

console.log('composer: 类型判断')
{
  eq('png', mediaTypeFor('a.png'), 'image/png')
  eq('大写 JPG', mediaTypeFor('IMG_0001.JPG'), 'image/jpeg')
  eq('jpeg', mediaTypeFor('x.jpeg'), 'image/jpeg')
  eq('webp', mediaTypeFor('x.webp'), 'image/webp')
  eq('gif', mediaTypeFor('x.gif'), 'image/gif')
  eq('相册 uri', mediaTypeFor('file://media/Photo/3/IMG_001/IMG_001.jpg'), 'image/jpeg')
  eq('带查询串', mediaTypeFor('file://media/x.png?networkid=1'), 'image/png')
  eq('不认识的后缀', mediaTypeFor('a.heic'), '')
  eq('没有后缀', mediaTypeFor('a'), '')
  eq('空串', mediaTypeFor(''), '')
  ok('四种类型都在白名单里',
    IMAGE_MEDIA_TYPES.length === 4 && IMAGE_MEDIA_TYPES.indexOf('image/jpeg') >= 0)
}

console.log('composer: 造图片块')
{
  const image = outgoingImage(TINY_PNG, 'tiny.png')
  eq('mediaType', image.mediaType, 'image/png')
  eq('name', image.name, 'tiny.png')
  ok('data 是 base64 而不是 base64url', image.data.indexOf('-') < 0 && image.data.indexOf('_') < 0)
  ok('data 解回来是原字节', encodeBase64(TINY_PNG) === image.data)

  const part = imagePart(image)
  eq('块类型', `${part['type']}`, 'image')
  eq('块里有 mediaType', `${part['mediaType']}`, 'image/png')
  eq('块里有 name', `${part['name']}`, 'tiny.png')
  const nameless = imagePart({ mediaType: 'image/png', data: 'AA==', name: '' })
  ok('没有名字就不带 name 键', nameless['name'] === undefined)

  throws('不认识的类型拒绝', () => { outgoingImage(TINY_PNG, 'a.heic') })
  throws('空字节拒绝', () => { outgoingImage(new Uint8Array(0), 'a.png') })
}

console.log('composer: 造内容数组')
{
  const image = outgoingImage(TINY_PNG, 'tiny.png')

  const both = buildContent('what colour', [image])
  ok('文字在前、图片在后', both.length === 2 && `${both[0]['type']}` === 'text'
    && `${both[1]['type']}` === 'image')

  const imageOnly = buildContent('   ', [image])
  ok('只有图片也是一个块', imageOnly.length === 1 && `${imageOnly[0]['type']}` === 'image')

  const textOnly = buildContent('hi', [])
  ok('只有文字', textOnly.length === 1 && `${textOnly[0]['text']}` === 'hi')

  const trimmed = buildContent('  hi  ', [])
  eq('文字被 trim', `${trimmed[0]['text']}`, 'hi')

  const blank = buildContent('  \n ', [])
  ok('全空白不产生空文字块', blank.length === 0)

  eq('textPart 就是两个键', `${Object.keys(textPart('x')).length}`, '2')

  ok('有话可发（文字）', hasContent('x', []))
  ok('有话可发（图片）', hasContent('', [image]))
  ok('没话可发', !hasContent('  ', []))
}

console.log('composer: 请求体')
{
  const content = buildContent('hi', [])
  const request = promptRequest('phone-1', 'session-1', content)
  eq('requestId', `${request['requestId']}`, 'phone-1')
  eq('sessionId', `${request['sessionId']}`, 'session-1')
  eq('默认 queue', `${request['mode']}`, PROMPT_MODE_QUEUE)
  ok('content 原样带过去', Array.isArray(request['content']))

  const steer = promptRequest('phone-2', 'session-1', content, PROMPT_MODE_STEER)
  eq('可以指定 steer', `${steer['mode']}`, PROMPT_MODE_STEER)

  const fallback = promptRequest('phone-3', 'session-1', content, 'sideways')
  eq('未知模式回落到 queue', `${fallback['mode']}`, PROMPT_MODE_QUEUE)

  throws('没有 requestId 拒绝', () => { promptRequest('', 's', content) })
  throws('没有 sessionId 拒绝', () => { promptRequest('r', '', content) })
  throws('空 content 拒绝（否则是「继续上一轮」）', () => { promptRequest('r', 's', []) })
}

console.log('composer: 错误文案')
{
  const cases: string[][] = [
    ['gateway/input-invalid: wire field "request" failed', '电脑没接受这条消息'],
    ['the image media type is not allowed', '格式电脑不支持'],
    ['attachment is too large: 9 MB', '图片太大'],
    ['no such session: s1', '已经没有了'],
    ['the link stopped answering', '连接已经断了'],
  ]
  for (const pair of cases) {
    const text = describePromptError(new Error(pair[0]))
    ok(`认得 ${pair[0].substring(0, 24)}…`, text.includes(pair[1]), text)
  }
  eq('不认识的错误原样返回', describePromptError(new Error('boom')), 'boom')
}

console.log('')
if (failures.length === 0) {
  console.log('ALL COMPOSER CHECKS PASS (typescript core)')
} else {
  console.log(`COMPOSER CHECKS FAILED: ${failures.length}`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
}
