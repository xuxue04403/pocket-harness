/**
 * 工作区文件页：列目录、按名字搜、按行读文本。只读。
 *
 * 三处口径来自真 Host 的实测（`test/live_workspace.ts` 钉着）：
 * - `workspaceFileScopeId` 的值是 **Session id**，Host 自己据会话推出工作区根，
 *   所以手机只能看到这个会话拥有的目录，也永远出不去（越界会被拒）。
 * - 根目录必须传 `'.'`；空串是 `path is required`，`'/'` 是 `outside-workspace`。
 * - `search` 的四个字段全部必填，且空查询在客户端就拦住 —— 那只会把整个工作区
 *   扫一遍然后回一大堆无关的东西。
 */

import router from '@ohos.router'
import type { Context } from '@kit.AbilityKit'
import { decodeTicket, type PairingTicket } from '../core/pairing'
import { HostStore } from '../storage.ohos'
import { openRelayTransport, openTcpTransport, systemRandom } from '../platform.ohos'
import { LinkClient, LinkRefusedError } from '../core/client'
import {
  childPath,
  DEFAULT_READ_LINES,
  describeWorkspaceError,
  listRequest,
  nextOffset,
  normalizePath,
  parentPath,
  pathLabel,
  readFileText,
  readListing,
  readMatches,
  readRequest,
  ROOT_PATH,
  searchRequest,
  shouldSearch,
  sizeLabel,
  sortEntries,
  type WorkspaceEntry,
  type WorkspaceFileText,
  type WorkspaceMatch,
} from '../core/workspace'

interface FilesParams {
  readonly ticketText: string
  readonly sessionId: string
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
  return describeWorkspaceError(text)
}

@Entry
@Component
struct Files {
  @State path: string = ROOT_PATH
  @State entries: WorkspaceEntry[] = []
  @State truncated: boolean = false
  @State loading: boolean = true
  @State error: string = ''
  @State query: string = ''
  @State submitted: string = ''
  @State matches: WorkspaceMatch[] = []
  @State searching: boolean = false
  // 打开文件后的状态
  @State openFile: boolean = false
  @State fileName: string = ''
  @State page: WorkspaceFileText = {
    absolutePath: '', text: '', offset: 1, lines: 0, bytes: 0, eof: true,
  }
  @State reading: boolean = false
  private link: LinkClient | null = null
  private ticketText: string = ''
  private sessionId: string = ''
  /** 每次列目录都加一；过期的响应不回写（见 load）。 */
  private loadSeq: number = 0
  /** 同理，用于搜索：旧查询不能盖掉新查询的结果。 */
  private searchSeq: number = 0
  /** 每次打开或续读文本文件都加一；过期的读取不回写（见 openTextFile）。 */
  private openSeq: number = 0

  aboutToAppear(): void {
    const params = router.getParams() as FilesParams
    this.ticketText = params.ticketText
    this.sessionId = params.sessionId
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
    // 连点两次目录时两条请求会同时在飞，谁先回来不确定。没有世代号的话，
    // 慢的那条会把 `entries` 写成上一个目录的内容，而 `path` 已经显示新目录 ——
    // 界面看起来像「这个目录里的文件不对」，其实只是响应乱序。
    const mine = ++this.loadSeq
    this.error = ''
    try {
      const answer = await link.rpc.call('workspaceFiles/list',
        listRequest(this.sessionId, this.path), 20000)
      if (this.loadSeq !== mine) return
      const listing = readListing(answer)
      this.entries = sortEntries(listing.entries)
      this.truncated = listing.truncated
    } catch (error) {
      if (this.loadSeq !== mine) return
      this.error = describeError(error as Object)
      this.entries = []
    }
  }

  private openDirectory(entry: WorkspaceEntry): void {
    this.openFile = false
    this.query = ''
    this.submitted = ''
    this.matches = []
    this.path = childPath(this.path, entry.name)
    this.load()
  }

  private goUp(): void {
    this.openFile = false
    this.path = parentPath(this.path)
    this.load()
  }

