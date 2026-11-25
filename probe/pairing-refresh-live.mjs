import { randomBytes } from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const build = await import('file:///' + path.join(root, 'packages/dsh_arkts/build/index.mjs').replace(/\\/g, '/'))
const { decodeTicket, newDeviceIdentity, LinkClient, decodeBase64Url } = build
const WebSocket = (await import('file:///' + path.join(root, 'relay/node_modules/ws/index.js').replace(/\\/g, '/'))).default

const get = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })) }).on('error', reject)
})

const port = process.env.POCKET_HARNESS_WEB_PORT ?? process.argv[2] ?? '57597'
const res = await get(`http://127.0.0.1:${port}/api/pocket-harness/pair?format=json`)
const snapshot = JSON.parse(res.body)
const ticket = decodeTicket(snapshot.ticket)
const fill = (n) => new Uint8Array(randomBytes(n))
const identity = newDeviceIdentity(fill)

function openRelayTransport(t) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(t.relayUrl)
    socket.binaryType = 'arraybuffer'
    let frameHandler = () => {}
    let closeHandler = () => {}
    let settled = false
    const transport = { onFrame: (h) => { frameHandler = h }, onClose: (h) => { closeHandler = h }, send: (f) => socket.send(f), close: () => socket.close(1000, 'done') }
    socket.on('open', () => socket.send(JSON.stringify({ v: 1, role: 'client', room: t.relayRoom, token: t.relayToken })))
    socket.on('message', (data, isBinary) => {
      if (isBinary) { frameHandler(Buffer.from(data)); return }
      const control = JSON.parse(data.toString('utf8'))
      if (control.type === 'ready' && !settled) { settled = true; resolve(transport) }
      if (control.type === 'peer-gone') closeHandler()
    })
    socket.on('close', (code, reason) => { if (!settled) { settled = true; reject(new Error(`closed ${code} ${reason}`)) } else closeHandler() })
    socket.on('error', (e) => { if (!settled) { settled = true; reject(e) } })
  })
}

const client = await LinkClient.handshake({
  ticket, identity, random: fill, connectionId: newDeviceIdentity(fill).deviceId,
  transport: await openRelayTransport(ticket), timeoutMs: 20000, route: 'relay', endpoint: ticket.relayUrl, heartbeat: true,
})
console.log('connected over relay')

const refreshed = await client.rpc.call('pocketPairing/refresh', {}, 20000)
const fresh = decodeTicket(refreshed.ticket)
const hours = (Date.parse(refreshed.expiresAt) - Date.now()) / 3600000
console.log('refresh ->', {
  hasRelay: fresh.relayUrl !== null && fresh.relayRoom !== null && fresh.relayToken !== null,
  secretPresent: fresh.pairingSecret !== null && fresh.pairingSecret !== undefined && fresh.pairingSecret.length > 0,
  lanEndpoints: fresh.lanEndpoints?.length ?? 0,
  sameHost: fresh.hostDeviceId === ticket.hostDeviceId,
  hoursLeft: Math.round(hours),
})
client.close()
console.log('PAIRED TICKET REFRESH WORKS OVER THE RELAY')
process.exit(0)
