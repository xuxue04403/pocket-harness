// 手机侧的连接流程：明文 hello → Noise IK → RPC。
//
// 与 Dart 侧 `lan_client.dart` 的 `LinkClient` 一一对应。传输层由平台提供
// （鸿蒙用 @ohos.net.socket / webSocket，Node 测试用 net），这里只负责把一节
// 已经连通的字节管道升级成一条能发 RPC 的加密链路。

import { encodeBase64Url, fromUtf8 } from './bytes'
import { newDeviceId, type RandomSource } from './identity'
import { encodeProof, LINK_HELLO_VERSION, encodeHello } from './link_protocol'
import { createNoisePrologue, NoiseIkSession } from './noise'
import { decodeTicket, hasRelay, parseEndpoint, type DeviceIdentity, type PairingTicket } from './pairing'
import { RpcClient } from './rpc'
import { SecureChannel, type FrameTransport } from './secure_channel'
import { FRAME_KIND, decodeFrame, encodeFrame } from './wire'
import type { JsonObject } from './json'

/** 手机用哪个方向到达 Host。 */
export type LinkRoute = 'lan' | 'relay'

/** Host 明确拒绝时抛这个，带上它给出的理由。 */
export class LinkRefusedError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(`the Host refused this phone: ${reason}`)
    this.name = 'LinkRefusedError'
    this.reason = reason
  }
}

/** 连一个 `host:port` 的明文 TCP；由平台提供。 */
export type TransportFactory = (host: string, port: number) => Promise<FrameTransport>

/** 连中继 WebSocket；由平台提供。 */
export type RelayFactory = (ticket: PairingTicket) => Promise<FrameTransport>

/** 一条已经握完手的加密链路。 */
export class LinkClient {
  readonly transport: FrameTransport
  readonly channel: SecureChannel
  readonly rpc: RpcClient
  readonly route: LinkRoute
  readonly endpoint: string

  private constructor(options: {
    transport: FrameTransport
    channel: SecureChannel
    rpc: RpcClient
    route: LinkRoute
    endpoint: string
  }) {
    this.transport = options.transport
    this.channel = options.channel
    this.rpc = options.rpc
    this.route = options.route
    this.endpoint = options.endpoint
  }

  /**
   * 连上 Host：先试局域网地址，再试中继。
   *
   * 每个局域网地址背后都是同一台 Host，所以一旦它明确拒绝（proof 不对、
   * 配对已失效），就立刻上抛 —— 换下一个地址只会得到一个误导性的 socket 错误。
   */
  static async connect(options: {
    readonly ticket: PairingTicket
    readonly identity: DeviceIdentity
    readonly random: RandomSource
    readonly openTransport: TransportFactory
    readonly openRelay?: RelayFactory
    readonly connectionId?: string
    readonly timeoutMs?: number
    readonly heartbeat?: boolean
  }): Promise<LinkClient> {
    const connectionId = options.connectionId ?? newDeviceId(options.random)
    const timeoutMs = options.timeoutMs ?? 8000
    const failures: string[] = []
    const heartbeat = options.heartbeat ?? true

    for (const endpoint of options.ticket.lanEndpoints) {
      const parsed = parseEndpoint(endpoint)
      if (parsed === null) continue
      try {
        const transport = await options.openTransport(parsed.host, parsed.port)
        return await LinkClient.handshake({
          ticket: options.ticket,
          identity: options.identity,
          random: options.random,
          connectionId,
          transport,
          timeoutMs,
          route: 'lan',
          endpoint: `${parsed.host}:${parsed.port}`,
          heartbeat,
        })
      } catch (error) {
        if (error instanceof LinkRefusedError) throw error
        // 一个地址连不上不代表别的也不行：多网卡的 Host 常常只有一个通。
        failures.push(`${endpoint}: ${messageOf(error)}`)
      }
    }

    const relayUrl = options.ticket.relayUrl
    const relayable = hasRelay(options.ticket)
    if (relayable && options.openRelay !== undefined) {
      try {
        const transport = await options.openRelay(options.ticket)
        return await LinkClient.handshake({
          ticket: options.ticket,
          identity: options.identity,
          random: options.random,
          connectionId,
          transport,
          timeoutMs,
          route: 'relay',
          endpoint: relayUrl ?? 'relay',
          heartbeat,
        })
      } catch (error) {
        if (error instanceof LinkRefusedError) throw error
        failures.push(`relay: ${messageOf(error)}`)
      }
    }

    if (failures.length === 0) {
      throw new Error(
        relayable
          ? 'the pairing code lists no usable LAN or relay endpoint'
          : 'the pairing code lists no usable LAN endpoint',
      )
    }
    if (failures.length === 1) throw new Error(failures[0])
    throw new Error(`no endpoint answered: ${failures.join('; ')}`)
  }

  /** 从一张配对码直接连线，省去调用方自己 decode。 */
  static async connectWithTicket(options: {
    readonly ticketText: string
    readonly identity: DeviceIdentity
    readonly random: RandomSource
    readonly openTransport: TransportFactory
    readonly openRelay?: RelayFactory
    readonly connectionId?: string
    readonly timeoutMs?: number
    readonly heartbeat?: boolean
  }): Promise<LinkClient> {
    const ticket = decodeTicket(options.ticketText)
    return LinkClient.connect({ ...options, ticket })
  }

