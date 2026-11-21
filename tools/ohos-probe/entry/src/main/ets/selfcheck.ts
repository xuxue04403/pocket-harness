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

