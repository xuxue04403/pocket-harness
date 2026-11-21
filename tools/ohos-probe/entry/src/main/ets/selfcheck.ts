/**
 * 在 ArkTS 运行时里跑一遍完整的客户端连接流程。
 *
 * 存在的理由：`core/` 里的协议原语能编译，不等于「手机真正走的这条路」能编译。
 * `LinkClient` 是 hello → Noise → RPC 的串联，它用到异步、Promise、setTimeout 与
 * 回调式传输接口 —— 这些才是 ArkTS 与 TypeScript 差异最容易咬人的地方，所以
 * 让它必须被 `Index.ets` 引用，从而进入 ArkTS 的类型检查与字节码。
 */

import { decodeBase64Url, encodeBase64Url, fromUtf8, utf8 } from './core/bytes'
import { x25519PublicKey } from './core/curve25519'
import { newDeviceIdentity } from './core/identity'
import { decodeHello, encodeHello, verifyHelloProof } from './core/link_protocol'
import { createNoisePrologue, NoiseIkSession } from './core/noise'
import { decodeTicket, encodeTicket, parseEndpoint } from './core/pairing'
import { RpcClient } from './core/rpc'
import { SecureChannel, type FrameTransport } from './core/secure_channel'
import { FRAME_KIND, decodeFrame, encodeEnvelope, encodeFrame, responseEnvelope } from './core/wire'
import { LinkClient, LinkRefusedError } from './core/client'
import type { JsonObject } from './core/json'
import { decodeMatrix } from './core/qr/decode'
import { grayFromLuma } from './core/qr/frame'
import { matrixFromImage } from './core/qr/sampler'
import { matrixFromFrame } from './core/qr/scan'
import { QR_SAMPLES } from './qr_samples'
import { openTcpTransport, systemRandom } from './platform.ohos'

/** 用固定字节填充的随机源：让结果可复现。 */
function fixedRandom(fill: number): (length: number) => Uint8Array {
  return (length: number): Uint8Array => {
    const out = new Uint8Array(length)
    out.fill(fill)
    return out
  }
}

/**
 * 一对内存里的传输，用来在同一个页面里同时扮演手机与 Host。
 *
 * 投递走 `Promise.resolve().then(...)`：回调里同步重入自身的 handler 会让握手
 * 的状态机看到乱序的帧。
 */
class MemoryPipe implements FrameTransport {
  peer: MemoryPipe | null = null
  closed: boolean = false
  private frameHandler: (frame: Uint8Array) => void = () => undefined
  private closeHandler: () => void = () => undefined

