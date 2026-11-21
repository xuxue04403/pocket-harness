/**
 * 模型清单与当前路由。
 *
 * 两件事在这个文件里对齐：`session/modelCatalog` 是「电脑上能用哪些模型」，
 * `session/projections` 的 `modelSelection` 是「这个会话现在用哪一个」。
 * 手机上的选择器要把两者摆在一起，所以这里把 Host 的分组结构压平成一维列表，
 * 并把「当前路由」压成一句可以显示在标题栏里的文案。
 *
 * 三个实测出来的形状细节：
 * - `session/modelCatalog` 的模型在 `groups[].models[]` 里，provider 名在 `groups[].name`；
 * - `session/selectModel` 回答的是**扁平**的 `{provider, model, reasoningEffort}`，
 *   而 `session/projections` 的 `modelSelection` 是**套层**的 `{lastUsed, next}`；
 * - 取 `next` 而不是 `lastUsed` —— 前者才是下一轮要用的路由。
 */

import { arrayField, objectField, stringField, type JsonObject } from './json'

/** 一个模型接受的思考强度。 */
export interface ModelEffort {
  readonly id: string
  readonly name: string
  readonly description: string
}

/** 一条可以被选中的路由：provider + model + 该模型接受的强度。 */
export interface ModelChoice {
  readonly provider: string
  readonly providerName: string
  readonly model: string
  readonly name: string
  readonly description: string
  readonly efforts: ModelEffort[]
  readonly defaultEffort: string
}

/** 整份清单，已压平。 */
export interface ModelCatalog {
  readonly choices: ModelChoice[]
  readonly defaultProvider: string
  readonly defaultModel: string
}

/** 当前路由。 */
export interface ModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: string
}

/** 空清单：读不到时用它，界面显示「这台电脑没有可用的模型」。 */
export const EMPTY_CATALOG: ModelCatalog = {
  choices: [],
  defaultProvider: '',
  defaultModel: '',
}

/** 读一条强度；缺 `name` 用 id 顶上。 */
function readEffort(value: JsonObject): ModelEffort | null {
  const id = stringField(value, 'id', '')
  if (id.length === 0) return null
  return {
    id: id,
    name: stringField(value, 'name', id),
    description: stringField(value, 'description', ''),
  }
}

/** 读一条路由；缺 provider 或 model 就丢弃，因为二者缺一都无法下发。 */
function readChoice(group: JsonObject, value: JsonObject): ModelChoice | null {
  const provider = stringField(group, 'id', '')
  const model = stringField(value, 'id', '')
  if (provider.length === 0 || model.length === 0) return null

  const efforts: ModelEffort[] = []
  let defaultEffort = ''
  const reasoning = objectField(value, 'reasoning')
  if (reasoning !== undefined) {
    const raw = arrayField(reasoning, 'efforts')
    for (let i = 0; i < raw.length; i++) {
      const entry = raw[i]
      if (typeof entry !== 'object' || entry === null) continue
      const effort = readEffort(entry as JsonObject)
      if (effort !== null) efforts.push(effort)
    }
    defaultEffort = stringField(reasoning, 'defaultEffort', '')
  }

  return {
    provider: provider,
    providerName: stringField(group, 'name', provider),
    model: model,
    name: stringField(value, 'name', model),
    description: stringField(value, 'description', ''),
    efforts: efforts,
    defaultEffort: defaultEffort,
  }
}

/** 读 `session/modelCatalog`。畸形条目一律跳过，不让一个坏模型挡住整个选择器。 */
export function readModelCatalog(answer: JsonObject): ModelCatalog {
  const choices: ModelChoice[] = []
  const groups = arrayField(answer, 'groups')
  for (let i = 0; i < groups.length; i++) {
    const entry = groups[i]
    if (typeof entry !== 'object' || entry === null) continue
    const group = entry as JsonObject
    const models = arrayField(group, 'models')
    for (let j = 0; j < models.length; j++) {
      const model = models[j]
      if (typeof model !== 'object' || model === null) continue
      const choice = readChoice(group, model as JsonObject)
      if (choice !== null) choices.push(choice)
    }
  }

  const fallback = objectField(answer, 'default')
  return {
    choices: choices,
    defaultProvider: fallback === undefined ? '' : stringField(fallback, 'provider', ''),
    defaultModel: fallback === undefined ? '' : stringField(fallback, 'model', ''),
  }
}

/**
 * 读一条路由，两种形状都认。
 *
 * 传进来的既可能是 `session/selectModel` 的扁平回答，也可能是
 * `session/projections` 的 `modelSelection`（套着 `next`/`lastUsed`）。
 * 判据是顶层有没有 `provider`：有就是扁平的那个。
 */
export function readModelSelection(value: Object | null): ModelSelection | null {
  if (value === null || typeof value !== 'object') return null
  const map = value as JsonObject

  let route: JsonObject | undefined = undefined
  if (stringField(map, 'provider', '').length > 0) {
    route = map
  } else {
    route = objectField(map, 'next')
    if (route === undefined) route = objectField(map, 'lastUsed')
  }
  if (route === undefined) return null

  const provider = stringField(route, 'provider', '')
  const model = stringField(route, 'model', '')
  if (provider.length === 0 || model.length === 0) return null
  return {
    provider: provider,
    model: model,
    reasoningEffort: stringField(route, 'reasoningEffort', ''),
  }
}

/** 从 `session/projections` 的回答里取 `values.modelSelection`。 */
export function readProjectionSelection(answer: JsonObject): ModelSelection | null {
  const values = objectField(answer, 'values')
  if (values === undefined) return null
  const bag = values['modelSelection']
  return bag === undefined ? null : readModelSelection(bag as Object)
}

/** 找一个路由在清单里的条目；找不到返回 null（路由可能已不再可用）。 */
export function findChoice(catalog: ModelCatalog, selection: ModelSelection | null): ModelChoice | null {
  if (selection === null) return null
  for (let i = 0; i < catalog.choices.length; i++) {
    const choice = catalog.choices[i]
    if (choice.provider === selection.provider && choice.model === selection.model) return choice
  }
  return null
}

/**
 * 标题栏那一行。
 *
 * 拿不到当前路由时说「默认模型」，因为那正是 Host 的行为：会话没有选过，
 * 就跟着电脑的全局默认走。选过就显示模型名，强度只在非空时附上 —— 显示
 * 「model · 」比不显示更难读。
 */
export function routeLabel(catalog: ModelCatalog, selection: ModelSelection | null): string {
  if (selection === null) return '默认模型'
  const choice = findChoice(catalog, selection)
  const name = choice === null ? selection.model : choice.name
  if (selection.reasoningEffort.length === 0) return name
  return `${name} · ${selection.reasoningEffort}`
}

/** 该路由可选的强度；模型没有强度概念时返回空数组。 */
export function effortsOf(choice: ModelChoice | null): ModelEffort[] {
  return choice === null ? [] : choice.efforts
}

/** 选一条路由时应该带上的强度：默认值优先，其次第一个，最后空串。 */
export function defaultEffortOf(choice: ModelChoice): string {
  if (choice.defaultEffort.length > 0) return choice.defaultEffort
  if (choice.efforts.length > 0) return choice.efforts[0].id
  return ''
}
