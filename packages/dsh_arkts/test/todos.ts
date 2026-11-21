/**
 * 待办清单的断言。
 *
 * 两处来源形状一样但语义不同：`session/projections` 的 `values.todos` 可能是
 * `null`（还没列计划），而 `todo/write` 事件每次**整表替换**。`null` 与空数组
 * 必须分开，否则界面会在 agent 还没列计划时显示一个空面板。
 */

import type { JsonObject } from '../src/json'
import {
  TODO_COMPLETED,
  TODO_IN_PROGRESS,
  TODO_PENDING,
  isTodoDone,
  isTodoRunning,
  readTodoItem,
  readTodoWrite,
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

function same(label: string, actual: number, expected: number): void {
  ok(`${label} (got ${actual})`, actual === expected)
}

function eq(label: string, actual: string, expected: string): void {
  ok(`${label} (got "${actual}")`, actual === expected)
}

function item(content: string, status: string): JsonObject {
  return { content: content, status: status } as JsonObject
}

function parsed(content: string, status: string): TodoItem {
  const read = readTodoItem(item(content, status) as Object)
  if (read === null) throw new Error(`could not read ${content}`)
  return read
}

function checkReadItem(): void {
  const full = readTodoItem(item('读一下协议', 'in_progress') as Object)
  ok('a full item is read', full !== null)
  if (full !== null) {
    eq('its content survives', full.content, '读一下协议')
    eq('its status survives', full.status, 'in_progress')
  }

  const noStatus = readTodoItem({ content: '只有内容' } as JsonObject as Object)
  ok('a missing status defaults to pending', noStatus !== null && noStatus.status === TODO_PENDING)

  const unknown = readTodoItem(item('x', 'deferred') as Object)
  ok('an unknown status is kept verbatim', unknown !== null && unknown.status === 'deferred')

  ok('no content is dropped', readTodoItem({ status: 'pending' } as JsonObject as Object) === null)
  ok('a blank content is dropped', readTodoItem(item('   ', 'pending') as Object) === null)
  ok('a number is not an item', readTodoItem(3 as Object) === null)
  ok('null is not an item', readTodoItem(null as Object) === null)
  ok('an array is not an item', readTodoItem([] as Object) === null)

  const padded = readTodoItem(item('  缩进过的内容  ', 'pending') as Object)
  ok('content is trimmed', padded !== null && padded.content === '缩进过的内容')
}

function checkReadTodos(): void {
  const three = { todos: [item('a', 'completed'), item('b', 'in_progress'), item('c', 'pending')] } as JsonObject
  const read = readTodos(three)
  ok('a list is read', read !== null)
  same('all three survive', read === null ? 0 : read.length, 3)

  ok('a missing todos key stays null', readTodos({} as JsonObject) === null)
  ok('a null todos value stays null', readTodos({ todos: null } as JsonObject) === null)
  const empty = readTodos({ todos: [] } as JsonObject)
  ok('an empty list reads as an empty list, not null', empty !== null && empty.length === 0)

  const withJunk = readTodos({ todos: [item('a', 'pending'), 7, null, item('  ', 'pending')] } as JsonObject)
  same('junk entries are skipped', withJunk === null ? -1 : withJunk.length, 1)

  ok('a non-array todos stays null', readTodos({ todos: 'nope' } as JsonObject) === null)
}

function checkReadWrite(): void {
  const written = readTodoWrite({ todos: [item('一', 'pending'), item('二', 'completed')] } as JsonObject)
  same('a write carries the whole list', written.length, 2)
  same('a write with no todos is empty', readTodoWrite({} as JsonObject).length, 0)
  same('a write with junk is empty', readTodoWrite({ todos: 5 } as JsonObject).length, 0)
}

function checkStatusHelpers(): void {
  ok('completed is done', isTodoDone(parsed('x', TODO_COMPLETED)))
  ok('pending is not done', !isTodoDone(parsed('x', TODO_PENDING)))
  ok('in_progress is running', isTodoRunning(parsed('x', TODO_IN_PROGRESS)))
  ok('completed is not running', !isTodoRunning(parsed('x', TODO_COMPLETED)))
}

function checkProgress(): void {
  eq(
    'progress counts done out of all',
    todoProgress([
      parsed('a', 'completed'),
      parsed('b', 'completed'),
      parsed('c', 'in_progress'),
      parsed('d', 'pending'),
      parsed('e', 'pending'),
    ]),
    '已完成 2/5',
  )
  eq('an empty list has no progress text', todoProgress([]), '')
  eq('nothing done reads 0/n', todoProgress([parsed('a', 'pending')]), '已完成 0/1')
}

function checkSummary(): void {
  eq(
    'the running line wins',
    todoSummary([parsed('第一步', 'completed'), parsed('第二步', 'in_progress'), parsed('第三步', 'pending')]),
    '第二步',
  )
  eq(
    'otherwise the first unfinished line',
    todoSummary([parsed('第一步', 'completed'), parsed('第二步', 'pending')]),
    '第二步',
  )
  eq('an all-done list says so', todoSummary([parsed('第一步', 'completed'), parsed('第二步', 'completed')]), '全部完成')
  eq('an empty list has no summary', todoSummary([]), '')
}

function checkVisibility(): void {
  ok('null hides the panel', !shouldShowTodos(null))
  ok('an empty list hides the panel', !shouldShowTodos([]))
  ok('a written list shows it', shouldShowTodos([parsed('a', 'pending')]))
}

checkReadItem()
checkReadTodos()
checkReadWrite()
checkStatusHelpers()
checkProgress()
checkSummary()
checkVisibility()

if (failures > 0) {
  console.log(`FAILED: ${failures} check(s)`)
  process.exitCode = 1
} else {
  console.log('ALL TODO CHECKS PASS (typescript core)')
}
