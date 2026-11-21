/**
 * 中继协议：手机与 Host 各自跟中继说的话。
 *
 * 中继本身不理解业务，它只做三件事：认房间、等两端到齐、把字节原样转过去。
 * 但两端必须照它的规矩说话，否则会被直接关掉。三条规矩全部来自实测：
 *
 * 1. **首帧必须是文本**。中继读它来分配房间；首帧发二进制会被当成协议违规，
 *    直接以 4400 关掉连接。
 * 2. **回执分两件事**：`{v:1, ok:true, …}` 表示「你已进房」（可以一直等对方，
 *    不算超时），`{v:1, type:'ready'}` 才表示「对方也到了」。把两者混为一谈，
 *    一个空房间会每隔十几秒自我重连一次。
 * 3. **`peer-gone` 是终止信号**，不是可忽略的通知：对端走了，这条链路就没有
 *    意义了，继续等只会让用户对着一个永远不动的界面。
 */

import { stringField, type JsonObject } from './json'

/** 中继协议版本，与 `relay/server.mjs` 的 `v` 一致。 */
export const RELAY_PROTOCOL_VERSION = 1

/** 房间名与 token 都在配对票据里，长度上限只是防止把整段乱码发过去。 */
export const MAX_ROOM_LENGTH = 128
export const MAX_RELAY_TOKEN_LENGTH = 256

/** 中继允许的最大帧，与 `relay/server.mjs` 的 `MAX_FRAME_BYTES` 一致。 */
export const MAX_RELAY_FRAME_BYTES = 4 * 1024 * 1024 + 64

export type RelayRole = 'host' | 'client'

/** 一条中继控制消息的三种下场。 */
export const RELAY_JOINED = 'joined'
export const RELAY_READY = 'ready'
export const RELAY_PEER_GONE = 'peer-gone'
export const RELAY_ERROR = 'error'
export const RELAY_IGNORED = 'ignored'

/** 首帧 hello 的 JSON 文本。 */
export function encodeRelayHello(role: RelayRole, room: string, token: string): string {
  if (room.length === 0) throw new Error('a relay room must not be empty')
  if (room.length > MAX_ROOM_LENGTH) throw new Error(`a relay room must be at most ${MAX_ROOM_LENGTH} characters`)
  if (token.length === 0) throw new Error('a relay token must not be empty')
  if (token.length > MAX_RELAY_TOKEN_LENGTH) {
    throw new Error(`a relay token must be at most ${MAX_RELAY_TOKEN_LENGTH} characters`)
  }
  return JSON.stringify({ v: RELAY_PROTOCOL_VERSION, role: role, room: room, token: token })
}

/** 解析后的一条控制消息。 */
export interface RelayControl {
  /** 见上方的 `RELAY_*` 常量。 */
  readonly kind: string
  /** 只在 `kind === RELAY_ERROR` 时有意义。 */
  readonly message: string
  /**
   * 中继在被拒时给的状态码（4400/4403/4408/4409），不可读时为 0。
   *
   * **中继的拒绝不在这条 JSON 通道上**：它是 WebSocket 的关闭帧
   * （`socket.close(4403, 'bad token')`），所以这个字段只对 `describeRelayClose`
   * 有意义，`readRelayControl` 永远回 0。保留它是因为真中继把码放在关闭帧里，
   * 而我们要用一个统一的结构把两种来源说清楚。
   */
  readonly code: number
}

/**
 * 读一条中继控制消息。
 *
 * 不是 JSON、或不是对象时返回 `RELAY_IGNORED` 而不是抛错：控制通道上出现噪音
 * 不该让界面显示一条错误，它只是没有意义。
 */
export function readRelayControl(text: string): RelayControl {
  let message: JsonObject
  try {
    const parsed = JSON.parse(text) as Object
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { kind: RELAY_IGNORED, message: '', code: 0 }
    }
    message = parsed as JsonObject
  } catch {
    return { kind: RELAY_IGNORED, message: '', code: 0 }
  }

  const type = stringField(message, 'type', '')
  if (type === RELAY_READY) return { kind: RELAY_READY, message: '', code: 0 }
  if (type === RELAY_PEER_GONE) return { kind: RELAY_PEER_GONE, message: '', code: 0 }

  // 进房回执：`{v, ok:true, role, paired}`。这就是全部——中继**从不**用 JSON
  // 表示拒绝，它直接关连接（见下方 `describeRelayClose`）。所以 `ok:false`
  // 这种形状不存在，不要为它写分支。
  if (message['ok'] === true) return { kind: RELAY_JOINED, message: '', code: 0 }

  return { kind: RELAY_IGNORED, message: '', code: 0 }
}

/**
 * 把中继的**关闭帧**翻成可操作的一句话。
 *
 * 这是拒绝的唯一到达方式：`relay/server.mjs` 在 token 不匹配、房间已满、首帧不合法
 * 时都调 `socket.close(code, reason)`。code 为 1000/1005 是正常收尾，不算错误。
 *
 * 之所以要单独一个函数：一度以为拒绝会以 `{ok:false}` 的 JSON 到达，于是写了两个
 * 永远不会走到的分支，而真正的错误路径（关闭帧）没有任何处理——真机上表现为
 * 「中继把手机关了，界面一直转圈」。
 */
export function describeRelayClose(code: number, reason: string): RelayControl {
  const detail = reason.length > 0 ? reason : 'the relay closed the link'
  if (code === 4403 || code === 4408 || code === 4409 || code === 4400) {
    return { kind: RELAY_ERROR, message: detail, code: code }
  }
  if (code === 1000 || code === 1005 || code === 0) {
    return { kind: RELAY_PEER_GONE, message: detail, code: code }
  }
  return { kind: RELAY_ERROR, message: detail, code: code }
}

/** 把中继的拒绝翻译成人话——用户看到的必须是能行动的一句话。 */
export function describeRelayRefusal(control: RelayControl): string {
  if (control.code === 4403) return '中继不认这个 token，请检查电脑上配置的 relayToken 与中继启动时的一致。'
  if (control.code === 4408) return '中继在等你进房，但超时了。请检查网络后重试。'
  if (control.code === 4409) return '这个房间已经有另一部手机连着。中继一次只服务一部手机。'
  if (control.code === 4400) return '中继没看懂这次握手。请确认中继版本与手机一致。'
  return control.message.length > 0 ? control.message : '中继拒绝了这次连接。'
}