  send(frame: Uint8Array): void {
    if (this.closed) throw new Error('the pipe is closed')
    const target: MemoryPipe | null = this.peer
    if (target === null) return
    const copy = new Uint8Array(frame.length)
    copy.set(frame)
    Promise.resolve().then(() => {
      if (target.closed) return
      target.frameHandler(copy)
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const target: MemoryPipe | null = this.peer
    Promise.resolve().then(() => {
      if (target !== null && !target.closed) target.closeHandler()
    })
  }

  onFrame(handler: (frame: Uint8Array) => void): void {
    this.frameHandler = handler
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler
  }
}

/** 只认 `test/echo` 的 Host 桩，够把 hello → Noise → RPC 走完。 */
class HostStub {
  private readonly transport: MemoryPipe
  private readonly hostPrivateKey: Uint8Array
  private readonly clientPublicKey: Uint8Array
  private readonly secret: string
  private readonly hostId: string
  private channel: SecureChannel | null = null
  readonly ready: Promise<void>
  private markReady: () => void = () => undefined

  constructor(
    transport: MemoryPipe,
    hostPrivateKey: Uint8Array,
    clientPublicKey: Uint8Array,
    secret: string,
    hostId: string,
  ) {
    this.transport = transport
    this.hostPrivateKey = hostPrivateKey
    this.clientPublicKey = clientPublicKey
    this.secret = secret
    this.hostId = hostId
    this.ready = new Promise<void>((resolve: () => void) => {
      this.markReady = resolve
    })
    let greeted = false
    this.transport.onFrame((frame: Uint8Array) => {
      if (greeted) return
      greeted = true
      this.admit(frame)
    })
  }

  private admit(frame: Uint8Array): void {
    const decoded = decodeFrame(frame)
    if (decoded.kind !== FRAME_KIND.control) throw new Error('the first frame must be control')
    const hello = decodeHello(decoded.payload)
    if (!verifyHelloProof(hello, this.secret)) {
      this.reply('{"v":1,"accepted":false,"reason":"bad-proof"}')
      return
    }
    const accepted = '{"v":1,"accepted":true,"host":"' + this.hostId + '","name":"arkts-stub"}'
    this.reply(accepted)

    const session = new NoiseIkSession({
      role: 'responder',
      localPrivateKey: this.hostPrivateKey,
      localPublicKey: x25519PublicKey(this.hostPrivateKey),
      remotePublicKey: this.clientPublicKey,
      prologue: createNoisePrologue(hello.connection, this.hostId, hello.client),
      random: fixedRandom(29),
    })
    this.channel = new SecureChannel({
      transport: this.transport,
      session: session,
      onEstablished: () => {
        this.markReady()
      },
      onMessage: (plaintext: Uint8Array) => {
        this.answer(plaintext)
      },
    })
    this.channel.start()
  }

  private reply(text: string): void {
    this.transport.send(encodeFrame({ kind: FRAME_KIND.control, payload: utf8(text) }))
  }

  private answer(plaintext: Uint8Array): void {
    const envelope = JSON.parse(fromUtf8(plaintext)) as JsonObject
    const id = envelope.id
    if (typeof id !== 'string') return
    if (envelope.type === 'ping') {
      this.channel?.send(encodeEnvelope({ type: 'pong', payload: {} }))
      return
    }
    if (envelope.type !== 'request') return
    const payload = envelope.payload as JsonObject
    if (payload.endpoint === 'test/echo') {
      this.channel?.send(encodeEnvelope(responseEnvelope(id, { echoed: true, peer: 'arkts-stub' })))
      return
    }
    this.channel?.send(encodeEnvelope({ type: 'error', id: id, payload: { code: 'NO_ENDPOINT', message: 'no such endpoint' } }))
  }
}

/** 结果汇总，交给页面显示。 */
export interface ClientCheckResult {
  readonly ok: boolean
  readonly summary: string
  readonly detail: string
}

/**
 * 在 ArkTS 运行时里把三张二维码金标真解一遍。
 *
 * 这是「扫码配对」这条路的地基检查：解码器是纯整数运算 + 位域解析，恰恰是
 * 换一个 JavaScript 引擎最容易出偏差的地方。样本覆盖 v1（单块、H 级）、
 * v3（单块、M 级）与 v5（两块交织、M 级），版本分支与块交织都会被走到。
 */
export function runQrCheck(): ClientCheckResult {
  const started = Date.now()
  const lines: string[] = []
  let passed = 0
  for (const sample of QR_SAMPLES) {
    try {
      const rows: boolean[][] = []
      for (const line of sample.rows) {
        const modules: boolean[] = []
        for (let index = 0; index < line.length; index += 1) modules.push(line.charAt(index) === '1')
        rows.push(modules)
      }
      const decoded = decodeMatrix(rows)
      if (decoded.text !== sample.text) {
        return { ok: false, summary: '二维码解出来不是原文', detail: sample.label + ' → ' + decoded.text }
      }
      if (decoded.version !== sample.version) {
        return { ok: false, summary: '二维码版本认错', detail: sample.label + ' → v' + decoded.version }
      }
      if (decoded.level !== sample.level) {
        return { ok: false, summary: '二维码纠错等级认错', detail: sample.label + ' → ' + decoded.level }
      }
      if (decoded.mask !== sample.mask) {
        return { ok: false, summary: '二维码掩码认错', detail: sample.label + ' → ' + decoded.mask }
      }
      passed += 1
      lines.push('ok ' + sample.label + ' v' + decoded.version + '/' + decoded.level + ' ' + decoded.text.length + ' 字符')
    } catch (error) {
      return { ok: false, summary: '二维码解码抛错', detail: sample.label + ' → ' + error }
    }
  }

  // 采样器也要走一次：配对码最终是从相机帧里抠出来的矩阵，而不是现成的字符串数组。
  // 这里把第一张样本放大成「每模块 4 像素、四周 4 模块静区」的灰度图，再原路解回。
  try {
    const sample = QR_SAMPLES[0]
    const side = sample.rows.length
    const modulePixels = 4
    const quiet = 4
    const pixels = new Uint8Array((side * modulePixels + quiet * 2) * (side * modulePixels + quiet * 2))
    pixels.fill(255)
    const imageSide = side * modulePixels + quiet * 2
    for (let row = 0; row < side; row += 1) {
      const line = sample.rows[row]
      for (let col = 0; col < side; col += 1) {
        if (line.charAt(col) !== '1') continue
        for (let dy = 0; dy < modulePixels; dy += 1) {
          for (let dx = 0; dx < modulePixels; dx += 1) {
            const x = quiet + col * modulePixels + dx
            const y = quiet + row * modulePixels + dy
            pixels[y * imageSide + x] = 0
          }
        }
      }
    }
    const fromPixels = decodeMatrix(matrixFromImage({ width: imageSide, height: imageSide, pixels: pixels }))
    if (fromPixels.text !== sample.text) {
      return { ok: false, summary: '从灰度图里认不出二维码', detail: sample.label + ' → ' + fromPixels.text }
    }
    lines.push('ok 灰度图 ' + imageSide + 'px 解回同一张码')
  } catch (error) {
    return { ok: false, summary: '灰度图定位抛错', detail: '' + error }
  }

  // 相机帧不是渲染图：模块落在非整数像素上、整张码还会歪，而且相机给的亮度平面
  // 是**带行填充的**。这里把一张样本按「每模块 4.7 像素、绕中心转 20 度、右下角
  // 渐暗」渲染成 320×320 的场景，每行再留 16 字节填充，走
  // 亮度平面 → 灰度 → 定位 → 仿射采样 → 解码 的完整路径。
  // 这一步钉住过一个真实缺陷：横向行程在旋转后被拉长 1/cosθ，不除掉就会把尺寸
  // 认成小一号的版本。填充这一层也常错：按紧密排列读会把图剪斜，看着就是「解不出」。
  try {
    const sample = QR_SAMPLES[1]
    const size = sample.rows.length
    const side = 320
    const padding = 16
    const rowStride = side + padding
    const modulePixels = 4.7
    const radians = (20 * Math.PI) / 180
    const cos = Math.cos(radians)
    const sin = Math.sin(radians)
    const span = size * modulePixels
    const centre = side / 2
    const luma = new ArrayBuffer(rowStride * side)
    const plane = new Uint8Array(luma)
    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) {
        const dx = x - centre
        const dy = y - centre
        const rx = dx * cos + dy * sin
        const ry = -dx * sin + dy * cos
        const u = (rx + span / 2) / modulePixels
        const v = (ry + span / 2) / modulePixels
        let level = 255
        if (u >= 0 && v >= 0 && u < size && v < size) {
          const black = sample.rows[Math.floor(v)].charAt(Math.floor(u)) === '1'
          level = black ? 24 : 231
        }
        const shade = 1 - (0.4 * (x + y)) / (2 * side)
        plane[y * rowStride + x] = Math.floor(level * shade)
      }
    }
    const gray = grayFromLuma({ luma: luma, width: side, height: side, rowStride: rowStride, pixelStride: 1 })
    if (gray.width !== side || gray.pixels.length !== side * side) {
      return { ok: false, summary: '亮度平面转灰度时尺寸不对', detail: gray.width + '×' + gray.pixels.length }
    }
    const tilted = decodeMatrix(matrixFromFrame(gray))
    if (tilted.text !== sample.text) {
      return { ok: false, summary: '歪着的相机帧里认不出二维码', detail: sample.label + ' → ' + tilted.text }
    }
    if (tilted.version !== sample.version) {
      return { ok: false, summary: '歪着的相机帧把版本认错了', detail: sample.label + ' → v' + tilted.version }
    }
    lines.push('ok 带 ' + padding + ' 字节行填充、转 20 度的 320px 场景解回同一张码（v' + tilted.version + '）')
  } catch (error) {
    return { ok: false, summary: '相机帧路径抛错', detail: '' + error }
  }

