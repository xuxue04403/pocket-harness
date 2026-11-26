// Draws the pairing code the *running* Host printed, as a QR code on screen.
//
// The Host logs a fresh `pocketharness://pair?t=…` code every ten minutes, and
// that code is the one meant to be scanned: it carries the endpoints the Host
// discovered for itself. Rebuilding an equivalent ticket from the credentials
// store works too (probe/live-ticket.mjs does that for tests), but it puts the
// endpoint guessing on our side. Reading the log keeps the Host as the single
// source of truth for what address a phone should dial.
//
// The code contains the pairing secret, so this script never echoes it: it only
// reports the endpoints, when the code expires, and where the PNG landed.
//
// Usage:
//   node tools/pair-qr-live.mjs [--out=probe/_pairing.png] [--size=760] [--log=<path>]
//                               [--min-left=<minutes>] [--no-wait]
//
// --min-left (default 8) is how much life the code must have left before it is
// drawn. A code that is about to expire would produce a QR that dies in the
// person's hand, so the script waits for the next ten-minute rotation instead;
// --no-wait draws whatever is there even if it expires immediately.
//
// Exit codes:
//   0  a QR code was written
//   1  no pairing code found in the log
//   2  the newest code already expired (start the Harness, or wait for the next rotation)
//   3  waited for a rotation but none arrived (the plugin's timer is not running)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'

const args = process.argv.slice(2)
const flag = name => {
  const hit = args.find(arg => arg.startsWith(`--${name}=`))
  return hit === undefined ? null : hit.slice(name.length + 3)
}

const outPng = resolve(flag('out') ?? 'probe/_pairing.png')
const width = Number.parseInt(flag('size') ?? '760', 10)
const minLeftMin = Number.parseFloat(flag('min-left') ?? '8')
const shouldWait = !args.includes('--no-wait')
const logPath = resolve(flag('log') ?? resolve(homedir(), '.dsh', 'logs', 'ft', 'current.log'))

const ROTATION_MS = 10 * 60 * 1000

if (!existsSync(logPath)) {
  process.stderr.write(`no log at ${logPath}\n`)
  process.exit(1)
}

const CODE = /pocketharness:\/\/pair\?t=([A-Za-z0-9_-]+)/g

/** Reads the whole log and returns the last code it contains, with its line. */
function readNewest() {
  let code = null
  let line = null
  for (const candidate of readFileSync(logPath, 'utf8').split(/\r?\n/)) {
    for (const match of candidate.matchAll(CODE)) {
      code = match[1]
      line = candidate
    }
  }
  return { code, line }
}

if (readNewest().code === null) {
  process.stderr.write(`no pairing code in ${logPath}\n`)
  process.exit(1)
}

// The rotation timer fires every ten minutes on a wall-clock boundary the Host
// picked at startup, so when the current code is nearly spent the next one is
// minutes — not hours — away. Poll rather than sleep exactly, because the Host
// may have started mid-minute.
function waitForNext() {
  return new Promise(resolveWait => {
    const deadline = Date.now() + ROTATION_MS + 60 * 1000
    const poll = setInterval(() => {
      const candidate = readNewest()
      if (candidate.code !== null) {
        // A half-written state file or a ticket the Host rotated mid-read parses as
        // garbage. Letting that throw inside a setInterval callback kills the whole
        // process; just skip this round and try again on the next tick.
        let exp = Number.NaN
        try {
          const ticket = JSON.parse(Buffer.from(candidate.code, 'base64url').toString('utf8'))
          exp = Date.parse(ticket.exp)
        } catch {
          exp = Number.NaN
        }
        if (Number.isFinite(exp) && exp - Date.now() >= minLeftMin * 60 * 1000) {
          clearInterval(poll)
          resolveWait(true)
        }
      }
      if (Date.now() > deadline) {
        clearInterval(poll)
        resolveWait(false)
      }
    }, 2000)
  })
}

let { code, line } = readNewest()
const ticketOf = text => JSON.parse(Buffer.from(text, 'base64url').toString('utf8'))
let ticket = ticketOf(code)
let remainingMs = Date.parse(ticket.exp) - Date.now()

process.stderr.write(`host     ${ticket.name}\n`)
process.stderr.write(`endpoints ${JSON.stringify(ticket.lan)}\n`)
process.stderr.write(`printed  ${line.slice(0, 31)}\n`)

if (!(remainingMs > 0)) {
  // An expired code means the plugin stopped rotating, which is a real fault
  // worth reporting rather than papering over.
  process.stderr.write(`code expired ${Math.round(-remainingMs / 60000)} min ago; the Host rotates it every 10 minutes\n`)
  process.exit(2)
}

if (shouldWait && remainingMs < minLeftMin * 60 * 1000) {
  process.stderr.write(`only ${Math.round(remainingMs / 60000)} min left; waiting for the next rotation…\n`)
  const arrived = await waitForNext()
  if (!arrived) {
    process.stderr.write('no new code appeared; the pairing-code rotation timer looks stopped\n')
    process.exit(3)
  }
  ;({ code, line } = readNewest())
  ticket = ticketOf(code)
  remainingMs = Date.parse(ticket.exp) - Date.now()
  process.stderr.write(`printed  ${line.slice(0, 31)}\n`)
}

process.stderr.write(`expires  ${ticket.exp} (${Math.round(remainingMs / 60000)} min left)\n`)

// Same settings as packages/dsh_arkts/tools/pair-qr.mjs: level M survives a phone
// held at an angle, and the four-module quiet zone is what makes the camera lock
// on instead of hunting for the finder patterns.
const { default: QRCode } = await import('../packages/dsh_arkts/node_modules/qrcode/lib/index.js')
const text = `pocketharness://pair?t=${code}`
const buffer = await QRCode.toBuffer(text, {
  type: 'png',
  errorCorrectionLevel: 'M',
  margin: 4,
  width: Number.isFinite(width) && width > 0 ? width : 760,
})

mkdirSync(dirname(outPng), { recursive: true })
writeFileSync(outPng, buffer)
process.stderr.write(`wrote ${outPng} (${buffer.length} bytes, ${width}px)\n`)
