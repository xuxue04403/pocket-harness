/**
 * AGENTS 类指令页：列出 agent 真正会读的指令文件，读、改、新建、写回电脑。
 *
 * 端点挂在 `pocketInstructions` 命名空间下 —— 这是**插件自己的**，不是 DSH 的
 * Remote API。工作区文件接口只有 stat/list/read/readBytes/search/render/changes，
 * 没有写端点，所以手机上能看工作区文件却改不了指令，只能由 Host 插件补。
 *
 * 三处口径来自真 Host 的实测（`test/live_instructions.ts` 钉着）：
 * - 顺序是 Host 排好的：全局链（`~/.dsh`、`~/.agents`）在前，项目链从项目根
 *   （以 `.git` 为界）一路到会话目录在后，每层基础候选在前、`.local.md` 在后。
 *   界面照抄这个顺序，就是 agent 实际读的顺序，不要自己再排。
 * - 只允许四个文件名，且只能落在已有 scope 的目录里。手机上也只提供这四个，
 *   不给人选一个一定会被拒的名字。
 * - 写不存在的文件必须显式 `create: true`，否则 `NOT_FOUND`。所以「新建」走的是
 *   另一条路：先挑名字、再带着 create 进去编辑。
 */

import router from '@ohos.router'
import type { Context } from '@kit.AbilityKit'
import { decodeTicket, type PairingTicket } from '../core/pairing'
import { HostStore } from '../storage.ohos'
import { openRelayTransport, openTcpTransport, systemRandom } from '../platform.ohos'
import { LinkClient, LinkRefusedError } from '../core/client'
import {
  INSTRUCTION_FILE_NAMES,
  createDirectory,
  describeInstructionError,
  describeRequest,
  instructionNameHint,
  instructionPath,
  instructionSizeLabel,
  instructionSubtitle,
  instructionsSummary,
  isDirty,
  isGlobalInstruction,
  readInstructionText,
  readInstructions,
  readInstructionRequest,
  readWrittenBytes,
  writeInstructionRequest,
  type InstructionFile,
  type InstructionsSnapshot,
} from '../core/instructions'

interface InstructionsParams {
  readonly ticketText: string
  readonly cwd: string
}

function describeError(error: Object): string {
  if (error instanceof LinkRefusedError) {
    if (error.reason === 'not-paired') return '这台电脑还不认识这部手机，请在电脑日志里取最新的配对码。'
    if (error.reason === 'pairing-expired') return '配对码已过期，请扫描电脑上当前的配对码。'
    if (error.reason === 'bad-proof') return '配对码不匹配，请扫描电脑上当前的配对码。'
    return `电脑拒绝了这次连接（${error.reason}）。`
  }
  const text = '' + error
  if (text.includes('did not answer the hello')) return '连不上这台电脑，请确认手机和电脑在同一网络。'
  return describeInstructionError(error)
}

@Entry
@Component
struct Instructions {
  @State snapshot: InstructionsSnapshot = { projectRoot: '', cwd: '', files: [] }
  @State loading: boolean = true
  @State error: string = ''
  @State notice: string = ''
  // 编辑器
  @State editing: boolean = false
  @State editingPath: string = ''
  @State editingName: string = ''
  @State editingScope: string = ''
  @State original: string = ''
  @State draft: string = ''
  @State saving: boolean = false
  @State creating: boolean = false
  @State createPanel: boolean = false
  private link: LinkClient | null = null
  private ticketText: string = ''
  private cwd: string = ''
  /** 每次打开文件加一；过期的读取不回写（见 openFile）。 */
  private openSeq: number = 0

  aboutToAppear(): void {
    const params = router.getParams() as InstructionsParams
    this.ticketText = params.ticketText
    this.cwd = params.cwd === undefined || params.cwd === null ? '' : params.cwd
    this.connect()
  }

  aboutToDisappear(): void {
    this.link?.close()
    this.link = null
  }

  private async connect(): Promise<void> {
    this.loading = true
    this.error = ''
    try {
      const ticket: PairingTicket = decodeTicket(this.ticketText)
      const context = this.getUIContext().getHostContext() as Context
      const store = await HostStore.open(context)
      const identity = await store.deviceIdentity()
      this.link = await LinkClient.connect({
        ticket: ticket,
        identity: identity,
        random: systemRandom,
        openTransport: openTcpTransport,
        openRelay: openRelayTransport,
        timeoutMs: 15000,
        heartbeat: true,
      })
      await this.load()
    } catch (error) {
      this.error = describeError(error as Object)
    }
    this.loading = false
  }

