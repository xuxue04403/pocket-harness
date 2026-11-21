// 真实链路验证：TypeScript 客户端连上运行中的 Harness。
//
// 这一步是整份 TypeScript 核心存在的理由 —— 只有当它能和真正的 Host 完成
// Noise 握手并跑通业务调用，鸿蒙侧的移植才是可信的。

import { connect } from 'node:net'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

import { decodeBase64Url } from '../src/bytes'
import { identityFromPrivateKey } from '../src/identity'
import { decodeTicket } from '../src/pairing'
import { NoiseIkSession, createNoisePrologue } from '../src/noise'
import { SecureChannel } from '../src/secure_channel'
import { RpcClient } from '../src/rpc'
import { encodeHello, encodeProof } from '../src/link_protocol'
import { FRAME_KIND, encodeFrame, decodeFrame } from '../src/wire'

interface TcpTransport {
  send(frame: Uint8Array): void
  close(): void
  onFrame(handler: (frame: Uint8Array) => void): void
  onClose(handler: () => void): void
}

function openTcp(host: string, port: number, timeoutMs: number): Promise<TcpTransport> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port })
    let buffer = Buffer.alloc(0)
    let frameHandler: ((frame: Uint8Array) => void) | null = null
    let closeHandler: (() => void) | null = null

    socket.setNoDelay(true)
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('the socket went quiet')))

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (buffer.length < 4) return
        const length = buffer.readUInt32BE(0)
        if (buffer.length < 4 + length) return
        const payload = new Uint8Array(buffer.subarray(4, 4 + length))
        buffer = buffer.subarray(4 + length)
        frameHandler?.(payload)
      }
    })
    socket.on('close', () => closeHandler?.())
    socket.once('error', reject)

    socket.once('connect', () => {
      socket.setTimeout(0)
      resolve({
        send(frame) {
          const header = Buffer.alloc(4)
          header.writeUInt32BE(frame.length, 0)
          socket.write(Buffer.concat([header, Buffer.from(frame)]))
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

  const endpoint = ticket.lanEndpoints[0]
  const colon = endpoint.lastIndexOf(':')
  const host = endpoint.slice(0, colon)
  const port = Number(endpoint.slice(colon + 1))

  const connectionId = `ts-${Date.now().toString(36)}`
  const transport = await openTcp(host, port, 15_000)
  console.log(`tcp connected to ${host}:${port}`)

  // 明文 hello 必须是第一帧，且必须先把应答读掉再交给安全通道。
  const helloAnswered = new Promise<Uint8Array>((resolve) => {
    transport.onFrame((frame) => resolve(frame))
  })
  const proof = ticket.pairingSecret === null
    ? undefined
    : encodeProof(ticket.pairingSecret, connectionId, identity.deviceId)
  transport.send(encodeFrame({
    kind: FRAME_KIND.control,
    payload: encodeHello({ v: 1, connection: connectionId, client: identity.deviceId, ...(proof === undefined ? {} : { proof }) }),
  }))

  const replyFrame = decodeFrame(await helloAnswered)
  const reply = JSON.parse(new TextDecoder().decode(replyFrame.payload)) as Record<string, unknown>
  if (reply.accepted !== true) throw new Error(`the Host refused the link: ${String(reply.reason)}`)
  console.log(`hello accepted as ${String(reply.name)}`)

  const session = new NoiseIkSession({
    role: 'initiator',
    localPrivateKey: identity.privateKey,
    localPublicKey: identity.publicKey,
    remotePublicKey: ticket.hostPublicKey,
    prologue: createNoisePrologue(connectionId, ticket.hostDeviceId, identity.deviceId),
    random: (length) => new Uint8Array(randomBytes(length)),
  })

  // 通道与 RPC 互相引用：消息进来要先解密再交给 RPC，所以用一次可变引用打通。
  let rpc: RpcClient | null = null
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the Noise handshake did not complete in time')), 15_000)
    const channel = new SecureChannel({
      transport,
      session,
      onEstablished: () => {
        clearTimeout(timer)
        resolve()
      },
      onMessage: (plaintext) => rpc?.accept(plaintext),
      onError: (error) => {
        clearTimeout(timer)
        reject(error)
      },
    })
    rpc = new RpcClient({ channel })
    channel.start()
  })
  await ready
  console.log('noise handshake complete')

  const client = rpc as RpcClient
  const list = await client.call('session/list', { _request: {} })
  const items = Array.isArray(list.items) ? list.items : []
  console.log(`session/list -> ${items.length} sessions`)
  if (items.length === 0) throw new Error('the Host answered with no sessions; is this the right profile?')

  const first = items[0] as Record<string, unknown>
  console.log(`first session ${String(first.sessionId).slice(0, 8)}… updated ${String(first.updatedAt)}`)

  // 流式端点也验一次：job/list 首帧即整集，流不会自己结束。
  for await (const frame of client.openStream('job/list', { request: { sessionId: first.sessionId } }, { timeoutMs: 20_000 })) {
    const jobs = Array.isArray(frame.jobs) ? frame.jobs : []
    console.log(`job/list -> ${jobs.length} jobs (stream opened and read)`)
    break
  }

  transport.close()
  console.log('\nTYPESCRIPT CLIENT TALKS TO THE REAL HOST')
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    process.exit(1)
  },
)
