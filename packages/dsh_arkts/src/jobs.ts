/**
 * 后台任务：电脑上跑着的长命令。
 *
 * 形状来自 Dart 侧实测（`app/lib/src/dsh/host_link.dart` 的 `JobSummary`）：
 *
 * - `job/list` 是**流**，首帧是 `{type:'rows', jobs:[...]}`，之后**流不结束**——
 *   它是一条持续推送的整集流，所以只能取首帧，不能 `toList()`。
 * - `job/follow` 是流，回 `opened` → 若干 `output` → `status` 后**自行结束**；
 *   `output` 帧里的文本是 `chunks[].text` 拼起来的，不是一整段。
 * - `job/kill` 对**已结束**的任务回 `{outcome:'already-finished'}` 而不是报错。
 *   界面必须说「已经结束了」而不是假装终止成功，否则用户会以为是自己点掉的。
 *
 * 这里只做纯解析与文案，所有网络动作在页面里。
 */

import { arrayField, numberField, objectField, stringField, type JsonObject } from './json'

/** 一台后台任务。`progress`/`detail` 是可选的人类可读补充。 */
export interface JobSummary {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly status: string
  readonly progress: string
  readonly detail: string
  readonly startedAt: number
  readonly finishedAt: number
}

export const JOB_RUNNING = 'running'
export const JOB_STOPPING = 'stopping'
export const JOB_COMPLETED = 'completed'
export const JOB_KILLED = 'killed'
export const JOB_FAILED = 'failed'

export const OUTCOME_REQUESTED = 'requested'
export const OUTCOME_ALREADY_FINISHED = 'already-finished'

/** 正在跑（含正在停）的任务。只有这些能终止，也只有这些要转圈。 */
export function isJobLive(job: JobSummary): boolean {
  return job.status === JOB_RUNNING || job.status === JOB_STOPPING
}

/**
 * 状态的四个字。
 *
 * 认不出的状态原样返回而不是归成「未知」：Host 将来加一个状态时，界面上写着
 * `suspended` 至少能让人查得到，写成「未知」就什么都查不到了。
 */
export function jobStatusLabel(job: JobSummary): string {
  if (job.status === JOB_RUNNING) return '运行中'
  if (job.status === JOB_STOPPING) return '停止中'
  if (job.status === JOB_COMPLETED) return '已完成'
  if (job.status === JOB_KILLED) return '已终止'
  if (job.status === JOB_FAILED) return '失败'
  return job.status
}

/** 读一条任务。没有 `id` 就丢弃：没有 id 既不能跟随也不能终止，留着只是占位。 */
export function readJob(value: JsonObject): JobSummary | null {
  const id = stringField(value, 'id', '')
  if (id.length === 0) return null
  const kind = stringField(value, 'kind', '')
  const label = stringField(value, 'label', '')
  return {
    id,
    kind: kind.length > 0 ? kind : 'job',
    label: label.length > 0 ? label : id,
    status: stringField(value, 'status', ''),
    progress: stringField(value, 'progress', ''),
    detail: stringField(value, 'detail', ''),
    startedAt: numberField(value, 'startedAt', 0),
    finishedAt: numberField(value, 'finishedAt', 0),
  }
}

/** 读 `job/list` 的一帧。坏条目跳过，不让一条畸形任务挡住整页。 */
export function readJobs(answer: JsonObject): JobSummary[] {
  const raw = arrayField(answer, 'jobs')
  const out: JobSummary[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const job = readJob(entry as JsonObject)
    if (job !== null) out.push(job)
  }
  return out
}

/**
 * 运行中的排前面，再按开始时间倒序。
 *
 * 一个会话里通常只有一两条在跑，而它们正是用户打开这一页要看的东西；剩下几十条
 * 已结束的任务排在后面，顺序按时间倒序就好。不改入参（界面的 @State 只认新数组）。
 */
export function sortJobs(jobs: JobSummary[]): JobSummary[] {
  const copy = jobs.slice()
  copy.sort((left: JobSummary, right: JobSummary): number => {
    const leftLive = isJobLive(left)
    const rightLive = isJobLive(right)
    if (leftLive !== rightLive) return leftLive ? -1 : 1
    return right.startedAt - left.startedAt
  })
  return copy
}

