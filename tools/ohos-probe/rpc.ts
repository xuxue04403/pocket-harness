// RPC 客户端：信封编解码 + 请求/响应关联 + 流式端点。
//
// 与 Dart 侧 `rpc_client.dart` 的行为一致，包括那个关键细节：流的第一帧可能在
// 调用方拿到 streamId 之前就到达，所以每个流用单消费者队列缓冲，而不是广播流。

import {
  decodeEnvelope,
  encodeEnvelope,
  errorEnvelope,
  requestEnvelope,
  responseEnvelope,
  type Envelope,
} from './wire'
import type { SecureChannel } from './secure_channel'
import type { JsonObject } from './json'

export const DEFAULT_STREAM_OPEN_ENDPOINT = 'link/stream.open'
export const DEFAULT_STREAM_CLOSE_ENDPOINT = 'link/stream.close'

/** Host 返回的错误。 */
export class RpcError extends Error {
  readonly code: string
  readonly details: JsonObject

  constructor(code: string, message: string, details: JsonObject = {}) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.details = details
  }
}

interface PendingCall {
  readonly resolve: (value: JsonObject) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout> | undefined
}

interface PendingStream {
  readonly push: (value: JsonObject) => void
  readonly finish: () => void
  readonly fail: (error: Error) => void
  readonly closeEndpoint: string
  timer: ReturnType<typeof setTimeout> | undefined
  streamId: number | null
  cancelled: boolean
}

export interface RpcClientOptions {
  readonly channel: SecureChannel
  readonly defaultTimeoutMs?: number
}

/** 一条 RPC 客户端。 */
export class RpcClient {
  private readonly channel: SecureChannel
  private readonly defaultTimeoutMs: number
  private readonly calls = new Map<string, PendingCall>()
  private readonly opening = new Map<string, PendingStream>()
  private readonly streams = new Map<number, PendingStream>()
  private nextCallId = 1
  private closed = false

  constructor(options: RpcClientOptions) {
    this.channel = options.channel
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000
  }

  get openStreams(): number {
    return this.streams.size
  }

