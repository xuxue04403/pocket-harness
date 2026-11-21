// 电脑的全局设置。
//
// `settings/describe` 一次回整份配置档案：24 个命名空间，每个带当前值与 revision。
// 手机端只做两件事 —— 让人看见有哪些、并改掉其中一个（全局默认模型）。
//
// 三条必须遵守的规矩：
// - **写必须带 `expectedRevision`**。不带就是「最后写入者赢」，会把电脑上刚改过的
//   值无声覆盖掉；带了不匹配就得到 `settings/conflict`，这比覆盖好。
// - **`secrets` 里的字段是被打码的**。它们显示为空不是「没设置」，是「在电脑上设过
//   但这里看不到」，界面必须说明，而不是让人对着空框发愁。
// - **写同一个值不会递增 revision**（实测），所以「没变」既不该报错也不该当成写入。

import { arrayField, numberField, objectField, stringField } from './json'
import type { JsonObject } from './json'

/** 一个命名空间的当前状态。 */
export interface SettingsNamespace {
  readonly ns: string
  readonly value: JsonObject
  /** 电脑上显式保存的那一层（可能为空）。 */
  readonly user: JsonObject
  /** schema 给的默认值（可能为空）。 */
  readonly base: JsonObject
  readonly revision: number
  /** 写入何时生效，例如 `live`；缺失表示电脑没说明。 */
  readonly applies: string
  /** 被打码、手机上填不了的字段名。 */
  readonly secrets: string[]
}

/** 整份 `settings/describe` 的回答。 */
export interface SettingsSnapshot {
  readonly writable: boolean
  readonly hasDocument: boolean
  readonly namespaces: SettingsNamespace[]
}

export const EMPTY_SETTINGS: SettingsSnapshot = {
  writable: false,
  hasDocument: false,
  namespaces: [],
}

/** 全局默认模型住在哪个命名空间。 */
export const DEFAULT_MODEL_NS = 'agent-default-model'

/** 读一个命名空间；没有 `ns` 的丢弃。 */
export function readNamespace(entry: JsonObject): SettingsNamespace | null {
  const ns = stringField(entry, 'ns')
  if (ns.length === 0) return null
  return {
    ns,
    value: objectField(entry, 'value') ?? {},
    user: objectField(entry, 'user') ?? {},
    base: objectField(entry, 'base') ?? {},
    revision: numberField(entry, 'revision', 0),
    applies: stringField(entry, 'applies'),
    secrets: arrayField(entry, 'secrets').filter((name): name is string => typeof name === 'string'),
  }
}

/** 读整份回答。坏条目跳过，不让一个畸形命名空间清空整页。 */
export function readSettings(answer: JsonObject): SettingsSnapshot {
  const raw = answer['namespaces']
  const namespaces: SettingsNamespace[] = []
  if (Array.isArray(raw)) {
    for (const entry of raw as Object[]) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      const namespace = readNamespace(entry as JsonObject)
      if (namespace !== null) namespaces.push(namespace)
    }
  }
  return {
    writable: answer['writable'] === true,
    hasDocument: answer['hasDocument'] === true,
    namespaces,
  }
}

/** 按名字找一个命名空间。 */
export function findNamespace(snapshot: SettingsSnapshot, ns: string): SettingsNamespace | null {
  for (const entry of snapshot.namespaces) {
    if (entry.ns === ns) return entry
  }
  return null
}

/**
 * 写成 `settings/update` 的请求体。
 *
 * `patch` 是**部分**值：电脑会与当前值合并，所以只传要改的键就够。
 * `expectedRevision` 必须来自刚刚读到的那一份；编一个假值只会换来
 * `settings/conflict`。
 */
export function updateRequest(namespace: SettingsNamespace, patch: JsonObject): JsonObject {
  return { ns: namespace.ns, patch: patch, expectedRevision: namespace.revision }
}

/**
 * 只读列表里的一行摘要。
 *
 * 只挑几个「一眼能读懂」的键，其余用数量概括 —— 把 24 个命名空间的完整 JSON
 * 摊在手机上没人看得下去。
 */
export function summarize(namespace: SettingsNamespace, limit: number = 2): string {
  const parts: string[] = []
  const keys = Object.keys(namespace.value)
  for (const key of keys) {
    if (parts.length >= limit) break
    const raw = namespace.value[key]
    if (raw === null || typeof raw === 'object') continue
    let text = '' + raw
    if (typeof raw === 'boolean') text = raw ? '开' : '关'
    if (text.length > 24) text = text.slice(0, 23) + '…'
    parts.push(key + '=' + text)
  }
  if (parts.length === 0) {
    if (namespace.secrets.length > 0) return '含电脑上保存的密钥，已隐藏'
    return keys.length === 0 ? '空' : keys.length + ' 项设置'
  }
  return parts.join(' · ')
}

/** 这个命名空间里有没有手机上填不了的字段。 */
export function hasSecrets(namespace: SettingsNamespace): boolean {
  return namespace.secrets.length > 0
}

/** 写完之后怎么更新本地状态：电脑会回新的 `revision` 与 `value`。 */
export function applyUpdate(namespace: SettingsNamespace, answer: JsonObject): SettingsNamespace {
  const value = objectField(answer, 'value')
  return {
    ns: namespace.ns,
    value: value ?? namespace.value,
    user: namespace.user,
    base: namespace.base,
    revision: numberField(answer, 'revision', namespace.revision),
    applies: namespace.applies,
    secrets: namespace.secrets,
  }
}

/**
 * 把 `settings/conflict` 之类的错误翻成一句能照做的话。
 *
 * 冲突时**不要**自动重读再重试：那等于替人决定要覆盖电脑上的改动，界面应该让人
 * 重新看一眼再决定。
 */
export function describeSettingsError(error: Object): string {
  const text = '' + error
  // 两种写法都要认：有的构建把错误码放在前面（`settings/conflict …`），有的只给
  // 一句英文说明（`settings namespace "x" changed since it was read`）。
  if (text.includes('settings/conflict') || text.includes('changed since it was read')) {
    return '这个设置在电脑上刚被改过。请重新打开这一页再改，避免覆盖掉那边的改动。'
  }
  if (text.includes('settings/rejected')) {
    return '电脑拒绝了这个值，可能是类型或取值范围不对。'
  }
  return text
}
