// 全局设置的断言。
//
// 重点：坏命名空间不整页清空、`expectedRevision` 一定带上、被打码的密钥不能显示成
// 「空」、写同值不算新版本。

import {
  applyUpdate,
  DEFAULT_MODEL_NS,
  EMPTY_SETTINGS,
  findNamespace,
  hasSecrets,
  readNamespace,
  readSettings,
  summarize,
  updateRequest,
  describeSettingsError,
} from '../src/settings'
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
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  ok(label, a === b, `${a} !== ${b}`)
}

function namespace(ns: string, value: JsonObject, extra: Partial<JsonObject> = {}): JsonObject {
  const base: JsonObject = { ns, value, revision: 10 }
  for (const key of Object.keys(extra)) base[key] = extra[key] as Object
  return base
}

function settingsOf(entries: Object[], extra: Partial<JsonObject> = {}): JsonObject {
  const base: JsonObject = { writable: true, hasDocument: true, namespaces: entries }
  for (const key of Object.keys(extra)) base[key] = extra[key] as Object
  return base
}

// ---- 单个命名空间 ----

same('a full namespace reads back', readNamespace(namespace('agent-default-model', {
  provider: 'gateway',
  model: 'deepseek-v4.1-flash',
}, { user: { model: 'x' }, base: { model: 'y' }, applies: 'live' })), {
  ns: 'agent-default-model',
  value: { provider: 'gateway', model: 'deepseek-v4.1-flash' },
  user: { model: 'x' },
  base: { model: 'y' },
  revision: 10,
  applies: 'live',
  secrets: [],
})

ok('a namespace with no name is dropped', readNamespace({ value: {} } as JsonObject) === null)
ok('a namespace with a blank name is dropped', readNamespace(namespace('', {})) === null)
ok('a missing value reads as an empty object', (() => {
  const read = readNamespace({ ns: 'x', revision: 3 } as JsonObject)
  return read !== null && Object.keys(read.value).length === 0 && read.revision === 3
})())
ok('a missing revision reads as zero', readNamespace({ ns: 'x', value: {} } as JsonObject)?.revision === 0)
ok('a missing applies reads as an empty string',
  readNamespace(namespace('x', {}))?.applies === '')
ok('secrets keep only strings', (() => {
  const read = readNamespace(namespace('x', {}, { secrets: ['apiKey', 42, null, 'token'] }))
  return read !== null && read.secrets.join(',') === 'apiKey,token'
})())
ok('a value that is not an object reads as empty', (() => {
  const read = readNamespace({ ns: 'x', value: 'nope', revision: 1 } as JsonObject)
  return read !== null && Object.keys(read.value).length === 0
})())

// ---- 整份回答 ----

ok('the snapshot keeps every namespace in order', (() => {
  const read = readSettings(settingsOf([
    namespace('a', {}),
    namespace('b', {}),
    namespace('c', {}),
  ]))
  return read.namespaces.length === 3 && read.namespaces[0].ns === 'a' && read.namespaces[2].ns === 'c'
})())
same('malformed namespaces are skipped', readSettings(settingsOf([
  namespace('good', {}),
  'not an object',
  null,
  42,
  namespace('also-good', {}),
])).namespaces.map((entry) => entry.ns), ['good', 'also-good'])
same('a missing namespaces key reads as empty', readSettings({ writable: true } as JsonObject).namespaces, [])
same('a namespaces value that is not an array reads as empty',
  readSettings({ namespaces: 'nope' } as JsonObject).namespaces, [])
ok('writable must be literally true', readSettings({ writable: 'yes', namespaces: [] } as JsonObject).writable === false)
ok('hasDocument must be literally true',
  readSettings({ hasDocument: 1, namespaces: [] } as JsonObject).hasDocument === false)
same('the empty snapshot is empty', EMPTY_SETTINGS.namespaces, [])
ok('an empty snapshot is not writable', EMPTY_SETTINGS.writable === false)

// ---- 查找 ----

const snapshot = readSettings(settingsOf([
  namespace('agent-default-model', { provider: 'gateway', model: 'deepseek-v4.1-flash' }),
  namespace('ui-theme', { preference: 'system', fontSize: 14 }),
  namespace('pwsh-sandbox', { mode: 'workspace-write', enabled: true }),
]))

ok('a namespace is found by name', findNamespace(snapshot, DEFAULT_MODEL_NS)?.ns === DEFAULT_MODEL_NS)
ok('an unknown name finds nothing', findNamespace(snapshot, 'nope') === null)
ok('the default-model namespace name is what DSH uses',
  DEFAULT_MODEL_NS === 'agent-default-model')

