// 真实链路的公共部分：读票据与身份、开 TCP 传输、连上运行中的 Host。
//
// `test:live` 里有好几个脚本要连同一台 Host，把它们各自抄一遍 `openTcp` 只会
// 让某一天其中一份悄悄落后。这里只有一份，且与鸿蒙侧的 `platform.ohos.ts`
// 一一对应（4 字节大端长度前缀 + `FrameSplitter`）。

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect as netConnect, type Socket } from 'node:net'

import { decodeBase64Url, encodeBase64Url } from '../src/bytes'
import { decodeTicket } from '../src/pairing'
import { identityFromPrivateKey } from '../src/identity'
import { LinkClient } from '../src/client'
import { FrameSplitter, frameWithLength } from '../src/framing'
import type { FrameTransport } from '../src/secure_channel'
import type { RpcClient } from '../src/rpc'

const CONNECT_TIMEOUT_MS = 15000

/** 连上之后的句柄：调用方只需要 `rpc` 与 `close`。 */
export interface LiveLink {
  readonly rpc: RpcClient
  readonly route: string
  readonly endpoint: string
  close(): Promise<void>
}

function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '..', '..', '..')
}

/** 4 字节大端长度前缀的 TCP 传输，等价于 Dart 的 `FramedSocket`。 */
function openTcp(host: string, port: number): Promise<FrameTransport> {
  return new Promise<FrameTransport>((resolveTransport, rejectTransport) => {
    const splitter = new FrameSplitter()
    const socket: Socket = netConnect({ host, port })
    let closed = false
    let onFrame: ((frame: Uint8Array) => void) | null = null
    let onClose: (() => void) | null = null
    const notifyClose = (): void => {
      if (closed) return
      closed = true
      const handler = onClose
      if (handler !== null) handler()
    }
    socket.setNoDelay(true)
    socket.on('connect', () => {
      // 连上之后不能再留着 15 秒的静默超时：会话流本来就可能长时间没数据。
      socket.setTimeout(0)
      resolveTransport({
        send: (frame: Uint8Array) => {
          socket.write(Buffer.from(frameWithLength(frame)))
        },
        close: () => {
          socket.destroy()
        },
        onFrame: (handler: (frame: Uint8Array) => void) => {
          onFrame = handler
        },
        onClose: (handler: () => void) => {
          onClose = handler
        },
      })
    })
    socket.on('data', (chunk: Buffer) => {
      let frames: Uint8Array[]
      try {
        frames = splitter.push(new Uint8Array(chunk))
      } catch {
        socket.destroy()
        return
      }
      for (const frame of frames) {
        const handler = onFrame
        if (handler !== null) handler(frame)
      }
    })
    socket.on('close', notifyClose)
    socket.on('error', (error: Error) => {
      rejectTransport(error)
      notifyClose()
    })
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      socket.destroy()
      rejectTransport(new Error(`the Host did not answer at ${host}:${port}`))
    })
  })
}

/**
 * 连上运行中的 Host。
 *
 * 票据与身份来自 `probe/live-ticket.mjs` 与 `probe/_probe-identity.txt`；
 * 票据只有 10 分钟有效期，所以先跑那条脚本再跑这里。
 */
export async function connectLive(): Promise<LiveLink> {
  const root = repoRoot()
  const ticketText = readFileSync(join(root, 'probe', '_live-ticket.txt'), 'utf8').trim()
  const lines = readFileSync(join(root, 'probe', '_probe-identity.txt'), 'utf8').trim().split(/\r?\n/)
  if (lines.length < 2) {
    throw new Error('probe/_probe-identity.txt must hold a device id and a private key')
  }

  const ticket = decodeTicket(ticketText)
  const identity = identityFromPrivateKey(lines[0], decodeBase64Url(lines[1]))
  console.log(`ticket -> ${ticket.hostName}, endpoints ${ticket.lanEndpoints.join(', ')}`)

  const link = await LinkClient.connect({
    ticket,
    identity,
    // 固定随机源：这条路径只验证形状，握手金标另有 vectors.ts。
    random: (length: number): Uint8Array => decodeBase64Url(encodeBase64Url(new Uint8Array(length).fill(7))),
    openTransport: openTcp,
    timeoutMs: CONNECT_TIMEOUT_MS,
    heartbeat: true,
  })
  console.log(`connected over ${link.route} (${link.endpoint})`)
  return {
    rpc: link.rpc,
    route: link.route,
    endpoint: link.endpoint,
    close: () => link.close(),
  }
}

/** 把任意异常压成一句可读的话。 */
export function describeError(error: Object): string {
  if (error instanceof Error) return error.message
  return '' + error
}
