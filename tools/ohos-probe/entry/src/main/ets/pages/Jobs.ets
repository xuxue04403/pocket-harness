/**
 * 后台任务页：看这个会话跑过的长命令、跟随输出、终止。
 *
 * 三处口径来自真 Host 的实测（`test/live_jobs.ts` 钉着）：
 * - `job/list` 是**流**，首帧是整集 `{type:'rows', jobs:[...]}`，之后**流不结束**。
 *   所以只能取第一帧；订流等 `done` 会永远等下去。
 * - `job/follow` 回 `opened` → 若干 `output` → `status` 后自行结束。
 * - `job/kill` 对**已结束**的任务回 `{outcome:'already-finished'}` 而不是报错，
 *   所以界面必须说「已经结束了」而不是假装终止成功。
 *
 * **不在这一页验证「杀活任务」**：那个「运行中」的任务很可能就是当前会话自己的工具
 * 调用，杀掉它等于把自己掐断。
 */

import router from '@ohos.router'
import type { Context } from '@kit.AbilityKit'
import { decodeTicket, type PairingTicket } from '../core/pairing'
import { HostStore } from '../storage.ohos'
import { openRelayTransport, openTcpTransport, systemRandom } from '../platform.ohos'
import { LinkClient, LinkRefusedError } from '../core/client'
import type { JsonObject } from '../core/json'
import {
  describeJobError,
  describeKillOutcome,
  followRequest,
  isJobLive,
  jobHeadline,
  jobStatusLabel,
  jobSubtitle,
  killOutcome,
  killRequest,
  OUTCOME_ALREADY_FINISHED,
  readFollowFrame,
  readJobs,
  sortJobs,
  type JobSummary,
} from '../core/jobs'

interface JobsParams {
  readonly ticketText: string
  readonly sessionId: string
}

// AsyncGenerator 的三个类型参数必须都给：ArkTS 不接受它们的 any 默认值，
// 只写一个参数时 `await stream.next()` 会被判成 unknown。
type JobStream = AsyncGenerator<JsonObject, void, undefined>

function describeError(error: Object): string {
  if (error instanceof LinkRefusedError) {
    if (error.reason === 'not-paired') return '这台电脑还不认识这部手机，请在电脑日志里取最新的配对码。'
    if (error.reason === 'pairing-expired') return '配对码已过期，请扫描电脑上当前的配对码。'
    if (error.reason === 'bad-proof') return '配对码不匹配，请扫描电脑上当前的配对码。'
    return `电脑拒绝了这次连接（${error.reason}）。`
  }
  return describeJobError(error)
}

@Entry
@Component
struct Jobs {
  @State hostName: string = 'Pocket Harness'
  @State route: string = ''
  @State jobs: JobSummary[] = []
  @State error: string = ''
  @State notice: string = ''
  @State loading: boolean = true
  @State openJob: JobSummary | null = null
  @State output: string = ''
  @State outputDone: boolean = false
  @State outputLossy: boolean = false
  @State killing: string = ''

  private ticketText: string = ''
  private sessionId: string = ''
  private link: LinkClient | null = null
  private poller: number = -1
  /** 每次开始跟随都加一；过期的循环看到它变了就退出（见 openOutput）。 */
  private outputSeq: number = 0

  aboutToAppear(): void {
    const params = router.getParams() as JobsParams
    this.ticketText = params.ticketText
    this.sessionId = params.sessionId
    this.connect()
  }

  aboutToDisappear(): void {
    if (this.poller >= 0) clearInterval(this.poller)
    // 页面走了，跟随循环也该停：它每来一帧都会往 @State 上写，
    // 而 `this.link` 马上就要被关掉。
    this.outputSeq = this.outputSeq + 1
    this.closeLink()
  }

  private closeLink(): void {
    const link = this.link
    this.link = null
    if (link !== null) link.close()
  }

