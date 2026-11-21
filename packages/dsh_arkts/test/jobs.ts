/**
 * 后台任务的断言。
 *
 * `job/list` 是一条**不结束**的整集流，`job/kill` 对已结束的任务回
 * `already-finished` 而不是报错 —— 这两件事是这一层最容易搞错的地方，所以
 * 这里既钉解析也钉文案。
 */

import type { JsonObject } from '../src/json'
import {
  describeJobError,
  describeKillOutcome,
  durationLabel,
  FOLLOW_OPENED,
  FOLLOW_OUTPUT,
  FOLLOW_STATUS,
  followRequest,
  isJobLive,
  jobHeadline,
  jobStatusLabel,
  jobSubtitle,
  killOutcome,
  killRequest,
  OUTCOME_ALREADY_FINISHED,
  OUTCOME_REQUESTED,
  readFollowFrame,
  readJob,
  readJobs,
  sortJobs,
  type JobSummary,
} from '../src/jobs'

let failures = 0

function eq(label: string, actual: string, expected: string): void {
  if (actual === expected) {
    console.log(`  ok  ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`)
}

function ok(label: string, condition: boolean): void {
  eq(label, condition ? 'true' : 'false', 'true')
}

function same(label: string, actual: string[], expected: string[]): void {
  eq(label, JSON.stringify(actual), JSON.stringify(expected))
}

const NOW = 1_800_000_000_000

function job(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: 'job-1',
    kind: 'pwsh',
    label: 'cd D:\\IDE\\dsh-bot; Get-ChildItem',
    status: 'running',
    progress: '',
    detail: '',
    startedAt: NOW - 5000,
    finishedAt: 0,
    ...overrides,
  }
}

function record(overrides: JsonObject = {}): JsonObject {
  return {
    id: 'job-1',
    kind: 'pwsh',
    label: 'cd D:\\IDE\\dsh-bot; Get-ChildItem',
    status: 'running',
    startedAt: NOW - 5000,
    finishedAt: 0,
    ...overrides,
  }
}

function checkReadJob(): void {
  const full = readJob(record())
  ok('a full record parses', full !== null)
  eq('the id survives', full?.id ?? '', 'job-1')
  eq('the kind survives', full?.kind ?? '', 'pwsh')
  eq('the status survives', full?.status ?? '', 'running')
  eq('startedAt survives', `${full?.startedAt ?? -1}`, `${NOW - 5000}`)

  const noId = readJob(record({ id: '' }))
  ok('a record without an id is dropped', noId === null)

  const sparse = readJob({ id: 'x' })
  ok('a sparse record still yields a job', sparse !== null)
  eq('a missing kind becomes "job"', sparse?.kind ?? '', 'job')
  eq('a missing label falls back to the id', sparse?.label ?? '', 'x')
  eq('a missing status is empty', sparse?.status ?? 'x', '')

  const array = readJob(record({ kind: 'pwsh' } as JsonObject))
  ok('a normal kind is kept', array?.kind === 'pwsh')
}

function checkReadJobs(): void {
  const answer: JsonObject = {
    type: 'rows',
    jobs: [record(), record({ id: 'job-2', status: 'completed' }), 'not-an-object', { kind: 'pwsh' }],
  }
  const jobs = readJobs(answer)
  same('bad entries are skipped, not fatal', jobs.map((entry: JobSummary): string => entry.id), ['job-1', 'job-2'])

  same('a response without jobs is empty', readJobs({}).map((entry: JobSummary): string => entry.id), [])

  // job/list 是流：首帧就是 rows，之后不再有帧。解析层只关心这一帧。
  const first: JsonObject = { type: 'rows', jobs: [] }
  same('an empty first frame is legal', readJobs(first).map((entry: JobSummary): string => entry.id), [])
}

