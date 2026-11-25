// Re-issuing a phone's address book entry after it has already paired.
//
// Why this exists: a pairing ticket is what a phone stores after scanning, and it
// carries the addresses the phone may dial — the LAN addresses and, when the Host
// advertises one, the relay. Those facts change. The laptop moves to another
// Wi-Fi, the relay gets configured for the first time, the LAN address is handed
// out differently by DHCP. Without this endpoint a phone keeps dialling whatever
// was true on the day it scanned, and "it worked at home but not on mobile data"
// is exactly what that looks like.
//
// The refreshed ticket deliberately carries no pairing secret. A secret proves
// the holder saw a code on the Host's screen, which is how a *new* phone is
// admitted; this caller has already been admitted by its pinned key, and handing
// it a live secret would let one trusted phone pair others.
//
// Everything here is plain node, so it tests without a running Harness.

import { encodeTicket, PAIRING_TICKET_VERSION } from './pairing.js'

/** The namespace the phone calls; also what the Host adapter branches on. */
export const PAIRING_NAMESPACE = 'pocketPairing'

/**
 * How long a refreshed entry stays usable.
 *
 * Long on purpose: this ticket grants no new access — it only reminds the phone
 * where the Host can be reached, and the phone re-earns admission with its pinned
 * key on every connect. A short life here would mean a phone that has not
 * connected in a week starts looking "expired" in the list for no good reason.
 */
export const PAIRED_TICKET_TTL_MS = 30 * 24 * 60 * 60 * 1000

function coded(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Serves one `pocketPairing/*` call.
 *
 * `issue(port)` is supplied by the Host so this module never has to know how a
 * listener is found, and so the port in the ticket is the one actually bound.
 * It is awaited because the Host has to read its credentials record and, when a
 * relay is advertised, its room — both asynchronous. Treating the promise as a
 * ticket is how this first shipped, and the symptom was a Buffer error from deep
 * inside the encoder rather than anything that named the real mistake.
 */
export async function servePairing(request, { issue } = {}) {
  switch (request?.method) {
    case 'refresh': {
      if (typeof issue !== 'function') {
        throw coded('UNAVAILABLE', `${PAIRING_NAMESPACE}/refresh needs a running link server`)
      }
      const ticket = await issue()
      return {
        v: PAIRING_TICKET_VERSION,
        ticket: encodeTicket(ticket),
        expiresAt: ticket.expiresAt === null ? null : new Date(ticket.expiresAt).toISOString(),
      }
    }
    default:
      throw coded('UNKNOWN_METHOD', `${PAIRING_NAMESPACE} has no method ${request?.method}`)
  }
}
