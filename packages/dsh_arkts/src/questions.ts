/**
 * 把一条转发来的 waterfall 说成手机能渲染的提问。
 *
 * DSH 在 turn 被阻塞时问人两种东西：某个工具能不能跑（`approval/request`），
 * 以及一道选择题的答案（`user-questions/request`）。两者都以同一种转发
 * waterfall 到达，所以一个视图就能同时显示，只要把原始 request 留着回应。
 *
 * 这个文件是纯函数：不碰网络、不碰界面，只把 JSON 收口成结构。因此它同时被
 * `npm test` 与鸿蒙的对话框使用，形状一旦猜错会立刻在 CI 里红。
 */

import { stringField, type JsonObject } from './json'
import type { RemoteInvocation } from './remote_events'

/** 审批只有一种放行结果，其余一律按拒绝处理（fail-closed）。 */
export const APPROVAL_ALLOWED_ONCE = 'allowed-once'
export const APPROVAL_REJECTED = 'rejected'

/** 一个可选项。 */
export interface QuestionOption {
  readonly label: string
  readonly description: string
}

/** 一道选择题。 */
export interface QuestionChoice {
  /** Host 回传答案时用的键，缺失时按位置补齐。 */
  readonly id: string
  readonly question: string
  readonly header: string
  readonly detail: string
  readonly multiSelect: boolean
  readonly options: QuestionOption[]
}

/** 提问的种类。 */
export const QUESTION_APPROVAL = 'approval'
export const QUESTION_CHOICE = 'choice'

/** 一条等待回答的提问。 */
export interface PendingQuestion {
  readonly invocation: RemoteInvocation
  /** 审批还是选择题。 */
  readonly kind: string
  /** 一行说清在问什么。 */
  readonly title: string
  /** 仅审批：工具名。 */
  readonly toolName: string
  /** 仅审批：Host 给的理由（已选好语言）。 */
  readonly reason: string
  /** 仅选择题：题目列表。 */
  readonly questions: QuestionChoice[]
}

/**
 * 读一条 waterfall；手机渲染不了时返回 null。
 *
 * 返回 null 的调用方应该 `answer(..., delegate: true)` 把它交回电脑——
 * 丢掉它会让那个 waterfall 永远挂住，整个 turn 卡死。
 */
export function readQuestion(invocation: RemoteInvocation): PendingQuestion | null {
  if (invocation.event === 'approval/request') {
    const toolName = stringField(invocation.request, 'toolName', '')
    const reason = displayReason(invocation.request['displayReason'])
    const fallback = stringField(invocation.request, 'reason', '')
    const spoken = reason.length > 0 ? reason : fallback
    const subject = toolName.length > 0 ? toolName : '某个工具'
    return {
      invocation,
      kind: QUESTION_APPROVAL,
      title: spoken.length > 0 ? `${subject}: ${spoken}` : `${subject} 想要执行`,
      toolName,
      reason: spoken,
      questions: [],
    }
  }

  if (invocation.event === 'user-questions/request') {
    const questions = readChoices(invocation.request)
    if (questions.length === 0) return null
    return {
      invocation,
      kind: QUESTION_CHOICE,
      title: questions.length === 1 ? questions[0].question : `${questions.length} 个问题`,
      toolName: '',
      reason: '',
      questions,
    }
  }

  return null
}

/** 读一批选择题。 */
export function readChoices(request: JsonObject): QuestionChoice[] {
  const raw = request['questions']
  if (!Array.isArray(raw)) return []
  const parsed: QuestionChoice[] = []
  for (const entry of raw as Object[]) {
    const item = asObject(entry)
    if (item === undefined) continue
    const text = stringField(item, 'question', '')
    if (text.length === 0) continue
    parsed.push({
      // 没有 id 的题目无法按 id 作答，用位置兜底，别让一条坏数据藏掉整批。
      id: stringField(item, 'id', `question-${parsed.length}`),
      question: text,
      header: stringField(item, 'header', ''),
      detail: stringField(item, 'detail', ''),
      multiSelect: item['multiSelect'] === true,
      options: readOptions(item['options']),
    })
  }
  return parsed
}

function readOptions(raw: Object | undefined): QuestionOption[] {
  if (raw === undefined || !Array.isArray(raw)) return []
  const options: QuestionOption[] = []
  for (const entry of raw as Object[]) {
    // 新 Host 是 `{label, description}`，老版本是裸字符串；两种都收，
    // 版本不一致时降级而不是崩。
    if (typeof entry === 'string') {
      options.push({ label: entry, description: '' })
      continue
    }
    const item = asObject(entry)
    if (item === undefined) continue
    const label = stringField(item, 'label', '')
    if (label.length === 0) continue
    options.push({ label, description: stringField(item, 'description', '') })
  }
  return options
}

/**
 * 组装 DSH 的答案 API 期望的形状。
 *
 * `selections` 把题目 id 映射到选中的标签（跳过就是空数组），`custom` 带自由文本。
 */
export function answerValue(
  questions: QuestionChoice[],
  selections: Map<string, string[]>,
  custom: Map<string, string> = new Map<string, string>(),
): JsonObject {
  const answers: Object[] = []
  for (const question of questions) {
    const entry: JsonObject = {
      id: question.id,
      selected: selections.get(question.id) ?? [],
    }
    const extra = custom.get(question.id)
    if (extra !== undefined && extra.length > 0) entry['custom'] = extra
    answers.push(entry)
  }
  return { answers }
}

/** `displayReason` 可能是多语言对象；没有本机翻译时退回英文（与 Dart 侧一致）。 */
function displayReason(raw: Object | undefined): string {
  const map = raw === undefined ? undefined : asObject(raw)
  if (map === undefined) return ''
  const english = stringField(map, 'en', '')
  if (english.length > 0) return english
  for (const key of Object.keys(map)) {
    const text = map[key]
    if (typeof text === 'string' && text.trim().length > 0) return text.trim()
  }
  return ''
}

function asObject(value: Object | undefined): JsonObject | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as JsonObject
}