  /** 在一节已连通的字节管道上跑 hello 与 Noise。 */
  static async handshake(options: {
    readonly ticket: PairingTicket
    readonly identity: DeviceIdentity
    readonly random: RandomSource
    readonly connectionId: string
    readonly transport: FrameTransport
    readonly timeoutMs: number
    readonly route: LinkRoute
    readonly endpoint: string
    readonly heartbeat: boolean
  }): Promise<LinkClient> {
    const { ticket, identity, connectionId, transport } = options

    let settled = false
    let answer: (value: JsonObject) => void = () => undefined
    let refuse: (error: Error) => void = () => undefined
    const replied = new Promise<JsonObject>((resolve, reject) => {
      answer = resolve
      refuse = reject
    })
    // hello 的回复和传输失败在赛跑，先到的那个算数，所以两个回调都只看第一次。
    const settle = (): boolean => {
      if (settled) return false
      settled = true
      return true
    }

    transport.onFrame((frame) => {
      if (!settle()) return
      try {
        answer(readControlReply(frame))
      } catch (error) {
        refuse(new Error(messageOf(error)))
      }
    })
    transport.onClose(() => {
      if (!settle()) return
      refuse(new Error('the transport closed before the Host answered'))
    })

    const secret = ticket.pairingSecret
    const hello = {
      v: LINK_HELLO_VERSION,
      connection: connectionId,
      client: identity.deviceId,
      ...(secret !== null ? { proof: encodeProof(secret, connectionId, identity.deviceId) } : {}),
    }
    transport.send(encodeFrame({ kind: FRAME_KIND.control, payload: encodeHello(hello) }))

    const reply = await withTimeout(replied, options.timeoutMs, 'the Host did not answer the hello')
    if (reply.accepted !== true) {
      transport.close()
      throw new LinkRefusedError(typeof reply.reason === 'string' ? reply.reason : 'refused')
    }
    if (reply.host !== ticket.hostDeviceId) {
      transport.close()
      throw new Error(`the Host answered as ${String(reply.host)}, not ${ticket.hostDeviceId}`)
    }

    const session = new NoiseIkSession({
      role: 'initiator',
      localPrivateKey: identity.privateKey,
      localPublicKey: identity.publicKey,
      remotePublicKey: ticket.hostPublicKey,
      // prologue 必须与 Host 用同样的三段 id 拼，否则握手认证失败。
      prologue: createNoisePrologue(connectionId, ticket.hostDeviceId, identity.deviceId),
      random: options.random,
    })

    let established: () => void = () => undefined
    let failHandshake: (error: Error) => void = () => undefined
    const ready = new Promise<void>((resolve, reject) => {
      established = resolve
      failHandshake = reject
    })

    let rpc: RpcClient | null = null
    const channel = new SecureChannel({
      transport,
      session,
      onEstablished: () => {
        established()
      },
      onMessage: (plaintext) => {
        rpc?.accept(plaintext)
      },
      onClose: () => {
        rpc?.close()
      },
      onError: (error) => {
        failHandshake(error)
      },
    })

    // initiator 先说话，消息一立刻发出；之后在 `onEstablished` 里翻牌子。
    channel.start()
    await withTimeout(ready, options.timeoutMs, 'the Noise handshake did not finish')
    rpc = new RpcClient({ channel })
    if (options.heartbeat) rpc.startHeartbeat()

    return new LinkClient({
      transport,
      channel,
      rpc,
      route: options.route,
      endpoint: options.endpoint,
    })
  }

  /** 打开一条流式端点；宿主在回应 streamId 之后会马上推帧。 */
  openStream(endpoint: string, args: JsonObject = {}, timeoutMs?: number): AsyncGenerator<JsonObject> {
    return this.rpc.openStream(endpoint, args, timeoutMs === undefined ? {} : { timeoutMs })
  }

  close(): void {
    this.rpc.close()
    this.channel.close()
  }
}

function readControlReply(frame: Uint8Array): JsonObject {
  const decoded = decodeFrame(frame)
  if (decoded.kind !== FRAME_KIND.control) {
    throw new Error(`the Host answered with frame kind ${decoded.kind}, not control`)
  }
  let value: Object
  try {
    value = JSON.parse(fromUtf8(decoded.payload))
  } catch {
    throw new Error('the hello reply is not a JSON object')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('the hello reply is not a JSON object')
  }
  return value as JsonObject
}

/** 从任意 catch 到的东西里取一句人话（ArkTS 不允许把参数写成 unknown）。 */
function messageOf(error: Object): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 给一个 promise 加超时，超时后抛便于排障的固定文案。 */
function withTimeout<T>(value: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (timeoutMs <= 0) return value
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    value.then(
      (result) => {
        clearTimeout(timer)
        resolve(result)
      },
      (error: Object) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** 编码后的配对码里只放公钥，私钥永不出门。 */
export function identityPublicKey(identity: DeviceIdentity): string {
  return encodeBase64Url(identity.publicKey)
}
