/**
 * 电脑设置页。
 *
 * 只做两件事：让人看见这台电脑有哪些配置，并改掉其中一个（全局默认模型）。
 * 其余命名空间只读展示 —— 在手机上摊开 24 个命名空间的完整 JSON 没有任何用处，
 * 而且改错了没有撤销。
 *
 * 两处必须守住的规矩写在界面上：
 * - 写会带 `expectedRevision`（来自刚读到的那一份），电脑上刚被改过就会被拒；
 *   冲突时**不自动重试**，因为那等于替人决定要覆盖电脑上的改动。
 * - 含密钥的命名空间显示「已隐藏」而不是空框 —— 那些值在电脑上设过，只是这里看不到。
 */

import router from '@ohos.router'
import type { Context } from '@kit.AbilityKit'
import { decodeTicket, type PairingTicket } from '../core/pairing'
import { HostStore } from '../storage.ohos'
import { openRelayTransport, openTcpTransport, systemRandom } from '../platform.ohos'
import { LinkClient, LinkRefusedError } from '../core/client'
import type { JsonObject } from '../core/json'
import {
  EMPTY_CATALOG,
  readModelCatalog,
  readModelSelection,
  routeLabel,
  type ModelCatalog,
  type ModelChoice,
  type ModelSelection,
} from '../core/models'
import {
  applyUpdate,
  DEFAULT_MODEL_NS,
  describeSettingsError,
  EMPTY_SETTINGS,
  findNamespace,
  hasSecrets,
  readSettings,
  summarize,
  updateRequest,
  type SettingsNamespace,
  type SettingsSnapshot,
} from '../core/settings'

interface SettingsParams {
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
struct Settings {
  @State hostName: string = 'Pocket Harness'
  @State route: string = ''
  @State snapshot: SettingsSnapshot = EMPTY_SETTINGS
  @State catalog: ModelCatalog = EMPTY_CATALOG
  @State selection: ModelSelection | null = null
  @State modelLabel: string = '默认模型'
  @State loading: boolean = true
  @State error: string = ''
  @State notice: string = ''
  @State panel: boolean = false
  @State saving: boolean = false
  private link: LinkClient | null = null
  private ticketText: string = ''

  aboutToAppear(): void {
    const params = router.getParams() as SettingsParams
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
    // 点「重试」会再建一条链路，旧的那条必须在这里关掉：它可能还在握着电脑上的
    // 连接名额，而这个页面是唯一持有它的人。一直不关，攒够八条之后电脑就开始
    // 拒新连接，表现成「越重试越连不上」。
    const previous = this.link
    this.link = null
    if (previous !== null) previous.close()
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
      await this.reload(link)
    } catch (error) {
      this.error = describeError(error as Object)
    }
    this.loading = false
  }

  /** 重新读整份配置与模型清单；写完之后也要走一遍，避免本地状态与电脑不一致。 */
  private async reload(link: LinkClient): Promise<void> {
    const snapshot = readSettings(await link.rpc.call('settings/describe', {}, 20000))
    this.snapshot = snapshot
    const model = findNamespace(snapshot, DEFAULT_MODEL_NS)
    this.selection = model === null ? null : readModelSelection(model.value)
    this.catalog = readModelCatalog(await link.rpc.call('session/modelCatalog', {}, 20000))
    this.modelLabel = routeLabel(this.catalog, this.selection)
  }

  private async retry(): Promise<void> {
    const link = this.link
    if (link === null) return
    this.error = ''
    this.notice = ''
    try {
      await this.reload(link)
    } catch (error) {
      this.error = describeSettingsError(error as Object)
    }
  }

  private async pickModel(choice: ModelChoice): Promise<void> {
    const link = this.link
    const model = findNamespace(this.snapshot, DEFAULT_MODEL_NS)
    if (link === null || model === null) return
    this.saving = true
    this.error = ''
    this.notice = ''
    try {
      const patch: JsonObject = { provider: choice.provider, model: choice.model }
      const answer = await link.rpc.call('settings/update', updateRequest(model, patch), 20000)
      const updated = applyUpdate(model, answer)
      const namespaces: SettingsNamespace[] = []
      for (const entry of this.snapshot.namespaces) {
        namespaces.push(entry.ns === updated.ns ? updated : entry)
      }
      this.snapshot = {
        writable: this.snapshot.writable,
        hasDocument: this.snapshot.hasDocument,
        namespaces: namespaces,
      }
      this.selection = readModelSelection(updated.value)
      this.modelLabel = routeLabel(this.catalog, this.selection)
      this.panel = false
      this.notice = `已改成 ${this.modelLabel}。新建会话从这里开始，已有会话不受影响。`
    } catch (error) {
      // 冲突时把错误留在界面上，让人重开这一页再改；不要替人重试。
      this.error = describeSettingsError(error as Object)
    }
    this.saving = false
  }