  private async connect(): Promise<void> {
    this.loading = true
    this.error = ''
    // 点「重试」会再建一条链路，旧的那条必须在这里关掉：它可能还在握着电脑上的
    // 连接名额，而这个页面是唯一持有它的人。一直不关，攒够八条之后电脑就开始
    // 拒新连接，表现成「越重试越连不上」。
    const previous = this.link
    this.link = null
    if (previous !== null) previous.close()
    // 定时器同理：重试会重新走进这里，旧的那个 5 秒轮询不关掉就会一直活着，
    // 每重试一次多一条，最后变成对着一台连不上的电脑每秒发一堆请求。
    if (this.poller >= 0) {
      clearInterval(this.poller)
      this.poller = -1
    }
    try {
      const context = this.getUIContext().getHostContext() as Context
      const store = await HostStore.open(context)
      const identity = await store.deviceIdentity()
      const ticket: PairingTicket = decodeTicket(this.ticketText)
      const link = await LinkClient.connect({
        ticket,
        identity,
        random: systemRandom,
        openTransport: openTcpTransport,
        openRelay: openRelayTransport,
        connectionId: 'jobs-' + Date.now(),
        timeoutMs: 15000,
        heartbeat: true,
      })
      this.link = link
      this.hostName = ticket.hostName
      this.route = link.route === 'relay' ? '经中继' : '局域网直连'
      await this.reload()
      // 整集流不会自己结束，但任务列表会变（新任务、任务结束）。轮询比订流简单，
      // 而且这一页是看一眼就走的，不需要秒级同步。
      this.poller = setInterval(() => { this.reload() }, 5000)
    } catch (error) {
      this.error = describeError(error)
    } finally {
      this.loading = false
    }
  }

  /** 只取 `job/list` 的第一帧：这是一条不会结束的整集流。 */
  private async reload(): Promise<void> {
    const link = this.link
    if (link === null || this.openJob !== null) return
    try {
      const stream: JobStream = link.rpc.openStream(
        'job/list',
        { request: { sessionId: this.sessionId } } as JsonObject,
        { timeoutMs: 20000 },
      )
      const first: IteratorResult<JsonObject, void> = await stream.next()
      await stream.return(undefined)
      if (first.done === true || first.value === undefined) {
        this.jobs = []
        return
      }
      this.jobs = sortJobs(readJobs(first.value))
      this.error = ''
    } catch (error) {
      this.error = describeError(error)
    }
  }

  private async kill(job: JobSummary): Promise<void> {
    const link = this.link
    if (link === null) return
    this.killing = job.id
    try {
      const answer = await link.rpc.call('job/kill', killRequest(this.sessionId, job.id), 20000)
      const outcome = killOutcome(answer)
      this.notice = describeKillOutcome(outcome, jobHeadline(job, 40))
      if (outcome === OUTCOME_ALREADY_FINISHED) await this.reload()
    } catch (error) {
      this.error = describeError(error)
    } finally {
      this.killing = ''
    }
  }

  /** 跟随输出：`opened` → `output`… → `status` 后流自行结束。 */
  private async openOutput(job: JobSummary): Promise<void> {
    const link = this.link
    if (link === null) return
    // 点另一行、或关掉面板，都不会让上一条跟随循环停下：它在 `for (;;)` 里
    // 拿着自己的 `chunks`，每来一帧就把 `this.output = chunks` 写回去。于是旧任务
    // 的输出会盖掉新任务刚显示的内容，而且关掉面板之后还在后台一帧一帧地写。
    // 用一个世代号让过期的循环自己退出。
    const mine = ++this.outputSeq
    this.openJob = job
    this.output = ''
    this.outputDone = false
    this.outputLossy = false
    let stream: JobStream | null = null
    try {
      stream = link.rpc.openStream(
        'job/follow',
        followRequest(job.id, this.sessionId),
        { timeoutMs: 20000 },
      )
      let chunks = ''
      for (;;) {
        const next: IteratorResult<JsonObject, void> = await stream.next()
        if (this.outputSeq !== mine) return
        if (next.done === true || next.value === undefined) break
        const frame = readFollowFrame(next.value)
        if (frame === null) continue
        if (frame.job !== null) this.openJob = frame.job
        if (frame.text.length > 0) {
          chunks += frame.text
          this.output = chunks
        }
        if (frame.lossy) this.outputLossy = true
        if (frame.kind === 'status') {
          this.outputDone = true
        }
      }
      if (this.outputSeq === mine) this.outputDone = true
    } catch (error) {
      if (this.outputSeq !== mine) return
      this.error = describeError(error)
      this.outputDone = true
    } finally {
      // 提前退出时也要把流关掉：`job/follow` 自己不结束的话，网络那头会一直
      // 记着这条流，直到这条链路断开为止。
      if (stream !== null) {
        const abandoned = stream
        abandoned.return(undefined).catch(() => undefined)
      }
    }
  }

  private closeOutput(): void {
    // 关掉面板等于放弃这条跟随：世代号加一，还在跑的循环下一次醒来就退出。
    this.outputSeq = this.outputSeq + 1
    this.openJob = null
    this.output = ''
    this.outputDone = false
    this.outputLossy = false
  }

