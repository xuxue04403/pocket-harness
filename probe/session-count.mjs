// Count what the phone would show, straight from a live Host.
//
// Reads the pairing snapshot the running plugin serves, opens a link, asks for
// `session/list`, and prints the numbers the release notes quote. Anything the
// notes claim should be reproducible by this script alone, so no count here is
// typed in by hand.
//
//   node probe/session-count.mjs [webPort] [folder]
import { randomBytes } from 'node:crypto'
import { get } from 'node:http'
import { connect as netConnect } from 'node:net'

import {
  FrameSplitter,
  LinkClient,
  decodeTicket,
  frameWithLength,
  newDeviceIdentity,
} from '../packages/dsh_arkts/build/index.mjs'

const port = Number(process.argv[2] ?? process.env.POCKET_HARNESS_WEB_PORT ?? '59016')
const folder = process.argv[3] ?? 'zpan'

function snapshotOf() {
  return new Promise((resolve, reject) => {
    get({ host: '127.0.0.1', port, path: '/api/pocket-harness/pair?format=json' }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (error) {
          reject(error)
        }
      })
    }).on('error', reject)
  })
}

function openTcp(host, target) {
  return new Promise((resolveTransport, rejectTransport) => {
    const splitter = new FrameSplitter()
    const socket = netConnect({ host, port: target })
    let handleFrame = null
    let handleClose = null
    socket.setNoDelay(true)
    socket.on('connect', () => {
      socket.setTimeout(0)
      resolveTransport({
        send: (frame) => socket.write(Buffer.from(frameWithLength(frame))),
        close: () => socket.destroy(),
        onFrame: (handler) => { handleFrame = handler },
        onClose: (handler) => { handleClose = handler },
      })
    })
    socket.on('data', (chunk) => {
      for (const frame of splitter.push(new Uint8Array(chunk))) {
        if (handleFrame !== null) handleFrame(frame)
      }
    })
    socket.on('close', () => { if (handleClose !== null) handleClose() })
    socket.on('error', (error) => { rejectTransport(error); if (handleClose !== null) handleClose() })
    socket.setTimeout(15000, () => {
      socket.destroy()
      rejectTransport(new Error(`the Host did not answer at ${host}:${target}`))
    })
  })
}

function directoryOf(row) {
  const values = row?.projections?.values ?? {}
  const projected = values.workingDirectory
  if (typeof projected === 'string' && projected.length > 0) return projected
  if (typeof row.cwd === 'string' && row.cwd.length > 0) return row.cwd
  return ''
}

// The one rule that survives a restart. `agentAvailable` means "an agent is
// attached right now", which is false for every Session the moment the Host
// restarts; `blank` means "no turn has started yet", which is true for a brand
// new Session the user just made and false for an abandoned prompt. Only
// `lastPromptAt` separates "somebody talked to this" from "something wrote a
// prompt and vanished", and it is stamped from `user/message` events whose
// source is the user, so it is durable across restarts.
function prompted(row) {
  const metadata = row?.projections?.values?.sessionListMetadata
  return typeof metadata?.lastPromptAt === 'number'
}

const snapshot = await snapshotOf()
if (typeof snapshot.ticket !== 'string') {
  throw new Error('the Host did not hand out a ticket: ' + JSON.stringify(snapshot).slice(0, 200))
}
const ticket = decodeTicket(snapshot.ticket)
const identity = newDeviceIdentity((length) => new Uint8Array(randomBytes(length)))

const link = await LinkClient.connect({
  ticket,
  identity,
  random: (length) => new Uint8Array(randomBytes(length)),
  openTransport: openTcp,
  timeoutMs: 15000,
})

try {
  const answer = await link.rpc.call('session/list', { _request: {} }, 30000)
  const rows = Array.isArray(answer.items) ? answer.items : []
  const visible = rows.filter((row) => row.agentAvailable !== false)
  const matching = rows.filter((row) => directoryOf(row).includes(folder))
  const matchingVisible = matching.filter((row) => row.agentAvailable !== false)
  const matchingPrompted = matching.filter((row) => prompted(row))

  console.log('rows the Host returned        ', rows.length)
  console.log('rows with an agent            ', visible.length)
  console.log('rows with a user prompt       ', rows.filter(prompted).length)
  console.log(`rows under "${folder}"`.padEnd(31), matching.length)
  console.log('  ...of those with an agent   ', matchingVisible.length)
  console.log('  ...of those with a prompt   ', matchingPrompted.length)
  for (const row of matching) {
    const values = row?.projections?.values ?? {}
    const title = typeof values.title === 'string' ? values.title : '(no title)'
    const metadata = values.sessionListMetadata
    const when = metadata?.lastPromptAt
    console.log(
      '  ',
      String(row.agentAvailable !== false).padEnd(5),
      String(prompted(row)).padEnd(5),
      String(row.sessionId).slice(0, 16),
      (when ? new Date(when).toISOString() : 'never').padEnd(24),
      JSON.stringify(title).slice(0, 40),
    )
  }
} finally {
  await link.close()
}
process.exit(0)
