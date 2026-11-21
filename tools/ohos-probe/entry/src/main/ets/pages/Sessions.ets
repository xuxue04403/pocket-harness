/**
 * 会话列表页。
 *
 * 从 Host 的 `session/list` 取全部会话。注意这个部署一次返回 800 多个会话、
 * 没有分页，所以界面自己做了「运行中优先、然后新的优先」的排序，并且列表项
 * 只显示标题与目录 —— 把 800 行完整 projections 渲染出来没有意义。
 *
 * 右上角可以新建会话：先挑智能体预设、再填工作目录。「跟随电脑」与
 * 「显式选默认预设」不是一回事，所以第一行永远是「跟随电脑」而不是预先选中
 * 那个默认预设 —— 选了就把会话钉死在该预设上，以后改默认它不再跟随。
 */

import router from '@ohos.router'
import type { Context } from '@kit.AbilityKit'
import { decodeTicket, type PairingTicket } from '../core/pairing'
import { HostStore } from '../storage.ohos'
import { openRelayTransport, openTcpTransport, systemRandom } from '../platform.ohos'
import { LinkClient, LinkRefusedError } from '../core/client'
import { readSessionRows, sortSessionRows, filterSessionRows, type SessionRow } from '../core/session_rows'
import {
  createSessionRequest,
  FOLLOW_DESKTOP_PRESET,
  followDesktopLabel,
  normalizeCwd,
  readCreatedSessionId,
  readPresets,
  type AgentPreset,
  type NewSessionChoice,
} from '../core/agent_presets'

/** 页面之间传递的参数。 */
interface SessionsParams {
  readonly ticketText: string
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
  return text
}

@Entry
@Component
struct Sessions {
  @State hostName: string = 'Pocket Harness'
  @State route: string = ''
  @State rows: SessionRow[] = []
  @State error: string = ''
  @State loading: boolean = true
  @State presets: AgentPreset[] = []
  @State creating: boolean = false
  @State newPanel: boolean = false
  @State pickedPreset: string = ''
  @State cwdText: string = ''
  @State createError: string = ''
  @State query: string = ''
  private link: LinkClient | null = null
  private ticketText: string = ''

