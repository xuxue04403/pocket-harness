// 从公网侧走一遍真实链路：relay（VPS 443）→ 本机 Host → Noise 握手 → rpc。
//
// 与 live.mjs 的区别在于传输层：那里走局域网 TCP，这里走 wss://<domain>/ph-relay。
// 票据直接从运行中的 Host 的 /api/pocket-harness/pair?format=json 取，那才是手机
// 扫码时真正拿到的内容（含 relay/room/rtok）。
//
// 用法：
//   node probe/relay-e2e.mjs [pair-json-url]
//
// 默认从 POCKET_HARNESS_PAIR_URL 读；没有的话按 DSH_WEB_PORT / 61038 拼本机地址。
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const build = await import('file:///' + path.join(root, 'packages/dsh_arkts/build/index.mjs').replace(/\\/g, '/'))
const {
  decodeTicket,
  identityFromPrivateKey,
  newDeviceIdentity,
  LinkClient,
  FrameSplitter,
  frameWithLength,
} = build

const WebSocket = (await import('file:///' + path.join(root, 'relay/node_modules/ws/index.js').replace(/\\/g, '/'))).default

const pairUrl = process.argv[2]
  ?? process.env.POCKET_HARNESS_PAIR_URL
  ?? `http://127.0.0.1:${process.env.POCKET_HARNESS_WEB_PORT ?? '61038'}/api/pocket-harness/pair?format=json`

const get = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => {
    let body = ''
    res.on('data', (chunk) => (body += chunk))
    res.on('end', () => resolve({ status: res.statusCode, body }))
  }).on('error', reject)
})

const response = await get(pairUrl)
if (response.status !== 200) {
  console.error(`the Host answered ${response.status}`)
  process.exit(1)
}
const snapshot = JSON.parse(response.body)
const ticket = decodeTicket(snapshot.ticket)
console.log(`ticket -> ${ticket.hostName}, relay ${ticket.relayUrl}, room ${String(ticket.relayRoom).slice(0, 8)}…`)

// 每次用一个新设备身份，避免干扰已配对的手机；配对码里的 secret 让它能直接进来。
const fill = (length) => new Uint8Array(randomBytes(length))
const identity = newDeviceIdentity(fill)

/** 一条 WebSocket 之上的帧管道，形状与 RelaySocket 一致。 */
function openRelayTransport(relayTicket) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(relayTicket.relayUrl)
    socket.binaryType = 'arraybuffer'
    let frameHandler = () => {}
    let closeHandler = () => {}
    let settled = false
    const transport = {
      onFrame: (handler) => { frameHandler = handler },
      onClose: (handler) => { closeHandler = handler },
      send: (frame) => socket.send(frame),
      close: () => socket.close(1000, 'done'),
    }
    socket.on('open', () => {
      socket.send(JSON.stringify({ v: 1, role: 'client', room: relayTicket.relayRoom, token: relayTicket.relayToken }))
    })
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        frameHandler(Buffer.from(data))
        return
      }
      const control = JSON.parse(data.toString('utf8'))
      if (control.type === 'ready' && !settled) {
        settled = true
        resolve(transport)
      }
      if (control.type === 'peer-gone') {
        closeHandler()
      }
    })
    socket.on('close', (code, reason) => {
      if (!settled) {
        settled = true
        reject(new Error(`the relay closed before the peer arrived (${code} ${reason})`))
        return
      }
      closeHandler()
    })
    socket.on('error', (error) => {
      if (!settled) {
        settled = true
        reject(error)
      }
    })
  })
}

const client = await LinkClient.handshake({
  ticket,
  identity,
  random: fill,
  connectionId: newDeviceIdentity(fill).deviceId,
  transport: await openRelayTransport(ticket),
  timeoutMs: 20_000,
  route: 'relay',
  endpoint: ticket.relayUrl,
  heartbeat: true,
})

console.log('handshake over the relay succeeded')
const list = await client.rpc.call('session/list', { _request: {} }, 20_000)
const items = Array.isArray(list['items']) ? list['items'] : []
console.log(`session/list -> ${items.length} sessions`)

client.close()
console.log('THE PHONE CAN REACH THIS HOST THROUGH THE PUBLIC RELAY')
process.exit(0)
