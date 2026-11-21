// Business RPC over the secure channel.
//
// The phone never learns what an endpoint means: it forwards `namespace/method`
// plus JSON args, and this Host hands them to the real Typert gateway. Everything
// below is transport plumbing — correlation ids, timeouts, cancellation and the
// stream multiplexer — so a new DSH feature needs no code here at all.

import { EventEmitter } from 'node:events'

import {
  decodeEnvelope,
  encodeEnvelope,
  envelope,
  errorEnvelope,
  eventEnvelope,
  responseEnvelope,
} from './envelope.js'

/** How many streams one link may have open at once. */
export const MAX_STREAMS = 16

/**
 * Serves business calls arriving on one secure channel.
 *
 * `gateway` is `{ invoke(request), stream(request) }` and `peer` is the live
 * PeerScope those calls are attributed to; both come from the Host plugin, which
 * keeps this class testable without a running Harness.
 */
export class RpcServer extends EventEmitter {
  #channel
  #gateway
  #peer
  #streams = new Map()
  #nextStreamId = 1
  #closed = false
  #inflight = new Set()

  constructor({ channel, gateway, peer }) {
    super()
    this.#channel = channel
    this.#gateway = gateway
    this.#peer = peer
    channel.on('message', bytes => this.#onMessage(bytes))
    channel.on('error', error => this.#shutdown(error))
    channel.on('close', () => this.#shutdown(new Error('the secure channel closed')))
  }

  get openStreams() {
    return this.#streams.size
  }

  async #onMessage(bytes) {
    if (this.#closed) return
    let decoded
    try {
      decoded = decodeEnvelope(bytes)
    } catch (error) {
      this.emit('protocol-error', error)
      return
    }
    if (decoded.type === 'ping') {
      this.#send(envelope({ type: 'pong', payload: decoded.payload }))
      return
    }
    if (decoded.type !== 'request') return
    const id = decoded.id
    if (typeof id !== 'string') {
      this.emit('protocol-error', new Error('a request envelope has no id'))
      return
    }
    const task = this.#handleRequest(id, decoded.payload).catch(error => {
      this.emit('handler-error', error)
    })
    this.#inflight.add(task)
    task.finally(() => this.#inflight.delete(task))
  }

  async #handleRequest(id, payload) {
    if (payload === null || typeof payload !== 'object') {
      this.#sendError(id, 'PROTOCOL_ERROR', 'the request payload must be an object')
      return
    }
    const endpoint = payload.endpoint
    if (typeof endpoint !== 'string' || endpoint.length === 0) {
      this.#sendError(id, 'PROTOCOL_ERROR', 'the request has no endpoint')
      return
    }
    const args = payload.payload?.args
    if (args !== undefined && (args === null || typeof args !== 'object')) {
      this.#sendError(id, 'PROTOCOL_ERROR', 'the request args must be an object')
      return
    }
    // `stream.open` / `stream.close` are link control, not DSH endpoints.
    if (endpoint === 'link/stream.open') {
      this.#openStream(id, args)
      return
    }
    if (endpoint === 'link/stream.close') {
      this.#closeStream(id, args)
      return
    }
    // Gateway-internal names (`$events`, `$events/result`) bypass the business
    // dispatcher: the Typert gateway owns them, and `$events` has no slash pair.
    if (isGatewayEndpoint(endpoint)) {
      await this.#invokeGatewayEndpoint(id, endpoint, args)
      return
    }
    const split = splitEndpoint(endpoint)
    if (split === null) {
      this.#sendError(id, 'PROTOCOL_ERROR', `the endpoint ${endpoint} is not namespace/method`)
      return
    }
    try {
      const value = await this.#gateway.invoke({
        namespace: split.namespace,
        method: split.method,
        args: args ?? {},
        peer: this.#peer,
      })
      this.#sendResponse(id, value === undefined ? {} : value)
    } catch (error) {
      this.#sendFailure(id, error)
    }
  }

  /** Calls a Gateway-internal unary endpoint, which returns `{ok, value|error}`. */
  async #invokeGatewayEndpoint(id, endpoint, args) {
    if (typeof this.#gateway.dispatch !== 'function') {
      this.#sendError(id, 'UNSUPPORTED', 'this Host does not expose gateway endpoints')
      return
    }
    const result = await this.#gateway.dispatch(endpoint, { args: args ?? {} })
    if (result?.ok === true) {
      this.#sendResponse(id, result.value === undefined ? {} : result.value)
      return
    }
    const error = result?.error ?? {}
    this.#sendError(
      id,
      typeof error.code === 'string' ? error.code : 'HOST_ERROR',
      typeof error.message === 'string' ? error.message : 'the Host rejected the request',
      error.details,
    )
  }

  async #openStream(id, args) {
    if (this.#streams.size >= MAX_STREAMS) {
      this.#sendError(id, 'STREAM_LIMIT', `at most ${MAX_STREAMS} streams may be open`)
      return
    }
    const endpoint = args?.endpoint
    if (typeof endpoint !== 'string') {
      this.#sendError(id, 'PROTOCOL_ERROR', 'stream.open needs an endpoint')
      return
    }
    if (isGatewayEndpoint(endpoint)) {
      await this.#openGatewayStream(id, endpoint, args)
      return
    }
    const split = splitEndpoint(endpoint)
    if (split === null) {
      this.#sendError(id, 'PROTOCOL_ERROR', `the endpoint ${endpoint} is not namespace/method`)
      return
    }
    const aborter = new AbortController()
    let streamId
    try {
      const source = await this.#gateway.stream({
        namespace: split.namespace,
        method: split.method,
        args: args?.args ?? {},
        peer: this.#peer,
        signal: aborter.signal,
      })
      streamId = this.#nextStreamId++
      this.#streams.set(streamId, { aborter, source })
      this.#sendResponse(id, { streamId })
    } catch (error) {
      this.#sendFailure(id, error)
      return
    }
    void this.#pump(streamId, this.#streams.get(streamId))
  }

  /** Opens a Gateway-internal stream such as `$events` through the carrier seam. */
  async #openGatewayStream(id, endpoint, args) {
    if (typeof this.#gateway.open !== 'function') {
      this.#sendError(id, 'UNSUPPORTED', 'this Host does not expose gateway streams')
      return
    }
    const aborter = new AbortController()
    let streamId
    try {
      const source = await this.#gateway.open(endpoint, { args: args?.args ?? {} }, aborter.signal)
      streamId = this.#nextStreamId++
      this.#streams.set(streamId, { aborter, source })
      this.#sendResponse(id, { streamId })
    } catch (error) {
      this.#sendFailure(id, error)
      return
    }
    void this.#pump(streamId, this.#streams.get(streamId))
  }

  async #pump(streamId, record) {
    try {
      for await (const value of record.source) {
        if (this.#closed || !this.#streams.has(streamId)) return
        this.#send(eventEnvelope({ streamId, hasValue: true, value: value === undefined ? null : value }))
      }
      if (this.#streams.delete(streamId)) {
        this.#send(eventEnvelope({ streamId, done: true }))
      }
    } catch (error) {
      if (this.#streams.delete(streamId)) {
        this.#send(eventEnvelope({ streamId, done: true, error: failureOf(error) }))
      }
    }
  }

  #closeStream(id, args) {
    const streamId = args?.streamId
    const record = this.#streams.get(streamId)
    if (record === undefined) {
      this.#sendError(id, 'NO_SUCH_STREAM', `stream ${streamId} is not open`)
      return
    }
    this.#streams.delete(streamId)
    record.aborter.abort(new Error('the client closed the stream'))
    this.#sendResponse(id, {})
  }

  #sendResponse(id, value) {
    this.#send(responseEnvelope(id, value))
  }

  #sendError(id, code, message, details) {
    this.#send(errorEnvelope(id, code, message, details))
  }

  /** Forwards one gateway failure, keeping the code the client can act on. */
  #sendFailure(id, error) {
    const failure = failureOf(error)
    this.#send(errorEnvelope(id, failure.code, failure.message, failure.details))
  }

  #send(envelopeValue) {
    if (this.#closed) return
    try {
      this.#channel.send(encodeEnvelope(envelopeValue))
    } catch (error) {
      this.#shutdown(error)
    }
  }

  async #shutdown(error) {
    if (this.#closed) return
    this.#closed = true
    for (const record of this.#streams.values()) {
      record.aborter.abort(error)
    }
    this.#streams.clear()
    if (error !== undefined) this.emit('closed', error)
  }

  async close() {
    await this.#shutdown(new Error('the RPC server closed'))
    await Promise.allSettled([...this.#inflight])
  }
}

/**
 * True for a Gateway-internal endpoint such as `$events` or `$events/result`.
 *
 * Those names are not business `namespace/method` pairs: the Typert gateway
 * resolves them itself, so they must reach its carrier dispatcher untouched.
 */
export function isGatewayEndpoint(endpoint) {
  return typeof endpoint === 'string' && endpoint.startsWith('$')
}

/** Splits `namespace/method`, rejecting anything else. */
export function splitEndpoint(endpoint) {
  if (typeof endpoint !== 'string') return null
  const parts = endpoint.split('/')
  if (parts.length !== 2) return null
  const [namespace, method] = parts
  if (namespace.length === 0 || method.length === 0) return null
  return { namespace, method }
}

/** Normalizes any thrown value into the shape the phone reports to the user. */
export function failureOf(error) {
  if (error !== null && typeof error === 'object') {
    const code = typeof error.code === 'string' ? error.code : undefined
    const message = typeof error.message === 'string' ? error.message : String(error)
    const details = error.details !== null && typeof error.details === 'object' ? error.details : {}
    if (code !== undefined) return { code, message, details }
    return { code: 'HOST_ERROR', message, details }
  }
  return { code: 'HOST_ERROR', message: String(error), details: {} }
}
