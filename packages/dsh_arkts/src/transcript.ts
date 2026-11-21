/**
 * 把 Host 的会话事件流读成界面要显示的行。
 *
 * 与 Dart 侧 `buildTranscript` 同一口径。形状上的四个关键点，全部来自实测：
 * - 每条记录是 `{type:'event', event:{type, seq, time, data}}`，真正的负载在
 *   `event.data` 里；
 * - `user/message`、`assistant/message` 的正文是一组内容块（`text`/`reasoning`/
 *   `image`/`tool-call`），不是字符串；
 * - `tool/call` 的 `arguments` 是**未解析的原始 JSON 字符串**；
 * - `turn/end` 的 `reason.kind` 只有 `completed`/`aborted` 是正常结束，其余
 *   （`error`、`blocked`、`max-tokens`、`interrupted`、`forked`）都要给用户一句话。
 */

import { arrayField, objectField, stringField, type JsonObject } from './json'

/** 一行 transcript。`seq` 是 Host 的持久序号，用来保持顺序。 */
export interface TranscriptRow {
  readonly seq: number
  /** `user` | `assistant` | `tool` | `notice` —— 界面据此选渲染方式。 */
  readonly kind: string
  readonly text: string
  /** 只有 `assistant` 有：思考过程。 */
  readonly reasoning: string
  /** 只有 `tool` 有：工具名。 */
  readonly name: string
  /** 只有 `tool` 有：原始参数串（`call`）或错误标记（`result`）。 */
  readonly arguments: string
  /** 只有 `notice`/`tool` 有：这一行是不是坏消息。 */
  readonly isError: boolean
  /** 只有 `user` 有：DSH 归于智能体而非人发的（技能、cron、子代理等）。 */
  readonly injected: boolean
}

export const ROW_USER = 'user'
export const ROW_ASSISTANT = 'assistant'
export const ROW_TOOL = 'tool'
export const ROW_NOTICE = 'notice'

/** 这些来源的「用户消息」其实是系统注入的，界面要弱化显示。 */
const INJECTED_SOURCES: string[] = ['skill', 'cron', 'subagent', 'goal', 'hook', 'system', 'compaction', 'file-change']

/** 只在这几个 `turn/end` 原因下保持安静。 */
const QUIET_TURN_ENDINGS: string[] = ['completed', 'aborted']

/**
 * 造一行。
 *
 * 这里不写 `{ ...base, field: value }`：ArkTS 禁止对象展开（`arkts-no-spread`），
 * 所以每个字段都显式给出来。
 */
function row(seq: number, kind: string, text: string, reasoning: string = '', name: string = '',
  args: string = '', isError: boolean = false, injected: boolean = false): TranscriptRow {
  return { seq, kind, text, reasoning, name, arguments: args, isError, injected }
}

/** 拼接一组内容块里的正文；`blockType` 决定取 `text` 还是 `reasoning`。 */
export function textOfContent(content: Object, blockType: string = 'text'): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content as Object[]) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
    const map = block as JsonObject
    if (stringField(map, 'type', '') !== blockType) continue
    const text = stringField(map, 'text', '')
    if (text.length > 0) parts.push(text)
  }
  return parts.join('\n').trim()
}

/** 内容块里有没有图片（手机上暂时只显示「一张图片」而不去取字节）。 */
export function countImages(content: Object): number {
  if (!Array.isArray(content)) return 0
  let count = 0
  for (const block of content as Object[]) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
    if (stringField(block as JsonObject, 'type', '') === 'image') count += 1
  }
  return count
}

