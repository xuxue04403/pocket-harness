// 真实链路验证：TypeScript 客户端连上运行中的 Harness。
//
// 这一步是整份 TypeScript 核心存在的理由 —— 只有当它能和真正的 Host 完成
// Noise 握手并跑通业务调用，鸿蒙侧的移植才是可信的。
//
// 这里刻意走 `LinkClient.connect` 而不是手写 hello/握手：鸿蒙 App 用的就是
// 那条路径，只有它被真实 Host 验证过，"协议层能跑" 才算数。

import { connect } from 'node:net'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

import { decodeBase64Url } from '../src/bytes'
import { identityFromPrivateKey } from '../src/identity'
import { decodeTicket } from '../src/pairing'
import { LinkClient } from '../src/client'
import { FrameSplitter, frameWithLength } from '../src/framing'
import type { FrameTransport } from '../src/secure_channel'
import type { JsonObject } from '../src/json'

/** 4 字节大端长度前缀的 TCP 传输，等价于 Dart 的 `FramedSocket`。 */
function openTcp(host: string, port: number, timeoutMs: number): Promise<FrameTransport> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port })
    // 用与鸿蒙侧同一份切帧实现：这里手搓一份的话，测的就不是真正跑的那段代码。
    const splitter = new FrameSplitter()
    let frameHandler: (frame: Uint8Array) => void = () => undefined
    let closeHandler: () => void = () => undefined
    let closed = false

    socket.setNoDelay(true)
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('the socket went quiet')))

    socket.on('data', (chunk: Buffer) => {
      let frames: Uint8Array[] = []
      try {
        frames = splitter.push(new Uint8Array(chunk))
      } catch (error) {
        socket.destroy(error instanceof Error ? error : new Error(String(error)))
        return
      }
      for (const frame of frames) frameHandler(frame)
    })
    socket.on('close', () => {
      if (closed) return
      closed = true
      closeHandler()
    })
    socket.once('error', reject)

    socket.once('connect', () => {
      // 握手之后链路上会有长时间的静默，所以连接建立后立刻取消这个超时。
      socket.setTimeout(0)
      resolve({
        send(frame) {
          socket.write(Buffer.from(frameWithLength(frame)))
        },
        close() {
          socket.destroy()
        },
        onFrame(handler) {
          frameHandler = handler
        },
        onClose(handler) {
          closeHandler = handler
        },
      })
    })
  })
}

function readText(path: string): string {
  return readFileSync(path, 'utf8').trim()
}

// 仓库根目录：这个文件在 packages/dsh_arkts/test，构建产物在 packages/dsh_arkts/build，
// 两种情况下往上两级都能到根。用绝对路径，避免 npm 在不同工作目录下跑时找不到探针文件。
function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '..', '..', '..')
}

function field(source: JsonObject, name: string): string {
  const value = source[name]
  return typeof value === 'string' ? value : ''
}

async function main(): Promise<void> {
  const root = repoRoot()
  const ticketPath = join(root, 'probe', '_live-ticket.txt')
  const identityPath = join(root, 'probe', '_probe-identity.txt')
  if (!existsSync(ticketPath)) throw new Error(`missing ${ticketPath}; run probe/live-ticket.mjs first`)
  if (!existsSync(identityPath)) throw new Error(`missing ${identityPath}`)

  const ticket = decodeTicket(readText(ticketPath))
  const [deviceId, privateKeyText] = readText(identityPath).split(/\r?\n/)
  const identity = identityFromPrivateKey(deviceId.trim(), decodeBase64Url(privateKeyText.trim()))
  console.log(
    `ticket -> ${ticket.hostName} (${ticket.hostDeviceId.slice(0, 8)}…), endpoints ${ticket.lanEndpoints.join(', ')}`,
  )

  const link = await LinkClient.connect({
    ticket,
    identity,
    random: (length) => new Uint8Array(randomBytes(length)),
    openTransport: (host, port) => openTcp(host, port, 15_000),
    timeoutMs: 15_000,
    // 探针跑几秒就结束，心跳只会多几条无关的日志。
    heartbeat: false,
  })
  console.log(`noise handshake complete over ${link.route} (${link.endpoint})`)

  const list = await link.rpc.call('session/list', { _request: {} })
  const items = Array.isArray(list.items) ? (list.items as Object[]) : []
  console.log(`session/list -> ${items.length} sessions`)
  if (items.length === 0) throw new Error('the Host answered with no sessions; is this the right profile?')

  const first = items[0] as JsonObject
  const sessionId = field(first, 'sessionId')
  console.log(`first session ${sessionId.slice(0, 8)}… updated ${String(first.updatedAt)}`)

  // 流式端点也验一次：job/list 首帧即整集，流不会自己结束，所以读到第一帧就退。
  for await (const frame of link.rpc.openStream('job/list', { request: { sessionId } }, { timeoutMs: 20_000 })) {
    const jobs = Array.isArray(frame.jobs) ? (frame.jobs as Object[]) : []
    console.log(`job/list -> ${jobs.length} jobs (stream opened and read)`)
    break
  }

  link.close()
  console.log('\nTYPESCRIPT CLIENT TALKS TO THE REAL HOST')
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    process.exit(1)
  },
)