  private async openTextFile(name: string): Promise<void> {
    const link = this.link
    if (link === null) return
    // 连点两个文件时，慢的那条回来会把正文换成 A 的内容，而标题已经写着 B。
    // 更糟的是此后再点「读更多」，offset 会从 A 的末尾算起，往 B 里拼 A 的后半段。
    const mine = ++this.openSeq
    this.reading = true
    this.error = ''
    try {
      const target = childPath(this.path, name)
      const answer = await link.rpc.call('workspaceFiles/read',
        readRequest(this.sessionId, target, 1, DEFAULT_READ_LINES), 20000)
      if (this.openSeq !== mine) return
      this.page = readFileText(answer)
      this.fileName = name
      this.openFile = true
    } catch (error) {
      if (this.openSeq !== mine) return
      this.error = describeError(error as Object)
    }
    if (this.openSeq === mine) this.reading = false
  }

  /** 只续读，不重来：分页的意义就是几千行的文件也能在手机上翻。 */
  private async readMore(): Promise<void> {
    const link = this.link
    if (link === null) return
    const mine = this.openSeq
    this.reading = true
    try {
      const target = childPath(this.path, this.fileName)
      const answer = await link.rpc.call('workspaceFiles/read',
        readRequest(this.sessionId, target, nextOffset(this.page), DEFAULT_READ_LINES), 20000)
      // 续读途中有别的文件被打开，这批字节属于上一个文件，丢掉。
      if (this.openSeq !== mine) return
      const more = readFileText(answer)
      this.page = {
        absolutePath: more.absolutePath,
        text: this.page.text + more.text,
        offset: this.page.offset,
        lines: this.page.lines + more.lines,
        bytes: more.bytes,
        eof: more.eof,
      }
    } catch (error) {
      if (this.openSeq !== mine) return
      this.error = describeError(error as Object)
    }
    if (this.openSeq === mine) this.reading = false
  }

  private async search(): Promise<void> {
    const link = this.link
    if (link === null) return
    if (!shouldSearch(this.query)) {
      this.matches = []
      this.submitted = ''
      return
    }
    // 搜索也是「后发先至」的候选：一个 30 秒超时的请求完全可能比后一个慢。
    const mine = ++this.searchSeq
    this.searching = true
    this.error = ''
    this.submitted = this.query.trim()
    try {
      const answer = await link.rpc.call('workspaceFiles/search',
        searchRequest(this.sessionId, this.submitted), 30000)
      if (this.searchSeq !== mine) return
      this.matches = readMatches(answer)
    } catch (error) {
      if (this.searchSeq !== mine) return
      this.error = describeError(error as Object)
      this.matches = []
    } finally {
      if (this.searchSeq === mine) this.searching = false
    }
  }

  /** 搜索结果给的是相对工作区根的路径：打开它要把当前目录设成它的父目录。 */
  private openMatch(match: WorkspaceMatch): void {
    if (match.type === 'directory') {
      this.submitted = ''
      this.matches = []
      this.path = normalizePath(match.path)
      this.load()
      return
    }
    const cut = match.path.lastIndexOf('/')
    this.path = cut < 0 ? ROOT_PATH : match.path.slice(0, cut)
    const name = cut < 0 ? match.path : match.path.slice(cut + 1)
    this.openTextFile(name)
  }

