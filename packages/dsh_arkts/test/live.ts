// 真实链路验证：TypeScript 客户端连上运行中的 Harness。
//
// 这一步是整份 TypeScript 核心存在的理由 —— 只有当它能和真正的 Host 完成
// Noise 握手并跑通业务调用，鸿蒙侧的移植才是可信的。
//
// 这里刻意走 `LinkClient.connect` 而不是手写 hello/握手：鸿蒙 App 用的就是
// 那条路径，只有它被真实 Host 验证过，"协议层能跑" 才算数。连接细节在
// `live_common.ts` 里只有一份，和 `live_transcript` / `live_models` 共用。

import { connectLive, describeError, type LiveLink } from './live_common'
import type { JsonObject } from '../src/json'

function field(source: JsonObject, name: string): string {
  const value = source[name]
  return typeof value === 'string' ? value : ''
}

async function main(): Promise<void> {
  let link: LiveLink | null = null
  try {
    link = await connectLive()

    const list = await link.rpc.call('session/list', { _request: {} }, 20_000)
    const items = Array.isArray(list['items']) ? (list['items'] as Object[]) : []
    console.log(`session/list -> ${items.length} sessions`)
    if (items.length === 0) throw new Error('the Host answered with no sessions; is this the right profile?')

    const first = items[0] as JsonObject
    const sessionId = field(first, 'sessionId')
    console.log(`first session ${sessionId.slice(0, 8)}… updated ${String(first['updatedAt'])}`)

    // 流式端点也验一次：job/list 首帧即整集，流不会自己结束，所以读到第一帧就退。
    for await (const frame of link.rpc.openStream('job/list', { request: { sessionId } }, { timeoutMs: 20_000 })) {
      const jobs = Array.isArray(frame['jobs']) ? (frame['jobs'] as Object[]) : []
      console.log(`job/list -> ${jobs.length} jobs (stream opened and read)`)
      break
    }

    console.log('\nTYPESCRIPT CLIENT TALKS TO THE REAL HOST')
  } catch (error) {
    console.log(`FAILED: ${describeError(error as Object)}`)
    process.exitCode = 1
  } finally {
    if (link !== null) await link.close()
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error: Object) => {
    console.error(`FAILED: ${describeError(error)}`)
    process.exit(1)
  },
)
