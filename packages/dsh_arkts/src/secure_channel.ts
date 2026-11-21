// 安全通道：把 Noise 会话架在一个帧传输之上。
//
// 传输层只要求三个动作（收帧、发帧、关），所以鸿蒙的 TCP/WebSocket、Node 的
// net/ws、测试里的内存管道都能复用同一套逻辑。

import { concat } from './bytes'
import { NoiseIkSession } from './noise'
import {
  Reassembler,
  decodeFragment,
  decodeFrame,
  encodeFragment,
  encodeFrame,
  splitFragments,
  FRAME_KIND,
  MAX_SEALED_PAYLOAD,
  type Frame,
} from './wire'

/** 传输层需要提供的能力。 */
export interface FrameTransport {
  send(frame: Uint8Array): void
  close(): void
  onFrame(handler: (frame: Uint8Array) => void): void
  onClose(handler: () => void): void
}

export interface SecureChannelOptions {
  readonly transport: FrameTransport
  readonly session: NoiseIkSession
  /** 握手完成时回调，可以在这里发送第一条业务帧。 */
  readonly onEstablished?: () => void
  readonly onMessage?: (plaintext: Uint8Array) => void
  readonly onClose?: (reason?: Error) => void
  readonly onError?: (error: Error) => void
}

/**
 * 一条 Noise 通道，负责分片与帧类型分发。
 *
 * 握手阶段的帧顺序由 `NoiseIkSession.isWriteTurn` 决定，所以这里不做"谁是客户端"
 * 的判断 —— 两端跑同一份代码。
 */
export class SecureChannel {
  private readonly transport: FrameTransport
  private readonly session: NoiseIkSession
  private readonly reassembler = new Reassembler()
  private readonly onEstablished?: () => void
  private readonly onMessage?: (plaintext: Uint8Array) => void
  private readonly onClose?: (reason?: Error) => void
  private readonly onError?: (error: Error) => void

  private closed = false
  private messageId = 0

  constructor(options: SecureChannelOptions) {
    this.transport = options.transport
    this.session = options.session
    this.onEstablished = options.onEstablished
    this.onMessage = options.onMessage
    this.onClose = options.onClose
    this.onError = options.onError
    this.transport.onFrame((frame) => this.acceptFrame(frame))
    this.transport.onClose(() => this.fail(new Error('the transport closed')))
  }

  get established(): boolean {
    return this.session.complete
  }

  /** 主动开始握手（只有 initiator 需要调）。 */
  start(): void {
    if (this.session.isWriteTurn) this.writeHandshake()
  }

  /** 发送一条业务消息；超过单帧上限时自动分片。 */
  send(plaintext: Uint8Array): void {
    if (this.closed) throw new Error('the secure channel is closed')
    if (!this.session.complete) throw new Error('the secure channel is not established')
    const sealed = this.session.encrypt(plaintext)
    if (sealed.length <= MAX_SEALED_PAYLOAD) {
      this.transport.send(encodeFrame({ kind: FRAME_KIND.secure, payload: sealed }))
      return
    }
    for (const piece of splitFragments(sealed, this.messageId)) {
      this.transport.send(encodeFrame({ kind: FRAME_KIND.fragment, payload: encodeFragment(piece) }))
    }
    this.messageId = (this.messageId + 1) >>> 0
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.session.destroy()
    this.transport.close()
  }

  /** 由 Link 层在读掉明文 hello 之后转交帧。 */
  acceptFrame(frame: Uint8Array): void {
    if (this.closed) return
    try {
      this.handleFrame(decodeFrame(frame))
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private handleFrame(value: Frame): void {
    if (!this.session.complete) {
      if (value.kind !== FRAME_KIND.handshake) {
        throw new Error(`expected a handshake frame, got kind ${value.kind}`)
      }
      this.session.readHandshake(value.payload)
      if (this.session.isWriteTurn) this.writeHandshake()
      if (this.session.complete) this.onEstablished?.()
      return
    }

    if (value.kind === FRAME_KIND.handshake) {
      throw new Error('the peer kept the handshake going after it completed')
    }
    if (value.kind === FRAME_KIND.control) return

    if (value.kind === FRAME_KIND.secure) {
      this.onMessage?.(this.session.decrypt(value.payload))
      return
    }
    if (value.kind === FRAME_KIND.fragment) {
      const whole = this.reassembler.accept(decodeFragment(value.payload))
      if (whole !== null) this.onMessage?.(this.session.decrypt(whole))
      return
    }
    throw new Error(`unexpected frame kind ${value.kind}`)
  }

  private writeHandshake(): void {
    const message = this.session.writeHandshake()
    this.transport.send(encodeFrame({ kind: FRAME_KIND.handshake, payload: message }))
    // responder 写完消息二之后握手即完成，但 initiator 要等读到才算完。
    if (this.session.complete) this.onEstablished?.()
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    this.session.destroy()
    this.onError?.(error)
    this.onClose?.(error)
    this.transport.close()
  }
}

/** 供测试与调试用的常量别名。 */
export const MAX_FRAME_PAYLOAD = MAX_SEALED_PAYLOAD

/** 便捷构造：把多个帧数组拼成一条消息。 */
export function joinFrames(frames: readonly Uint8Array[]): Uint8Array {
  return concat(frames)
}
