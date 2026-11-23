/**
 * 网关的转发事件流：手机回答电脑上本该由窗口回答的问题。
 *
 * DSH 有两件事会在 turn 阻塞时问人：审批（`approval/request`）与
 * `ask_user_question`（`user-questions/request`）。两者都是 Agent 作用域的
 * Cordis waterfall，且**同一时刻只有一个客户端能回答**。电脑在自己的窗口里答，
 * 手机想拿到同样的机会，只能走网关内部的 `$events` 流加 `$events/result` 调用。
 *
 * 这两个端点名是网关的，不是业务的 `namespace/method`，所以它们原样穿过链路
 * （Host 侧 `isGatewayEndpoint` 只认 `$` 开头）。本文件负责其余全部：关联 id、
 * ready 握手、取消、把一次 waterfall 变成一条回复。
 */

import { objectField, stringField, type JsonObject } from './json'
import type { RpcClient, StreamCancel } from './rpc'

/** 网关内部：承载转发事件的流。 */
export const REMOTE_EVENT_STREAM_ENDPOINT = '$events'

/** 网关内部：接收一条 outcome 的 unary 端点。 */
export const REMOTE_EVENT_RESULT_ENDPOINT = '$events/result'

/** 一帧待回答的 waterfall。 */
export interface RemoteInvocation {
  /** Cordis 事件名，例如 `approval/request`。 */
  readonly event: string
  /** 回应时要原样带回的关联 id。 */
  readonly eventId: string
  /** 发起它的 Agent；对手机不透明。 */
  readonly agentId: string
  /** 原始请求字段（永远不含 `agent` 与 `signal`）。 */
  readonly request: JsonObject
}

/** 一条不需要回答的转发通知。 */
export interface RemoteNotification {
  readonly event: string
  readonly args: Object[]
}

/** 应答的三种下场。 */
export const OUTCOME_NEXT = 'next'
export const OUTCOME_RESULT = 'result'
export const OUTCOME_REJECTED = 'rejected'

/**
 * 一条活的 `$events` 订阅。
 *
 * 用完必须 `close()`：DSH 把已回答的 waterfall 视为被该客户端持有，
 * 留着订阅会继续吞掉后续提问。
 */
export class RemoteEvents {
  private readonly rpc: RpcClient
  /** 网关分配；每条回复都要带回。 */
  readonly clientId: string
  /** Host 的账户主目录，电脑用它缩短路径。 */
  readonly home: string

  private readonly frames: RemoteInvocation[] = []
  private readonly notices: RemoteNotification[] = []
  private readonly cancelled: string[] = []
  /**
   * 正在等新帧的调用方，按挂上的顺序。
   *
   * 这里必须是**一组**而不是一个槽：`nextInvocation` 与 `nextNotification`
   * 是对外两个方法，界面完全可以各挂一个（甚至同一个方法挂两次）。用单槽时
   * 后挂的会覆盖前一个的唤醒函数，被覆盖那条 `for(;;)` 就永远等下去——
   * 真机上表现为「审批弹窗再也没出现，但链路是好的」。
   */
  private readonly waiters: (() => void)[] = []
  private closed = false
  private failure: Error | null = null
  private cancel: StreamCancel | null = null

  private constructor(rpc: RpcClient, clientId: string, home: string) {
    this.rpc = rpc
    this.clientId = clientId
    this.home = home
  }

  /**
   * 打开流并等网关的 `ready` 帧。
   *
   * 旧版 Harness 没有 `@deepseek-ai/dsh-api-remotes`，会回
   * `gateway/service-unavailable`，调用方据此降级而不是一直挂着。
   */
  static async open(rpc: RpcClient, timeoutMs = 15_000): Promise<RemoteEvents> {
    const cancel: StreamCancel = { aborted: false, wake: () => undefined }
    const stream = rpc.openStream(REMOTE_EVENT_STREAM_ENDPOINT, {}, { timeoutMs, cancel })
    try {
      const first = await withTimeout(stream.next(), timeoutMs, 'the Host did not start the event stream')
      if (first.done === true) throw new Error('the Host closed the event stream before it was ready')
      const ready = first.value
      const type = stringField(ready, 'type', '')
      if (type !== 'ready') throw new Error('the Host did not start the event stream with ready')
      const clientId = stringField(ready, 'clientId', '')
      if (clientId.length === 0) throw new Error('the Host sent no event client id')
      const host = objectField(ready, 'host')
      const home = host === undefined ? '' : stringField(host, 'home', '')
      const events = new RemoteEvents(rpc, clientId, home)
      events.cancel = cancel
      events.pump(stream)
      return events
    } catch (error) {
      // 打开失败也必须把流关掉。链路上一共只有 16 条流的名额，而网关还会把
      // 这条 `$events` 订阅当成"某个客户端正在回答"：留着它，后续审批就再也
      // 到不了这台手机，而界面上看起来只是"没弹窗"。
      cancel.aborted = true
      cancel.wake()
      // 只置位是不够的：`open` 只拉过一帧，生成器此刻停在 `yield` 上，
      // 而 `wake()` 解的是"等下一帧"那个 await。再拉一次让它走到循环顶部的
      // `aborted` 判断，`openStream` 的 `finally` 才会真的发出关流请求。
      void stream.next().catch(() => undefined)
      throw error
    }
  }

