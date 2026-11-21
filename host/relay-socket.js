// The Host's byte pipe through a relay, shaped like FramedSocket.
//
// A relay connection is a WebSocket whose binary messages are already one frame
// each, so unlike a TCP socket there is nothing to re-frame: every binary message
// is handed to the frame handler whole. The relay never inspects those bytes; it
// only matches a room name, which is why the Host can sit behind NAT with no
// inbound port and still be reachable.
//
// Built on the WebSocket that both node 22+ and the Harness's Electron runtime
// provide globally, so the plugin ships with no runtime dependency at all.

import { EventEmitter } from 'node:events'

/** Largest frame either side accepts, mirroring the Dart constant. */
export const MAX_RELAY_FRAME_BYTES = 4 * 1024 * 1024 + 64

export class RelaySocket extends EventEmitter {
  #socket
  #closed = false
  #failure = null
  #handler = null

  constructor(socket) {
    super()
    this.#socket = socket
    socket.addEventListener('message', event => this.#onMessage(event.data))
    socket.addEventListener('close', event => {
      // 1000 and 1001 are the two ends saying goodbye; anything else is a fault.
      if (event.code === 1000 || event.code === 1001) {
        this.#fail(null)
        return
      }
      this.#fail(new Error(`the relay closed the link (${event.code} ${event.reason ?? ''})`.trim()))
    })
    socket.addEventListener('error', () => {
      this.#fail(new Error('the relay connection failed'))
    })
  }

  get failure() {
    return this.#failure
  }

  get closed() {
    return this.#closed
  }

  /** Replaces the frame handler, exactly as FramedSocket does. */
  onFrame(handler) {
    this.#handler = handler
  }

  onClose(handler) {
    this.once('close', handler)
  }

  send(frame) {
    if (this.#closed) throw new Error('the relay transport is closed')
    if (frame.length > MAX_RELAY_FRAME_BYTES) {
      throw new Error(`a frame of ${frame.length} bytes exceeds the relay limit`)
    }
    this.#socket.send(frame)
  }

  #onMessage(data) {
    if (this.#closed) return
    if (typeof data === 'string') {
      // Control notices carry pairing state, never payload bytes.
      if (data.includes('peer-gone')) {
        this.#fail(new Error('the phone left the relay'))
        return
      }
      // The relay answers the hello with an ack, then — only once a phone is in
      // the room too — a separate "ready". A Host can legitimately sit in an
      // empty room for hours, so joining and pairing must be distinguishable.
      if (data.includes('"ok":true')) this.emit('joined')
      if (data.includes('"ready"')) this.emit('ready')
      return
    }
    const frame = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data.buffer ?? data)
    if (frame.length > MAX_RELAY_FRAME_BYTES) {
      this.#fail(new Error(`an inbound frame of ${frame.length} bytes exceeds the limit`))
      return
    }
    try {
      this.#handler?.(frame)
    } catch (error) {
      this.#fail(error)
    }
  }

  #fail(error) {
    if (this.#closed) return
    this.#failure = error
    this.#closed = true
    // The relay still thinks this peer occupies the room until the socket is
    // really closed. Leaving it open would keep a zombie host in the room, so no
    // later dial could take the slot and no phone could ever pair again.
    try {
      this.#socket.close(1000, 'closed')
    } catch {
      // A socket that already failed needs no further cleanup.
    }
    this.emit('close', error)
  }

  async close() {
    if (this.#closed) return
    this.#closed = true
    try {
      this.#socket.close(1000, 'done')
    } catch {
      // A socket that already failed needs no further cleanup.
    }
    this.emit('close', null)
  }
}
