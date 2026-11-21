// 用真实 Host 校验「带图片的消息」能发出去。
//
// 单测只能证明块形状对；这里证明 Host 真的接受 base64 图片并按会话存下来。
// 做法：读 `probe/samples/tiny.png`（408 字节的 64×64 PNG）→ `session/create`
// 建一个**空会话** → 发一条带图片的 prompt → 用 `session/page` 轮询等
// `user/message` 出现，检查它的内容块里有一张图片。
//
// 三条来自 Dart 侧踩坑的规矩写在这里也适用：
// - 不要用 `session/observeEvent` 的 `await for` 等这一条（会 60s 超时），
//   改用 `session/page` 轮询；
// - 事件里的图片块只有 `{type:'image', attachment:{...}}`，字节要另外用
//   `session/attachment` 取；
// - 轮询要有上限，否则 Host 出问题时会永远挂着。

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildContent, outgoingImage, promptRequest, PROMPT_MODE_QUEUE } from '../src/composer'
import { decodeBase64 } from '../src/bytes'
import { attachmentData, attachmentRequest, imageRefsOfData } from '../src/images'
import { connectLive, describeError, type LiveLink } from './live_common'
import type { JsonObject } from '../src/json'

const failures: string[] = []
const POLL_ATTEMPTS = 20
const POLL_DELAY_MS = 500

function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures.push(label)
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((done) => { setTimeout(done, ms) })
}

function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '..', '..', '..')
}

/** 在会话的最近若干条记录里找第一条 `user/message`。 */
async function firstUserMessage(link: LiveLink, sessionId: string): Promise<JsonObject | null> {
  const answer = await link.rpc.call('session/page', {
    request: { address: { kind: 'session', sessionId }, maxMessages: 20 },
  }, 20000)
  const records = answer['records']
  if (!Array.isArray(records)) return null
  for (const record of records as Object[]) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) continue
    const entry = record as JsonObject
    if (entry['type'] !== 'event') continue
    const event = entry['event']
    if (event === null || typeof event !== 'object' || Array.isArray(event)) continue
    const eventMap = event as JsonObject
    if (eventMap['type'] !== 'user/message') continue
    const data = eventMap['data']
    if (data === null || typeof data !== 'object' || Array.isArray(data)) continue
    return data as JsonObject
  }
  return null
}

async function main(): Promise<void> {
  console.log('LIVE COMPOSER CHECKS (against the running Host)')
  let link: LiveLink | null = null
  try {
    const root = repoRoot()
    const bytes = new Uint8Array(readFileSync(join(root, 'probe', 'samples', 'tiny.png')))
    ok('the sample picture is on disk', bytes.length > 0, `${bytes.length} bytes`)
    const image = outgoingImage(bytes, 'tiny.png')
    ok('the picture is recognised as a PNG', image.mediaType === 'image/png', image.mediaType)
    ok('the payload is standard base64', image.data.indexOf('-') < 0 && image.data.indexOf('_') < 0)

    link = await connectLive()

    // 建一个空会话：不要往已有会话里塞测试图片，那会污染真实对话。
    const created = await link.rpc.call('session/create', { request: {} }, 20000)
    const sessionId = `${created['sessionId'] ?? ''}`
    ok('a fresh session was created', sessionId.length > 0)
    if (sessionId.length === 0) throw new Error('the Host returned no session id')

    const content = buildContent('这张图片是什么颜色？', [image])
    ok('the content carries text then image', content.length === 2
      && `${content[0]['type']}` === 'text' && `${content[1]['type']}` === 'image')

    const request = promptRequest(`live-image-${Date.now()}`, sessionId, content, PROMPT_MODE_QUEUE)
    const accepted = await link.rpc.call('session/prompt', { request }, 30000)
    ok('the Host accepted the image prompt', accepted['accepted'] === true, `${accepted['accepted']}`)

    let message: JsonObject | null = null
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
      message = await firstUserMessage(link, sessionId)
      if (message !== null) break
      await delay(POLL_DELAY_MS)
    }
    ok('the message shows up in the session', message !== null)
    if (message === null) throw new Error('the prompt never appeared as a user message')

    const blocks = message['content']
    ok('the message has content blocks', Array.isArray(blocks))
    const blockList = Array.isArray(blocks) ? blocks as Object[] : []
    let imageBlock: JsonObject | null = null
    let textSeen = false
    for (const block of blockList) {
      if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
      const map = block as JsonObject
      if (`${map['type']}` === 'image') imageBlock = map
      if (`${map['type']}` === 'text' && `${map['text']}`.length > 0) textSeen = true
    }
    ok('the text survived', textSeen)
    ok('the Host stored an image block', imageBlock !== null)
    if (imageBlock === null) throw new Error('no image block came back')

    const attachment = imageBlock['attachment']
    ok('the image block carries a reference, not the bytes', attachment !== null
      && typeof attachment === 'object' && !Array.isArray(attachment))
    const ref = attachment as JsonObject
    ok('the reference names a media type', `${ref['mediaType']}`.startsWith('image/'), `${ref['mediaType']}`)
    ok('the reference records a byte size', typeof ref['bytes'] === 'number' && (ref['bytes'] as number) > 0)

    // 再把字节取回来：这一步证明 base64 往返没坏。
    const fetched = await link.rpc.call('session/attachment', {
      request: { sessionId, attachment: ref },
    }, 20000)
    const data = `${fetched['data'] ?? ''}`
    ok('the bytes come back on demand', data.length > 0, `${data.length} base64 chars`)
    ok('the returned picture is the one we sent', data === image.data)

    // 界面上真正走的是 images.ts 那套解析：确认它读得懂这条记录，且用它自己的
    // 请求体能把字节取回来。单测只能喂造出来的形状，这里喂的是 Host 真发的。
    const refs = imageRefsOfData(message)
    ok('the shared parser finds the picture', refs.length === 1, `${refs.length}`)
    if (refs.length === 1) {
      const parsed = refs[0]
      ok('it reads the media type', parsed.mediaType.startsWith('image/'), parsed.mediaType)
      ok('it reads a real byte count', parsed.bytes > 0, `${parsed.bytes}`)
      const again = await link.rpc.call('session/attachment',
        attachmentRequest(sessionId, parsed), 20000)
      const againData = attachmentData(again)
      ok('the shared request body fetches the same bytes', againData === image.data)
      ok('those bytes decode to a PNG', decodeBase64(againData)[0] === 0x89)
    }
  } catch (error) {
    ok(`live composer run failed — ${describeError(error as Object)}`, false)
  } finally {
    if (link !== null) await link.close()
  }

  console.log('')
  if (failures.length === 0) {
    console.log('REAL IMAGE PROMPTS REACH THE HOST (live Host)')
  } else {
    console.log(`LIVE COMPOSER CHECKS FAILED: ${failures.length}`)
    process.exitCode = 1
  }
}

main().catch((error: Object) => {
  console.log(`LIVE COMPOSER CHECKS FAILED: ${describeError(error)}`)
  process.exitCode = 1
})
