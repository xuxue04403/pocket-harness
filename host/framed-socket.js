// Length-prefixed framing over a raw TCP socket.
//
// Every frame on the wire is `[uint32 big-endian length][payload]`, matching
// packages/dsh_link/lib/src/transport/socket_transport.dart. The frame handler is
// swappable on purpose: the link reads one plaintext hello frame itself and only
// then hands the socket to the secure channel, without ever dropping bytes in
// between (the swap happens inside the data handler, so it is atomic with
// respect to the socket's delivery order).

import { EventEmitter } from 'node:events'

/** Largest frame either side accepts, mirroring the Dart constant. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024 + 64

export class FramedSocket extends EventEmitter {
  #socket
  #buffer = Buffer.alloc(0)
  #handler = null
  #closed = false
  #failure = null

  constructor(socket) {
    super()
    this.#socket = socket
    socket.setNoDelay(true)
    socket.on('data', chunk => this.#onData(chunk))
    socket.on('error', error => this.#fail(error))
    socket.on('close', () => this.#fail(new Error('the peer closed the connection')))
  }

  /** Why the link failed, when it failed rather than being closed locally. */
  get failure() {
    return this.#failure
  }

  get closed() {
    return this.#closed
  }

  /**
   * Replaces the frame handler.
   *
   * Called with one complete frame payload at a time; [handler] receives a Buffer
   * that is only valid for the duration of the call.
   */
  onFrame(handler) {
    this.#handler = handler
  }

  onClose(handler) {
    this.once('close', handler)
  }

  /** Sends one frame, prefixing its length. */
  send(frame) {
    if (this.#closed) throw new Error('the socket transport is closed')
    const header = Buffer.allocUnsafe(4)
    header.writeUInt32BE(frame.length, 0)
    this.#socket.write(header)
    this.#socket.write(frame)
  }

  #onData(chunk) {
    if (this.#closed) return
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0)
      if (length > MAX_FRAME_BYTES) {
        this.#fail(new Error(`an inbound frame of ${length} bytes exceeds the limit`))
        return
      }
      if (this.#buffer.length - 4 < length) return
      const frame = this.#buffer.subarray(4, 4 + length)
      this.#buffer = this.#buffer.subarray(4 + length)
      try {
        this.#handler?.(frame)
      } catch (error) {
        this.#fail(error)
        return
      }
    }
  }

  #fail(error) {
    if (this.#closed) return
    this.#failure = error
    this.#closed = true
    this.emit('close', error)
  }

  /** Closes the link. Idempotent. */
  async close() {
    if (this.#closed) {
      this.#socket.destroy()
      return
    }
    this.#closed = true
    this.#socket.destroy()
    this.emit('close', null)
  }
}
