/**
 * 对话页。
 *
 * 走的是 `session/follow` 这条流：第一帧是 snapshot（历史），之后是实时事件与
 * 逐字增量。三个必须照做的细节：
 * - `activate: true` 不给就永远没有帧（DSH 有意如此，被动读不激活智能体）；
 * - `assistantStream: true` 才有逐字增量，否则只能等整条消息落定；
 * - snapshot 之后到达的事件要按 `seq` 去重后插入，因为替换型事件会带同一个
 *   `seq` 再来一次。
 */

import router from '@ohos.router'
import type { Context } from '@kit.AbilityKit'
import { decodeTicket, type PairingTicket } from '../core/pairing'
import { HostStore } from '../storage.ohos'
import { openTcpTransport, systemRandom } from '../platform.ohos'
import { LinkClient, LinkRefusedError } from '../core/client'
import { stringField, type JsonObject } from '../core/json'
import {
  readStreamDelta,
  readTranscript,
  readTranscriptRow,
  recordsOfSnapshot,
  ROW_ASSISTANT,
  ROW_NOTICE,
  ROW_TOOL,
  ROW_USER,
  type StreamDelta,
  type TranscriptRow,
} from '../core/transcript'

// AsyncGenerator 的三个类型参数必须都给：ArkTS 不接受它们的 ny 默认值。
type FollowStream = AsyncGenerator<JsonObject, void, undefined>

interface ChatParams {
  readonly ticketText: string
  readonly sessionId: string
  readonly title: string
}

/** 流式草稿：一次 attempt 还没落定的正文与思考。 */
interface Draft {
  attemptId: string
  text: string
  reasoning: string
}

function describeError(error: Object): string {
  if (error instanceof LinkRefusedError) {
    if (error.reason === 'not-paired') return '这台电脑还不认识这部手机。'
    if (error.reason === 'pairing-expired') return '配对码已过期。'
    if (error.reason === 'bad-proof') return '配对码不匹配。'
    return `电脑拒绝了这次连接（${error.reason}）。`
  }
  const text = '' + error
  if (text.includes('did not answer the hello')) return '连不上这台电脑。'
  if (text.includes('stopped answering')) return '连接已经断了。'
  return text
}

/** 界面上一行的外观。 */
interface RowView {
  readonly key: string
  readonly kind: string
  readonly title: string
  readonly body: string
  readonly tone: string
}

@Entry
@Component
struct Chat {
  @State rows: RowView[] = []
  @State draftText: string = ''
  @State draftReasoning: string = ''
  @State running: boolean = false
  @State error: string = ''
  @State loading: boolean = true
  @State input: string = ''
  @State sending: boolean = false
  private link: LinkClient | null = null
  private stream: FollowStream | null = null
  private draft: Draft | null = null
  private ticketText: string = ''
  private sessionId: string = ''
  private title: string = '会话'

  aboutToAppear(): void {
    const params = router.getParams() as ChatParams
    this.ticketText = params.ticketText
    this.sessionId = params.sessionId
    this.title = params.title
    this.connect()
  }

  aboutToDisappear(): void {
    this.stopStream()
    this.link?.close()
    this.link = null
  }

  private stopStream(): void {
    const stream = this.stream
    this.stream = null
    if (stream !== null) {
      // 取消生成器即取消订阅；Host 侧看到流关闭会停止推送。
      stream.return().catch(() => {})
    }
  }

  private async connect(): Promise<void> {
    this.loading = true
    this.error = ''
    try {
      const ticket: PairingTicket = decodeTicket(this.ticketText)
      const context = this.getUIContext().getHostContext() as Context
      const store = await HostStore.open(context)
      const identity = await store.deviceIdentity()
      const link = await LinkClient.connect({
        ticket: ticket,
        identity: identity,
        random: systemRandom,
        openTransport: openTcpTransport,
        timeoutMs: 15000,
        heartbeat: true,
      })
      this.link = link
      this.watch(link)
    } catch (error) {
      this.error = describeError(error as Object)
      this.loading = false
    }
  }

  private watch(link: LinkClient): void {
    const stream: FollowStream = link.openStream('session/follow', {
      request: {
        address: { kind: 'session', sessionId: this.sessionId },
        maxMessages: 40,
        activate: true,
        assistantStream: true,
      },
    }, 30000)
    this.stream = stream
    this.pump(stream)
  }

  /** 消费 follow 流；任何一帧都要落到 @State 上才能看见。 */
  private async pump(stream: FollowStream): Promise<void> {
    try {
      for await (const frame of stream) {
        if (this.stream !== stream) return
        this.accept(frame)
      }
    } catch (error) {
      if (this.stream !== stream) return
      this.error = describeError(error as Object)
    }
    if (this.stream === stream) {
      this.stream = null
      this.loading = false
      this.running = false
    }
  }

  private accept(frame: JsonObject): void {
    const type = stringField(frame, 'type', '')
    if (type === 'snapshot') {
      const rows = readTranscript(recordsOfSnapshot(frame))
      this.rows = rows.map((row: TranscriptRow): RowView => this.view(row))
      this.draft = null
      this.draftText = ''
      this.draftReasoning = ''
      this.loading = false
      return
    }
    if (type === 'event') {
      const row = readTranscriptRow(frame)
      if (row === null) return
      this.merge(row)
      const event = frame['event'] as JsonObject
      const name = stringField(event, 'type', '')
      if (name === 'turn/start') this.running = true
      if (name === 'assistant/message' || name === 'turn/end') {
        this.draft = null
        this.draftText = ''
        this.draftReasoning = ''
      }
      if (name === 'turn/end') this.running = false
      return
    }
    const delta = readStreamDelta(frame)
    if (delta !== null) this.applyDelta(delta)
  }