/** 一条记录 → 一行；读不出来或不需要显示时返回 null。 */
export function readTranscriptRow(record: Object): TranscriptRow | null {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return null
  const envelope = record as JsonObject
  if (stringField(envelope, 'type', '') !== 'event') return null
  const event = objectField(envelope, 'event')
  if (event === undefined) return null
  const type = stringField(event, 'type', '')
  const seqValue = event['seq']
  if (type.length === 0 || typeof seqValue !== 'number') return null
  const seq = seqValue as number
  const data = objectField(event, 'data')
  const payload: JsonObject = data === undefined ? {} : data

  if (type === 'user/message') {
    const content = payload['content']
    let text = content === undefined ? '' : textOfContent(content)
    const images = content === undefined ? 0 : countImages(content)
    if (text.length === 0 && images === 0) return null
    if (images > 0) text = text.length === 0 ? `[${images} 张图片]` : `${text}\n[${images} 张图片]`
    const source = objectField(payload, 'source')
    const kind = source === undefined ? '' : stringField(source, 'kind', '')
    return row(seq, ROW_USER, text, '', '', '', false, INJECTED_SOURCES.indexOf(kind) >= 0)
  }

  if (type === 'assistant/message') {
    const message = objectField(payload, 'message')
    const content = message === undefined ? undefined : message['content']
    const text = content === undefined ? '' : textOfContent(content, 'text')
    const reasoning = content === undefined ? '' : textOfContent(content, 'reasoning')
    const images = content === undefined ? 0 : countImages(content)
    if (text.length === 0 && reasoning.length === 0 && images === 0) return null
    const shown = images > 0 ? (text.length === 0 ? `[${images} 张图片]` : `${text}\n[${images} 张图片]`) : text
    return row(seq, ROW_ASSISTANT, shown, reasoning)
  }

  if (type === 'tool/call') {
    const name = stringField(payload, 'name', 'tool')
    return row(seq, ROW_TOOL, '', '', name, stringField(payload, 'arguments', ''))
  }

  if (type === 'tool/result') {
    const message = objectField(payload, 'message')
    const content = message === undefined ? undefined : message['content']
    const text = content === undefined ? '' : textOfContent(content)
    const isError = message !== undefined && message['isError'] === true
    if (text.length === 0 && !isError) return null
    return row(seq, ROW_TOOL, text, '', 'result', '', isError)
  }

  if (type === 'turn/end') {
    const reason = objectField(payload, 'reason')
    if (reason === undefined) return null
    const kind = stringField(reason, 'kind', '')
    if (kind.length === 0 || QUIET_TURN_ENDINGS.indexOf(kind) >= 0) return null
    const error = objectField(reason, 'error')
    const message = error === undefined ? '' : stringField(error, 'message', '')
    const shown = message.length > 0 ? message : `这一轮结束了：${kind}`
    return row(seq, ROW_NOTICE, shown, '', '', '', true)
  }

  return null
}

/** 整批记录 → 按 `seq` 排好的行。 */
export function readTranscript(records: Object[]): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  for (const record of records) {
    const built = readTranscriptRow(record)
    if (built !== null) rows.push(built)
  }
  rows.sort((left: TranscriptRow, right: TranscriptRow): number => left.seq - right.seq)
  return rows
}

/** 从 `session/follow` 的 snapshot 帧里取记录数组（没有就是空）。 */
export function recordsOfSnapshot(snapshot: JsonObject): Object[] {
  return arrayField(snapshot, 'records')
}

/** 一条流式增量；只有正文与思考需要落到界面上。 */
export interface StreamDelta {
  readonly attemptId: string
  readonly text: string
  readonly reasoning: string
}

/**
 * 从 `assistant-stream` 帧里取出增量。
 *
 * `tool-call-delta` 故意丢掉：它的 `argumentsDelta` 是半截 JSON，渲染出来只会
 * 是抖动，等 `tool/call` 事件落定再显示。
 */
export function readStreamDelta(frame: JsonObject): StreamDelta | null {
  if (stringField(frame, 'type', '') !== 'assistant-stream') return null
  const inner = objectField(frame, 'frame')
  if (inner === undefined) return null
  const attemptId = stringField(inner, 'attemptId', '')
  if (attemptId.length === 0) return null
  if (stringField(inner, 'type', '') !== 'chunk') return null
  const chunk = objectField(inner, 'chunk')
  if (chunk === undefined) return null
  const type = stringField(chunk, 'type', '')
  if (type === 'text-delta') return { attemptId, text: stringField(chunk, 'text', ''), reasoning: '' }
  if (type === 'reasoning-delta') return { attemptId, text: '', reasoning: stringField(chunk, 'text', '') }
  return null
}