  @Builder modelPanelView() {
    Column({ space: 0 }) {
      Row() {
        Text('全局默认模型').fontSize(16).fontWeight(FontWeight.Bold).layoutWeight(1)
        Text('收起').fontSize(12).fontColor('#1F6F5C')
          .onClick(() => { this.panel = false })
      }
      .width('100%')
      .padding({ bottom: 6 })

      Text('新建会话从这里开始。已经存在的会话不受影响。')
        .fontSize(11)
        .fontColor('#666666')
        .width('100%')
        .padding({ bottom: 8 })

      if (this.catalog.choices.length === 0) {
        Text('读不到这台电脑的模型清单。').fontSize(12).fontColor('#B3261E').width('100%')
      } else {
        List({ space: 0 }) {
          ForEach(this.catalog.choices, (choice: ModelChoice) => {
            ListItem() {
              Row({ space: 8 }) {
                Column({ space: 2 }) {
                  Text(choice.name).fontSize(14).width('100%')
                  Text(`${choice.model} · ${choice.providerName}`)
                    .fontSize(11)
                    .fontColor('#888888')
                    .width('100%')
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                }
                .layoutWeight(1)
                .alignItems(HorizontalAlign.Start)

                if (this.selection !== null
                  && this.selection.provider === choice.provider
                  && this.selection.model === choice.model) {
                  Text('当前').fontSize(11).fontColor('#1F6F5C')
                }
              }
              .width('100%')
              .padding({ top: 8, bottom: 8 })
            }
            .onClick(() => { this.pickModel(choice) })
          }, (choice: ModelChoice) => `${choice.provider}/${choice.model}`)
        }
        .height(240)
        .width('100%')
        .divider({ strokeWidth: 1, color: '#EEEEEE' })
      }
    }
    .alignItems(HorizontalAlign.Start)
    .padding(14)
    .margin({ left: 12, right: 12, bottom: 8 })
    .backgroundColor('#F5F8F7')
    .borderRadius(10)
  }

  @Builder namespaceRow(entry: SettingsNamespace) {
    Column({ space: 2 }) {
      Row({ space: 6 }) {
        Text(entry.ns).fontSize(13).layoutWeight(1)
        if (hasSecrets(entry)) {
          Text('含密钥').fontSize(10).fontColor('#B26A00')
        }
      }
      .width('100%')

      Text(summarize(entry))
        .fontSize(11)
        .fontColor('#888888')
        .width('100%')
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
    .padding({ left: 14, right: 14, top: 8, bottom: 8 })
  }

  @Builder othersList() {
    Column({ space: 0 }) {
      Text(`其它配置（${this.snapshot.namespaces.length} 个，只读）`)
        .fontSize(12)
        .fontColor('#888888')
        .width('100%')
        .padding({ left: 14, right: 14, top: 6, bottom: 6 })
      ForEach(this.snapshot.namespaces, (entry: SettingsNamespace) => {
        if (entry.ns !== DEFAULT_MODEL_NS) {
          this.namespaceRow(entry)
        }
      }, (entry: SettingsNamespace) => entry.ns)
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
  }

  build() {
    Column() {
      Row({ space: 8 }) {
        Text('返回').fontSize(13).fontColor('#1F6F5C')
          .onClick(() => { router.back() })
        Column({ space: 2 }) {
          Text('电脑设置').fontSize(18).fontWeight(FontWeight.Bold)
          Text(`${this.hostName} · ${this.route}`).fontSize(11).fontColor('#888888')
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 12, bottom: 8 })

      if (this.loading) {
        Row({ space: 8 }) {
          LoadingProgress().width(20).height(20)
          Text('正在连接…').fontSize(13).fontColor('#666666')
        }
        .padding(16)
      } else if (this.error.length > 0 && this.snapshot.namespaces.length === 0) {
        Column({ space: 12 }) {
          Text('读不到电脑的设置').fontSize(15).fontWeight(FontWeight.Bold)
          Text(this.error).fontSize(12).fontColor('#B3261E')
          Button('重试').onClick(() => { this.connect() })
        }
        .padding(16)
        .alignItems(HorizontalAlign.Start)
        .width('100%')
      } else {
        Scroll() {
          Column({ space: 0 }) {
            if (this.error.length > 0) {
              Text(this.error).fontSize(12).fontColor('#B3261E')
                .width('100%').padding({ left: 14, right: 14, top: 6, bottom: 6 })
            }
            if (this.notice.length > 0) {
              Text(this.notice).fontSize(12).fontColor('#1F6F5C')
                .width('100%').padding({ left: 14, right: 14, top: 6, bottom: 6 })
            }
            if (!this.snapshot.writable) {
              Text('这个配置档案是只读的，手机上改不了。')
                .fontSize(12).fontColor('#B26A00')
                .width('100%').padding({ left: 14, right: 14, top: 6, bottom: 6 })
            }

            Row({ space: 8 }) {
              Column({ space: 3 }) {
                Text('全局默认模型').fontSize(12).fontColor('#888888').width('100%')
                Text(this.modelLabel).fontSize(16).width('100%')
                Text('点击更改').fontSize(11).fontColor('#1F6F5C').width('100%')
              }
              .layoutWeight(1)
              .alignItems(HorizontalAlign.Start)
            }
            .width('100%')
            .padding(14)
            .onClick(() => {
              this.panel = !this.panel
              this.error = ''
              this.notice = ''
            })

            if (this.panel) {
              this.modelPanelView()
            }

            if (this.snapshot.namespaces.length === 0) {
              Text('这台电脑没有可读的配置。').fontSize(13).fontColor('#666666').padding(16)
            } else {
              this.othersList()
            }
          }
          .alignItems(HorizontalAlign.Start)
          .width('100%')
        }
        .layoutWeight(1)
        .width('100%')
      }
    }
    .width('100%')
    .height('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