  private merge(row: TranscriptRow): void {
    const view = this.view(row)
    const next: RowView[] = []
    let placed = false
    for (const existing of this.rows) {
      if (existing.key === view.key) {
        next.push(view)
        placed = true
        continue
      }
      next.push(existing)
    }
    if (!placed) next.push(view)
    next.sort((left: RowView, right: RowView): number => this.seqOf(left.key) - this.seqOf(right.key))
    this.rows = next
  }

  private seqOf(key: string): number {
    const index = key.indexOf('#')
    if (index < 0) return 0
    const parsed = Number.parseInt(key.substring(index + 1), 10)
    return Number.isNaN(parsed) ? 0 : parsed
  }

  private view(row: TranscriptRow): RowView {
    const key = `${row.kind}#${row.seq}`
    if (row.kind === ROW_USER) {
      return { key, kind: row.kind, title: row.injected ? '系统注入' : '你', body: row.text, tone: row.injected ? 'muted' : 'normal' }
    }
    if (row.kind === ROW_ASSISTANT) {
      return { key, kind: row.kind, title: 'DeepSeek', body: row.text, tone: 'normal' }
    }
    if (row.kind === ROW_NOTICE) {
      return { key, kind: row.kind, title: '出错了', body: row.text, tone: 'bad' }
    }
    if (row.name === 'result') {
      return { key, kind: row.kind, title: row.isError ? '工具失败' : '工具结果', body: row.text, tone: row.isError ? 'bad' : 'muted' }
    }
    return { key, kind: row.kind, title: row.name, body: row.arguments, tone: 'muted' }
  }

  private applyDelta(delta: StreamDelta): void {
    const current = this.draft
    if (current === null || current.attemptId !== delta.attemptId) {
      this.draft = { attemptId: delta.attemptId, text: delta.text, reasoning: delta.reasoning }
    } else {
      current.text += delta.text
      current.reasoning += delta.reasoning
    }
    const draft = this.draft
    if (draft !== null) {
      this.draftText = draft.text
      this.draftReasoning = draft.reasoning
    }
    this.running = true
  }

  private async send(mode: string): Promise<void> {
    const text = this.input.trim()
    if (text.length === 0 || this.sending) return
    const link = this.link
    if (link === null) return
    this.sending = true
    this.error = ''
    try {
      await link.rpc.call('session/prompt', {
        request: {
          requestId: `phone-${Date.now()}`,
          sessionId: this.sessionId,
          mode: mode,
          content: [{ type: 'text', text: text }],
        },
      }, 20000)
      this.input = ''
    } catch (error) {
      this.error = describeError(error as Object)
    }
    this.sending = false
  }

  @Builder
  private transcriptRow(view: RowView) {
    Column({ space: 4 }) {
      Text(view.title)
        .fontSize(11)
        .fontColor(view.tone === 'bad' ? '#B3261E' : '#888888')
      Text(view.body)
        .fontSize(15)
        .fontColor(view.tone === 'muted' ? '#666666' : '#1A1A1A')
        .copyOption(CopyOptions.LocalDevice)
    }
    .alignItems(HorizontalAlign.Start)
    .padding({ left: 16, right: 16, top: 8, bottom: 8 })
    .width('100%')
  }

  build() {
    Column() {
      Row() {
        Text(this.title)
          .fontSize(18)
          .fontWeight(FontWeight.Bold)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        Button('返回')
          .fontSize(13)
          .height(30)
          .onClick(() => { router.back() })
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 12, bottom: 8 })

      if (this.loading) {
        Row({ space: 8 }) {
          LoadingProgress().width(20).height(20)
          Text('正在打开会话…').fontSize(13).fontColor('#666666')
        }
        .padding(16)
      }

      List({ space: 0 }) {
        ForEach(this.rows, (view: RowView) => {
          ListItem() {
            this.transcriptRow(view)
          }
        }, (view: RowView) => view.key)

        if (this.draftText.length > 0 || this.draftReasoning.length > 0) {
          ListItem() {
            Column({ space: 4 }) {
              Text('DeepSeek').fontSize(11).fontColor('#888888')
              if (this.draftReasoning.length > 0) {
                Text(this.draftReasoning).fontSize(12).fontColor('#888888')
              }
              Text(this.draftText + '▍').fontSize(15)
            }
            .alignItems(HorizontalAlign.Start)
            .padding({ left: 16, right: 16, top: 8, bottom: 8 })
            .width('100%')
          }
        }
      }
      .layoutWeight(1)
      .width('100%')
      .divider({ strokeWidth: 1, color: '#EEEEEE' })

      if (this.error.length > 0) {
        Text(this.error)
          .fontSize(12)
          .fontColor('#B3261E')
          .padding({ left: 16, right: 16, top: 6, bottom: 6 })
          .width('100%')
      }

      Row({ space: 8 }) {
        TextInput({ text: this.input, placeholder: '给电脑上的智能体发消息' })
          .layoutWeight(1)
          .onChange((value: string) => { this.input = value })
        Button(this.sending ? '发送中' : '发送')
          .enabled(!this.sending)
          .onClick(() => { this.send('queue') })
        Button('插入')
          .backgroundColor('#EEEEEE')
          .fontColor('#1A1A1A')
          .onClick(() => { this.send('steer') })
      }
      .padding({ left: 12, right: 12, top: 8, bottom: 12 })
      .width('100%')
    }
    .width('100%')
    .height('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
