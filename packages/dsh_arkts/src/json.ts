// JSON 读写。
//
// ArkTS 不接受 `unknown`/`any`，而 `JSON.parse` 在鸿蒙的 lib 里返回 `Object`。
// 所以这里收口成 `JsonObject`，并给出若干只做形状检查的取值函数 —— 读到的
// 东西一律是 `Object`，用的时候再按需 `as` 成具体类型。

import { fromUtf8, utf8 } from './bytes'

/** 一个 JSON 对象。值一律是 `Object`，因为 ArkTS 没有联合类型的下标访问。 */
export type JsonObject = Record<string, Object>

export function parseJson(text: string): Object {
  return JSON.parse(text) as Object
}

/** 解析并按对象校验。 */
export function parseJsonObject(text: string): JsonObject {
  const parsed = parseJson(text)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('the JSON value is not an object')
  }
  return parsed as JsonObject
}

export function parseJsonBytes(bytes: Uint8Array): JsonObject {
  return parseJsonObject(fromUtf8(bytes))
}

export function encodeJsonBytes(value: JsonObject): Uint8Array {
  return utf8(JSON.stringify(value))
}

/** 取字符串字段；类型不符时返回 `fallback`。 */
export function stringField(source: JsonObject, key: string, fallback: string = ''): string {
  if (!(key in source)) return fallback
  const value = source[key]
  return typeof value === 'string' ? (value as string) : fallback
}

/** 取数字字段；类型不符时返回 `fallback`。 */
export function numberField(source: JsonObject, key: string, fallback: number = 0): number {
  if (!(key in source)) return fallback
  const value = source[key]
  return typeof value === 'number' ? (value as number) : fallback
}

/** 取布尔字段；只有真正的 `true` 才算真。 */
export function flagField(source: JsonObject, key: string): boolean {
  return key in source && source[key] === true
}

/** 取数组字段；类型不符时当作空数组。 */
export function arrayField(source: JsonObject, key: string): Object[] {
  if (!(key in source)) return []
  const value = source[key]
  return Array.isArray(value) ? (value as Object[]) : []
}

/** 取对象字段；类型不符时当作缺失。 */
export function objectField(source: JsonObject, key: string): JsonObject | undefined {
  if (!(key in source)) return undefined
  const value = source[key]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as JsonObject
}
