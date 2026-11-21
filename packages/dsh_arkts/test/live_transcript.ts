// 用真实 Host 的会话记录检验 transcript 解析。
//
// 单元测试用的是手写形状；这里把 `session/page` 拉回来的真实记录喂进同一个
// 解析器，证明「我以为的形状」和「Host 实际发的形状」是一回事。没有这一步，
// 解析器的断言只能证明它自洽。

import { connectLive, describeError, type LiveLink } from './live_common'
import type { JsonObject } from '../src/json'
import {
  readTranscript,
  ROW_ASSISTANT,
  ROW_TOOL,
  ROW_USER,
  type TranscriptRow,
} from '../src/transcript'

async function main(): Promise<void> {
  let link: LiveLink | null = null
  try {
    link = await connectLive()

    const list = await link.rpc.call('session/list', { _request: {} }, 20_000)
    const items = Array.isArray(list['items']) ? (list['items'] as Object[]) : []
    let checked = 0
    let userRows = 0
    let assistantRows = 0
    let toolRows = 0
    // 扫到出现工具调用为止：老会话里往往没有，硬取前三个会误以为工具行坏了。
    for (const item of items) {
      if (checked >= 80 || (toolRows > 0 && checked >= 3)) break
      const summary = item as JsonObject
      const sessionId = typeof summary['sessionId'] === 'string' ? (summary['sessionId'] as string) : ''
      if (sessionId.length === 0) continue
      let page: JsonObject
      try {
        page = await link.rpc.call(
          'session/page',
          { request: { address: { kind: 'session', sessionId }, maxMessages: 60 } },
          20_000,
        )
      } catch (error) {
        console.log(`  skip ${sessionId}: ${describeError(error as Object)}`)
        continue
      }
      const records = Array.isArray(page['records']) ? (page['records'] as Object[]) : []
      if (records.length === 0) continue
      checked += 1
      const rows: TranscriptRow[] = readTranscript(records)
      for (const row of rows) {
        if (row.kind === ROW_USER) userRows += 1
        if (row.kind === ROW_ASSISTANT) assistantRows += 1
        if (row.kind === ROW_TOOL) toolRows += 1
      }
    }
    console.log(`rows read from ${checked} sessions: user ${userRows}, assistant ${assistantRows}, tool ${toolRows}`)
    if (checked === 0) throw new Error('no session returned usable records')
    if (assistantRows === 0) throw new Error('no assistant rows came out of real records')
    if (userRows === 0) throw new Error('no user rows came out of real records')
    if (toolRows === 0) console.log('  note: none of the sessions scanned had tool calls')
    console.log('\nREAL RECORDS PARSE INTO TRANSCRIPT ROWS')
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
