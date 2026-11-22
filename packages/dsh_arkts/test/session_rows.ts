// 会话行的解析与排序。
//
// 这几条规则全部来自对真实 Host 的观察：主键叫 sessionId、标题在 projections 里、
// projections 可能缺失、800 多个会话没有分页。每一条都写进断言，因为界面上
// 出错时最难判断的就是「是数据形状变了还是界面写错了」。

import { cwdOf, filterSessionRows, readSessionRow, readSessionRows, sortSessionRows, UNTITLED_SESSION, type SessionRow } from '../src/session_rows'
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
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  ok(label, left === right, `got ${left}, expected ${right}`)
}

function checkRows(): void {
  // 完整形状：标题在 projections.values.title，目录在顶层 cwd。
  const full: JsonObject = {
    sessionId: 'session-a',
    updatedAt: 1_700_000_000_000,
    running: true,
    cwd: 'D:\\work',
    projections: { values: { title: 'Refactor the runner', agentPreset: 'lean' } },
  }
  const row = readSessionRow(full)
  ok('a full record is read', row !== null)
  if (row !== null) {
    ok('the key is sessionId', row.sessionId === 'session-a')
    ok('the title comes from projections', row.title === 'Refactor the runner', row.title)
    ok('the directory is preferred over the timestamp', row.detail === 'D:\\work', row.detail)
    ok('the running flag is read', row.running)
    ok('the timestamp is kept', row.updatedAt === 1_700_000_000_000)
  }

  // 没有标题：用占位文案，不是空字符串。
  const untitled = readSessionRow({
    sessionId: 'session-b',
    updatedAt: 1_700_000_000_000,
    cwd: 'D:\\work\\untitled',
  })
  ok('a session without a title still renders', untitled !== null && untitled.title === UNTITLED_SESSION)

  // 没有 cwd：退回相对时间。
  const noCwd = readSessionRow({ sessionId: 'session-c', updatedAt: Date.now() - 30_000 })
  ok('a session without a directory shows when it moved', noCwd !== null && noCwd.detail === '刚刚')

  // 没有 sessionId：无法定位，直接丢弃。
  ok('a record without a session id is dropped', readSessionRow({ title: 'orphan' }) === null)

  // projections 存在但 values 缺失，不能抛错。
  const noValues = readSessionRow({ sessionId: 'session-d', projections: { asOfSeq: 3 } })
  ok('projections without values do not throw', noValues !== null && noValues.title === UNTITLED_SESSION)

  // projections 是 null（Host 可能给 null）。
  const nullProjections = readSessionRow({ sessionId: 'session-e', projections: null })
  ok('a null projections bag does not throw', nullProjections !== null)

  // 列表层：跳过非对象与坏条目。
  const list: JsonObject = {
    items: [
      { sessionId: 'one', updatedAt: 1 },
      null,
      'not an object',
      { title: 'no id' },
      { sessionId: 'two', updatedAt: 2 },
    ],
  }
  const rows = readSessionRows(list)
  same('only readable rows survive', rows.map((r: SessionRow): string => r.sessionId), ['one', 'two'])

  ok('a response without items is empty', readSessionRows({}).length === 0)
}

function checkSort(): void {
  const rows: SessionRow[] = [
    { sessionId: 'old', title: 'old', detail: '', running: false, updatedAt: 100 },
    { sessionId: 'idle-new', title: 'new', detail: '', running: false, updatedAt: 900 },
    { sessionId: 'live-old', title: 'live', detail: '', running: true, updatedAt: 10 },
  ]
  const sorted = sortSessionRows(rows)
  same(
    'running comes first, then newest',
    sorted.map((row: SessionRow): string => row.sessionId),
    ['live-old', 'idle-new', 'old'],
  )
  same('the input order is not mutated', rows.map((row: SessionRow): string => row.sessionId), ['old', 'idle-new', 'live-old'])
}

function checkFilter(): void {
  const rows: SessionRow[] = [
    { sessionId: 's1', title: 'Pocket Harness 设计', detail: 'D:\\IDE\\dsh-bot', running: false, updatedAt: 1 },
    { sessionId: 's2', title: '码率优化', detail: 'D:\\IDE\\UU', running: false, updatedAt: 2 },
    { sessionId: 's3', title: '未命名会话', detail: 'C:\\Users\\xuexu\\.dsh\\profiles\\desktop', running: false, updatedAt: 3 },
  ]

  same('an empty query keeps every row', filterSessionRows(rows, '').map((r: SessionRow): string => r.sessionId), ['s1', 's2', 's3'])
  same('whitespace is an empty query', filterSessionRows(rows, '   ').map((r: SessionRow): string => r.sessionId), ['s1', 's2', 's3'])
  same('the title matches case-insensitively', filterSessionRows(rows, 'pocket').map((r: SessionRow): string => r.sessionId), ['s1'])
  same('the directory matches', filterSessionRows(rows, 'uu').map((r: SessionRow): string => r.sessionId), ['s2'])
  same('the directory matches with backslashes and case', filterSessionRows(rows, 'IDE\\UU'.toLowerCase()).map((r: SessionRow): string => r.sessionId), ['s2'])
  same('no match is an empty list', filterSessionRows(rows, 'nothing-like-this'), [])
  same('the session id is not searched', filterSessionRows(rows, 's2'), [])
  // 返回副本：界面把结果直接赋给 @State，若与入参同一个数组，ArkUI 判不出变化。
  ok('the result is a copy', filterSessionRows(rows, '') !== rows)

  // 空查询返回「全部」而技能过滤返回「空」——这条差异是刻意的，写在这里防止被"统一"。
  same('an empty query keeps everything, unlike the skill filter', filterSessionRows(rows, '').length, 3)
}

function checkCwd(): void {
  // `detail` 有两种填法：有工作目录时是绝对路径，否则是相对时间。指令页要拿目录
  // 去问 Host「哪些 AGENTS 类文件生效」，把「3 小时前」当目录传下去，Host 找不到
  // 项目根，界面上看起来就是「这个项目一份指令文件都没有」。
  const withDir: SessionRow = { sessionId: 'a', title: 't', detail: 'D:\\IDE\\dsh-bot', running: false, updatedAt: 1 }
  const posix: SessionRow = { sessionId: 'b', title: 't', detail: '/home/me/app', running: false, updatedAt: 1 }
  const withTime: SessionRow = { sessionId: 'c', title: 't', detail: '3 小时前', running: false, updatedAt: 1 }
  const justNow: SessionRow = { sessionId: 'd', title: 't', detail: '刚刚', running: false, updatedAt: 1 }
  const blank: SessionRow = { sessionId: 'e', title: 't', detail: '', running: false, updatedAt: 1 }

  same('a windows directory is the cwd', cwdOf(withDir), 'D:\\IDE\\dsh-bot')
  same('a posix directory is the cwd', cwdOf(posix), '/home/me/app')
  same('a relative time is not a directory', cwdOf(withTime), '')
  same('"刚刚" is not a directory', cwdOf(justNow), '')
  same('an empty detail is not a directory', cwdOf(blank), '')
}

function main(): void {
  console.log('session rows')
  checkRows()
  checkSort()
  checkFilter()
  checkCwd()
  if (failures.length > 0) {
    console.log(`\n${failures.length} SESSION ROW CHECK(S) FAILED`)
    process.exit(1)
  }
  console.log('\nALL SESSION ROW CHECKS PASS (typescript core)')
}

main()
