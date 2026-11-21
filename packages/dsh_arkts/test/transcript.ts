// transcript 的解析。
//
// 每条断言都对应一个实测出来的形状：负载在 event.data 里、正文是内容块数组、
// 工具参数是未解析的字符串、turn/end 只有两种原因是安静的。界面上「某条消息
// 不见了」是最难排查的故障，所以这些规则必须在这里被钉住。

import {
  countImages,
  readStreamDelta,
  readTranscript,
  readTranscriptRow,
  recordsOfSnapshot,
  textOfContent,
  ROW_ASSISTANT,
  ROW_NOTICE,
  ROW_TOOL,
  ROW_USER,
  type TranscriptRow,
} from '../src/transcript'
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

function same(label: string, actual: Object, expected: Object): void {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  ok(label, left === right, `got ${left}, expected ${right}`)
}

function event(type: string, seq: number, data: JsonObject): JsonObject {
  return { type: 'event', event: { type, seq, time: 1_700_000_000_000, data } }
}

function textBlock(text: string): JsonObject {
  return { type: 'text', text }
}

function checkUser(): void {
  const plain = readTranscriptRow(event('user/message', 3, { content: [textBlock('数到 40')] }))
  ok('a user message becomes a row', plain !== null)
  if (plain !== null) {
    ok('it is a user row', plain.kind === ROW_USER)
    ok('the text comes out of the blocks', plain.text === '数到 40', plain.text)
    ok('it keeps the sequence number', plain.seq === 3)
    ok('a typed message is not injected', !plain.injected)
  }

  const injected = readTranscriptRow(
    event('user/message', 4, { content: [textBlock('/brainstorming ') ], source: { kind: 'skill' } }),
  )
  ok('a skill-injected message is marked', injected !== null && injected.injected)

  ok('an empty user message is dropped', readTranscriptRow(event('user/message', 5, { content: [] })) === null)
  ok(
    'a message with only an image still shows',
    readTranscriptRow(event('user/message', 6, { content: [{ type: 'image', attachment: { attachmentId: 'a' } }] })) !==
      null,
  )
}

function checkAssistant(): void {
  const both = readTranscriptRow(
    event('assistant/message', 7, {
      message: { content: [{ type: 'reasoning', text: '先想一下' }, textBlock('答案')] },
    }),
  )
  ok('an assistant message keeps text and reasoning', both !== null && both.text === '答案' && both.reasoning === '先想一下')
  if (both !== null) ok('it is an assistant row', both.kind === ROW_ASSISTANT)

  const reasoningOnly = readTranscriptRow(
    event('assistant/message', 8, { message: { content: [{ type: 'reasoning', text: '只想不说' }] } }),
  )
  ok('reasoning alone still renders', reasoningOnly !== null && reasoningOnly.text === '')

  ok(
    'an empty assistant message is dropped',
    readTranscriptRow(event('assistant/message', 9, { message: { content: [] } })) === null,
  )
}

function checkTools(): void {
  const call = readTranscriptRow(event('tool/call', 10, { name: 'pwsh', arguments: '{"command":"dir"}' }))
  ok('a tool call keeps its name', call !== null && call.name === 'pwsh')
  if (call !== null) {
    ok('the arguments stay raw', call.arguments === '{"command":"dir"}')
    ok('a tool call has no body', call.text === '')
    ok('it is a tool row', call.kind === ROW_TOOL)
  }

  const good = readTranscriptRow(event('tool/result', 11, { message: { content: [textBlock('ok')] } }))
  ok('a tool result carries its output', good !== null && good.text === 'ok' && !good.isError)

  const bad = readTranscriptRow(event('tool/result', 12, { message: { content: [], isError: true } }))
  ok('a failed tool result survives an empty body', bad !== null && bad.isError)

  ok('an empty tool result is dropped', readTranscriptRow(event('tool/result', 13, { message: { content: [] } })) === null)
}

function checkTurnEnd(): void {
  ok('a completed turn says nothing', readTranscriptRow(event('turn/end', 14, { reason: { kind: 'completed' } })) === null)
  ok('an aborted turn says nothing', readTranscriptRow(event('turn/end', 15, { reason: { kind: 'aborted' } })) === null)

  const failed = readTranscriptRow(
    event('turn/end', 16, { reason: { kind: 'error', error: { message: '模型返回 500' } } }),
  )
  ok('a failed turn becomes a notice', failed !== null && failed.kind === ROW_NOTICE && failed.isError)
  ok('the notice uses the Host message', failed !== null && failed.text === '模型返回 500')

  const blocked = readTranscriptRow(event('turn/end', 17, { reason: { kind: 'blocked' } }))
  ok('a blocked turn without a message still explains itself', blocked !== null && blocked.text.length > 0)
}

function checkBatch(): void {
  const rows = readTranscript([
    event('assistant/message', 20, { message: { content: [textBlock('second')] } }),
    event('user/message', 10, { content: [textBlock('first')] }),
    { type: 'not-an-event' },
    event('turn/start', 11, { turn: 1 }),
    event('session/title', 12, { title: 'renamed' }),
  ])
  same(
    'only renderable rows survive, in sequence order',
    rows.map((r: TranscriptRow): string => r.text),
    ['first', 'second'],
  )

  const snapshot: JsonObject = {
    type: 'snapshot',
    records: [event('user/message', 1, { content: [textBlock('hi')] })],
  }
  ok('a snapshot exposes its records', recordsOfSnapshot(snapshot).length === 1)
  ok('a snapshot without records is empty', recordsOfSnapshot({ type: 'snapshot' }).length === 0)
}

function checkStreaming(): void {
  const text = readStreamDelta({
    type: 'assistant-stream',
    frame: { type: 'chunk', attemptId: 'a1', index: 0, chunk: { type: 'text-delta', text: '你' } },
  })
  ok('a text delta is read', text !== null && text.text === '你' && text.reasoning === '')

  const reasoning = readStreamDelta({
    type: 'assistant-stream',
    frame: { type: 'chunk', attemptId: 'a1', index: 0, chunk: { type: 'reasoning-delta', text: '想' } },
  })
  ok('a reasoning delta is read', reasoning !== null && reasoning.reasoning === '想' && reasoning.text === '')

  ok(
    'a tool-call delta is dropped on purpose',
    readStreamDelta({
      type: 'assistant-stream',
      frame: { type: 'chunk', attemptId: 'a1', index: 1, chunk: { type: 'tool-call-delta', argumentsDelta: '{"a"' } },
    }) === null,
  )
  ok('a non-stream frame is ignored', readStreamDelta({ type: 'snapshot' }) === null)
  ok(
    'a start frame without a chunk is ignored',
    readStreamDelta({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'a1' } }) === null,
  )
}

function checkHelpers(): void {
  ok('text blocks concatenate with newlines', textOfContent([textBlock('a'), textBlock('b')]) === 'a\nb')
  ok('reasoning blocks are skipped for text', textOfContent([{ type: 'reasoning', text: 'x' }]) === '')
  ok('images are counted', countImages([{ type: 'image' }, { type: 'text', text: 'x' }]) === 1)
  ok('a non-array body is empty', textOfContent('not an array') === '')
}

function main(): void {
  console.log('transcript')
  checkUser()
  checkAssistant()
  checkTools()
  checkTurnEnd()
  checkBatch()
  checkStreaming()
  checkHelpers()
  if (failures.length > 0) {
    console.log(`\n${failures.length} TRANSCRIPT CHECK(S) FAILED`)
    process.exit(1)
  }
  console.log('\nALL TRANSCRIPT CHECKS PASS (typescript core)')
}

main()