  @Builder jobRow(job: JobSummary) {
    Row({ space: 10 }) {
      if (isJobLive(job)) {
        LoadingProgress().width(16).height(16)
      } else {
        Text(job.status === 'failed' ? '✕' : '✓')
          .fontSize(14)
          .fontColor(job.status === 'failed' ? '#B3261E' : '#1F6F5C')
      }
      Column({ space: 3 }) {
        Text(jobHeadline(job))
          .fontSize(14)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
        Text(jobSubtitle(job, Date.now()))
          .fontSize(11)
          .fontColor('#888888')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      if (isJobLive(job)) {
        Text(this.killing === job.id ? '…' : '终止')
          .fontSize(12)
          .fontColor('#B3261E')
          .onClick(() => { this.kill(job) })
      }
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 10, bottom: 10 })
    .onClick(() => { this.openOutput(job) })
  }

  @Builder outputView(job: JobSummary) {
    Column({ space: 8 }) {
      Row({ space: 8 }) {
        Text('返回').fontSize(13).fontColor('#1F6F5C')
          .onClick(() => { this.closeOutput() })
        Text(jobStatusLabel(job) + (this.outputDone ? '' : ' · 跟随中'))
          .fontSize(12)
          .fontColor('#888888')
          .layoutWeight(1)
      }
      .width('100%')

      Scroll() {
        Text(this.output.length > 0 ? this.output : (this.outputDone ? '这个任务没有输出。' : '等待输出…'))
          .fontSize(11)
          .fontFamily('monospace')
          .width('100%')
      }
      .layoutWeight(1)
      .width('100%')
      .align(Alignment.TopStart)

      if (this.outputLossy) {
        Text('中间有一段输出已经丢了（任务输出超过电脑保留的上限）。')
          .fontSize(11)
          .fontColor('#B3261E')
          .width('100%')
      }
    }
    .layoutWeight(1)
    .width('100%')
    .padding({ left: 16, right: 16, top: 8, bottom: 8 })
    .alignItems(HorizontalAlign.Start)
  }

  build() {
    Column() {
      Row({ space: 8 }) {
        Column({ space: 2 }) {
          Text('后台任务').fontSize(18).fontWeight(FontWeight.Bold)
          Text(this.route.length > 0 ? `${this.hostName} · ${this.route}` : this.hostName)
            .fontSize(11)
            .fontColor('#888888')
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)

        Text('刷新')
          .fontSize(13)
          .fontColor('#1F6F5C')
          .onClick(() => { this.reload() })
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 12, bottom: 8 })

      if (this.notice.length > 0) {
        Text(this.notice)
          .fontSize(12)
          .fontColor('#1F6F5C')
          .width('100%')
          .padding({ left: 16, right: 16, bottom: 6 })
      }
      if (this.error.length > 0) {
        Text(this.error)
          .fontSize(12)
          .fontColor('#B3261E')
          .width('100%')
          .padding({ left: 16, right: 16, bottom: 6 })
      }

      if (this.openJob !== null) {
        this.outputView(this.openJob as JobSummary)
      } else if (this.loading) {
        Row({ space: 8 }) {
          LoadingProgress().width(20).height(20)
          Text('正在连接…').fontSize(13).fontColor('#666666')
        }
        .padding(16)
      } else if (this.error.length > 0 && this.jobs.length === 0) {
        Column({ space: 12 }) {
          Text('读不到任务列表').fontSize(13).fontColor('#B3261E')
          Button('重试').onClick(() => { this.connect() })
        }
        .padding(16)
        .width('100%')
      } else if (this.jobs.length === 0) {
        Column({ space: 6 }) {
          Text('没有后台任务').fontSize(14).fontColor('#444444')
          Text('电脑上的智能体跑长命令时，任务会出现在这里。')
            .fontSize(12)
            .fontColor('#888888')
        }
        .padding(16)
        .width('100%')
        .alignItems(HorizontalAlign.Start)
      } else {
        List({ space: 0 }) {
          ForEach(this.jobs, (job: JobSummary) => {
            ListItem() {
              this.jobRow(job)
            }
          }, (job: JobSummary) => job.id)
        }
        .layoutWeight(1)
        .width('100%')
        .divider({ strokeWidth: 1, color: '#EEEEEE' })
      }
    }
    .width('100%')
    .height('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
