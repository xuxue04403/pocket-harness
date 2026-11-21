/**
 * 鸿蒙侧的传输与随机数实现 —— 唯一依赖 `@ohos.*` 的文件。
 *
 * 这个文件**不参与 Node 测试**（Node 里没有 `@ohos.net.socket`），它存在的意义是
 * 让 ArkTS 编译器检查这段桥接代码：`packages/dsh_arkts/src` 的其余部分都是纯 TS，
 * 只有这里的 API 用法是鸿蒙专属的。
 *
 * 两个必须记住的鸿蒙口径：
 * - `TCPSocket.send` 收 `ArrayBuffer`，而 `Uint8Array` 可能是 `ArrayBuffer` 的一段
 *   视图，必须先 `slice` 出精确的字节区间，否则会把整个底层缓冲区发出去。
 * - `message` 事件给的是 `ArrayBuffer`，一次回调不保证一帧，必须自己按长度前缀切。
 */

import socket from '@ohos.net.socket'
import webSocket from '@ohos.net.webSocket'
import { cryptoFramework } from '@kit.CryptoArchitectureKit'
import type { RandomSource } from './core/identity'
import type { JsonObject } from './core/json'
import { FrameSplitter, frameWithLength } from './core/framing'
import type { FrameTransport } from './core/secure_channel'
import type { PairingTicket } from './core/pairing'
import {
  MAX_RELAY_FRAME_BYTES,
  RELAY_ERROR,
  RELAY_PEER_GONE,
  RELAY_READY,
  describeRelayClose,
  describeRelayRefusal,
  encodeRelayHello,
  readRelayControl,
} from './core/relay_protocol'

/** 用系统 CSPRNG 填充。`generateRandomSync` 在鸿蒙上是同步的，正好对上 `RandomSource`。 */
export function systemRandom(length: number): Uint8Array {
  const random = cryptoFramework.createRandom()
  const blob = random.generateRandomSync(length)
  const data = new Uint8Array(blob.data.byteLength)
  data.set(new Uint8Array(blob.data as ArrayBuffer))
  return data
}

/** 把 `Uint8Array` 精确地变成独立的 `ArrayBuffer`（不带多余的尾巴）。 */
function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.length)
  new Uint8Array(copy).set(bytes)
  return copy
}

/**
 * 直连 TCP 传输。
 *
 * 与 Dart 的 `FramedSocket`、Node 的 `test/live.ts` 的 `openTcp` 同口径：
 * 线上是 `[uint32 大端长度][帧]`。
 */
/**
 * 连接超时。与 `TransportFactory` 的签名（只有 host 与 port）保持一致，
 * 所以这里用常量而不是第三个参数：建立连接的时限与握手时限是两件事，
 * 后者由 `LinkClient` 的 `timeoutMs` 管。
 */
const CONNECT_TIMEOUT_MS = 15_000

export async function openTcpTransport(host: string, port: number): Promise<FrameTransport> {
  const tcp = socket.constructTCPSocketInstance()
  const splitter = new FrameSplitter()
  let frameHandler: (frame: Uint8Array) => void = () => undefined
  let closeHandler: () => void = () => undefined
  let closed = false

  const notifyClose = (): void => {
    if (closed) return
    closed = true
    closeHandler()
  }

  tcp.on('message', (info: socket.SocketMessageInfo) => {
    let frames: Uint8Array[] = []
    try {
      frames = splitter.push(new Uint8Array(info.message))
    } catch {
      // 长度前缀不可信之后，这条链路的边界已经没意义了。
      void tcp.close()
      notifyClose()
      return
    }
    for (const frame of frames) frameHandler(frame)
  })
  tcp.on('close', notifyClose)
  tcp.on('error', notifyClose)

  await tcp.connect({
    address: { address: host, port: port, family: 1 },
    timeout: CONNECT_TIMEOUT_MS,
  })

  return {
    send(frame: Uint8Array): void {
      if (closed) throw new Error('the socket is closed')
      // 不 await：FrameTransport.send 是同步签名，调用方按顺序连发多帧时
      // 系统 socket 自己保序。
      void tcp.send({ data: exactBuffer(frameWithLength(frame)) })
    },
    close(): void {
      if (closed) return
      closed = true
      void tcp.close()
    },
    onFrame(handler: (frame: Uint8Array) => void): void {
      frameHandler = handler
    },
    onClose(handler: () => void): void {
      closeHandler = handler
    },
  }
}

/** 供页面显示的诊断信息，避免把整个 socket 对象塞进 UI。 */
export function describeTransport(host: string, port: number): JsonObject {
  return { host: host, port: port, framing: 'uint32-be-length' }
}

