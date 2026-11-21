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
import { openRelayTransport, openTcpTransport, systemRandom } from '../platform.ohos'
import { LinkClient, LinkRefusedError } from '../core/client'
import { stringField, type JsonObject } from '../core/json'
import {
  defaultEffortOf,
  EMPTY_CATALOG,
  readModelCatalog,
  readProjectionSelection,
  readModelSelection,
  routeLabel,
  type ModelChoice,
  type ModelCatalog,
  type ModelSelection,
} from '../core/models'
import type { StreamCancel, StreamOptions } from '../core/rpc'
import {
  appendSkill,
  filterSkills,
  readSkills,
  type SkillEntry,
} from '../core/skills'
import { RemoteEvents, type RemoteInvocation } from '../core/remote_events'
import {
  APPROVAL_ALLOWED_ONCE,
  APPROVAL_REJECTED,
  QUESTION_APPROVAL,
  answerValue,
  readQuestion,
  type PendingQuestion,
  type QuestionOption,
} from '../core/questions'
import {
  mergeTranscriptRow,
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
import {
  buildContent,
  describePromptError,
  hasContent,
  promptRequest,
  PROMPT_MODE_QUEUE,
  PROMPT_MODE_STEER,
  type OutgoingImage,
} from '../core/composer'
import {
  isTodoDone,
  isTodoRunning,
  readTodos,
  readTodoWrite,
  shouldShowTodos,
  todoProgress,
  todoSummary,
  type TodoItem,
} from '../core/todos'
import { pickOneImage, thumbnailOfBase64 } from '../images.ohos'
import {
  attachmentData,
  attachmentRequest,
  imageSummary,
  type ImageRef,
} from '../core/images'
import { image } from '@kit.ImageKit'

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
  readonly images: ImageRef[]
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
  @State questions: PendingQuestion[] = []
  @State questionsReady: boolean = false
  @State questionIndex: number = 0
  /** 这台电脑能用的模型，压平后给选择面板用。 */
  @State catalog: ModelCatalog = EMPTY_CATALOG
  /** 本会话当前路由；null 表示它跟着电脑的全局默认走。 */
  @State selection: ModelSelection | null = null
  @State modelLabel: string = '默认模型'
  @State modelPanel: boolean = false
  @State switching: boolean = false
  /** 这个会话能用的技能；插入的是 `/name` 斜杠命令，不是另一条 RPC。 */
  @State skills: SkillEntry[] = []
  @State skillPanel: boolean = false
  @State skillQuery: string = ''
  /** 已选好、还没发出去的图片。 */
  @State pendingImages: OutgoingImage[] = []
  @State picking: boolean = false
  /**
   * agent 的计划。`null` 是「还没列计划」（整块隐藏），空数组是「计划被清空」。
   * 每次 `todo/write` 都整表替换，所以这里直接覆盖，不做合并。
   */
  @State todos: TodoItem[] | null = null
  @State todoPanel: boolean = false
  private link: LinkClient | null = null
  private stream: FollowStream | null = null
  private followCancel: StreamCancel | null = null
  private events: RemoteEvents | null = null
  private draft: Draft | null = null
  /**
   * 已经取回来、解好码的缩略图，按 attachmentId 缓存。
   *
   * 不放在 `@State` 里：`PixelMap` 是原生对象，交给状态系统比较反而更贵。界面用
   * 一个 `@State thumbVersion` 计数来触发重绘，这个映射本身只被读写。
   */
  private thumbnails: Map<string, image.PixelMap> = new Map<string, image.PixelMap>()
  /** 正在取的图片 id，防止同一条消息滚进滚出时重复发请求。 */
  private loadingThumbs: Set<string> = new Set<string>()
  @State thumbVersion: number = 0
  /** 解析后的行；@State rows 是它的渲染视图，两者必须一起更新。 */
  private parsedRows: TranscriptRow[] = []
  private ticketText: string = ''
  private sessionId: string = ''
  private title: string = ''

  aboutToAppear(): void {
    const params = router.getParams() as ChatParams
    this.ticketText = params.ticketText
    this.sessionId = params.sessionId
    this.title = params.title
    this.connect()
  }

  aboutToDisappear(): void {
    this.stopStream()
    const events = this.events
    this.events = null
    if (events !== null) events.close()
    this.link?.close()
    this.link = null
  }

  private stopStream(): void {
    const stream = this.stream
    this.stream = null
    const cancel = this.followCancel
    this.followCancel = null
    if (cancel !== null) {
      // 必须走 `StreamCancel`：生成器可能正停在 `await` 上等这一侧，
      // `stream.return()` 只会排队等它，双方互等即死锁。
      cancel.aborted = true
      cancel.wake()
    }
    if (stream !== null) {
      // 兜底：取消句柄已经让它自己收尾，这里只丢掉引用。
      stream.return(undefined).catch(() => {})
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
        openRelay: openRelayTransport,
        timeoutMs: 15000,
        heartbeat: true,
      })
      this.link = link
      this.watch(link)
      this.listenForQuestions(link)
      this.loadModel(link)
      this.loadSkills(link)
    } catch (error) {
      this.error = describeError(error as Object)
      this.loading = false
    }
  }

  /**
   * 读这台电脑能用的模型，以及本会话当前的路由。
   *
   * 两件事各自可能失败：清单拿不到只是没得选，路由拿不到只影响标题栏那一行。
   * 所以都吞掉错误 —— 一个都没读到不该让对话页打不开。
   */
  private loadModel(link: LinkClient): void {
    link.rpc.call('session/modelCatalog', {}, 15000).then((answer: JsonObject) => {
      this.catalog = readModelCatalog(answer)
      this.modelLabel = routeLabel(this.catalog, this.selection)
    }).catch(() => {
      this.catalog = EMPTY_CATALOG
    })

    link.rpc.call('session/projections', { request: { sessionId: this.sessionId } }, 15000).then((answer: JsonObject) => {
      this.selection = readProjectionSelection(answer)
      this.modelLabel = routeLabel(this.catalog, this.selection)
      const values = answer['values']
      if (values !== null && typeof values === 'object' && !Array.isArray(values)) {
        this.setTodos(readTodos(values as JsonObject))
      }
    }).catch(() => {
      this.selection = null
    })
  }

  /**
   * 读这个会话能用的技能。
   *
   * 清单按会话的目录与预设算出来，所以必须带 `sessionId`。读不到就当没有 ——
   * 没有技能面板不该影响正常对话。
   */
  private loadSkills(link: LinkClient): void {
    link.rpc.call('skills/list', { request: { sessionId: this.sessionId } }, 15000).then((answer: JsonObject) => {
      this.skills = readSkills(answer)
    }).catch(() => {
      this.skills = []
    })
  }

  /**
   * 换掉整块计划，并决定面板是否要展开。
   *
   * 从「没有计划」变成「有计划」时自动展开一次 —— 这时 agent 刚开始干活，用户最
   * 想知道它打算做什么。之后用户自己收起就保持收起，不要每次 `todo/write` 都弹开。
   */
  private setTodos(next: TodoItem[] | null): void {
    const had = this.todos
    this.todos = next
    if (!shouldShowTodos(next)) {
      this.todoPanel = false
      return
    }
    if (had === null || had.length === 0) this.todoPanel = true
  }

  /**
   * 把一条技能追加到输入框。
   *
   * 拼接规则在 `core/skills.ts` 的 `appendSkill` 里，单测钉住了「原文末尾不是空白
   * 就先补一个空格」—— 否则 `/a` 后面再插 `/b` 会粘成 `/a/b`，那是另一个命令。
   */
  private insertSkill(skill: SkillEntry): void {
    this.input = appendSkill(this.input, skill)
    this.skillPanel = false
    this.skillQuery = ''
  }

  /**
   * 换本会话的模型。
   *
   * 只改这一个会话：全局默认在设置里，手机上改它要另走 `settings/update`。
   * 成功后用 Host 的回报更新标题栏，而不是用点下去的那个值 —— 电脑可能
   * 把强度改成了它自己认为合理的默认。
   */
  private pickModel(choice: ModelChoice): void {
    const link = this.link
    if (link === null || this.switching) return
    this.switching = true
    this.error = ''
    const effort = defaultEffortOf(choice)
    link.rpc.call('session/selectModel', {
      request: {
        sessionId: this.sessionId,
        provider: choice.provider,
        model: choice.model,
        reasoningEffort: effort,
      },
    }, 20000).then((answer: JsonObject) => {
      const selected = readModelSelection(answer)
      this.selection = selected
      this.modelLabel = routeLabel(this.catalog, selected)
      this.modelPanel = false
    }).catch((error: Object) => {
      this.error = describeError(error)
    })
    this.switching = false
  }

  /**
   * 订阅网关的转发事件流，于是审批与提问会出现在手机上。
   *
   * 拿不到这条流不该拖垮会话：读消息照常，问人的事留在电脑窗口。
   */
  private listenForQuestions(link: LinkClient): void {
    this.questionsReady = false
    RemoteEvents.open(link.rpc, 15000).then((events: RemoteEvents) => {
      this.events = events
      this.questionsReady = true
      this.drainQuestions(events)
    }).catch(() => {
      // 旧版 Harness 没有这个端点，或电脑上已经有窗口抢着回答。
      this.questionsReady = false
    })
  }

  private async drainQuestions(events: RemoteEvents): Promise<void> {
    for (;;) {
      let invocation: RemoteInvocation | null = null
      try {
        invocation = await events.nextInvocation()
      } catch {
        return
      }
      if (invocation === null || this.events !== events) return
      const question = readQuestion(invocation)
      if (question === null) {
        // 渲染不了就交回电脑：丢掉它会让那个 waterfall 永远挂住，整个 turn 卡死。
        events.answer(invocation, null, true).catch(() => {})
        continue
      }
      if (events.isCancelled(invocation)) continue
      this.questions = this.questions.concat([question])
      this.questionIndex = 0
    }
  }

  private answerApproval(allowed: boolean): Promise<void> {
    const question = this.currentQuestion()
    const events = this.events
    if (question === null || events === null) return Promise.resolve()
    this.dropCurrentQuestion()
    return events.answer(question.invocation, allowed ? APPROVAL_ALLOWED_ONCE : APPROVAL_REJECTED).then(() => {}).catch((error: Object) => {
      this.error = describeError(error)
    })
  }

  private answerWithSelections(selected: string[]): Promise<void> {
    const question = this.currentQuestion()
    const events = this.events
    if (question === null || events === null) return Promise.resolve()
    const selections = new Map<string, string[]>()
    for (const choice of question.questions) {
      // 单题按选中的标签；多题界面上一次只答第一题，其余留空由 Host 追问。
      selections.set(choice.id, question.questions.length === 1 ? selected : [])
    }
    const value = answerValue(question.questions, selections, new Map<string, string>())
    this.dropCurrentQuestion()
    return events.answer(question.invocation, value).then(() => {}).catch((error: Object) => {
      this.error = describeError(error)
    })
  }

  private delegateQuestion(): Promise<void> {
    const question = this.currentQuestion()
    const events = this.events
    if (question === null || events === null) return Promise.resolve()
    this.dropCurrentQuestion()
    return events.answer(question.invocation, null, true).then(() => {}).catch((error: Object) => {
      this.error = describeError(error)
    })
  }

  private currentQuestion(): PendingQuestion | null {
    if (this.questions.length === 0) return null
    return this.questions[0]
  }

  private dropCurrentQuestion(): void {
    if (this.questions.length === 0) return
    this.questions = this.questions.slice(1)
    this.questionIndex = 0
  }

  private watch(link: LinkClient): void {
    const cancel: StreamCancel = { aborted: false, wake: () => undefined }
    const options: StreamOptions = { timeoutMs: 30000, cancel: cancel }
    const stream: FollowStream = link.openStream('session/follow', {
      request: {
        address: { kind: 'session', sessionId: this.sessionId },
        maxMessages: 40,
        activate: true,
        assistantStream: true,
      },
    }, options)
    this.stream = stream
    this.followCancel = cancel
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
      this.parsedRows = rows
      this.rows = rows.map((row: TranscriptRow): RowView => this.view(row))
      this.draft = null
      this.draftText = ''
      this.draftReasoning = ''
      this.requestThumbnails()
      this.loading = false
      return
    }
    if (type === 'event') {
      const row = readTranscriptRow(frame)
      if (row === null) return
      this.merge(row)
      const event = frame['event'] as JsonObject
      const name = stringField(event, 'type', '')
      if (name === 'todo/write') {
        const data = event['data']
        if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
          this.setTodos(readTodoWrite(data as JsonObject))
        }
      }
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

  /**
   * 把一帧事件并进列表。
   *
   * 去重与排序在核心的 `mergeTranscriptRow` 里做（那里有断言）：同一个 `seq`
   * 会带新内容再来一次，直接 push 会让一条消息显示两遍。
   */
  private merge(row: TranscriptRow): void {
    this.rows = mergeTranscriptRow(this.parsedRows, row).map((item: TranscriptRow): RowView => this.view(item))
    if (row.images.length > 0) this.requestThumbnails()
  }

  /**
   * 给还没取过的图片引用排上取图任务。
   *
   * 只在有图片的时候才发请求：一条历史里可能有几百行，逐行去问 Host 要字节会让
   * 打开会话变得很慢，而绝大多数行根本没有图。
   */
  private requestThumbnails(): void {
    for (const view of this.rows) {
      for (const ref of view.images) {
        if (this.thumbnails.has(ref.attachmentId)) continue
        if (this.loadingThumbs.has(ref.attachmentId)) continue
        this.loadingThumbs.add(ref.attachmentId)
        this.loadThumbnail(ref)
      }
    }
  }

  /** 取一张图的字节、解成缩略图、放进缓存。失败只是这张图不显示。 */
  private async loadThumbnail(ref: ImageRef): Promise<void> {
    const link = this.link
    if (link === null) {
      this.loadingThumbs.delete(ref.attachmentId)
      return
    }
    try {
      const answer = await link.rpc.call('session/attachment',
        attachmentRequest(this.sessionId, ref), 20000)
      const data = attachmentData(answer)
      if (data.length === 0) return
      const map = await thumbnailOfBase64(data)
      this.thumbnails.set(ref.attachmentId, map)
      this.thumbVersion = this.thumbVersion + 1
    } catch {
      // 一张图读不出来不该影响整段对话：留着位置，界面上显示文件名。
    } finally {
      this.loadingThumbs.delete(ref.attachmentId)
    }
  }

  private thumbnailOf(ref: ImageRef): image.PixelMap | undefined {
    return this.thumbnails.get(ref.attachmentId)
  }

  private view(row: TranscriptRow): RowView {
    const key = `${row.kind}#${row.seq}`
    if (row.kind === ROW_USER) {
      return { key, kind: row.kind, title: row.injected ? '系统注入' : '你', body: row.text, tone: row.injected ? 'muted' : 'normal', images: row.images }
    }
    if (row.kind === ROW_ASSISTANT) {
      return { key, kind: row.kind, title: 'DeepSeek', body: row.text, tone: 'normal', images: row.images }
    }
    if (row.kind === ROW_NOTICE) {
      return { key, kind: row.kind, title: '出错了', body: row.text, tone: 'bad', images: [] }
    }
    if (row.name === 'result') {
      return { key, kind: row.kind, title: row.isError ? '工具失败' : '工具结果', body: row.text, tone: row.isError ? 'bad' : 'muted', images: [] }
    }
    return { key, kind: row.kind, title: row.name, body: row.arguments, tone: 'muted', images: [] }
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
    if (this.sending) return
    if (!hasContent(this.input, this.pendingImages)) return
    const link = this.link
    if (link === null) return
    this.sending = true
    this.error = ''
    try {
      const content = buildContent(this.input, this.pendingImages)
      const request = promptRequest(`phone-${Date.now()}`, this.sessionId, content, mode)
      await link.rpc.call('session/prompt', { request }, 20000)
      this.input = ''
      this.pendingImages = []
    } catch (error) {
      this.error = describePromptError(error as Object)
    }
    this.sending = false
  }

  /** 弹系统相册选一张图，放进待发区。取消不算错误。 */
  private async pickImage(): Promise<void> {
    if (this.picking) return
    this.picking = true
    this.error = ''
    try {
      const picked = await pickOneImage()
      if (picked.cancelled) return
      if (picked.image === null) {
        this.error = picked.problem
        return
      }
      this.pendingImages = this.pendingImages.concat([picked.image])
    } catch (error) {
      this.error = `选图失败：${error}`
    }
    this.picking = false
  }

  private removeImage(index: number): void {
    const kept: OutgoingImage[] = []
    for (let i = 0; i < this.pendingImages.length; i++) {
      if (i !== index) kept.push(this.pendingImages[i])
    }
    this.pendingImages = kept
  }

  @Builder
  private questionBar(question: PendingQuestion) {
    Column({ space: 8 }) {
      Row({ space: 6 }) {
        Text(question.kind === QUESTION_APPROVAL ? '需要你确认' : '等待回答')
          .fontSize(11)
          .fontColor('#B26A00')
        if (this.questions.length > 1) {
          Text(`还有 ${this.questions.length - 1} 个在排队`)
            .fontSize(11)
            .fontColor('#888888')
        }
      }
      Text(question.title)
        .fontSize(14)
        .fontColor('#1A1A1A')
        .maxLines(4)
        .textOverflow({ overflow: TextOverflow.Ellipsis })

      if (question.kind === QUESTION_APPROVAL) {
        Row({ space: 8 }) {
          Button('允许一次')
            .fontSize(13)
            .height(34)
            .onClick(() => { this.answerApproval(true) })
          Button('拒绝')
            .fontSize(13)
            .height(34)
            .backgroundColor('#EEEEEE')
            .fontColor('#1A1A1A')
            .onClick(() => { this.answerApproval(false) })
          Button('回电脑上处理')
            .fontSize(13)
            .height(34)
            .backgroundColor('#EEEEEE')
            .fontColor('#1A1A1A')
            .onClick(() => { this.delegateQuestion() })
        }
      } else {
        Column({ space: 6 }) {
          ForEach(question.questions[0].options, (option: QuestionOption) => {
            Button(option.label)
              .fontSize(13)
              .height(34)
              .width('100%')
              .backgroundColor('#EEEEEE')
              .fontColor('#1A1A1A')
              .onClick(() => { this.answerWithSelections([option.label]) })
          }, (option: QuestionOption) => option.label)
        }
        .width('100%')
        Button('回电脑上处理')
          .fontSize(13)
          .height(34)
          .backgroundColor('#EEEEEE')
          .fontColor('#1A1A1A')
          .onClick(() => { this.delegateQuestion() })
      }
    }
    .alignItems(HorizontalAlign.Start)
    .padding(12)
    .margin({ left: 12, right: 12, bottom: 8 })
    .width('92%')
    .borderRadius(10)
    .backgroundColor('#FFF6E5')
  }

  /**
   * 模型选择面板。
   *
   * 一个扁平列表：手机上竖向空间比桌面窗口值钱，分组标题只会把可选模型推得更远。
   * 当前路由打勾；没读到清单时说清楚是「读不到」而不是「没有模型」。
   */
  @Builder
  private modelPanelView() {
    Column({ space: 6 }) {
      Row({ space: 6 }) {
        Text('本会话使用的模型').fontSize(13).fontColor('#1A1A1A').layoutWeight(1)
        Button('收起')
          .fontSize(12)
          .height(28)
          .backgroundColor('#EEEEEE')
          .fontColor('#1A1A1A')
          .onClick(() => { this.modelPanel = false })
      }
      .width('100%')
      Text('只改这一个会话。电脑上的默认设置不受影响。')
        .fontSize(11)
        .fontColor('#888888')
        .width('100%')

      if (this.catalog.choices.length === 0) {
        Text('读不到这台电脑的模型清单。').fontSize(12).fontColor('#B3261E')
      } else {
        List({ space: 0 }) {
          ForEach(this.catalog.choices, (choice: ModelChoice) => {
            ListItem() {
              Row({ space: 8 }) {
                Column({ space: 2 }) {
                  Text(choice.name).fontSize(14).fontColor('#1A1A1A')
                  Text(`${choice.model} · ${choice.providerName}`)
                    .fontSize(11)
                    .fontColor('#888888')
                }
                .alignItems(HorizontalAlign.Start)
                .layoutWeight(1)

                if (this.selection !== null && this.selection.provider === choice.provider && this.selection.model === choice.model) {
                  Text('当前').fontSize(11).fontColor('#0A7A4F')
                }
              }
              .width('100%')
              .padding({ left: 4, right: 4, top: 8, bottom: 8 })
            }
            .onClick(() => { this.pickModel(choice) })
          }, (choice: ModelChoice) => `${choice.provider}/${choice.model}`)
        }
        .height(260)
        .width('100%')
        .divider({ strokeWidth: 1, color: '#EEEEEE' })
      }
    }
    .alignItems(HorizontalAlign.Start)
    .padding(12)
    .margin({ left: 12, right: 12, bottom: 8 })
    .width('92%')
    .borderRadius(10)
    .backgroundColor('#F2F5F4')
  }

  /**
   * 技能面板。
   *
   * 插入的东西就是一条 `/name` 斜杠命令 —— 和手打完全一样，所以这里只往输入框
   * 追加文本，不另发 RPC。清单按会话算出来，可能一个都没有。
   */
  @Builder
  private skillPanelView() {
    Column({ space: 6 }) {
      Row({ space: 6 }) {
        Text('插入技能').fontSize(13).fontColor('#1A1A1A').layoutWeight(1)
        Button('收起')
          .fontSize(12)
          .height(28)
          .backgroundColor('#EEEEEE')
          .fontColor('#1A1A1A')
          .onClick(() => { this.skillPanel = false })
      }
      .width('100%')
      Text('技能清单由电脑按这个会话的目录和预设决定，插进去就是一条 /指令。')
        .fontSize(11)
        .fontColor('#888888')
        .width('100%')
      TextInput({ text: this.skillQuery, placeholder: '按名称或用途筛选' })
        .fontSize(12)
        .height(34)
        .onChange((value: string) => { this.skillQuery = value })

      if (this.skills.length === 0) {
        Text('这个会话没有可用技能。').fontSize(12).fontColor('#888888')
      } else if (filterSkills(this.skills, this.skillQuery).length === 0) {
        Text('没有匹配的技能。').fontSize(12).fontColor('#888888')
      } else {
        List({ space: 0 }) {
          ForEach(filterSkills(this.skills, this.skillQuery), (skill: SkillEntry) => {
            ListItem() {
              Column({ space: 2 }) {
                Row({ space: 6 }) {
                  Text(`/${skill.name}`).fontSize(14).fontColor('#1A1A1A').layoutWeight(1)
                  if (!skill.modelInvocable) {
                    Text('仅手动').fontSize(10).fontColor('#888888')
                  }
                }
                .width('100%')
                if (skill.description.length > 0) {
                  Text(skill.description)
                    .fontSize(11)
                    .fontColor('#888888')
                    .maxLines(2)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                    .width('100%')
                }
              }
              .alignItems(HorizontalAlign.Start)
              .padding({ left: 4, right: 4, top: 8, bottom: 8 })
              .width('100%')
            }
            .onClick(() => { this.insertSkill(skill) })
          }, (skill: SkillEntry) => skill.name)
        }
        .height(240)
        .width('100%')
        .divider({ strokeWidth: 1, color: '#EEEEEE' })
      }
    }
    .alignItems(HorizontalAlign.Start)
    .padding(12)
    .margin({ left: 12, right: 12, bottom: 8 })
    .width('92%')
    .borderRadius(10)
    .backgroundColor('#F2F5F4')
  }

  @Builder
  private transcriptRow(view: RowView) {
    Column({ space: 4 }) {
      Text(view.title)
        .fontSize(11)
        .fontColor(view.tone === 'bad' ? '#B3261E' : '#888888')
      if (view.images.length > 0) {
        this.imageStrip(view.images)
      }
      if (view.body.length > 0) {
        Text(view.body)
          .fontSize(15)
          .fontColor(view.tone === 'muted' ? '#666666' : '#1A1A1A')
          .copyOption(CopyOptions.LocalDevice)
      }
    }
    .alignItems(HorizontalAlign.Start)
    .padding({ left: 16, right: 16, top: 8, bottom: 8 })
    .width('100%')
  }

  /**
   * 一行里的图片。
   *
   * 缩略图还没到时先占位显示文件名，而不是留一个空白方块：一张图从点开会话到
   * 真的解出来要一次加密往返，中间那段时间如果没有提示，会看起来像坏了。
   * `thumbVersion` 被读一次，是为了让缓存更新后这一块重绘（`PixelMap` 本身不进
   * 状态系统）。
   */
  @Builder
  private imageStrip(images: ImageRef[]) {
    Row({ space: 6 }) {
      ForEach(images, (ref: ImageRef) => {
        Stack({ alignContent: Alignment.Center }) {
          if (this.thumbnailOf(ref) !== undefined) {
            Image(this.thumbnailOf(ref))
              .width(96)
              .height(96)
              .objectFit(ImageFit.Cover)
              .borderRadius(8)
          } else {
            Column({ space: 2 }) {
              Text('图片')
                .fontSize(11)
                .fontColor('#888888')
              Text(imageSummary(ref))
                .fontSize(9)
                .fontColor('#AAAAAA')
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .constraintSize({ maxWidth: 80 })
            }
            .justifyContent(FlexAlign.Center)
            .width(96)
            .height(96)
            .backgroundColor('#F1F1F1')
            .borderRadius(8)
          }
        }
        // 读一次版本号：缓存变了这个 builder 才会重跑。
        .onClick(() => { const ignored = this.thumbVersion })
      }, (ref: ImageRef) => `${ref.attachmentId}-${this.thumbVersion}`)
    }
    .width('100%')
  }

  @Builder
  private pendingImagesBar() {
    Row({ space: 6 }) {
      Text(`已选 ${this.pendingImages.length} 张图片`)
        .fontSize(11)
        .fontColor('#666666')
      ForEach(this.pendingImages, (image: OutgoingImage, index: number) => {
        Row({ space: 4 }) {
          Text(image.name.length > 0 ? image.name : image.mediaType)
            .fontSize(10)
            .fontColor('#0A7A4F')
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .constraintSize({ maxWidth: 120 })
          Text('移除')
            .fontSize(10)
            .fontColor('#B3261E')
            .onClick(() => { this.removeImage(index) })
        }
        .padding({ left: 8, right: 8, top: 3, bottom: 3 })
        .backgroundColor('#E8F3EE')
        .borderRadius(10)
      }, (image: OutgoingImage, index: number) => `${index}-${image.name}`)
    }
    .width('100%')
    .padding({ left: 16, right: 16, bottom: 4 })
  }

  /**
   * 计划面板。
   *
   * 收起时只留一行：进度 + 正在做的那条。展开时逐条列。理由是对话页的主要面积
   * 属于对话本身 —— 计划是「为什么它在做这些事」的索引，不是主体。
   */
  @Builder
  private todoPanelView() {
    Column({ space: 0 }) {
      Row({ space: 8 }) {
        Text(this.todoPanel ? '收起计划' : '计划')
          .fontSize(12)
          .fontColor('#0A7A4F')
          .fontWeight(FontWeight.Medium)
        if (this.todos !== null) {
          Text(todoProgress(this.todos))
            .fontSize(11)
            .fontColor('#666666')
        }
        if (this.todos !== null) {
          Text(todoSummary(this.todos))
            .fontSize(12)
            .fontColor('#1A1A1A')
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
        } else {
          Blank().layoutWeight(1)
        }
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 6, bottom: 6 })
      .onClick(() => { this.todoPanel = !this.todoPanel })

      if (this.todoPanel && this.todos !== null) {
        ForEach(this.todos, (item: TodoItem, index: number) => {
          Row({ space: 8 }) {
            Text(isTodoDone(item) ? '✓' : (isTodoRunning(item) ? '▶' : '○'))
              .fontSize(12)
              .fontColor(isTodoDone(item) ? '#0A7A4F' : (isTodoRunning(item) ? '#B26A00' : '#999999'))
              .width(14)
            Text(item.content)
              .fontSize(12)
              .fontColor(isTodoDone(item) ? '#888888' : '#1A1A1A')
              .decoration({ type: isTodoDone(item) ? TextDecorationType.LineThrough : TextDecorationType.None, color: '#888888' })
              .maxLines(2)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .layoutWeight(1)
          }
          .width('100%')
          .padding({ left: 12, right: 12, top: 3, bottom: 3 })
        }, (item: TodoItem, index: number) => `${index}-${item.content}`)
      }
    }
    .width('100%')
    .backgroundColor('#F4F7F5')
    .borderRadius(8)
    .margin({ left: 12, right: 12, top: 4, bottom: 4 })
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
      .padding({ left: 16, right: 16, top: 12, bottom: 4 })

      Row({ space: 6 }) {
        Text(this.modelLabel)
          .fontSize(12)
          .fontColor('#0A7A4F')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text('切换模型')
          .fontSize(12)
          .fontColor('#0A7A4F')
          .decoration({ type: TextDecorationType.Underline, color: '#0A7A4F' })
          .onClick(() => {
            this.modelPanel = !this.modelPanel
            this.skillPanel = false
          })
        Text('插入技能')
          .fontSize(12)
          .fontColor('#0A7A4F')
          .decoration({ type: TextDecorationType.Underline, color: '#0A7A4F' })
          .onClick(() => {
            this.skillPanel = !this.skillPanel
            this.modelPanel = false
          })
        Text('工作区文件')
          .fontSize(12)
          .fontColor('#0A7A4F')
          .decoration({ type: TextDecorationType.Underline, color: '#0A7A4F' })
          .onClick(() => {
            router.pushUrl({
              url: 'pages/Files',
              params: { ticketText: this.ticketText, sessionId: this.sessionId },
            })
          })
        Text('后台任务')
          .fontSize(12)
          .fontColor('#0A7A4F')
          .decoration({ type: TextDecorationType.Underline, color: '#0A7A4F' })
          .onClick(() => {
            router.pushUrl({
              url: 'pages/Jobs',
              params: { ticketText: this.ticketText, sessionId: this.sessionId },
            })
          })
      }
      .width('100%')
      .padding({ left: 16, right: 16, bottom: 8 })

      if (this.loading) {
        Row({ space: 8 }) {
          LoadingProgress().width(20).height(20)
          Text('正在打开会话…').fontSize(13).fontColor('#666666')
        }
        .padding(16)
      }

      if (this.modelPanel) {
        this.modelPanelView()
      }

      if (this.skillPanel) {
        this.skillPanelView()
      }

      if (shouldShowTodos(this.todos)) {
        this.todoPanelView()
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

      if (this.questions.length > 0) {
        this.questionBar(this.questions[0])
      }

      if (this.error.length > 0) {
        Text(this.error)
          .fontSize(12)
          .fontColor('#B3261E')
          .padding({ left: 16, right: 16, top: 6, bottom: 6 })
          .width('100%')
      }

      if (this.pendingImages.length > 0) {
        this.pendingImagesBar()
      }

      Row({ space: 8 }) {
        TextInput({ text: this.input, placeholder: '给电脑上的智能体发消息' })
          .layoutWeight(1)
          .onChange((value: string) => { this.input = value })
        Button(this.picking ? '…' : '图片')
          .backgroundColor('#EEEEEE')
          .fontColor('#1A1A1A')
          .enabled(!this.picking)
          .onClick(() => { this.pickImage() })
        Button(this.sending ? '发送中' : '发送')
          .enabled(!this.sending)
          .onClick(() => { this.send(PROMPT_MODE_QUEUE) })
        Button('插入')
          .backgroundColor('#EEEEEE')
          .fontColor('#1A1A1A')
          .onClick(() => { this.send(PROMPT_MODE_STEER) })
      }
      .padding({ left: 12, right: 12, top: 8, bottom: 12 })
      .width('100%')
    }
    .width('100%')
    .height('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