/** `job/follow` 的请求体。`sessionId` 可不传，传了能让 Host 少查一次。 */
export function followRequest(jobId: string, sessionId: string): JsonObject {
  const request: JsonObject = { jobId }
  if (sessionId.length > 0) request.sessionId = sessionId
  return { request }
}

/** `job/kill` 的请求体。`sessionId` 在这里**必须**有，Host 用它定位任务。 */
export function killRequest(sessionId: string, jobId: string): JsonObject {
  return { request: { sessionId, jobId } }
}

/** 终止的结果。缺 `outcome` 时按「已受理」处理（Host 的默认语义）。 */
export function killOutcome(answer: JsonObject): string {
  const outcome = stringField(answer, 'outcome', '')
  return outcome.length > 0 ? outcome : OUTCOME_REQUESTED
}

/** 终止之后该跟用户说什么。 */
export function describeKillOutcome(outcome: string, label: string): string {
  if (outcome === OUTCOME_ALREADY_FINISHED) return '这个任务在你说之前就已经结束了。'
  return `已经请求终止「${label}」。命令收到信号后可能还要几秒才退出。`
}

/** `job/follow` 的一帧。`output` 帧已经把多个 chunk 拼成一段文本。 */
export interface JobFollowFrame {
  readonly kind: string
  readonly text: string
  readonly job: JobSummary | null
  readonly lossy: boolean
}

export const FOLLOW_OPENED = 'opened'
export const FOLLOW_OUTPUT = 'output'
export const FOLLOW_STATUS = 'status'

/**
 * 读一帧 `job/follow`。
 *
 * `output` 帧的文本藏在 `chunks[]` 里，每条自己的 `text`；把它们拼起来才是这一帧新增
 * 的输出。`lossy` 表示中间丢了内容（任务输出超过上限），界面要提示「可能不完整」，
 * 否则用户会以为命令真的没打印那几行。
 */
export function readFollowFrame(value: JsonObject): JobFollowFrame | null {
  const kind = stringField(value, 'type', '')
  if (kind === FOLLOW_OPENED || kind === FOLLOW_STATUS) {
    const job = objectField(value, 'job')
    return {
      kind,
      text: '',
      job: job === undefined ? null : readJob(job),
      lossy: false,
    }
  }
  if (kind !== FOLLOW_OUTPUT) return null
  const chunks = arrayField(value, 'chunks')
  let text = ''
  for (const entry of chunks) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    text += stringField(entry as JsonObject, 'text', '')
  }
  return { kind, text, job: null, lossy: value.lossy === true }
}

/**
 * 「跑了多久」。
 *
 * 还在跑就用当前时间算；结束了就用 `finishedAt`。`startedAt` 缺失（0）时返回空串，
 * 界面据此不显示时长 —— 显示「0 秒」比什么都不显示更容易被误解成任务瞬间失败了。
 */
export function durationLabel(job: JobSummary, now: number): string {
  if (job.startedAt <= 0) return ''
  const end = job.finishedAt > 0 ? job.finishedAt : now
  const delta = Math.max(0, end - job.startedAt)
  if (delta < 1000) return '不到 1 秒'
  const seconds = Math.floor(delta / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return rest === 0 ? `${minutes} 分钟` : `${minutes} 分 ${rest} 秒`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}

/** 一行副标题：状态 + 进度 + 细节 + 时长，空的项跳过。 */
export function jobSubtitle(job: JobSummary, now: number): string {
  const parts: string[] = [jobStatusLabel(job)]
  if (job.progress.length > 0) parts.push(job.progress)
  if (job.detail.length > 0) parts.push(job.detail)
  const duration = durationLabel(job, now)
  if (duration.length > 0) parts.push(duration)
  return parts.join(' · ')
}

/** 任务的标题行：单行、超长截断。命令行常常很长，整行铺开会把状态挤没。 */
export function jobHeadline(job: JobSummary, limit = 80): string {
  const flat = job.label.replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  return `${flat.slice(0, limit)}…`
}

/** 能不能把任务输出当成可读文本看（有些任务是二进制的，界面不渲染）。 */
export function describeJobError(error: Object): string {
  const text = `${error instanceof Error ? error.message : error}`
  if (text.includes('stopped answering') || text.includes('closed')) {
    return '连接已经断了。请返回上一页重新连接。'
  }
  if (text.includes('no such job') || text.includes('not found')) {
    return '这个任务在电脑上已经找不到了。它可能已经被清理。'
  }
  return text
}
