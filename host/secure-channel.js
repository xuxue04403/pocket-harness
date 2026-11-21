// Secure channel: the Noise handshake plus sealed, fragmented payloads on top of
// one framed transport.
//
// This is the Host-side twin of packages/dsh_link/lib/src/transport/secure_channel.dart.
// Both sides always run the same state machine; only the Noise role differs, and
// the routing rules below (handshake frames while the handshake is open, sealed
// or fragmented frames after) are what keep the two ends in lockstep.

import { EventEmitter } from 'node:events'

import { Fragment, FRAME_KIND, Reassembler, decodeFrame, encodeFrame } from './frames.js'

/**
 * Runs the handshake over [transport] and then seals/unseals payloads.
 *
 * `transport` must expose `onFrame(callback)`, `send(buffer)` and `close()`.
 */
export class SecureChannel extends EventEmitter {
  #session
  #transport
  #reassembler = new Reassembler()
  #nextMessageId = 1
  #closed = false
  #established = false
  #readyResolve
  #readyReject
  #ready

  constructor({ transport, session }) {
    super()
    this.#transport = transport
    this.#session = session
    this.#ready = new Promise((resolve, reject) => {
      this.#readyResolve = resolve
      this.#readyReject = reject
    })
    // Swallow the rejection: callers that care await `ready`, and the channel
    // also emits 'error' so nobody is left with an unhandled rejection.
    this.#ready.catch(() => {})
    // Frames are not claimed here: the link owns the transport's handler so it
    // can read the plaintext hello first, then hand everything to `acceptFrame`.
    transport.onClose?.(error => this.#fail(error ?? new Error('the transport closed')))
  }

  /**
   * Feeds one frame from the transport.
   *
   * The link calls this instead of the transport calling the channel directly, so
   * frames that arrived while admission was still running are replayed in order
   * rather than lost.
   */
  acceptFrame(frame) {
    this.#onFrame(frame)
  }

  /** Completes when the handshake finished, or rejects with the failure. */
  get ready() {
    return this.#ready
  }

  get established() {
    return this.#established && !this.#closed
  }

  /** Transport bytes sent so far — useful for link accounting on the phone. */
  get sendingCounter() {
    return this.#session.sendingCounter
  }

  /** Starts the handshake. The responder waits for message one instead. */
  start({ payload } = {}) {
    if (this.#session.complete) {
      this.#completeHandshake()
      return
    }
    if (this.#session.canWriteHandshake) {
      const message = payload === undefined
        ? this.#session.writeHandshakeMessage()
        : this.#session.writeHandshakeMessage(payload)
      this.#transport.send(encodeFrame(FRAME_KIND.handshake, message))
      if (this.#session.complete) this.#completeHandshake()
    }
  }

  /** Seals one application message, fragmenting when it is too large. */
  send(plaintext) {
    if (this.#closed) throw new Error('the secure channel is closed')
    if (!this.#session.complete) throw new Error('the secure channel is not established')
    const sealed = this.#session.encrypt(plaintext)
    const fragments = Fragment.split(sealed, this.#nextMessageId)
    if (fragments.length === 0) {
      this.#transport.send(encodeFrame(FRAME_KIND.secure, sealed))
      return
    }
    this.#nextMessageId = this.#nextMessageId >= 0xffffffff ? 1 : this.#nextMessageId + 1
    for (const fragment of fragments) {
      this.#transport.send(encodeFrame(FRAME_KIND.fragment, fragment.encode()))
    }
  }

  #onFrame(bytes) {
    if (this.#closed) return
    try {
      const frame = decodeFrame(bytes)
      if (!this.#session.complete) {
        this.#onHandshakeFrame(frame)
        return
      }
      switch (frame.kind) {
        case FRAME_KIND.secure:
          this.#emit(this.#session.decrypt(frame.payload))
          return
        case FRAME_KIND.fragment: {
          const whole = this.#reassembler.accept(Fragment.decode(frame.payload))
          if (whole !== null) this.#emit(this.#session.decrypt(whole))
          return
        }
        case FRAME_KIND.control:
          // Control frames belong to the transport, not the channel.
          return
        case FRAME_KIND.handshake:
          throw new Error('received a handshake frame after the handshake completed')
      }
    } catch (error) {
      this.#fail(error)
    }
  }

  #onHandshakeFrame(frame) {
    if (frame.kind !== FRAME_KIND.handshake) {
      throw new Error(`expected a handshake frame, got kind ${frame.kind}`)
    }
    if (this.#session.isWriteTurn) {
      throw new Error('received a handshake frame while it was our turn to write')
    }
    const payload = this.#session.readHandshakeMessage(frame.payload)
    if (payload.length > 0) this.#emit(payload)
    if (this.#session.complete) {
      this.#completeHandshake()
    } else if (this.#session.canWriteHandshake) {
      this.#transport.send(encodeFrame(FRAME_KIND.handshake, this.#session.writeHandshakeMessage()))
      if (this.#session.complete) this.#completeHandshake()
    }
  }

  #completeHandshake() {
    if (this.#established) return
    this.#established = true
    this.#readyResolve()
    this.emit('established')
  }

  #emit(plaintext) {
    if (this.#closed) return
    this.emit('message', plaintext)
  }

  #fail(error) {
    if (this.#closed) return
    if (!this.#established) this.#readyReject(error)
    this.emit('error', error)
    void this.close()
  }

  async close() {
    if (this.#closed) return
    this.#closed = true
    this.#session.destroy()
    await this.#transport.close()
    this.emit('close')
  }
}