// ---- 写请求 ----

const model = findNamespace(snapshot, DEFAULT_MODEL_NS)
ok('the model namespace exists', model !== null)
if (model !== null) {
  same('the update request carries the revision that was read',
    updateRequest(model, { provider: 'deepseek-official', model: 'deepseek-v4-pro' }), {
      ns: 'agent-default-model',
      patch: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      expectedRevision: 10,
    })
  ok('the patch is partial, not the whole value',
    Object.keys((updateRequest(model, { model: 'x' }).patch as JsonObject)).length === 1)
}

// ---- 摘要 ----

ok('the summary names a couple of plain keys', (() => {
  const theme = findNamespace(snapshot, 'ui-theme')
  if (theme === null) return false
  const text = summarize(theme)
  return text.includes('preference=system') && text.includes('fontSize=14')
})())
ok('the summary stops at the limit', (() => {
  const theme = findNamespace(snapshot, 'ui-theme')
  if (theme === null) return false
  return !summarize(theme, 1).includes('fontSize')
})())
ok('a boolean reads as 开', (() => {
  const sandbox = findNamespace(snapshot, 'pwsh-sandbox')
  if (sandbox === null) return false
  return summarize(sandbox).includes('enabled=开')
})())
ok('a redacted namespace says so instead of looking empty', (() => {
  const redacted = readNamespace(namespace('llm-pi-ai', {}, { secrets: ['apiKey'] }))
  if (redacted === null) return false
  return summarize(redacted) === '含电脑上保存的密钥，已隐藏'
})())
ok('a truly empty namespace says 空', (() => {
  const empty = readNamespace(namespace('x', {}))
  if (empty === null) return false
  return summarize(empty) === '空'
})())
ok('an object-only namespace counts its keys', (() => {
  const nested = readNamespace(namespace('x', { a: { b: 1 }, c: { d: 2 } }))
  if (nested === null) return false
  return summarize(nested) === '2 项设置'
})())
ok('a long value is shortened', (() => {
  const long = readNamespace(namespace('x', { path: '/a/very/long/path/that/keeps/going/for/a/while' }))
  if (long === null) return false
  const text = summarize(long)
  return text.includes('…') && text.length < 40
})())
ok('having secrets is visible to the caller', (() => {
  const redacted = readNamespace(namespace('x', {}, { secrets: ['apiKey'] }))
  return redacted !== null && hasSecrets(redacted)
})())
ok('a plain namespace has no secrets', hasSecrets(snapshot.namespaces[0]) === false)

// ---- 写回 ----

ok('the answer moves the revision forward', (() => {
  const before = snapshot.namespaces[0]
  const after = applyUpdate(before, { ns: 'agent-default-model', revision: 11, value: { model: 'x' } })
  return after.revision === 11 && sameQuiet(after.value, { model: 'x' })
})())
ok('an answer without a revision keeps the old one', (() => {
  const before = snapshot.namespaces[0]
  const after = applyUpdate(before, { value: { model: 'x' } } as JsonObject)
  return after.revision === before.revision
})())
ok('an answer without a value keeps the old one', (() => {
  const before = snapshot.namespaces[0]
  const after = applyUpdate(before, { revision: 12 } as JsonObject)
  return sameQuiet(after.value, before.value) && after.revision === 12
})())
ok('writing the same value leaves the revision alone', (() => {
  // 实测：写同值时电脑回的还是旧 revision，所以界面不该把它当成「已经改了」。
  const before = snapshot.namespaces[0]
  const after = applyUpdate(before, { revision: before.revision, value: before.value } as JsonObject)
  return after.revision === before.revision
})())

// ---- 错误文案 ----

ok('a conflict tells the person to look again', (() => {
  const text = describeSettingsError(
    new Error('RpcException(gateway/internal): settings/conflict settings namespace "agent-default-model" changed since it was read'))
  return text.includes('刚被改过') && text.includes('重新打开这一页')
})())
ok('a rejected value says the computer refused it', (() => {
  const text = describeSettingsError(new Error('settings/rejected nope'))
  return text.includes('电脑拒绝了这个值')
})())
ok('an unknown failure keeps its own words', (() => {
  const text = describeSettingsError(new Error('the link stopped answering'))
  return text.includes('stopped answering')
})())

function sameQuiet(a: JsonObject, b: JsonObject): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

if (failures.length > 0) {
  console.log(`\n${failures.length} SETTINGS CHECK(S) FAILED`)
  process.exit(1)
}
console.log('\nALL SETTINGS CHECKS PASS (typescript core)')
