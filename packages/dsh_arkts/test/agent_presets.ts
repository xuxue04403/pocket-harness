// 预设与新建会话参数的断言。
//
// 重点不在「能不能读」，而在两条只有真机才会踩到的规矩：
// 1. 空 `cwd` 不能变成 `cwd: ''` 发出去（Host 会当成一个空目录）；
// 2. 「跟随电脑」与「显式选了默认预设」必须能区分开。

import {
  createSessionRequest,
  defaultPreset,
  FOLLOW_DESKTOP_PRESET,
  followDesktopLabel,
  normalizeCwd,
  readCreatedSessionId,
  readPreset,
  readPresets,
} from '../src/agent_presets'
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

function preset(id: string, extra: Partial<JsonObject> = {}): JsonObject {
  const base: JsonObject = { id }
  for (const key of Object.keys(extra)) base[key] = extra[key] as Object
  return base
}

function list(value: Object): JsonObject {
  return { presets: value } as JsonObject
}

// ---- 单条预设 ----

const lean = {
  id: 'lean',
  name: '精工模式',
  description: '面向编码与量化策略的精简工具集。',
  isDefault: false,
  order: 5,
}
same('a full preset reads back', readPreset(lean), {
  id: 'lean',
  label: '精工模式',
  description: '面向编码与量化策略的精简工具集。',
  isDefault: false,
  order: 5,
})

ok('a preset without a name falls back to its id', readPreset(preset('ptc'))?.label === 'ptc')
ok('a preset without a description reads as empty', readPreset(preset('ptc'))?.description === '')
ok('a preset without an order reads as zero', readPreset(preset('ptc'))?.order === 0)
ok('isDefault must be literally true', readPreset(preset('ptc', { isDefault: 'yes' }))?.isDefault === false)
ok('a preset with no id is dropped', readPreset({} as JsonObject) === null)
ok('a preset with a blank id is dropped', readPreset(preset('')) === null)

// ---- 整份清单 ----

same('a list sorts by order', readPresets(list([
  preset('cordis', { order: 4 }),
  preset('standard', { order: 1, isDefault: true }),
])).map((entry) => entry.id), ['standard', 'cordis'])

same('equal orders keep their order', readPresets(list([
  preset('b', { order: 2 }),
  preset('a', { order: 2 }),
])).map((entry) => entry.id), ['b', 'a'])

same('malformed entries are skipped', readPresets(list([
  preset('good', { order: 1 }),
  'not an object',
  null,
  ['nested'],
  preset('also-good', { order: 2 }),
])).map((entry) => entry.id), ['good', 'also-good'])

same('a missing presets key reads as empty', readPresets({} as JsonObject), [])
same('a presets value that is not an array reads as empty', readPresets({ presets: 'nope' } as JsonObject), [])

// ---- 默认预设 ----

const presets = readPresets(list([
  preset('standard', { order: 1, isDefault: true }),
  preset('lean', { name: '精工模式', order: 5 }),
]))
ok('the default preset is found', defaultPreset(presets)?.id === 'standard')
ok('a list with no default has no default', defaultPreset(readPresets(list([preset('a')]))) === null)
ok('the follow-desktop label names the default', followDesktopLabel(presets) === '电脑的默认预设（standard）')
ok(
  'the follow-desktop label survives an empty list',
  followDesktopLabel([]) === '电脑的默认预设',
)
ok(
  'the follow-desktop label uses the label, not the id',
  followDesktopLabel(readPresets(list([preset('lean', { name: '精工模式', isDefault: true })]))) ===
    '电脑的默认预设（精工模式）',
)

// ---- 请求体 ----

same('following the desktop sends neither field', createSessionRequest(FOLLOW_DESKTOP_PRESET), {})
same('a preset is sent on its own', createSessionRequest({ agentPreset: 'lean', cwd: '' }), {
  agentPreset: 'lean',
})
same('a working directory is sent on its own', createSessionRequest({ agentPreset: null, cwd: 'D:\\work' }), {
  cwd: 'D:\\work',
})
same('both are sent together', createSessionRequest({ agentPreset: 'lean', cwd: 'D:\\work' }), {
  agentPreset: 'lean',
  cwd: 'D:\\work',
})
same('a blank directory never becomes an empty cwd', createSessionRequest({ agentPreset: null, cwd: '   ' }), {})
same('a directory is trimmed', createSessionRequest({ agentPreset: null, cwd: '  D:\\work  ' }), {
  cwd: 'D:\\work',
})
same('an empty preset id is dropped', createSessionRequest({ agentPreset: '', cwd: '' }), {})
ok('normalizeCwd trims', normalizeCwd('  x  ') === 'x')
ok('normalizeCwd keeps an empty string empty', normalizeCwd('   ') === '')

// ---- 新建结果 ----

ok('the new session id is read', readCreatedSessionId({ sessionId: 'session-1' } as JsonObject) === 'session-1')
ok('a missing session id reads empty', readCreatedSessionId({} as JsonObject) === '')

if (failures.length > 0) {
  console.log(`\n${failures.length} PRESET CHECK(S) FAILED`)
  process.exit(1)
}
console.log('\nALL AGENT PRESET CHECKS PASS (typescript core)')