  /** 后台读帧直到 Host 结束这条流。 */
  private pump(stream: AsyncGenerator<JsonObject>): void {
    void (async (): Promise<void> => {
      try {
        for (;;) {
          const next = await stream.next()
          if (next.done === true || this.closed) break
          this.onFrame(next.value)
        }
      } catch (error) {
        if (!this.closed) this.failure = asError(error)
      } finally {
        this.closed = true
        this.wake()
      }
    })()
  }

  private onFrame(frame: JsonObject): void {
    const type = stringField(frame, 'type', '')
    if (type === 'waterfall') {
      const event = stringField(frame, 'event', '')
      const eventId = stringField(frame, 'eventId', '')
      const agentId = stringField(frame, 'agentId', '')
      if (event.length === 0 || eventId.length === 0) return
      const request = objectField(frame, 'request')
      this.frames.push({ event, eventId, agentId, request: request ?? {} })
      this.wake()
      return
    }
    if (type === 'emit') {
      const event = stringField(frame, 'event', '')
      if (event.length === 0) return
      const raw = frame['args']
      const args: Object[] = Array.isArray(raw) ? (raw as Object[]) : []
      this.notices.push({ event, args })
      this.wake()
      return
    }
    if (type === 'cancel') {
      // Host 撤回了提问（turn 中止，或电脑上已经答过）。id 已经交给界面了，
      // 所以记下来让 `isCancelled` 回答"这条已经死了"。
      const eventId = stringField(frame, 'eventId', '')
      if (eventId.length === 0) return
      this.cancelled.push(eventId)
      while (this.cancelled.length > 32) this.cancelled.shift()
    }
  }

  /** 取下一帧待回答的 waterfall；没有就等到有为止。 */
  async nextInvocation(): Promise<RemoteInvocation | null> {
    for (;;) {
      const next = this.frames.shift()
      if (next !== undefined) return next
      if (this.closed) {
        if (this.failure !== null) throw this.failure
        return null
      }
      await this.waitForNext()
    }
  }

  /** 取下一帧通知；没有就等到有为止。 */
  async nextNotification(): Promise<RemoteNotification | null> {
    for (;;) {
      const next = this.notices.shift()
      if (next !== undefined) return next
      if (this.closed) return null
      await this.waitForNext()
    }
  }

  /** 挂一个等待者，返回时说明可能有新帧，也可能已经关闭。 */
  private waitForNext(): Promise<void> {
    return new Promise<void>((wake) => { this.waiters.push(wake) })
  }

  /** 这条提问是否已被 Host 撤回。 */
  isCancelled(invocation: RemoteInvocation): boolean {
    return this.cancelled.includes(invocation.eventId)
  }

  /**
   * 回答一条 waterfall。
   *
   * `value` 是监听者的返回值：审批用 `'allowed-once'` 或 `'rejected'`，
   * 提问用一批答案。`delegate === true` 表示交给下一个监听者（电脑），
   * 手机渲染不了的提问就该这样交回去，否则 waterfall 永远挂着。
   */
  answer(invocation: RemoteInvocation, value: Object | null = null, delegate = false): Promise<JsonObject> {
    const outcome: JsonObject = delegate
      ? { kind: OUTCOME_NEXT }
      : { kind: OUTCOME_RESULT, value: value }
    return this.reply(invocation, outcome)
  }

  /** 用一条错误拒答；Host 会把它呈现给 agent。 */
  reject(invocation: RemoteInvocation, message: string, code: string | null = null): Promise<JsonObject> {
    const error: JsonObject = { name: 'Error', message }
    if (code !== null) error['code'] = code
    return this.reply(invocation, { kind: OUTCOME_REJECTED, error })
  }

  private reply(invocation: RemoteInvocation, outcome: JsonObject): Promise<JsonObject> {
    if (this.closed) throw new Error('the event stream is closed')
    return this.rpc.call(REMOTE_EVENT_RESULT_ENDPOINT, {
      clientId: this.clientId,
      eventId: invocation.eventId,
      outcome,
    })
  }

  /**
   * 释放订阅。
   *
   * 用 [StreamCancel] 通知生成器收尾，而不是 `stream.return()`：生成器可能
   * 正停在 `await` 上等这一侧喂数据，`return()` 会排队等它，双方互等即死锁
   * （真机上表现为「点关闭后界面一直转圈」）。
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const cancel = this.cancel
    this.cancel = null
    if (cancel !== null) {
      cancel.aborted = true
      cancel.wake()
    }
    this.wake()
  }

  private wake(): void {
    // 全部醒来，各自再去表里取；先清空再逐个叫，避免新挂上的等待者被这一轮
    // 唤醒（它等的东西还没到）。
    const waiters = this.waiters.splice(0, this.waiters.length)
    for (const wake of waiters) wake()
  }
}

function asError(value: Object): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    work.then((value) => {
      clearTimeout(timer)
      resolve(value)
    }, (error: Object) => {
      clearTimeout(timer)
      reject(asError(error))
    })
  })
}
