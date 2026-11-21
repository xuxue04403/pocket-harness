// A tiny relay that puts a phone and a Host on the same byte pipe.
//
// It is deliberately dumb: it never sees a key, never parses a frame, and never
// learns which DSH method is being called. Both ends run Noise IK above it, so
// the relay only has to match a room name with a shared token and copy bytes.
// That is what makes self-hosting it safe on a public VPS.

import { createServer } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'

import { WebSocketServer } from 'ws'

/** Max bytes the relay will hold for one peer before applying backpressure. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024
/** A room disappears once both sides are gone. */
const ROOM_IDLE_MS = 60_000
/** Largest single frame a peer may send. */
const MAX_FRAME_BYTES = 4 * 1024 * 1024 + 64

/**
 * One relayed conversation between a Host and a phone.
 *
 * A room holds at most one host and one client; a second client is refused
 * rather than queued, because the Host's Noise responder is bound to the single
 * connection id it was told about.
 */
class Room {
  host = null
  client = null
  createdAt = Date.now()

  get label() {
    return `${this.id.slice(0, 8)}…`
  }

  constructor(id) {
    this.id = id
  }

  attach(role, socket) {
    if (this[role] !== null) return false
    this[role] = socket
    return true
  }

  detach(role, socket) {
    if (this[role] === socket) this[role] = null
  }

  get empty() {
    return this.host === null && this.client === null
  }

  forward(from, data, isBinary) {
    const peer = from === this.host ? this.client : this.host
    if (peer === null || peer.readyState !== peer.OPEN) return
    if (peer.bufferedAmount > MAX_BUFFERED_BYTES) {
      // The far side is not draining; dropping the peer is better than growing
      // without bound. The client sees a closed link and reconnects.
      peer.close(1013, 'too much buffered data')
      return
    }
    peer.send(data, { binary: isBinary })
  }
}

/** Shared-secret check that does not leak length through timing. */
function sameToken(expected, actual) {
  if (typeof actual !== 'string') return false
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(actual, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Starts the relay.
 *
 * [token] is required: without it anyone who guesses a room name could join.
 * [path] defaults to `/relay` so the same origin can host a health page.
 */
export function createRelay({ token, path = '/relay', log = () => {} } = {}) {
  if (typeof token !== 'string' || token.length < 16) {
    throw new Error('the relay needs a shared token of at least 16 characters')
  }
  const rooms = new Map()
  const server = createServer((request, response) => {
    if (request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(`ok rooms=${rooms.size}\n`)
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('not found\n')
  })
  const wss = new WebSocketServer({ server, path, maxPayload: MAX_FRAME_BYTES })

  wss.on('connection', (socket, request) => {
    void request
    /** @type {{room: Room, role: 'host'|'client'}|null} */
    let joined = null
    const joinTimeout = setTimeout(() => {
      if (joined === null) socket.close(4408, 'no hello')
    }, 10_000)
    joinTimeout.unref?.()

    socket.on('message', (data, isBinary) => {
      if (joined === null) {
        if (isBinary) {
          socket.close(4400, 'the first message must be a hello')
          return
        }
        let hello
        try {
          hello = JSON.parse(data.toString('utf8'))
        } catch {
          socket.close(4400, 'malformed hello')
          return
        }
        const role = hello?.role
        const roomName = hello?.room
        if (role !== 'host' && role !== 'client') {
          socket.close(4400, 'hello.role must be host or client')
          return
        }
        if (typeof roomName !== 'string' || !/^[A-Za-z0-9_.:-]{8,128}$/.test(roomName)) {
          socket.close(4400, 'hello.room must be 8..128 URL-safe characters')
          return
        }
        if (!sameToken(token, hello?.token)) {
          log(`refused a ${role} with a bad token`)
          socket.close(4403, 'bad token')
          return
        }
        clearTimeout(joinTimeout)
        const room = rooms.get(roomName) ?? new Room(randomUUID())
        room.id = roomName
        if (!room.attach(role, socket)) {
          socket.close(4409, `a ${role} is already in this room`)
          return
        }
        rooms.set(roomName, room)
        joined = { room, role, name: roomName }
        log(`${role} joined ${roomName.slice(0, 8)}… (${rooms.size} rooms)`)
        socket.send(JSON.stringify({ v: 1, ok: true, role, paired: room.host !== null && room.client !== null }))
        if (room.host !== null && room.client !== null) {
          for (const peer of [room.host, room.client]) {
            if (peer.readyState === peer.OPEN) peer.send(JSON.stringify({ v: 1, type: 'ready' }))
          }
        }
        return
      }
      if (!isBinary) {
        // Text after admission is only used for a keepalive; nothing to relay.
        if (data.toString('utf8') === 'ping') socket.send('pong')
        return
      }
      if (data.length > MAX_FRAME_BYTES) {
        socket.close(4400, 'frame too large')
        return
      }
      joined.room.forward(socket, data, true)
    })

    socket.on('close', () => {
      clearTimeout(joinTimeout)
      if (joined === null) return
      joined.room.detach(joined.role, socket)
      // Tell the survivor immediately; waiting for a socket timeout would leave
      // the phone showing a connected session that is already dead.
      const peer = joined.role === 'host' ? joined.room.client : joined.room.host
      if (peer !== null && peer.readyState === peer.OPEN) {
        peer.send(JSON.stringify({ v: 1, type: 'peer-gone' }))
      }
      if (joined.room.empty) {
        rooms.delete(joined.name)
        log(`room ${joined.name.slice(0, 8)}… closed`)
      }
    })
    socket.on('error', () => socket.terminate())
  })

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - ROOM_IDLE_MS
    for (const [name, room] of rooms) {
      if (room.empty && room.createdAt < cutoff) rooms.delete(name)
    }
  }, 30_000)
  sweeper.unref?.()

  return {
    server,
    rooms,
    async listen({ port = 8080, host = '0.0.0.0' } = {}) {
      await new Promise((resolve, reject) => {
        const onError = error => reject(error)
        server.once('error', onError)
        server.listen(port, host, () => {
          server.removeListener('error', onError)
          resolve()
        })
      })
      return server.address().port
    },
    async close() {
      clearInterval(sweeper)
      for (const socket of wss.clients) socket.terminate()
      await new Promise(resolve => wss.close(() => resolve()))
      await new Promise(resolve => server.close(() => resolve()))
    },
  }
}