  private async load(): Promise<void> {
    const link = this.link
    if (link === null) return
    this.error = ''
    try {
      const answer = await link.rpc.call('pocketInstructions/describe',
        describeRequest(this.cwd), 20000)
      this.snapshot = readInstructions(answer)
    } catch (error) {
      this.error = describeError(error as Object)
      this.snapshot = { projectRoot: '', cwd: this.cwd, files: [] }
    }
  }

  private async openFile(file: InstructionFile): Promise<void> {
    const link = this.link
    if (link === null) return
    // 连点两个文件时，慢的那条回来会把 path 设成 A、正文设成 A 的文本，
    // 而用户以为自己在看 B —— 更糟的是随后的保存会写回 A。
    const mine = ++this.openSeq
    this.error = ''
    this.notice = ''
    try {
      const answer = await link.rpc.call('pocketInstructions/read',
        readInstructionRequest(file.path), 20000)
      if (this.openSeq !== mine) return
      const text = readInstructionText(answer)
      this.editingPath = file.path
      this.editingName = file.name
      this.editingScope = file.scope
      this.original = text
      this.draft = text
      this.creating = false
      this.editing = true
    } catch (error) {
      if (this.openSeq !== mine) return
      this.error = describeError(error as Object)
    }
  }

  /** 新建：先挑一个候选名，再带 `create` 进编辑器。 */
  private startCreate(name: string): void {
    const directory = createDirectory(this.snapshot.projectRoot, this.snapshot.cwd)
    if (directory.length === 0) {
      this.error = '这个会话既没有项目根也没有工作目录，没有可以放指令文件的地方。'
      this.createPanel = false
      return
    }
    this.editingPath = instructionPath(directory, name)
    this.editingName = name
    this.editingScope = 'project'
    this.original = ''
    this.draft = ''
    this.creating = true
    this.createPanel = false
    this.editing = true
    this.error = ''
    this.notice = ''
  }

  private async save(): Promise<void> {
    const link = this.link
    if (link === null || this.saving) return
    this.saving = true
    this.error = ''
    this.notice = ''
    try {
      const answer = await link.rpc.call('pocketInstructions/write',
        writeInstructionRequest(this.editingPath, this.draft, this.creating), 30000)
      const bytes = readWrittenBytes(answer, this.draft)
      this.original = this.draft
      this.creating = false
      this.notice = `已保存到电脑（${instructionSizeLabel(bytes)}）。`
      await this.load()
    } catch (error) {
      this.error = describeError(error as Object)
    }
    this.saving = false
  }

  private closeEditor(): void {
    if (isDirty(this.draft, this.original)) {
      this.error = '还没保存：改动只在手机上。再返回一次就丢弃。'
      return
    }
    this.editing = false
    this.draft = ''
    this.original = ''
    this.error = ''
  }

  @Builder header() {
    Column({ space: 2 }) {
      Text(this.editing ? this.editingName : '工作区指令')
        .fontSize(17)
        .fontWeight(FontWeight.Bold)
        .width('100%')
      if (this.editing) {
        Text(this.editingPath)
          .fontSize(10)
          .fontColor('#888888')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
      } else {
        Text('agent 在每次请求前读这些文件')
          .fontSize(11)
          .fontColor('#888888')
          .width('100%')
      }
    }
    .layoutWeight(1)
    .alignItems(HorizontalAlign.Start)
  }