/**
 * 经中继的传输。
 *
 * 与 Dart 的 `RelayTransport` 同口径：WebSocket 上**二进制帧直接就是整帧**（不再套
 * 长度前缀），而文本帧是控制消息。三个必须照做的细节：
 * - 首帧 hello 必须是**文本**，中继要靠它认房间；发二进制会被当成违规直接关掉；
 * - `{v:1, ok:true, …}` 表示**已进房**（可以一直等手机），`{type:'ready'}` 才表示
 *   **对端也到了**——把两者混为一谈会让空房间每隔十几秒自我重连一次；
 * - `message` 事件的 `ArrayBuffer` 也可能一次给多段或半段，所以这里同样过
 *   `FrameSplitter`，与 TCP 那条路共用一份切帧代码（虽然中继不切帧，但复用不亏）。
 */
export function openRelayTransport(ticket: PairingTicket): Promise<FrameTransport> {
  return new Promise<FrameTransport>((resolveTransport, rejectTransport) => {
    const url = ticket.relayUrl === undefined ? '' : ticket.relayUrl
    const room = ticket.relayRoom === undefined ? '' : ticket.relayRoom
    const token = ticket.relayToken === undefined ? '' : ticket.relayToken
    if (url.length === 0 || room.length === 0 || token.length === 0) {
      rejectTransport(new Error('the pairing code carries no relay address'))
      return
    }

    const ws = webSocket.createWebSocket()
    const splitter = new FrameSplitter()
    let frameHandler: (frame: Uint8Array) => void = () => undefined
    let closeHandler: () => void = () => undefined
    let closed = false
    let ready = false
    let settled = false

    const notifyClose = (): void => {
      if (closed) return
      closed = true
      closeHandler()
      if (!settled) {
        settled = true
        rejectTransport(new Error('the relay closed before the peer arrived'))
      }
    }

    ws.on('message', (error: Object, data: string | ArrayBuffer) => {
      if (error !== null && error !== undefined) return
      if (typeof data === 'string') {
        // 控制消息只带配对状态，永远不含业务字节；解析规则在核心里有断言。
        const control = readRelayControl(data)
        if (control.kind === RELAY_READY) {
          if (!settled) {
            settled = true
            ready = true
            resolveTransport(transport)
          }
          return
        }
        if (control.kind === RELAY_PEER_GONE) {
          notifyClose()
          return
        }
        if (control.kind === RELAY_ERROR && !settled) {
          // 被拒时必须把中继的原因说出来，否则用户只会看到"连不上"。
          settled = true
          closed = true
          void ws.close()
          rejectTransport(new Error(describeRelayRefusal(control)))
          return
        }
        // 进房回执与噪音都不改变状态：前者只是告诉你房间分到了，后者没有意义。
        return
      }
      if (!ready) return
      // 中继上一条二进制消息**就是一整帧**，没有 4 字节长度前缀——那是 TCP 那条路
      // 的约定。曾经在这里套用 FrameSplitter，结果它把帧头当成长度前缀，解析出
      // 一个天文数字后抛错把连接关了，表现为"中继连上了但立刻断开"。
      frameHandler(new Uint8Array(data))
    })
    // 中继的拒绝**只**从关闭帧到达（`socket.close(4403, 'bad token')`），所以这里
    // 必须读 code：漏掉它就是"手机关了但界面一直转圈"。
    ws.on('close', (error: Object, result: webSocket.CloseResult) => {
      if (error !== null && error !== undefined) {
        notifyClose()
        return
      }
      const control = describeRelayClose(result.code, result.reason)
      if (!settled && control.kind === RELAY_ERROR) {
        settled = true
        closed = true
        rejectTransport(new Error(describeRelayRefusal(control)))
        return
      }
      notifyClose()
    })
    ws.on('error', () => { notifyClose() })

    const transport: FrameTransport = {
      send(frame: Uint8Array): void {
        if (closed) throw new Error('the relay transport is closed')
        if (frame.length > MAX_RELAY_FRAME_BYTES) {
          throw new Error(`a frame of ${frame.length} bytes exceeds the relay limit`)
        }
        void ws.send(exactBuffer(frame))
      },
      close(): void {
        if (closed) return
        closed = true
        void ws.close()
      },
      onFrame(handler: (frame: Uint8Array) => void): void {
        frameHandler = handler
      },
      onClose(handler: () => void): void {
        closeHandler = handler
      },
    }

    ws.connect(url).then(() => {
      // 文本帧：中继读它来分配房间。
      return ws.send(encodeRelayHello('client', room, token))
    }).then(() => {
      // 进房回执之后才轮到 ready；两者都在 message 回调里处理。
    }).catch((error: Object) => {
      if (settled) return
      settled = true
      rejectTransport(error instanceof Error ? error : new Error('' + error))
    })
  })
}


/** 便于测试与页面复用的随机源包装。 */
export const systemRandomSource: RandomSource = systemRandom


