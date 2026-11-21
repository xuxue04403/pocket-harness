/**
 * 会话列表页。
 *
 * 从 Host 的 `session/list` 取全部会话。注意这个部署一次返回 800 多个会话、
 * 没有分页，所以界面自己做了「运行中优先、然后新的优先」的排序，并且列表项
 * 只显示标题与目录 —— 把 800 行完整 projections 渲染出来没有意义。
 */

import router from '@ohos.router'
import type { Context } from '@kit.AbilityKit'
import { x25519PublicKey } from '../core/curve25519'
import { decodeTicket, type PairingTicket } from '../core/pairing'
import { HostStore } from '../storage.ohos'
import { openRelayTransport, openTcpTransport, systemRandom } from '../platform.ohos'
import { LinkClient, LinkRefusedError } from '../core/client'
import { readSessionRows, sortSessionRows, type SessionRow } from '../core/session_rows'

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
      this.route = link.route === 'relay' ? '经中继' : '局域网直连'
      const answer = await link.rpc.call('session/list', { _request: {} }, 20000)
      this.rows = sortSessionRows(readSessionRows(answer))
    } catch (error) {
      this.error = describeError(error as Object)
    }
    this.loading = false
  }

  build() {
    Column() {
      Row() {
        Text(this.hostName).fontSize(18).fontWeight(FontWeight.Bold).layoutWeight(1)
        Text(this.route).fontSize(11).fontColor('#888888')
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 12, bottom: 8 })

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
      } else {
        List({ space: 0 }) {
          ForEach(this.rows, (row: SessionRow) => {
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
