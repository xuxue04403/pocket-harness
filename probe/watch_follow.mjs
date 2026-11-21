// Watches one session's follow stream and prints frame kinds as they arrive,
// so the phone-side renderer can be checked against what DSH actually sends.
import { readFileSync } from 'node:fs'

const { PairingTicket } = await import('../packages/dsh_link/does-not-exist.js').catch(() => ({}))
void PairingTicket

const sessionId = process.argv[2]
const ticketText = readFileSync(new URL('./_live-ticket.txt', import.meta.url), 'utf8').trim()
const ticket = JSON.parse(Buffer.from(new URL(ticketText).searchParams.get('t'), 'base64url').toString('utf8'))
process.stdout.write(`host=${ticket.name ?? ticket.id} session=${sessionId}\n`)
