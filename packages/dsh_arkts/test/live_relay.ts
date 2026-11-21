/**
 * 走中继的真实链路：TypeScript 核心 ↔ 真实 Host 插件 ↔ 真实中继进程。
 *
 * 为什么要有这个文件：`test/relay_contract.ts` 证明了中继真的那么说话，
 * 但那是拿裸 WebSocket 说的；这里要证明的是**核心的 `LinkClient` 在中继上也能
 * 完成 Noise 握手并调通 RPC**——也就是鸿蒙 App 走的那条路。
 *
 * 平台差异只在这里体现：鸿蒙用 `@ohos.net.webSocket`，Node 用全局 `WebSocket`。
 * 两边对协议的期待完全一样（首帧文本 hello、二进制整帧、关闭帧表示拒绝），
 * 所以这个文件还能当 `platform.ohos.ts` 的可执行说明看。
 */

import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LinkClient } from '../src/client'
import { FrameSplitter } from '../src/framing'
import type { FrameTransport } from '../src/secure_channel'
import { decodeTicket, type PairingTicket } from '../src/pairing'
import { newDeviceIdentity } from '../src/identity'
import {
  MAX_RELAY_FRAME_BYTES,
  RELAY_PEER_GONE,
  RELAY_READY,
  describeRelayClose,
  describeRelayRefusal,
  encodeRelayHello,
  readRelayControl,
} from '../src/relay_protocol'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const HARNESS = process.env.DSH_EXE ?? 'C:\\Users\\xuexu\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe'

function nodeExe(): string {
  return HARNESS
}

/**
 * 用中继上的 WebSocket 造一个 `FrameTransport`。
 *
 * 这段与 `tools/ohos-probe/entry/src/main/ets/platform.ohos.ts` 的
 * `openRelayTransport` 一一对应，差别只在 API 名字。
 */
function openRelay(ticket: PairingTicket): Promise<FrameTransport> {
  return new Promise<FrameTransport>((resolveTransport, rejectTransport) => {
    const url = ticket.relayUrl ?? ''
    const room = ticket.relayRoom ?? ''
    const token = ticket.relayToken ?? ''
    if (url.length === 0 || room.length === 0 || token.length === 0) {
      rejectTransport(new Error('the pairing code carries no relay address'))
      return
    }

    const socket = new WebSocket(url)
    socket.binaryType = 'arraybuffer'
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

    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        const control = readRelayControl(event.data)
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
        return
      }
      if (!ready) return
      // 中继上一条二进制消息就是一整帧，没有长度前缀（那是 TCP 的约定）。
      frameHandler(new Uint8Array(event.data as ArrayBuffer))
    })
    socket.addEventListener('close', (event) => {
      const control = describeRelayClose(event.code, event.reason)
      if (!settled && control.kind !== RELAY_PEER_GONE) {
        settled = true
        closed = true
        rejectTransport(new Error(describeRelayRefusal(control)))
        return
      }
      notifyClose()
    })
    socket.addEventListener('error', () => { notifyClose() })

    const transport: FrameTransport = {
      send(frame: Uint8Array): void {
        if (closed) throw new Error('the relay transport is closed')
        if (frame.length > MAX_RELAY_FRAME_BYTES) {
          throw new Error(`a frame of ${frame.length} bytes exceeds the relay limit`)
        }
        socket.send(frame)
      },
      close(): void {
        if (closed) return
        closed = true
        socket.close()
      },
      onFrame(handler: (frame: Uint8Array) => void): void {
        frameHandler = handler
      },
      onClose(handler: () => void): void {
        closeHandler = handler
      },
    }

    socket.addEventListener('open', () => {
      // 首帧必须是文本：中继读它来分房间。
      socket.send(encodeRelayHello('client', room, token))
    })
  })
}

interface SmokeHost {
  readonly ticket: PairingTicket
  readonly stop: () => void
}

/** 起一个只走中继的 Host，等它打印票据。 */
function startHost(): Promise<SmokeHost> {
  return new Promise<SmokeHost>((resolveStart, rejectStart) => {
    const child = spawn(nodeExe(), [join(ROOT, 'probe', 'plugin-relay-smoke.mjs')], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buffer = ''
    const timer = setTimeout(() => {
      child.kill()
      rejectStart(new Error(`the Host did not print a ticket: ${buffer}`))
    }, 25_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      const line = buffer.split('\n')[0] ?? ''
      if (!line.includes('"ticket"')) return
      try {
        const parsed = JSON.parse(line) as { ticket: string }
        clearTimeout(timer)
        resolveStart({ ticket: decodeTicket(parsed.ticket), stop: () => { child.kill() } })
      } catch {
        // 半行，等下一次数据。
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { process.stderr.write(`[host] ${chunk}`) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      rejectStart(new Error(`the Host exited with ${String(code)}: ${buffer}`))
    })
  })
}

async function main(): Promise<void> {
  const host = await startHost()
  try {
    const ticket = host.ticket
    process.stdout.write(`relay ticket -> room ${String(ticket.relayRoom)}, ${String(ticket.lanEndpoints.length)} LAN endpoints\n`)

    // Host 会校验 device id 的形状（UUIDv7 或 ULID），所以身份必须真的生成一次。
    const random = (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length))
    const clientIdentity = newDeviceIdentity(random)

    const link = await LinkClient.connect({
      ticket,
      identity: clientIdentity,
      random,
      openTransport: () => Promise.reject(new Error('this ticket has no LAN endpoint')),
      openRelay,
      timeoutMs: 25_000,
    })

    if (link.route !== 'relay') throw new Error(`expected the relay route, got ${link.route}`)
    process.stdout.write(`noise handshake complete over relay (${String(link.endpoint)})\n`)

    const echoed = await link.rpc.call('test/echo', { over: 'relay' })
    if ((echoed['peer'] as string) !== 'peer-under-test') {
      throw new Error(`unexpected peer: ${String(echoed['peer'])}`)
    }
    process.stdout.write('test/echo -> relay carries the encrypted round trip\n')

    const seen: number[] = []
    for await (const frame of link.rpc.openStream('test/count', { count: 3 }, { timeoutMs: 20_000 })) {
      seen.push(frame['index'] as number)
    }
    // test/count 从 0 开始产 count 条，所以给 3 就是 0,1,2。
    const ascending = seen.every((value, index) => value === index)
    if (seen.length !== 3 || !ascending) throw new Error(`unexpected stream: ${seen.join(',')}`)
    process.stdout.write(`test/count -> [${seen.join(',')}] through the relay\n`)

    await link.close()
  } finally {
    host.stop()
  }
  process.stdout.write('ARKTS RELAY ROUTE TALKS TO THE REAL HOST\n')
}

main().catch((error: Object) => {
  process.stderr.write(`FAILED: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
