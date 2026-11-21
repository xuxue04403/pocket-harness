/**
 * 用真实 Host 的 `session/projections` 校验待办解析。
 *
 * 这台机器上 869 个会话里有 54 个真的带计划，所以「扫到一条计划」是能成立的断言；
 * 但计划分布很稀（大约每 16 个会话一条），扫太少就会 flaky。做法是扫到出现计划为止
 * （上限 200），同时把「还没列计划」的那种形状也断言一遍 —— 两种形状都要见过，
 * 否则只能证明其中一条路没被走错。
 */

import { connectLive, describeError } from './live_common'
import type { JsonObject } from '../src/json'
import { stringField } from '../src/json'
import {
  readTodos,
  shouldShowTodos,
  todoProgress,
  todoSummary,
  type TodoItem,
} from '../src/todos'

let failures = 0

function ok(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok  ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}`)
}

const SCAN_LIMIT = 200

async function main(): Promise<void> {
  const link = await connectLive()
  try {
    const list = await link.rpc.call('session/list', { _request: {} } as JsonObject, 20000)
    const items = list.items
    ok('session/list answers with items', Array.isArray(items))
    const rows = Array.isArray(items) ? (items as Object[]) : []
    ok('there is at least one session to look at', rows.length > 0)

    const scanned = Math.min(rows.length, SCAN_LIMIT)
    let sawNull = 0
    let sawList = 0
    let todoLines = 0
    let firstPlan = ''

    for (let index = 0; index < scanned; index += 1) {
      const row = rows[index]
      if (row === null || typeof row !== 'object') continue
      const sessionId = stringField(row as JsonObject, 'sessionId', '')
      if (sessionId.length === 0) continue
      const projections = await link.rpc.call(
        'session/projections',
        { request: { sessionId: sessionId } } as JsonObject,
        20000,
      )
      const values = projections.values
      if (values === null || typeof values !== 'object' || Array.isArray(values)) {
        sawNull += 1
        continue
      }
      const todos: TodoItem[] | null = readTodos(values as JsonObject)
      if (todos === null) {
        sawNull += 1
        ok(`session ${index}: no plan hides the panel`, !shouldShowTodos(todos))
        continue
      }
      sawList += 1
      todoLines += todos.length
      ok(`session ${index}: every todo has content`, todos.every((item) => item.content.length > 0))
      ok(`session ${index}: every todo has a status`, todos.every((item) => item.status.length > 0))
      if (todos.length > 0) {
        const progress = todoProgress(todos)
        const summary = todoSummary(todos)
        ok(`session ${index}: progress reads as a fraction`, progress.indexOf('/') > 0)
        ok(`session ${index}: a summary is never empty`, summary.length > 0)
        if (firstPlan.length === 0) {
          firstPlan = `${todos.length} lines, first=${todos[0].content} (${todos[0].status}), ${progress}`
        }
      }
    }

    console.log(`scanned ${scanned} sessions: ${sawList} with a plan (${todoLines} lines), ${sawNull} without`)
    if (firstPlan.length > 0) console.log(`first plan seen: ${firstPlan}`)

    // 两条路都要真的走到：这台机器上「没有计划」占绝大多数，而带计划的是少数，
    // 所以两个断言分别说明两件事 —— 一种是常态，一种是被验证过确实存在的形状。
    ok('the "no plan yet" shape really occurs', sawNull > 0)
    ok('at least one session has a plan', sawList > 0)
  } finally {
    await link.close()
  }

  if (failures > 0) {
    console.log(`FAILED: ${failures} check(s)`)
    process.exitCode = 1
  } else {
    console.log('REAL TODOS PARSE FROM A LIVE HOST (live Host)')
  }
}

main().catch((error: Object) => {
  console.log(`FAILED: ${describeError(error)}`)
  process.exitCode = 1
})
