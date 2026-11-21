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
import { cryptoFramework } from '@kit.CryptoArchitectureKit'
import type { RandomSource } from './core/identity'
import type { JsonObject } from './core/json'
import { FrameSplitter, frameWithLength } from './core/framing'
import type { FrameTransport } from './core/secure_channel'

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

/** 便于测试与页面复用的随机源包装。 */
export const systemRandomSource: RandomSource = systemRandom


