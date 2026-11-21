// 智能体预设与新建会话的参数。
//
// `agentPresets/list` 回答的是「这台电脑上有哪些预设」，而 `session/create` 接受
// 的是 `{cwd?, agentPreset?}`。两边都要收口成界面能直接用的形状：
//
// - 预设的 `id` 是路由用的键，`name` 才是给人看的（可能缺，此时退回 `id`）；
// - 有一个预设带 `isDefault`，界面要能把它标出来；
// - **新建会话时不传 `agentPreset` 与「传默认预设的 id」不是一回事**：不传表示
//   跟随电脑上的默认设置（以后改默认，新会话跟着变），传了就把会话钉死在该预设上。
//   所以这里只提供一个显式的 `null` 表示「跟随电脑」，不自动填默认 id。

import { numberField, stringField } from './json'
import type { JsonObject } from './json'

/** 一个智能体预设。 */
export interface AgentPreset {
  readonly id: string
  /** 给人看的名字；缺失时等于 `id`。 */
  readonly label: string
  /** 电脑自己给的说明，可能为空。 */
  readonly description: string
  readonly isDefault: boolean
  readonly order: number
}

/** 新建会话时要传给 Host 的东西。`null` 表示「用电脑的默认值」。 */
export interface NewSessionChoice {
  readonly agentPreset: string | null
  /** 空字符串表示「用电脑的默认工作目录」。 */
  readonly cwd: string
}

export const FOLLOW_DESKTOP_PRESET: NewSessionChoice = { agentPreset: null, cwd: '' }

/**
 * 读一个预设条目。没有 `id` 的直接丢弃 —— 一个选不中的预设比少一条更糟。
 */
export function readPreset(value: JsonObject): AgentPreset | null {
  const id = stringField(value, 'id')
  if (id.length === 0) return null
  const name = stringField(value, 'name')
  return {
    id,
    label: name.length === 0 ? id : name,
    description: stringField(value, 'description'),
    isDefault: value['isDefault'] === true,
    order: numberField(value, 'order', 0),
  }
}

/**
 * 读 `agentPresets/list` 的回答。
 *
 * 按 `order` 升序排（Host 给的就是给人看的顺序），`order` 相同时保持原序。
 */
export function readPresets(answer: JsonObject): AgentPreset[] {
  const raw = answer['presets']
  if (!Array.isArray(raw)) return []
  const presets: AgentPreset[] = []
  for (const entry of raw as Object[]) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const preset = readPreset(entry as JsonObject)
    if (preset !== null) presets.push(preset)
  }
  presets.sort((left, right) => left.order - right.order)
  return presets
}

/** 电脑标的默认预设；没有标注就是 `null`。 */
export function defaultPreset(presets: AgentPreset[]): AgentPreset | null {
  for (const preset of presets) {
    if (preset.isDefault) return preset
  }
  return null
}

/**
 * 「跟随电脑」这一行要显示的文字。
 *
 * 有默认预设时把它的名字带上，否则只说「电脑的默认预设」—— 用户不需要知道
 * 这台电脑其实没标默认。
 */
export function followDesktopLabel(presets: AgentPreset[]): string {
  const preset = defaultPreset(presets)
  if (preset === null) return '电脑的默认预设'
  return `电脑的默认预设（${preset.label}）`
}

/** 整理工作目录输入：去掉首尾空白，空就是空（会被当作「用默认」）。 */
export function normalizeCwd(text: string): string {
  return text.trim()
}

/**
 * 组装 `session/create` 的请求体。
 *
 * 只把非空字段写进去：空 `cwd` 永远是「用默认」，不能被当成空字符串目录送过去。
 */
export function createSessionRequest(choice: NewSessionChoice): JsonObject {
  const request: JsonObject = {}
  const preset = choice.agentPreset
  if (preset !== null && preset.length > 0) request['agentPreset'] = preset
  const cwd = normalizeCwd(choice.cwd)
  if (cwd.length > 0) request['cwd'] = cwd
  return request
}

/** 从 `session/create` 的回答里取新会话的 id；没有就返回空串。 */
export function readCreatedSessionId(answer: JsonObject): string {
  return stringField(answer, 'sessionId')
}