  const elapsed = Date.now() - started
  return {
    ok: true,
    summary: '二维码解码自检通过：' + passed + ' 张金标 + 灰度图定位（' + elapsed + ' ms）',
    detail: lines.join('\n'),
  }
}

/**
 * 用**真的**系统随机数与 TCP 传输去连一台 Host，只做握手与一次 `session/list`。
 *
 * 与 `runClientCheck` 的分工：那个用内存管道证明流程对，这个证明鸿蒙侧的
 * `@ohos.net.socket` 与 `cryptoFramework` 桥接对。地址从页面上传进来。
 */
export async function runPlatformCheck(
  endpoint: string,
  ticketText: string,
): Promise<ClientCheckResult> {
  const started = Date.now()
  try {
    const parsed = parseEndpoint(endpoint)
    if (parsed === null) throw new Error('请输入 host:port，例如 192.168.1.5:48100')
    const ticket = decodeTicket(ticketText)
    const link = await LinkClient.connect({
      ticket: ticket,
      identity: newDeviceIdentity(systemRandom),
      random: systemRandom,
      openTransport: openTcpTransport,
      timeoutMs: 15_000,
      heartbeat: true,
    })
    const sessions = await link.rpc.call('session/list', { _request: {} }, 15_000)
    const items = sessions.items
    const count = Array.isArray(items) ? items.length : 0
    link.close()
    const elapsed = Date.now() - started
    return {
      ok: true,
      summary: '真实链路通过：系统随机数 + TCP 握手 + session/list（' + elapsed + ' ms）',
      detail:
        'host ' + ticket.hostName + '\n' +
        'endpoint ' + link.endpoint + '\n' +
        'sessions ' + count + '\n' +
        '路线 ' + link.route,
    }
  } catch (error) {
    return { ok: false, summary: '真实链路失败', detail: '' + error }
  }
}

