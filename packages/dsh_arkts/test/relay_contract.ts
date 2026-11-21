/**
 * 中继协议与**真实中继进程**的对照断言。
 *
 * `test/relay_protocol.ts` 只验证「我们自己怎么解析」；这个文件验证「中继真的这么说话」。
 * 差别很关键：如果我把 `ok:true` 的字段名猜错，前者会全绿而真机上永远连不上。
 *
 * 这里用子进程起 `relay/run.mjs`（而不是 import `createRelay`），原因是 `ws` 装在
 * `relay/node_modules` 下、不在本包的解析链上；走进程边界反而更接近真实部署。
 */

import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RELAY_JOINED,
  RELAY_PEER_GONE,
  RELAY_READY,
  describeRelayClose,
  encodeRelayHello,
  readRelayControl,
} from '../src/relay_protocol'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const TOKEN = 'relay-contract-token-0123456789'
const ROOM = 'contract-room-1'

let failures = 0
function check(name: string, run: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(run)
    .catch((error) => {
      failures += 1
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`FAILED ${name}: ${message}\n`)
    })
}
function equal<T>(actual: T, expected: T, what: string): void {
  if (actual !== expected) throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`)
}

interface RelayProcess {
  readonly port: number
  readonly stop: () => void
}

/** 起中继进程并等它打印端口。 */
function startRelay(): Promise<RelayProcess> {
  return new Promise<RelayProcess>((resolveStart, rejectStart) => {
    const child = spawn(process.execPath, [join(ROOT, 'relay', 'run.mjs')], {
      env: { ...process.env, PORT: '0', HOST: '127.0.0.1', POCKET_HARNESS_RELAY_TOKEN: TOKEN },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buffer = ''
    const timer = setTimeout(() => {
      child.kill()
      rejectStart(new Error('the relay did not start in time'))
    }, 15_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      const match = /listening on [^:]+:(\d+)/.exec(buffer)
      if (match === null) return
      clearTimeout(timer)
      resolveStart({ port: Number(match[1]), stop: () => { child.kill() } })
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { process.stderr.write(`[relay] ${chunk}`) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      rejectStart(new Error(`the relay exited with ${String(code)}: ${buffer}`))
    })
  })
}

interface Control {
  readonly kind: string
  readonly message: string
  readonly code: number
}

/** 一条连到中继的 WebSocket，把控制消息与二进制帧分开。 */
class Link {
  readonly controls: Control[] = []
  readonly frames: Uint8Array[] = []
  /** 中继的拒绝只从关闭帧到达，所以这两个字段是唯一的证据。 */
  closeCode = 0
  closeReason = ''
  private readonly socket: WebSocket
  private readonly waiters: Array<() => void> = []

  constructor(url: string) {
    this.socket = new WebSocket(url)
    this.socket.binaryType = 'arraybuffer'
    this.socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        this.controls.push(readRelayControl(event.data))
      } else {
        this.frames.push(new Uint8Array(event.data as ArrayBuffer))
      }
      for (const waiter of this.waiters.splice(0)) waiter()
    })
    this.socket.addEventListener('close', (event) => {
      this.closeCode = event.code
      this.closeReason = event.reason
      this.controls.push(describeRelayClose(event.code, event.reason))
      for (const waiter of this.waiters.splice(0)) waiter()
    })
  }

  opened(): Promise<void> {
    if (this.socket.readyState === 1) return Promise.resolve()
    return new Promise<void>((resolveOpen) => {
      this.socket.addEventListener('open', () => resolveOpen(), { once: true })
    })
  }

  send(text: string): void {
    this.socket.send(text)
  }

  sendBytes(bytes: Uint8Array): void {
    this.socket.send(bytes)
  }

  async until(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await new Promise<void>((wake) => {
        this.waiters.push(wake)
        setTimeout(wake, 50)
      })
    }
  }

  close(): void {
    this.socket.close()
  }
}

async function main(): Promise<void> {
  const relay = await startRelay()
  const url = `ws://127.0.0.1:${relay.port}/relay`
  try {
    const host = new Link(url)
    const phone = new Link(url)
    await host.opened()
    await phone.opened()

    // 首帧必须是文本 hello——这是中继唯一的硬要求。
    host.send(encodeRelayHello('host', ROOM, TOKEN))
    phone.send(encodeRelayHello('client', ROOM, TOKEN))

    await check('the host is told it joined the room', async () => {
      await host.until(() => host.controls.some((c) => c.kind === RELAY_JOINED), 'the host join receipt')
    })

    await check('the phone is told it joined the room', async () => {
      await phone.until(() => phone.controls.some((c) => c.kind === RELAY_JOINED), 'the phone join receipt')
    })

    // 进房之后才轮到 ready：中继等到两端齐了才推这一条。
    await check('both ends are told the peer arrived', async () => {
      await host.until(() => host.controls.some((c) => c.kind === RELAY_READY), 'the host ready notice')
      await phone.until(() => phone.controls.some((c) => c.kind === RELAY_READY), 'the phone ready notice')
    })

    await check('bytes cross the relay unchanged', async () => {
      const payload = new Uint8Array([0, 1, 2, 250, 251, 255])
      host.sendBytes(payload)
      await phone.until(() => phone.frames.length > 0, 'the relayed bytes')
      const got = phone.frames[0]
      equal(got.length, payload.length, 'length')
      for (let index = 0; index < payload.length; index += 1) {
        equal(got[index], payload[index], `byte ${String(index)}`)
      }
    })

    // 一个房间只服务一部手机：第二部要被 4409 顶掉（必须在第一部还在的时候试）。
    await check('a second client is closed with 4409', async () => {
      const second = new Link(url)
      await second.opened()
      second.send(encodeRelayHello('client', ROOM, TOKEN))
      await second.until(() => second.closeCode !== 0, 'the close frame')
      equal(second.closeCode, 4409, 'close code')
    })

    await check('a phone that leaves tells the host', async () => {
      phone.close()
      await host.until(() => host.controls.some((c) => c.kind === RELAY_PEER_GONE), 'the peer-gone notice')
    })

    // 这是本轮最重要的一条：拒绝**不在** JSON 上，而是关闭帧。
    await check('a wrong token closes the socket with 4403', async () => {
      const intruder = new Link(url)
      await intruder.opened()
      intruder.send(encodeRelayHello('client', ROOM, 'not-the-token-at-all-x'))
      await intruder.until(() => intruder.closeCode !== 0, 'the close frame')
      equal(intruder.closeCode, 4403, 'close code')
      equal(intruder.closeReason, 'bad token', 'close reason')
      equal(describeRelayClose(intruder.closeCode, intruder.closeReason).kind, 'error', 'kind')
    })

    await check('a binary first message closes the socket with 4400', async () => {
      const intruder = new Link(url)
      await intruder.opened()
      intruder.sendBytes(new Uint8Array([1, 2, 3]))
      await intruder.until(() => intruder.closeCode !== 0, 'the close frame')
      equal(intruder.closeCode, 4400, 'close code')
    })

  } finally {
    relay.stop()
  }

  if (failures > 0) {
    process.stderr.write(`${failures} relay contract checks failed\n`)
    process.exit(1)
  }
  process.stdout.write('ALL RELAY CONTRACT CHECKS PASS (against the real relay)\n')
}

void main()
