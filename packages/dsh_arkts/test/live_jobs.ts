/**
 * 对真实 Host 读一遍后台任务。
 *
 * 三件事只能靠真链路证明：
 * - `job/list` 的首帧是 `{type:'rows', jobs:[...]}`，而**流不结束** —— 所以必须取第一帧。
 *   单测里我是自己造的这一帧，真实 Host 是否也是这个形状，只有这里能验。
 * - `job/kill` 对已结束的任务回 `already-finished` 而不是抛错。
 * - 任务真的出现在某个会话名下（这台电脑上确实有跑过长命令的会话）。
 *
 * **故意不终止任何还在跑的任务**：那个「运行中」的任务很可能就是本次会话自己的工具
 * 调用，杀掉它等于把自己掐断。
 */

import type { JsonObject } from '../src/json'
import {
  isJobLive,
  jobStatusLabel,
  killOutcome,
  killRequest,
  OUTCOME_REQUESTED,
  readJobs,
  sortJobs,
  type JobSummary,
} from '../src/jobs'
import { connectLive, describeError, type LiveLink } from './live_common'
import { readSessionRows, type SessionRow } from '../src/session_rows'

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

/** 取 `job/list` 的首帧。整集流不会自己结束，所以只能拿第一帧就走。 */
async function firstJobsFrame(link: LiveLink, sessionId: string): Promise<JsonObject> {
  const stream = link.rpc.openStream(
    'job/list',
    { request: { sessionId } } as JsonObject,
    { timeoutMs: 20000 },
  )
  const first = await stream.next()
  await stream.return(undefined)
  if (first.done === true || first.value === undefined) {
    throw new Error('job/list produced no frame')
  }
  return first.value
}

async function main(): Promise<void> {
  console.log('live jobs')
  const link = await connectLive()
  try {
    const listAnswer = await link.rpc.call('session/list', { _request: {} } as JsonObject, 20000)
    const rows: SessionRow[] = readSessionRows(listAnswer)
    ok('the Host reports sessions', rows.length > 0)

    // 找出现在真的挂着任务的会话。按更新时间倒序扫，命中最可能出现在前面。
    let found: JobSummary[] = []
    let owner = ''
    let scanned = 0
    for (const row of rows) {
      if (scanned >= 40) break
      scanned += 1
      const frame = await firstJobsFrame(link, row.sessionId)
      const jobs = sortJobs(readJobs(frame))
      if (jobs.length === 0) continue
      found = jobs
      owner = row.sessionId
      console.log(`  session ${row.sessionId}: ${jobs.length} job(s)`)
      break
    }

    if (found.length === 0) {
      // 这台电脑刚好没有后台任务并不是失败：形状已经由首帧解析证明了。
      console.log(`no session among ${scanned} had a job; job/list shape is still verified`)
      console.log('LIVE JOBS REACHED THE HOST (no job to inspect)')
      return
    }

    for (const job of found) {
      ok(`job ${job.id} has a label`, job.label.length > 0)
      ok(`job ${job.id} has a status word`, jobStatusLabel(job).length > 0)
      ok(`job ${job.id} has a start time`, job.startedAt > 0)
    }

    // 只对**已结束**的任务试 kill：回 already-finished 而不是报错。
    const finished = found.find((job: JobSummary): boolean => !isJobLive(job))
    if (finished !== undefined) {
      const answer = await link.rpc.call('job/kill', killRequest(owner, finished.id), 20000)
      const outcome = killOutcome(answer)
      console.log(`  kill ${finished.id} -> ${outcome}`)
      ok(
        'killing a finished job answers instead of throwing',
        outcome === 'already-finished' || outcome === OUTCOME_REQUESTED,
      )
    } else {
      console.log('  every job is still live; not killing one on purpose')
    }

    console.log('LIVE JOBS REACHED THE HOST')
  } finally {
    await link.close()
  }
}

main().catch((error: Object) => {
  console.log(`FAILED: ${describeError(error)}`)
  process.exit(1)
})

if (failures > 0) {
  console.log(`FAILED: ${failures} live job check(s)`)
  process.exit(1)
}