  @Builder summaryCard() {
    Column({ space: 3 }) {
      Text(instructionsSummary(this.snapshot))
        .fontSize(12)
        .fontColor('#0A7A4F')
        .width('100%')
      if (this.snapshot.projectRoot.length > 0) {
        Text(`项目根目录：${this.snapshot.projectRoot}`)
          .fontSize(10).fontColor('#888888').maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis }).width('100%')
      }
      if (this.snapshot.cwd.length > 0) {
        Text(`会话目录：${this.snapshot.cwd}`)
          .fontSize(10).fontColor('#888888').maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis }).width('100%')
      }
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
    .padding({ left: 16, right: 16, top: 8, bottom: 8 })
    .backgroundColor('#F4F7F5')
  }

  @Builder fileRow(file: InstructionFile) {
    Row({ space: 10 }) {
      Text(isGlobalInstruction(file) ? '全局' : '项目')
        .fontSize(10)
        .fontColor(isGlobalInstruction(file) ? '#FFFFFF' : '#0A7A4F')
        .backgroundColor(isGlobalInstruction(file) ? '#0A7A4F' : '#E3EFEA')
        .borderRadius(4)
        .padding({ left: 5, right: 5, top: 2, bottom: 2 })
      Column({ space: 2 }) {
        Text(file.name)
          .fontSize(14)
          .fontWeight(FontWeight.Medium)
          .width('100%')
        Text(instructionSubtitle(file))
          .fontSize(10)
          .fontColor('#888888')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 10, bottom: 10 })
    .onClick(() => { this.openFile(file) })
  }

  @Builder createSheet() {
    Column({ space: 0 }) {
      Text('新建哪种指令文件？')
        .fontSize(13).fontColor('#666666')
        .width('100%').padding({ left: 16, right: 16, top: 10, bottom: 6 })
      ForEach(INSTRUCTION_FILE_NAMES, (name: string) => {
        Column({ space: 2 }) {
          Text(name).fontSize(14).fontWeight(FontWeight.Medium).width('100%')
          Text(instructionNameHint(name)).fontSize(10).fontColor('#888888').width('100%')
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%')
        .padding({ left: 16, right: 16, top: 9, bottom: 9 })
        .onClick(() => { this.startCreate(name) })
      }, (name: string) => name)
      Text('会建在项目根上：根上的指令对所有子目录生效。')
        .fontSize(10).fontColor('#999999')
        .width('100%').padding({ left: 16, right: 16, top: 6, bottom: 10 })
    }
    .width('100%')
    .backgroundColor('#FFFFFF')
    .border({ width: { top: 1 }, color: '#EEEEEE' })
  }

  @Builder editorView() {
    Column({ space: 0 }) {
      TextArea({ text: this.draft, placeholder: '写下这个项目要让 agent 遵守的规则…' })
        .fontSize(13)
        .fontFamily('monospace')
        .width('100%')
        .layoutWeight(1)
        .padding(12)
        .onChange((value: string) => { this.draft = value })
      Row({ space: 8 }) {
        Text(isDirty(this.draft, this.original) ? '有未保存改动' : '没有改动')
          .fontSize(11).fontColor('#888888').layoutWeight(1)
        Button(this.saving ? '保存中…' : '保存')
          .fontSize(13)
          .enabled(!this.saving && isDirty(this.draft, this.original))
          .onClick(() => { this.save() })
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 8, bottom: 10 })
    }
    .width('100%')
    .layoutWeight(1)
  }

  build() {
    Column({ space: 0 }) {
      Row({ space: 8 }) {
        Text(this.editing ? '回到列表' : '返回')
          .fontSize(13).fontColor('#1F6F5C')
          .onClick(() => {
            if (this.editing) {
              this.closeEditor()
            } else {
              router.back()
            }
          })
        this.header()
        if (!this.editing && createDirectory(this.snapshot.projectRoot, this.snapshot.cwd).length > 0) {
          Text('新建')
            .fontSize(13).fontColor('#1F6F5C')
            .onClick(() => { this.createPanel = !this.createPanel })
        }
        if (this.editing) {
          Text('丢弃').fontSize(13).fontColor('#B3261E')
            .onClick(() => {
              this.editing = false
              this.draft = ''
              this.original = ''
              this.error = ''
            })
        }
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 12, bottom: 8 })

      if (this.error.length > 0) {
        Text(this.error)
          .fontSize(12).fontColor('#B3261E')
          .width('100%').padding({ left: 16, right: 16, bottom: 8 })
      }
      if (this.notice.length > 0) {
        Text(this.notice)
          .fontSize(12).fontColor('#0A7A4F')
          .width('100%').padding({ left: 16, right: 16, bottom: 8 })
      }

      if (this.editing) {
        this.editorView()
      } else if (this.loading) {
        Row({ space: 8 }) {
          LoadingProgress().width(20).height(20)
          Text('正在读取指令文件…').fontSize(13).fontColor('#666666')
        }
        .padding(16)
        Blank()
      } else {
        this.summaryCard()
        if (this.snapshot.files.length === 0) {
          Column({ space: 6 }) {
            Text('这个目录没有 AGENTS.md 一类的指令文件。')
              .fontSize(13).fontColor('#666666').width('100%')
            Text('点右上角「新建」可以建一份，建在项目根上。')
              .fontSize(11).fontColor('#999999').width('100%')
          }
          .alignItems(HorizontalAlign.Start)
          .width('100%')
          .padding(16)
          Blank()
        } else {
          List({ space: 0 }) {
            ForEach(this.snapshot.files, (file: InstructionFile) => {
              ListItem() { this.fileRow(file) }
            }, (file: InstructionFile) => file.path)
          }
          .layoutWeight(1)
          .width('100%')
          .divider({ strokeWidth: 1, color: '#EEEEEE' })
        }
        Text('改动保存在电脑上，不在手机上；下一次请求时生效。')
          .fontSize(10).fontColor('#999999')
          .width('100%').padding({ left: 16, right: 16, top: 8, bottom: 10 })
      }

      if (this.createPanel && !this.editing) {
        this.createSheet()
      }
    }
    .width('100%')
    .height('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