  /** 发一条 unary 请求并等响应。 */
  async call(
    endpoint: string,
    args: JsonObject = {},
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<JsonObject> {
    if (this.closed) throw new Error('the RPC client is closed')
    const id = `c${this.nextCallId++}`
    const envelope = requestEnvelope(id, { endpoint, payload: { args } })
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.calls.delete(id)
          reject(new Error(`the Host did not answer ${endpoint} in time`))
        }, timeoutMs)
        : undefined
      this.calls.set(id, { resolve, reject, timer })
      this.channel.send(encodeEnvelope(envelope))
    })
  }

  /**
   * 打开一个流式端点，逐条产出帧。
   *
   * 用异步生成器暴露，调用方 `for await` 即可；内部用单消费者队列缓冲，
   * 因为 Host 在回应 streamId 之后会立刻推帧。
   */
  async *openStream(
    endpoint: string,
    args: JsonObject = {},
    options: { readonly timeoutMs?: number; readonly openEndpoint?: string; readonly closeEndpoint?: string } = {},
  ): AsyncGenerator<JsonObject> {
    const openEndpoint = options.openEndpoint ?? DEFAULT_STREAM_OPEN_ENDPOINT
    const closeEndpoint = options.closeEndpoint ?? DEFAULT_STREAM_CLOSE_ENDPOINT
    const queue: JsonObject[] = []
    let done = false
    let failure: Error | null = null
    let notify: (() => void) | null = null
    const wake = (): void => {
      const pending = notify
      notify = null
      pending?.()
    }

    const record: PendingStream = {
      push: (value) => {
        queue.push(value)
        wake()
      },
      finish: () => {
        done = true
        wake()
      },
      fail: (error) => {
        failure = error
        done = true
        wake()
      },
      closeEndpoint,
      timer: undefined,
      streamId: null,
      cancelled: false,
    }

    const id = `s${this.nextCallId++}`
    this.opening.set(id, record)
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs
    if (timeoutMs > 0) {
      record.timer = setTimeout(() => {
        record.fail(new Error(`the Host did not open ${endpoint} in time`))
      }, timeoutMs)
    }
    this.channel.send(encodeEnvelope(requestEnvelope(id, { endpoint: openEndpoint, payload: { args: { endpoint, args } } })))

    try {
      for (;;) {
        if (queue.length > 0) {
          yield queue.shift()!
          continue
        }
        if (failure !== null) throw failure
        if (done) return
        await new Promise<void>((resolve) => {
          notify = resolve
        })
      }
    } finally {
      if (!record.cancelled && record.streamId !== null && !this.closed) {
        record.cancelled = true
        try {
          this.channel.send(
            encodeEnvelope(requestEnvelope(`x${this.nextCallId++}`, {
              endpoint: closeEndpoint,
              payload: { args: { streamId: record.streamId } },
            })),
          )
        } catch {
          // 通道已经断了：Host 会自己回收那条流。
        }
      }
      if (record.streamId !== null) this.streams.delete(record.streamId)
      this.opening.delete(id)
    }
  }

  /** 把从通道收到的字节喂进来。 */
  accept(bytes: Uint8Array): void {
    let envelope: Envelope
    try {
      envelope = decodeEnvelope(bytes)
    } catch {
      return
    }
    this.dispatch(envelope)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const failure = new Error('the RPC client closed')
    for (const pending of this.calls.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      pending.reject(failure)
    }
    this.calls.clear()
    for (const stream of [...this.opening.values(), ...this.streams.values()]) {
      stream.fail(failure)
    }
    this.opening.clear()
    this.streams.clear()
  }

  private dispatch(envelope: Envelope): void {
    if (envelope.type === 'response' || envelope.type === 'error') {
      const id = envelope.id
      if (id === undefined) return
      const pending = this.calls.get(id)
      if (pending !== undefined) {
        this.calls.delete(id)
        if (pending.timer !== undefined) clearTimeout(pending.timer)
        if (envelope.type === 'error') {
          const code = typeof envelope.payload.code === 'string' ? envelope.payload.code : 'HOST_ERROR'
          const message = typeof envelope.payload.message === 'string' ? envelope.payload.message : 'the Host refused this call'
          const details = envelope.payload.details
          pending.reject(new RpcError(code, message, (details !== null && typeof details === 'object' && !Array.isArray(details) ? details : {}) as JsonObject))
        } else {
          pending.resolve(envelope.payload)
        }
        return
      }
      const opening = this.opening.get(id)
      if (opening !== undefined) {
        this.opening.delete(id)
        if (opening.timer !== undefined) clearTimeout(opening.timer)
        const streamId = envelope.payload.streamId
        if (envelope.type === 'error' || typeof streamId !== 'number') {
          opening.fail(new Error('the Host did not return a stream id'))
          return
        }
        opening.streamId = streamId
        this.streams.set(streamId, opening)
      }
      return
    }

    if (envelope.type === 'pong') return
    if (envelope.type !== 'event') return

    const streamId = envelope.payload.streamId
    if (typeof streamId !== 'number') return
    const stream = this.streams.get(streamId)
    if (stream === undefined) return
    const failure = envelope.payload.error
    if (failure !== null && typeof failure === 'object' && !Array.isArray(failure)) {
      const map = failure as JsonObject
      stream.fail(new RpcError(
        typeof map.code === 'string' ? map.code : 'HOST_ERROR',
        typeof map.message === 'string' ? map.message : 'the stream failed',
      ))
      this.streams.delete(streamId)
      return
    }
    if (envelope.payload.done === true) {
      stream.finish()
      this.streams.delete(streamId)
      return
    }
    const value = envelope.payload.value
    stream.push(value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as JsonObject)
      : { value })
  }
}

export { encodeEnvelope, decodeEnvelope, errorEnvelope, requestEnvelope, responseEnvelope }
