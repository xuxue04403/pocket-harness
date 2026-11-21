/**
 * 鸿蒙侧的持久化：配对票据与设备身份。
 *
 * 用 `@ohos.data.preferences`（应用私有目录的键值存储）。两点考虑：
 * - 设备私钥应当放 Asset Store Kit（`@ohos.security.asset`），那是鸿蒙的 keystore
 *   等价物；这里先用 preferences 把界面跑通，迁移是独立的一步（Dart 侧已经做过
 *   同样的迁移，见 `app/lib/src/storage/host_store.dart`）。
 * - 票据里的配对 secret 每 10 分钟轮换一次，本来就有有效期，所以不加密也不会长期
 *   有效；但私钥是长期的，迁移到 asset 才是终态。
 */

import preferences from '@ohos.data.preferences'
import type { Context } from '@kit.AbilityKit'
import { identityFromPrivateKey, encodeIdentityPrivateKey, newDeviceIdentity } from './core/identity'
import { decodeBase64Url } from './core/bytes'
import { decodeTicket, encodeTicket, type DeviceIdentity, type PairingTicket } from './core/pairing'
import { systemRandom } from './platform.ohos'

const STORE = 'pocket_harness'
const ID_KEY = 'device.id'
const PRIVATE_KEY = 'device.key'
const TICKET_KEY = 'host.ticket'

/** 存着「这台手机是谁」和「上次配对的电脑是谁」。 */
export class HostStore {
  private readonly store: preferences.Preferences
  private identity: DeviceIdentity | null = null

  private constructor(store: preferences.Preferences) {
    this.store = store
  }

  static async open(context: Context): Promise<HostStore> {
    const store = await preferences.getPreferences(context, STORE)
    return new HostStore(store)
  }

  /**
   * 设备身份。
   *
   * 私钥一旦丢失就意味着所有配对过的 Host 都不再认识这台手机，所以宁可在解不出
   * 私钥时**保留旧的 deviceId 并重新生成密钥对**吗？不 —— 那样反而更糟：deviceId
   * 不变而公钥变了，Host 记的 pinKey 对不上，配对会失败且看起来像 bug。这里选择
   * 一起重建，代价是明确地要求重新配对。
   */
  async deviceIdentity(): Promise<DeviceIdentity> {
    if (this.identity !== null) return this.identity
    const savedId = this.store.getSync(ID_KEY, '') as string
    const savedKey = this.store.getSync(PRIVATE_KEY, '') as string
    if (savedId.length > 0 && savedKey.length > 0) {
      try {
        const bytes = decodeBase64Url(savedKey)
        if (bytes.length === 32) {
          this.identity = identityFromPrivateKey(savedId, bytes)
          return this.identity
        }
      } catch {
        // 落到下面重建：损坏的记录比重新配对更不值得维护。
      }
    }
    const created = newDeviceIdentity(systemRandom)
    this.store.putSync(ID_KEY, created.deviceId)
    this.store.putSync(PRIVATE_KEY, encodeIdentityPrivateKey(created))
    this.store.flushSync()
    this.identity = created
    return created
  }

  /** 上次配对的电脑；没有或解不出就是 null。 */
  ticket(): PairingTicket | null {
    const text = this.store.getSync(TICKET_KEY, '') as string
    if (text.length === 0) return null
    try {
      return decodeTicket(text)
    } catch {
      return null
    }
  }

  async saveTicket(ticket: PairingTicket): Promise<void> {
    this.store.putSync(TICKET_KEY, encodeTicket(ticket))
    this.store.flushSync()
  }

  async forget(): Promise<void> {
    this.store.deleteSync(TICKET_KEY)
    this.store.flushSync()
  }
}
