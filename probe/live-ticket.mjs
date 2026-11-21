// Builds a pairing ticket for the *running* Harness from its stored identity.
//
// The plugin prints its pairing code once at startup; this script exists so the
// live integration test can pair without scraping a log. It reads the identity
// record the plugin wrote into the credentials store, derives the public key from
// the stored private key, and emits the same `pocketharness://pair?...` text a QR
// code would carry.
//
// The ticket contains the pairing secret, so it is written to a file rather than
// printed: the test reads that file, and nothing secret reaches the terminal.

import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { x25519PrivateToPublic } from '../host/noise.js'
import { createTicket, encodeTicket } from '../host/pairing.js'

const store = join(homedir(), '.dsh', '.credentials.yaml')
const text = readFileSync(store, 'utf8')

/** Reads one indented `key: value` line inside the plugin's record block. */
function field(block, name) {
  const match = new RegExp(`^\\s+${name}:\\s*(.+)$`, 'm').exec(block)
  return match === null ? null : match[1].trim()
}

const start = text.indexOf('dsh-pocketharness-host/identity:')
if (start < 0) throw new Error('the plugin has no stored identity yet; start the Harness once with the plugin enabled')
const block = text.slice(start)

const deviceId = field(block, 'deviceId')
const privateKey = field(block, 'privateKey')
const secret = field(block, 'secret')
const expiresAt = Number(field(block, 'expiresAt'))

if (deviceId === null || privateKey === null) throw new Error('the stored identity is incomplete')
if (secret === null) throw new Error('the stored identity has no pairing secret')
if (!(expiresAt > Date.now())) {
  throw new Error('the stored pairing secret has expired; restart the Harness to rotate it')
}

const key = Buffer.from(privateKey, 'base64url')
const ticket = createTicket({
  hostDeviceId: deviceId,
  hostPublicKey: x25519PrivateToPublic(key),
  hostName: 'live-harness',
  lanEndpoints: ['127.0.0.1:48100'],
  pairingSecret: secret,
  ttlMs: expiresAt - Date.now(),
})

const out = process.argv[2] ?? join(import.meta.dirname, '_live-ticket.txt')
writeFileSync(out, `${encodeTicket(ticket)}\n`, 'utf8')
process.stderr.write(`wrote a pairing ticket to ${out}\n`)
