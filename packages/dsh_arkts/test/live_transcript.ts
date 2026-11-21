// 用真实 Host 的会话记录检验 transcript 解析。
//
// 单元测试用的是手写形状；这里把 `session/page` 拉回来的真实记录喂进同一个
// 解析器，证明「我以为的形状」和「Host 实际发的形状」是一回事。没有这一步，
// 解析器的断言只能证明它自洽。

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect as netConnect, type Socket } from 'node:net'

import { decodeTicket, identityFromPrivateKey, decodeBase64Url, encodeBase64Url } from '../src/index'
import { LinkClient } from '../src/client'
import { FrameSplitter, frameWithLength } from '../src/framing'
import type { FrameTransport } from '../src/secure_channel'
import type { JsonObject } from '../src/json'
import { readTranscript, ROW_ASSISTANT, ROW_TOOL, ROW_USER, type TranscriptRow } from '../src/transcript'

function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '..', '..', '..')
}

const root = repoRoot()
const ticketPath = join(root, 'probe', '_live-ticket.txt')
const identityPath = join(root, 'probe', '_probe-identity.txt')

const CONNECT_TIMEOUT_MS = 15000

function openTcp(host: string, port: number): Promise<FrameTransport> {
  return new Promise<FrameTransport>((resolveTransport, rejectTransport) => {
    const splitter = new FrameSplitter()
    const socket: Socket = netConnect({ host, port })
    let closed = false
    let onFrame: ((frame: Uint8Array) => void) | null = null
    let onClose: (() => void) | null = null
    const notifyClose = (): void => {
      if (closed) return
      closed = true
      const handler = onClose
      if (handler !== null) handler()
    }
    socket.setNoDelay(true)
    socket.on('connect', () => {
      socket.setTimeout(0)
      resolveTransport({
        send: (frame: Uint8Array) => { socket.write(Buffer.from(frameWithLength(frame))) },
        close: () => { socket.destroy() },
        onFrame: (handler: (frame: Uint8Array) => void) => { onFrame = handler },
        onClose: (handler: () => void) => { onClose = handler },
      })
    })
    socket.on('data', (chunk: Buffer) => {
      let frames: Uint8Array[]
      try {
        frames = splitter.push(new Uint8Array(chunk))
      } catch {
        socket.destroy()
        return
      }
      for (const frame of frames) {
        const handler = onFrame
        if (handler !== null) handler(frame)
      }
    })
    socket.on('close', notifyClose)
    socket.on('error', notifyClose)
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => { socket.destroy() })
  })
}

async function main(): Promise<void> {
  const ticket = decodeTicket(readFileSync(ticketPath, 'utf8').trim())
  const lines = readFileSync(identityPath, 'utf8').trim().split(/\r?\n/)
  const identity = identityFromPrivateKey(lines[0], decodeBase64Url(lines[1]))
  console.log(`ticket -> ${ticket.hostName}, endpoints ${ticket.lanEndpoints.join(', ')}`)

  const link = await LinkClient.connect({
    ticket,
    identity,
    random: (length: number): Uint8Array => decodeBase64Url(encodeBase64Url(new Uint8Array(length).fill(7))),
    openTransport: openTcp,
    timeoutMs: 15000,
    heartbeat: true,
  })
  console.log(`connected over ${link.route} (${link.endpoint})`)

  try {
    const list = await link.rpc.call('session/list', { _request: {} }, 20000)
    const items = Array.isArray(list.items) ? (list.items as Object[]) : []
    let checked = 0
    let userRows = 0
    let assistantRows = 0
    let toolRows = 0
    // 扫到出现工具调用为止：老会话里往往没有，硬取前三个会误以为工具行坏了。
    for (const item of items) {
      if (checked >= 80 || (toolRows > 0 && checked >= 3)) break
      const summary = item as JsonObject
      const sessionId = typeof summary.sessionId === 'string' ? (summary.sessionId as string) : ''
      if (sessionId.length === 0) continue
      let page: JsonObject
      try {
        page = await link.rpc.call('session/page', { request: { address: { kind: 'session', sessionId }, maxMessages: 60 } }, 20000)
      } catch (error) {
        console.log(`  skip ${sessionId}: ${'' + error}`)
        continue
      }
      const records = Array.isArray(page.records) ? (page.records as Object[]) : []
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
  } finally {
    link.close()
  }
}

main().catch((error: Object) => {
  console.error(`FAILED: ${'' + error}`)
  process.exit(1)
})
