// The Host's outbound dial to a relay.
//
// This is what makes a relay usable from behind NAT: the Host opens the socket,
// so it needs no inbound port, no port forwarding and no public address. The
// dial is retried with backoff because a phone can arrive at any time and the
// room only exists while the Host is in it.
//
// Uses the WebSocket that both node 22+ and the Harness's Electron runtime
// provide, so nothing has to be installed beside the plugin.

import { RelaySocket } from './relay-socket.js'

/** How long to wait before retrying a dropped relay dial. */
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000]

/** A relay that never answers within this is treated as unreachable. */
const HANDSHAKE_TIMEOUT_MS = 15_000

/**
 * Keeps one Host joined to one relay room.
 *
 * `onTransport` is called with a fresh [RelaySocket] each time the room is
 * paired with a phone. After that link ends the dialer re-joins, so the next
 * phone can connect. Only one relay link exists at a time, because the room
 * holds one host.
 */
export class RelayDialer {
  #url
  #room
  #token
  #onTransport
  #logger
  #socket = null
  #relay = null
  #timer = null
  #closed = false
  #served = 0

  constructor({ url, room, token, onTransport, logger = null }) {
    this.#url = url
    this.#room = room
    this.#token = token
    this.#onTransport = onTransport
    this.#logger = logger
  }

  get connected() {
    return this.#relay !== null && !this.#relay.closed
  }

  /** How many phones this dialer has handed to the link server. */
  get served() {
    return this.#served
  }

  start() {
    if (this.#closed) throw new Error('the relay dialer is closed')
    this.#join()
  }

  #join() {
    if (this.#closed) return
    let socket
    try {
      socket = new WebSocket(this.#url)
    } catch (error) {
      this.#logger?.warn?.(`pocket-harness: bad relay address (${error.message})`)
      this.#scheduleRejoin()
      return
    }
    socket.binaryType = 'arraybuffer'
    this.#socket = socket
    let joined = false
    const relay = new RelaySocket(socket)
    this.#relay = relay

    // Waiting for a phone is the normal state, not a timeout: the room can stay
    // empty for hours. Only the *join* has a deadline.
    const timer = setTimeout(() => {
      if (!joined) {
        this.#logger?.warn?.('pocket-harness: the relay did not answer in time')
        try {
          socket.close(1000, 'timeout')
        } catch {
          // Already gone.
        }
      }
    }, HANDSHAKE_TIMEOUT_MS)
    timer.unref?.()

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ v: 1, role: 'host', room: this.#room, token: this.#token }))
      this.#logger?.info?.('pocket-harness: joined the relay room')
    })
    relay.on('joined', () => {
      joined = true
      clearTimeout(timer)
    })
    relay.on('ready', () => {
      joined = true
      clearTimeout(timer)
      this.#served += 1
      this.#logger?.info?.('pocket-harness: relay paired with a phone')
      try {
        this.#onTransport(relay)
      } catch (error) {
        this.#logger?.warn?.(`pocket-harness: relay handoff failed (${error.message})`)
        void relay.close()
      }
    })
    relay.on('close', error => {
      clearTimeout(timer)
      if (this.#relay === relay) this.#relay = null
      if (this.#socket === socket) this.#socket = null
      if (error !== null && error !== undefined && !this.#closed) {
        this.#logger?.info?.(`pocket-harness: relay link closed (${error.message})`)
      }
      this.#scheduleRejoin()
    })
  }

  #scheduleRejoin() {
    if (this.#closed || this.#timer !== null) return
    const delay = RETRY_DELAYS_MS[0]
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.#join()
    }, delay)
    this.#timer.unref?.()
  }

  async close() {
    this.#closed = true
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null
    const relay = this.#relay
    this.#relay = null
    if (relay !== null) await relay.close()
    try {
      this.#socket?.close(1000, 'done')
    } catch {
      // A socket that already failed needs no further cleanup.
    }
    this.#socket = null
  }
}