function checkStatus(): void {
  ok('running is live', isJobLive(job({ status: 'running' })))
  ok('stopping is live', isJobLive(job({ status: 'stopping' })))
  ok('completed is not live', !isJobLive(job({ status: 'completed' })))
  ok('killed is not live', !isJobLive(job({ status: 'killed' })))

  eq('running reads as 运行中', jobStatusLabel(job({ status: 'running' })), '运行中')
  eq('stopping reads as 停止中', jobStatusLabel(job({ status: 'stopping' })), '停止中')
  eq('completed reads as 已完成', jobStatusLabel(job({ status: 'completed' })), '已完成')
  eq('killed reads as 已终止', jobStatusLabel(job({ status: 'killed' })), '已终止')
  eq('failed reads as 失败', jobStatusLabel(job({ status: 'failed' })), '失败')
  // 认不出的状态原样出现：写「未知」就再也查不到 Host 的新状态了。
  eq('an unknown status is shown verbatim', jobStatusLabel(job({ status: 'suspended' })), 'suspended')
}

function checkSort(): void {
  const jobs: JobSummary[] = [
    job({ id: 'done-new', status: 'completed', startedAt: 900 }),
    job({ id: 'live-old', status: 'running', startedAt: 100 }),
    job({ id: 'done-old', status: 'completed', startedAt: 50 }),
    job({ id: 'live-new', status: 'stopping', startedAt: 500 }),
  ]
  same(
    'live jobs first, then newest',
    sortJobs(jobs).map((entry: JobSummary): string => entry.id),
    ['live-new', 'live-old', 'done-new', 'done-old'],
  )
  same(
    'the input order is not mutated',
    jobs.map((entry: JobSummary): string => entry.id),
    ['done-new', 'live-old', 'done-old', 'live-new'],
  )
}

function checkRequests(): void {
  eq(
    'follow carries the job id',
    JSON.stringify(followRequest('job-1', '')),
    JSON.stringify({ request: { jobId: 'job-1' } }),
  )
  eq(
    'follow includes the session when known',
    JSON.stringify(followRequest('job-1', 'session-9')),
    JSON.stringify({ request: { jobId: 'job-1', sessionId: 'session-9' } }),
  )
  // kill 的 sessionId 是必填的：Host 用它定位任务，缺了会报边界校验失败。
  eq(
    'kill always carries the session',
    JSON.stringify(killRequest('session-9', 'job-1')),
    JSON.stringify({ request: { sessionId: 'session-9', jobId: 'job-1' } }),
  )
}

function checkKillOutcome(): void {
  eq('a missing outcome reads as requested', killOutcome({}), OUTCOME_REQUESTED)
  eq('requested survives', killOutcome({ outcome: 'requested' }), 'requested')
  eq('already-finished survives', killOutcome({ outcome: 'already-finished' }), OUTCOME_ALREADY_FINISHED)

  // 这条文案的差别很重要：说「已请求终止」会让用户以为是自己刚点掉的。
  eq(
    'already-finished is admitted instead of faked',
    describeKillOutcome(OUTCOME_ALREADY_FINISHED, 'x'),
    '这个任务在你说之前就已经结束了。',
  )
  ok(
    'a real kill says it only requested',
    describeKillOutcome(OUTCOME_REQUESTED, 'Get-ChildItem').includes('已经请求终止'),
  )
  ok(
    'a real kill repeats the label',
    describeKillOutcome(OUTCOME_REQUESTED, 'Get-ChildItem').includes('Get-ChildItem'),
  )
}

