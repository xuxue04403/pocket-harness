// 用真实 Host 校验技能清单。
//
// `skills/list` 要带 `sessionId`：清单是「按这个会话的目录与预设」算出来的，
// 同一个 App 在不同会话里看到的技能可能不一样。所以要真的拿一个会话去问。
//
// 不插入、不发送任何东西 —— 那会改到真实会话。

import { readSkills } from '../src/skills'
import { connectLive, describeError, type LiveLink } from './live_common'
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

async function main(): Promise<void> {
  console.log('LIVE SKILL CHECKS (against the running Host)')
  let link: LiveLink | null = null
  try {
    link = await connectLive()

    const list = await link.rpc.call('session/list', { _request: {} }, 20_000)
    const items = Array.isArray(list['items']) ? (list['items'] as Object[]) : []
    ok('there is a session to ask about', items.length > 0, `${items.length}`)
    let sessionId = ''
    for (const entry of items) {
      const candidate = (entry as JsonObject)['sessionId']
      if (typeof candidate === 'string' && candidate.length > 0) {
        sessionId = candidate
        break
      }
    }
    ok('a session id was found', sessionId.length > 0)

    const answer = await link.rpc.call('skills/list', { request: { sessionId } }, 20_000)
    const skills = readSkills(answer)
    ok('the Host lists at least one skill', skills.length > 0, `${skills.length}`)

    let nameless = 0
    let undescribed = 0
    let humanOnly = 0
    for (const skill of skills) {
      if (skill.name.length === 0) nameless += 1
      if (skill.description.length === 0) undescribed += 1
      if (!skill.modelInvocable) humanOnly += 1
    }
    ok('every skill has a name', nameless === 0, `${nameless} nameless`)
    ok('every skill has a description', undescribed === 0, `${undescribed} undescribed`)
    console.log(`  ${skills.length} skills, ${humanOnly} human-only`)
    console.log(`  first five: ${skills.slice(0, 5).map((skill) => `/${skill.name}`).join(', ')}`)

    // 调用名必须是 kebab-case 且不含空格：写进输入框时不能把命令切断。
    let malformed = 0
    for (const skill of skills) {
      if (skill.name.includes(' ') || skill.name !== skill.name.toLowerCase()) malformed += 1
    }
    ok('every name is a lowercase token with no spaces', malformed === 0, `${malformed} malformed`)

    if (failures.length > 0) {
      console.log(`\n${failures.length} CHECK(S) FAILED`)
      process.exit(1)
    }
    console.log('REAL SKILL LIST PARSES (live Host)')
  } catch (error) {
    console.log(`FAILED: ${describeError(error as Object)}`)
    process.exit(1)
  } finally {
    if (link !== null) await link.close()
  }
}

main()
