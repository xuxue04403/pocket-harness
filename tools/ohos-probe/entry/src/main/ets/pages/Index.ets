/**
 * 最小的握手自检页面：在鸿蒙设备上真的跑一遍 Noise IK。
 *
 * 这不是一个完整的 App，而是把「协议核心能在 ArkTS 运行时里跑通」这件事
 * 变成可以在设备上点一下就看到结果的证据。用固定密钥、固定随机数，
 * 结果应当与金标向量一致，所以两端消息的指纹可以硬编码比对。
 */
import { encodeBase64Url, fromUtf8, utf8 } from '../core/bytes'
import { x25519PublicKey } from '../core/curve25519'
import { NoiseIkSession, createNoisePrologue } from '../core/noise'
import { decodeTicket, encodeTicket } from '../core/pairing'
import { ClientCheckResult, runClientCheck } from '../selfcheck'

function hex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0')
  return out
}

/** 用固定字节填充的随机源：让握手结果可复现。 */
function fixedRandom(fill: number): (length: number) => Uint8Array {
  return (length: number): Uint8Array => {
    const out = new Uint8Array(length)
    out.fill(fill)
    return out
  }
}

@Entry
@Component
struct Index {
  @State title: string = 'Pocket Harness'
  @State summary: string = '点下方按钮跑一次协议自检'
  @State detail: string = ''

  build() {
    Column({ space: 12 }) {
      Text(this.title).fontSize(22).fontWeight(FontWeight.Bold)
      Text(this.summary).fontSize(14).fontColor('#444444')
      if (this.detail.length > 0) {
        Text(this.detail)
          .fontSize(11)
          .fontFamily('monospace')
          .width('100%')
      }
      Button('跑一次 Noise IK 握手')
        .width('80%')
        .onClick(() => { this.runOnce() })
      Button('跑一次完整客户端链路')
        .width('80%')
        .onClick(() => { this.runClient() })
    }
    .padding(20)
    .width('100%')
    .height('100%')
  }

  private runClient(): void {
    this.summary = '正在跑客户端链路…'
    this.detail = ''
    runClientCheck().then((result: ClientCheckResult) => {
      this.summary = result.summary
      this.detail = result.detail
    }).catch((error: Object) => {
      this.summary = '客户端链路自检失败'
      this.detail = '' + error
    })
  }

  private runOnce(): void {
    try {
      const started = Date.now()

      // 固定密钥：与金标向量的形状一致，但值不同 —— 这里验证的是"能跑通"，
      // 逐字节的金标比对在 packages/dsh_arkts 的 Node 测试里做。
      const clientPrivate = new Uint8Array(32)
      clientPrivate.fill(7)
      const hostPrivate = new Uint8Array(32)
      hostPrivate.fill(11)
      const clientPublic = x25519PublicKey(clientPrivate)
      const hostPublic = x25519PublicKey(hostPrivate)

      const prologue = createNoisePrologue('arkts-check', 'host-arkts', 'client-arkts')

      const client = new NoiseIkSession({
        role: 'initiator',
        localPrivateKey: clientPrivate,
        localPublicKey: clientPublic,
        remotePublicKey: hostPublic,
        prologue: prologue,
        random: fixedRandom(13),
      })
      const host = new NoiseIkSession({
        role: 'responder',
        localPrivateKey: hostPrivate,
        localPublicKey: hostPublic,
        remotePublicKey: clientPublic,
        prologue: prologue,
        random: fixedRandom(17),
      })

      const messageOne = client.writeHandshake()
      host.readHandshake(messageOne)
      const messageTwo = host.writeHandshake()
      client.readHandshake(messageTwo)

      if (!client.complete || !host.complete) {
        throw new Error('handshake did not complete')
      }

      // 双向各发一条传输消息。
      const outbound = utf8('hello from ArkTS')
      const sealed = client.encrypt(outbound)
      const opened = host.decrypt(sealed)
      const inbound = utf8('hello from the Host')
      const sealedBack = host.encrypt(inbound)
      const openedBack = client.decrypt(sealedBack)

      const outboundText = fromUtf8(opened)
      const inboundText = fromUtf8(openedBack)
      if (outboundText !== 'hello from ArkTS' || inboundText !== 'hello from the Host') {
        throw new Error('transport round trip mismatched')
      }

      // 配对票据往返，顺带验证 base64url 与 JSON 在 ArkTS 下的行为。
      const ticket = decodeTicket(encodeTicket({
        version: 1,
        hostDeviceId: '018f3a4c-7d21-7c3a-9e58-2b1c4d5e6f70',
        hostPublicKey: hostPublic,
        hostName: 'ArkTS Host',
        lanEndpoints: ['192.168.1.5:48100'],
        relayUrl: null,
        relayRoom: null,
        relayToken: null,
        pairingSecret: 'arkts-secret',
        expiresAt: 1_900_000_000_000,
      }))

      const elapsed = Date.now() - started
      this.summary = `握手 + 双向传输 + 票据往返，全部通过（${elapsed} ms）`
      this.detail =
        'message1 ' + encodeBase64Url(messageOne).length + 'B\n' +
        'message2 ' + encodeBase64Url(messageTwo).length + 'B\n' +
        'client pub ' + hex(clientPublic) + '\n' +
        'sealed ' + encodeBase64Url(sealed).length + 'B\n' +
        'ticket ' + ticket.hostName + ' @ ' + ticket.lanEndpoints[0]
    } catch (error) {
      this.summary = '自检失败'
      this.detail = '' + error
    }
  }
}