function checkFollowFrames(): void {
  const opened = readFollowFrame({
    type: FOLLOW_OPENED,
    job: record(),
    from: { at: 1, text: 2 },
  })
  ok('opened carries the job', opened?.job?.id === 'job-1')
  eq('opened carries no text', opened?.text ?? 'x', '')

  const output = readFollowFrame({
    type: FOLLOW_OUTPUT,
    chunks: [{ at: 1, text: 'relay listening\n' }, { at: 2, text: 'on port 65316\n' }],
    next: { at: 2, text: 3 },
  })
  eq('output frames concatenate their chunks', output?.text ?? '', 'relay listening\non port 65316\n')
  ok('an ordinary output frame is not lossy', output?.lossy === false)

  const lossy = readFollowFrame({
    type: FOLLOW_OUTPUT,
    chunks: [{ text: '…' }],
    lossy: true,
  })
  ok('a lossy frame says so', lossy?.lossy === true)

  const badChunk = readFollowFrame({ type: FOLLOW_OUTPUT, chunks: ['nope', { text: 'ok' }, null] })
  eq('bad chunks are skipped inside the frame', badChunk?.text ?? '', 'ok')

  const status = readFollowFrame({ type: FOLLOW_STATUS, job: record({ status: 'completed' }) })
  eq('status carries the final state', status?.job?.status ?? '', 'completed')

  ok('an unknown frame type is ignored', readFollowFrame({ type: 'heartbeat' }) === null)
  ok('an empty frame is ignored', readFollowFrame({}) === null)
}

function checkDuration(): void {
  eq('under a second', durationLabel(job({ startedAt: NOW }), NOW), '不到 1 秒')
  eq('seconds', durationLabel(job({ startedAt: NOW - 8000 }), NOW), '8 秒')
  eq('a finished job uses finishedAt', durationLabel(job({ startedAt: NOW - 8000, finishedAt: NOW - 3000 }), NOW), '5 秒')
  eq('minutes', durationLabel(job({ startedAt: NOW - 71000 }), NOW), '1 分 11 秒')
  eq('whole minutes lose the zero seconds', durationLabel(job({ startedAt: NOW - 120000 }), NOW), '2 分钟')
  eq('hours', durationLabel(job({ startedAt: NOW - 3_600_000 * 2 - 60_000 * 5 }), NOW), '2 小时 5 分')
  // 没有 startedAt 就不显示时长：写「0 秒」会被读成任务瞬间失败。
  eq('no startedAt means no duration', durationLabel(job({ startedAt: 0 }), NOW), '')
}

function checkSubtitle(): void {
  eq('just the status when nothing else is known', jobSubtitle(job({ status: 'running', startedAt: 0 }), NOW), '运行中')
  eq(
    'progress and duration join with dots',
    jobSubtitle(job({ status: 'running', progress: '42%', startedAt: NOW - 8000 }), NOW),
    '运行中 · 42% · 8 秒',
  )
  eq(
    'detail joins too',
    jobSubtitle(job({ status: 'killed', detail: 'killed before exit', startedAt: NOW - 3000, finishedAt: NOW - 1000 }), NOW),
    '已终止 · killed before exit · 2 秒',
  )
}

function checkHeadline(): void {
  eq('a short label is unchanged', jobHeadline(job({ label: 'ls' })), 'ls')
  eq('newlines collapse into spaces', jobHeadline(job({ label: 'cd a\n&&\nls' })), 'cd a && ls')
  const long = jobHeadline(job({ label: 'x'.repeat(200) }), 40)
  ok('a long label is truncated', long.length <= 41)
  ok('a long label ends with an ellipsis', long.endsWith('…'))
}

function checkErrorText(): void {
  ok('a dead link is explained', describeJobError(new Error('the link stopped answering')).includes('连接已经断了'))
  ok('a closed link is explained', describeJobError(new Error('the secure channel closed')).includes('连接已经断了'))
  ok('a vanished job is explained', describeJobError(new Error('no such job')).includes('已经找不到了'))
  eq('anything else is passed through', describeJobError(new Error('boom')), 'boom')
  eq('a non-Error is stringified', describeJobError('plain'), 'plain')
}

function main(): void {
  console.log('jobs')
  checkReadJob()
  checkReadJobs()
  checkStatus()
  checkSort()
  checkRequests()
  checkKillOutcome()
  checkFollowFrames()
  checkDuration()
  checkSubtitle()
  checkHeadline()
  checkErrorText()
  if (failures > 0) {
    console.log(`FAILED: ${failures} job check(s)`)
    process.exit(1)
  }
  console.log('ALL JOB CHECKS PASS (typescript core)')
}

main()