  aboutToAppear(): void {
    const params = router.getParams() as SessionsParams
    this.ticketText = params.ticketText
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
      this.hostName = ticket.hostName
      const link = await this.openLink(ticket)
      this.link = link
      this.route = link.route === 'relay' ? '经中继' : '局域网直连'
      const answer = await link.rpc.call('session/list', { _request: {} }, 20000)
      this.rows = sortSessionRows(readSessionRows(answer))
      this.loadPresets(link)
    } catch (error) {
      this.error = describeError(error as Object)
    }
    this.loading = false
  }

  private async openLink(ticket: PairingTicket): Promise<LinkClient> {
    const context = this.getUIContext().getHostContext() as Context
    const store = await HostStore.open(context)
    const identity = await store.deviceIdentity()
    return LinkClient.connect({
      ticket: ticket,
      identity: identity,
      random: systemRandom,
      openTransport: openTcpTransport,
      openRelay: openRelayTransport,
      timeoutMs: 15000,
      heartbeat: true,
    })
  }

  /** 预设读不到不影响列会话：面板里会退化成只有「跟随电脑」一行。 */
  private loadPresets(link: LinkClient): void {
    link.rpc.call('agentPresets/list', {}, 15000).then((answer) => {
      this.presets = readPresets(answer)
    }).catch(() => {
      this.presets = []
    })
  }

  private openNewPanel(): void {
    this.newPanel = true
    this.createError = ''
    this.pickedPreset = ''
    this.cwdText = ''
  }

  private async createSession(): Promise<void> {
    const link = this.link
    if (link === null) return
    this.creating = true
    this.createError = ''
    const choice: NewSessionChoice = {
      agentPreset: this.pickedPreset.length === 0 ? null : this.pickedPreset,
      cwd: normalizeCwd(this.cwdText),
    }
    try {
      const answer = await link.rpc.call('session/create', { request: createSessionRequest(choice) }, 30000)
      const sessionId = readCreatedSessionId(answer)
      if (sessionId.length === 0) throw new Error('电脑没有返回新会话的编号')
      this.newPanel = false
      router.pushUrl({
        url: 'pages/Chat',
        params: { ticketText: this.ticketText, sessionId: sessionId, title: '新会话' },
      })
    } catch (error) {
      this.createError = describeError(error as Object)
    }
    this.creating = false
  }

  @Builder newSessionPanel() {
    Column({ space: 0 }) {
      Row() {
        Text('新建会话').fontSize(16).fontWeight(FontWeight.Bold).layoutWeight(1)
        Text('收起').fontSize(12).fontColor('#1F6F5C')
          .onClick(() => { this.newPanel = false })
      }
      .width('100%')
      .padding({ bottom: 6 })

      Text('会话跑在电脑上，这里只决定它用哪套工具和工作目录。')
        .fontSize(11)
        .fontColor('#666666')
        .width('100%')
        .padding({ bottom: 10 })

      Text('智能体预设').fontSize(12).fontColor('#888888').width('100%')
      this.presetRow('', followDesktopLabel(this.presets), '跟随电脑上的设置')
      ForEach(this.presets, (preset: AgentPreset) => {
        this.presetRow(preset.id, preset.label, preset.description)
      }, (preset: AgentPreset) => preset.id)

      Text('工作目录').fontSize(12).fontColor('#888888').width('100%').padding({ top: 10 })
      TextInput({ text: this.cwdText, placeholder: '留空则用电脑的默认目录' })
        .fontSize(13)
        .onChange((value: string) => { this.cwdText = value })
        .width('100%')
        .padding({ top: 2 })

      if (this.createError.length > 0) {
        Text(this.createError).fontSize(12).fontColor('#B3261E').width('100%').padding({ top: 8 })
      }

      Row({ space: 10 }) {
        Button(this.creating ? '创建中…' : '创建会话')
          .enabled(!this.creating)
          .fontSize(13)
          .onClick(() => { this.createSession() })
        Button('取消')
          .fontSize(13)
          .backgroundColor('#EEEEEE')
          .fontColor('#333333')
          .onClick(() => { this.newPanel = false })
      }
      .width('100%')
      .padding({ top: 12 })
    }
    .alignItems(HorizontalAlign.Start)
    .padding(14)
    .margin({ left: 12, right: 12, bottom: 8 })
    .backgroundColor('#F5F8F7')
    .borderRadius(10)
  }

  @Builder presetRow(id: string, label: string, detail: string) {
    Row({ space: 8 }) {
      Text(this.pickedPreset === id ? '●' : '○')
        .fontSize(14)
        .fontColor(this.pickedPreset === id ? '#1F6F5C' : '#BBBBBB')
      Column({ space: 2 }) {
        Text(label).fontSize(14).width('100%')
        if (detail.length > 0) {
          Text(detail).fontSize(11).fontColor('#888888').width('100%').maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .padding({ top: 8, bottom: 8 })
    .onClick(() => { this.pickedPreset = id })
  }

  build() {
    Column() {
      Row({ space: 8 }) {
        Column({ space: 2 }) {
          Text(this.hostName).fontSize(18).fontWeight(FontWeight.Bold)
          Text(this.route).fontSize(11).fontColor('#888888')
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)

        Text('新建会话')
          .fontSize(13)
          .fontColor('#1F6F5C')
          .onClick(() => { this.openNewPanel() })

        Text('电脑设置')
          .fontSize(13)
          .fontColor('#1F6F5C')
          .onClick(() => {
            router.pushUrl({ url: 'pages/Settings', params: { ticketText: this.ticketText } })
          })
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 12, bottom: 8 })

      if (this.newPanel) {
        this.newSessionPanel()
      }

      // 800 多个会话滚起来很难找。搜索框放在面板下面、列表上面：它属于列表，
      // 不属于新建会话。
      if (!this.loading && this.error.length === 0 && this.rows.length > 0) {
        Row({ space: 8 }) {
          TextInput({ text: this.query, placeholder: '按标题或目录筛选' })
            .layoutWeight(1)
            .fontSize(13)
            .onChange((value: string) => { this.query = value })
          if (this.query.length > 0) {
            Text('清空')
              .fontSize(13)
              .fontColor('#1F6F5C')
              .onClick(() => { this.query = '' })
          }
        }
        .width('100%')
        .padding({ left: 16, right: 16, bottom: 8 })
      }

      if (this.loading) {
        Row({ space: 8 }) {
          LoadingProgress().width(20).height(20)
          Text('正在连接…').fontSize(13).fontColor('#666666')
        }
        .padding(16)
      } else if (this.error.length > 0) {
        Column({ space: 12 }) {
          Text(this.error).fontSize(13).fontColor('#B3261E')
          Button('重试').onClick(() => { this.connect() })
        }
        .padding(16)
        .width('100%')
      } else if (this.rows.length === 0) {
        Text('这台电脑上还没有会话。').fontSize(13).fontColor('#666666').padding(16)
      } else if (filterSessionRows(this.rows, this.query).length === 0) {
        Text(`没有标题或目录里带「${this.query.trim()}」的会话。`)
          .fontSize(13)
          .fontColor('#666666')
          .padding(16)
      } else {
        List({ space: 0 }) {
          ForEach(filterSessionRows(this.rows, this.query), (row: SessionRow) => {
            ListItem() {
              Column({ space: 4 }) {
                Row({ space: 6 }) {
                  if (row.running) {
                    LoadingProgress().width(14).height(14)
                  }
                  Text(row.title)
                    .fontSize(15)
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                    .layoutWeight(1)
                }
                .width('100%')

                Text(row.detail)
                  .fontSize(11)
                  .fontColor('#888888')
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .width('100%')
              }
              .alignItems(HorizontalAlign.Start)
              .padding({ left: 16, right: 16, top: 10, bottom: 10 })
              .width('100%')
            }
            .onClick(() => {
              router.pushUrl({
                url: 'pages/Chat',
                params: { ticketText: this.ticketText, sessionId: row.sessionId, title: row.title },
              })
            })
          }, (row: SessionRow) => row.sessionId)
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