  @Builder header() {
    Column({ space: 2 }) {
      Text(pathLabel(this.path)).fontSize(17).fontWeight(FontWeight.Bold)
        .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).width('100%')
      Text(this.openFile ? `读取 ${this.fileName}` : (this.path === ROOT_PATH ? '工作区根目录' : this.path))
        .fontSize(11)
        .fontColor('#888888')
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .width('100%')
    }
    .alignItems(HorizontalAlign.Start)
    .layoutWeight(1)
  }

  @Builder searchBar() {
    Row({ space: 8 }) {
      TextInput({ text: this.query, placeholder: '按文件名或路径查找' })
        .fontSize(13)
        .layoutWeight(1)
        .onChange((value: string) => { this.query = value })
        .onSubmit(() => { this.search() })
      if (this.searching) {
        LoadingProgress().width(18).height(18)
      } else {
        Text('搜索').fontSize(13).fontColor('#1F6F5C').onClick(() => { this.search() })
      }
      if (this.query.length > 0) {
        Text('清空').fontSize(13).fontColor('#888888').onClick(() => {
          this.query = ''
          this.submitted = ''
          this.matches = []
        })
      }
    }
    .width('100%')
    .padding({ left: 14, right: 14, top: 4, bottom: 8 })
  }

  @Builder entryRow(entry: WorkspaceEntry) {
    Row({ space: 10 }) {
      Text(entry.type === 'directory' ? '📁' : '📄').fontSize(15)
      Column({ space: 2 }) {
        Text(entry.name)
          .fontSize(14)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
        if (entry.type !== 'directory' && sizeLabel(entry.size).length > 0) {
          Text(sizeLabel(entry.size)).fontSize(10).fontColor('#999999').width('100%')
        }
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
      if (entry.type === 'directory') {
        Text('›').fontSize(16).fontColor('#BBBBBB')
      }
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 10, bottom: 10 })
    .onClick(() => {
      if (entry.type === 'directory') {
        this.openDirectory(entry)
      } else {
        this.openTextFile(entry.name)
      }
    })
  }

  @Builder matchRow(match: WorkspaceMatch) {
    Column({ space: 2 }) {
      Text(match.path)
        .fontSize(13)
        .width('100%')
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      Text(match.type === 'directory' ? '目录' : '文件')
        .fontSize(10)
        .fontColor('#999999')
        .width('100%')
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
    .padding({ left: 16, right: 16, top: 9, bottom: 9 })
    .onClick(() => { this.openMatch(match) })
  }

  @Builder fileView() {
    Column({ space: 0 }) {
      Scroll() {
        Text(this.page.text.length === 0 ? '（空文件）' : this.page.text)
          .fontSize(12)
          .fontFamily('monospace')
          .width('100%')
          .padding(14)
      }
      .layoutWeight(1)
      .width('100%')
      .align(Alignment.TopStart)

      if (!this.page.eof) {
        Row({ space: 8 }) {
          Button(this.reading ? '读取中…' : '继续读取')
            .fontSize(13)
            .enabled(!this.reading)
            .onClick(() => { this.readMore() })
          Text(`已读 ${this.page.lines} 行`).fontSize(11).fontColor('#888888')
        }
        .width('100%')
        .padding(12)
      }
    }
    .width('100%')
    .layoutWeight(1)
  }

  build() {
    Column() {
      Row({ space: 8 }) {
        Text('返回').fontSize(13).fontColor('#1F6F5C')
          .onClick(() => { router.back() })
        this.header()
        if (this.path !== ROOT_PATH && !this.openFile) {
          Text('上一级').fontSize(13).fontColor('#1F6F5C').onClick(() => { this.goUp() })
        }
        if (this.openFile) {
          Text('回到目录').fontSize(13).fontColor('#1F6F5C').onClick(() => {
            this.openFile = false
            this.page = { absolutePath: '', text: '', offset: 1, lines: 0, bytes: 0, eof: true }
          })
        }
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 12, bottom: 8 })

      if (this.error.length > 0) {
        Text(this.error)
          .fontSize(12)
          .fontColor('#B3261E')
          .width('100%')
          .padding({ left: 16, right: 16, bottom: 8 })
      }

      if (this.openFile) {
        this.fileView()
      } else {
        this.searchBar()

        if (this.submitted.length > 0) {
          if (this.matches.length === 0) {
            Text(`没有匹配「${this.submitted}」的文件。`)
              .fontSize(13).fontColor('#666666').padding(16)
          } else {
            List({ space: 0 }) {
              ForEach(this.matches, (match: WorkspaceMatch) => {
                ListItem() { this.matchRow(match) }
              }, (match: WorkspaceMatch) => match.path)
            }
            .layoutWeight(1)
            .width('100%')
            .divider({ strokeWidth: 1, color: '#EEEEEE' })
          }
        } else if (this.loading || this.reading) {
          Row({ space: 8 }) {
            LoadingProgress().width(20).height(20)
            Text('正在读取…').fontSize(13).fontColor('#666666')
          }
          .padding(16)
        } else if (this.entries.length === 0) {
          Text('这个目录是空的。').fontSize(13).fontColor('#666666').padding(16)
        } else {
          List({ space: 0 }) {
            ForEach(this.entries, (entry: WorkspaceEntry) => {
              ListItem() { this.entryRow(entry) }
            }, (entry: WorkspaceEntry) => `${entry.type}/${entry.name}`)
            if (this.truncated) {
              ListItem() {
                Text('这个目录的条目太多，电脑只返回了前一部分。')
                  .fontSize(11).fontColor('#999999').padding(14)
              }
            }
          }
          .layoutWeight(1)
          .width('100%')
          .divider({ strokeWidth: 1, color: '#EEEEEE' })
        }
      }
    }
    .width('100%')
    .height('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
