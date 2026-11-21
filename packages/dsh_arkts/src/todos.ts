/**
 * 待办清单（agent 的 plan）。
 *
 * 两处来源，形状一样：
 * - `session/projections` 的 `values.todos`：会话打开时读一次，形如 `null`（还没写过）
 *   或 `TodoItem[]`。**`null` 与空数组要分开** —— 前者是「agent 还没列计划」，
 *   后者是「计划被清空了」，界面上一个该隐藏、一个该显示成空表。
 * - `todo/write` 事件的 `data.todos`：DSH 每次写都**整表替换**，所以条目不需要 id，
 *   最新的一帧就是真相。
 *
 * 三个状态是桌面端展示的全部，也是这个面板值得看的原因：全 `pending` 的列表什么也没说，
 * 而一条 `in_progress` 直接告诉你 agent 现在在做什么。认不出的状态原样保留，
 * 不要因为新版 Host 加了一个状态就让整个面板消失。
 */

import { type JsonObject } from './json'

export const TODO_PENDING = 'pending'
export const TODO_IN_PROGRESS = 'in_progress'
export const TODO_COMPLETED = 'completed'

export interface TodoItem {
  readonly content: string
  readonly status: string
}

/** 解析一条待办；没有可读内容就丢弃（空行在面板里只是噪音）。 */
export function readTodoItem(value: Object): TodoItem | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const map = value as JsonObject
  const content = map.content
  if (typeof content !== 'string') return null
  const trimmed = content.trim()
  if (trimmed.length === 0) return null
  const status = map.status
  return { content: trimmed, status: typeof status === 'string' ? status : TODO_PENDING }
}

function readList(raw: Object | null | undefined): TodoItem[] {
  if (raw === null || raw === undefined) return []
  if (!Array.isArray(raw)) return []
  const items: TodoItem[] = []
  for (const entry of raw as Object[]) {
    const item = readTodoItem(entry)
    if (item !== null) items.push(item)
  }
  return items
}

/**
 * 从 `session/projections` 的 `values` 里读待办。
 *
 * 返回 `null` 表示「还没有计划」，返回空数组表示「有计划但一条都没写」——
 * 目前 DSH 不会给出后者，但把两者分开能让调用方不必猜。
 */
export function readTodos(values: JsonObject): TodoItem[] | null {
  const raw = values.todos
  if (raw === null || raw === undefined) return null
  // 不是数组说明这个 projection 的形状变了（或者被别的扩展占了同名键）。这时候
  // 返回 null 让面板隐藏，比返回空数组让界面宣称「计划为空」更诚实。
  if (!Array.isArray(raw)) return null
  return readList(raw)
}

/** 从 `todo/write` 事件的 `data` 里读待办：整表替换。 */
export function readTodoWrite(data: JsonObject): TodoItem[] {
  const raw = data.todos
  if (raw === null || raw === undefined) return []
  return readList(raw)
}

export function isTodoDone(item: TodoItem): boolean {
  return item.status === TODO_COMPLETED
}

export function isTodoRunning(item: TodoItem): boolean {
  return item.status === TODO_IN_PROGRESS
}

/** `已完成 2/5`。列表为空时回空串，免得面板标题出现 `0/0`。 */
export function todoProgress(items: TodoItem[]): string {
  if (items.length === 0) return ''
  const done = items.filter((item) => isTodoDone(item)).length
  return `已完成 ${done}/${items.length}`
}

/**
 * 折叠时显示的那一行：优先正在做的那条，否则第一条没做完的，再否则最后一条。
 * 全做完时停下来说「全部完成」，比重复最后一条的内容有用。
 */
export function todoSummary(items: TodoItem[]): string {
  if (items.length === 0) return ''
  const running = items.filter((item) => isTodoRunning(item))
  if (running.length > 0) return running[0].content
  const pending = items.filter((item) => !isTodoDone(item))
  if (pending.length === 0) return '全部完成'
  return pending[0].content
}

/** 面板该不该出现：没有计划时整块隐藏。 */
export function shouldShowTodos(items: TodoItem[] | null): boolean {
  return items !== null && items.length > 0
}