export async function runClientCheck(): Promise<ClientCheckResult> {
  const started = Date.now()
  try {
    const hostPrivateKey = new Uint8Array(32)
    hostPrivateKey.fill(11)
    const secret = 'arkts-selfcheck-secret'
    const hostId = '0192f0bb-2222-7000-8000-000000000002'

    const identity = newDeviceIdentity(fixedRandom(23))
    const phonePipe = new MemoryPipe()
    const hostPipe = new MemoryPipe()
    phonePipe.peer = hostPipe
    hostPipe.peer = phonePipe

    const stub = new HostStub(hostPipe, hostPrivateKey, identity.publicKey, secret, hostId)

    const ticketText = encodeTicket({
      version: 1,
      hostDeviceId: hostId,
      hostPublicKey: x25519PublicKey(hostPrivateKey),
      hostName: 'ArkTS Stub',
      lanEndpoints: ['127.0.0.1:48100'],
      relayUrl: null,
      relayRoom: null,
      relayToken: null,
      pairingSecret: secret,
      expiresAt: 1_900_000_000_000,
    })
    // 票据必须能自己解回来：这是「扫码 → 连接」之间唯一的一次格式化往返。
    const back = decodeTicket(ticketText)
    if (back.hostDeviceId !== hostId || back.lanEndpoints.length !== 1) {
      throw new Error('the ticket did not survive the round trip')
    }
    const shownTicket = ticketText

    const link = await LinkClient.connectWithTicket({
      ticketText: ticketText,
      identity: identity,
      random: fixedRandom(31),
      openTransport: (host: string, port: number): Promise<FrameTransport> => {
        // 只有一个内存端点：地址对不对由上面那张票据决定。
        if (port !== 48100) throw new Error('the self-check only serves port 48100')
        return Promise.resolve(phonePipe)
      },
      timeoutMs: 5000,
      heartbeat: false,
    })
    await stub.ready
    const echoed = await link.rpc.call('test/echo', {}, 5000)
    if (echoed.peer !== 'arkts-stub') throw new Error('the stub did not answer as itself')

    // 错误的 proof 必须被拒，且理由要传出来。
    const badPipe = new MemoryPipe()
    const badHostPipe = new MemoryPipe()
    badPipe.peer = badHostPipe
    badHostPipe.peer = badPipe
    new HostStub(badHostPipe, hostPrivateKey, identity.publicKey, secret, hostId)
    let refused = ''
    try {
      await LinkClient.connectWithTicket({
        ticketText: encodeTicket({
          version: 1,
          hostDeviceId: hostId,
          hostPublicKey: x25519PublicKey(hostPrivateKey),
          hostName: 'ArkTS Stub',
          lanEndpoints: ['127.0.0.1:48100'],
          relayUrl: null,
          relayRoom: null,
          relayToken: null,
          pairingSecret: 'not-the-secret',
          expiresAt: 1_900_000_000_000,
        }),
        identity: identity,
        random: fixedRandom(37),
        openTransport: (host: string, port: number): Promise<FrameTransport> => Promise.resolve(badPipe),
        timeoutMs: 5000,
        heartbeat: false,
      })
    } catch (error) {
      if (error instanceof LinkRefusedError) refused = error.reason
      else throw error
    }
    if (refused !== 'bad-proof') throw new Error('a wrong secret was not refused, got "' + refused + '"')

    link.close()
    const elapsed = Date.now() - started
    return {
      ok: true,
      summary: '客户端链路自检通过：hello → Noise IK → RPC → 拒绝错误配对（' + elapsed + ' ms）',
      detail:
        'route ' + link.route + '\n' +
        'endpoint ' + link.endpoint + '\n' +
        'device ' + identity.deviceId.slice(0, 8) + '…\n' +
        'ticket ' + shownTicket.length + ' chars, decoded host ' + back.hostName + '\n' +
        'refused ' + refused,
    }
  } catch (error) {
    return {
      ok: false,
      summary: '客户端链路自检失败',
      detail: '' + error,
    }
  }
}

