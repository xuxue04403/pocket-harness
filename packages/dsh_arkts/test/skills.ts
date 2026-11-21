// 技能清单的断言。
//
// 重点：插入文本的拼接（空草稿不留前导空格、非空草稿要补分隔符）、
// 空查询返回全部（与会话过滤相反）、坏条目跳过。

import {
  appendSkill,
  filterSkills,
  readSkill,
  readSkills,
  skillInvocation,
  SKILL_PREFIX,
} from '../src/skills'
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

function skill(name: string, extra: Partial<JsonObject> = {}): JsonObject {
  const base: JsonObject = { name, description: `about ${name}` }
  for (const key of Object.keys(extra)) base[key] = extra[key] as Object
  return base
}

function skillsOf(value: Object): JsonObject {
  return { skills: value } as JsonObject
}

// ---- 单条 ----

same('a full skill reads back', readSkill({
  name: 'brainstorming',
  description: '探索意图与设计',
  whenToUse: '在动手之前',
  path: '/skills/brainstorming/SKILL.md',
  modelInvocable: true,
}), {
  name: 'brainstorming',
  description: '探索意图与设计',
  whenToUse: '在动手之前',
  path: '/skills/brainstorming/SKILL.md',
  modelInvocable: true,
})

ok('a skill without optional fields reads as empty strings', (() => {
  const read = readSkill({ name: 'x' } as JsonObject)
  return read !== null && read.description === '' && read.whenToUse === '' && read.path === ''
})())
ok('modelInvocable must be literally true', readSkill(skill('x', { modelInvocable: 'yes' }))?.modelInvocable === false)
ok('a skill with no name is dropped', readSkill({} as JsonObject) === null)
ok('a skill with a blank name is dropped', readSkill(skill('')) === null)

// ---- 整份清单 ----

ok('the list keeps its order', (() => {
  const read = readSkills(skillsOf([skill('b'), skill('a')]))
  return read.length === 2 && read[0].name === 'b' && read[1].name === 'a'
})())
same('malformed entries are skipped', readSkills(skillsOf([
  skill('good'),
  'not an object',
  null,
  42,
  skill('also-good'),
])).map((entry) => entry.name), ['good', 'also-good'])
same('a missing skills key reads as empty', readSkills({} as JsonObject), [])
same('a skills value that is not an array reads as empty', readSkills({ skills: 'nope' } as JsonObject), [])

// ---- 过滤 ----

const sample = readSkills(skillsOf([
  { name: 'brainstorming', description: '探索意图', whenToUse: '动手之前' },
  { name: 'autopilot', description: '保持 PR 可合并', whenToUse: '长时间任务' },
  { name: 'canvas', description: '画布', whenToUse: '' },
]))

same('an empty query returns everything', filterSkills(sample, '').map((entry) => entry.name),
  ['brainstorming', 'autopilot', 'canvas'])
same('a blank query returns everything', filterSkills(sample, '   ').map((entry) => entry.name),
  ['brainstorming', 'autopilot', 'canvas'])
same('names match', filterSkills(sample, 'auto').map((entry) => entry.name), ['autopilot'])
same('descriptions match', filterSkills(sample, '画布').map((entry) => entry.name), ['canvas'])
same('when-to-use matches', filterSkills(sample, '动手').map((entry) => entry.name), ['brainstorming'])
same('the query is case-insensitive', filterSkills(sample, 'BRAIN').map((entry) => entry.name),
  ['brainstorming'])
same('no match returns nothing', filterSkills(sample, 'zzz'), [])
ok('filtering does not change the input', (() => {
  const before = sample.map((entry) => entry.name).join(',')
  filterSkills(sample, 'auto')
  return sample.map((entry) => entry.name).join(',') === before
})())
ok('filtering returns a copy, not the input itself', filterSkills(sample, '') !== sample)

// ---- 插入文本 ----

const brainstorm = sample[0]
ok('an invocation is the slash command with a trailing space',
  skillInvocation(brainstorm) === '/brainstorming ')
ok('the prefix constant is a slash', SKILL_PREFIX === '/')

ok('appending to an empty draft adds no leading space',
  appendSkill('', brainstorm) === '/brainstorming ')
ok('appending after a word inserts one space',
  appendSkill('look at this', brainstorm) === 'look at this /brainstorming ')
ok('appending after a space does not double it',
  appendSkill('look at this ', brainstorm) === 'look at this /brainstorming ')
ok('appending after a newline does not add a space',
  appendSkill('line\n', brainstorm) === 'line\n/brainstorming ')
ok('appending after a tab does not add a space',
  appendSkill('x\t', brainstorm) === 'x\t/brainstorming ')
ok('two skills do not glue together', (() => {
  const autopilot = sample[1]
  const once = appendSkill('', brainstorm)
  const twice = appendSkill(once, autopilot)
  return twice === '/brainstorming /autopilot '
})())

if (failures.length > 0) {
  console.log(`\n${failures.length} SKILL CHECK(S) FAILED`)
  process.exit(1)
}
console.log('\nALL SKILL CHECKS PASS (typescript core)')
