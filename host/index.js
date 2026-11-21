// Pocket Harness Host: lets a phone drive this harness over an encrypted LAN link.
//
// The plugin owns three things and nothing else:
//   1. its identity — one X25519 key pair plus the list of phones it trusts,
//   2. the link server — one TCP listener, admission, Noise IK, RPC framing,
//   3. a thin adapter that hands each phone RPC to the real Typert gateway.
//
// Because the adapter forwards `namespace/method` verbatim, every DSH Remote API
// (sessions, workspaces, terminal, jobs, settings) works on the phone without a
// single line of per-feature code here. New DSH features appear for free.
//
// Deliberately free of `@deepseek-ai/*` imports: those only resolve inside the
// running Harness, so avoiding them keeps this file testable from plain node.

import { randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'

import { credentialKey } from './credentials-key.js'
import { createTicket, encodeTicket, PAIRING_TICKET_TTL_MS } from './pairing.js'
import { LinkServer, pairingProof } from './link.js'
import { newDeviceId } from './ids.js'
import { x25519PrivateToPublic } from './noise.js'
import { RelayDialer } from './relay-client.js'

export const name = 'pocket-harness'

/** Services this plugin needs before it can serve a phone. */
export const inject = ['typertGateway', 'credentials']

/** Default TCP port; 0 asks the kernel for any free port. */
const DEFAULT_PORT = 48100

/** How the Host stores its own state inside the credentials service. */
const RECORD_SCOPE = 'dsh-pocketharness-host'
const RECORD_ID = 'identity'

/**
 * Starts the Host side of Pocket Harness.
 *
 * The listener is only opened when `config.enabled` is not `false`, so a profile
 * can ship the plugin switched off and turn it on from the settings UI.
 */
export function apply(ctx, config = {}) {
  const enabled = config.enabled !== false
  if (!enabled) {
    ctx.logger?.info?.('pocket-harness: disabled by configuration')
    return
  }

  const state = new HostState(ctx, {
    hostName: config.hostName ?? 'Pocket Harness Host',
    relayUrl: config.relayUrl ?? null,
  })
  let server = null
  let starting = null
  let dialer = null

  /** Opens the listener once, remembering the promise so calls can await it. */
  const start = () => {
    if (starting !== null) return starting
    starting = (async () => {
      const identity = await state.identity()
      server = new LinkServer({
        identity,
        createGateway: peer => gatewayFor(ctx, peer),
        authorize: request => state.authorize(request),
        logger: ctx.logger,
        hostName: config.hostName ?? 'Pocket Harness Host',
      })
      const port = await server.listen({ port: config.port ?? DEFAULT_PORT, host: config.bindHost ?? '0.0.0.0' })
      ctx.logger?.info?.(`pocket-harness: link server listening on port ${port}`)
      dialer = await startRelay(ctx, config, state, server)
      return server
    })()
    return starting
  }

  /** Releases the port, the relay dial and every live phone link. */
  const stop = async () => {
    const current = server
    const currentDialer = dialer
    server = null
    dialer = null
    starting = null
    if (currentDialer !== null) await currentDialer.close()
    if (current !== null) {
      await current.close()
      ctx.logger?.info?.('pocket-harness: link server stopped')
    }
  }

  // A restarted plugin must not leave the old port bound.
  ctx.effect(() => () => {
    void stop()
  }, 'pocket-harness: link server lifetime')

  let refresh = null
  ctx.effect(() => () => {
    if (refresh !== null) clearTimeout(refresh)
  }, 'pocket-harness: pairing code rotation')

  // The pairing code is the only thing a new phone needs. Publish one now and
  // publish a fresh one whenever it lapses, so a person who comes back to the
  // Host later still finds a usable code instead of a dead one in the log.
  // Already-paired phones are unaffected: they are admitted by pinned key and
  // never look at this secret again.
  const publishCode = async current => {
    const ticket = await state.newTicket(current.port)
    ctx.logger?.info?.(`pocket-harness: pairing code ${encodeTicket(ticket)}`)
    const remaining = Math.max(1000, (ticket.expiresAt ?? Date.now()) - Date.now())
    refresh = setTimeout(() => {
      void publishCode(current).catch(error => {
        ctx.logger?.warn?.(`pocket-harness: could not refresh the pairing code (${error.message})`)
      })
    }, remaining)
    // Do not hold the host process open just for a code nobody may need.
    refresh.unref?.()
  }

  void start()
    .then(current => publishCode(current))
    .catch(error => {
      ctx.logger?.warn?.(`pocket-harness: could not start the link server (${error.message})`)
    })
}

/**
 * Joins a relay, when the profile configured one.
 *
 * A relay is what lets a phone reach this Host across the internet without a
 * public address: the Host dials out, so no port is opened and no router is
 * touched. The room name and token are kept with the Host identity because they
 * are what the pairing code hands to the phone, and they must survive restarts
 * so a code already on screen keeps working.
 *
 * The relay only ever sees Noise ciphertext; the token stops a stranger who
 * guessed a room name from taking the slot.
 */
async function startRelay(ctx, config, state, server) {
  const url = config.relayUrl
  if (typeof url !== 'string' || url.length === 0) return null
  const room = await state.relayRoom()
  const token = await state.relayToken()
  const dialer = new RelayDialer({
    url,
    room,
    token,
    logger: ctx.logger,
    onTransport: transport => {
      ctx.logger?.info?.('pocket-harness: relay connection handed to the link server')
      server.attach(transport)
    },
  })
  dialer.start()
  return dialer
}

/**
 * Adapts one phone Peer to the Typert gateway the rest of DSH already speaks.
 *
 * `invoke`/`stream` cover ordinary `namespace/method` endpoints. The Gateway's
 * own names (`$events`, `$events/result`) are not business pairs, so they need
 * the carrier seam underneath: `dispatchRpc` for unary results and
 * `openWireStream` for streams. Both are undocumented internals, hence the
 * runtime shape checks and the graceful "unsupported" fallback.
 */
function gatewayFor(ctx, peer) {
  const gateway = ctx.typertGateway
  return {
    invoke: request => gateway.invoke({ ...request, peer }),
    stream: request => gateway.stream({ ...request, peer }),
    dispatch: (endpoint, payload, signal) => {
      const dispatchRpc = gateway.dispatchRpc
      if (typeof dispatchRpc !== 'function') {
        return Promise.resolve({
          ok: false,
          error: {
            code: 'UNSUPPORTED',
            message: 'this Harness build does not expose the Gateway carrier dispatcher',
            details: {},
          },
        })
      }
      return dispatchRpc.call(gateway, endpoint, payload, signal ?? new AbortController().signal, peer)
    },
    open: async (endpoint, payload, signal) => {
      const openWireStream = gateway.openWireStream
      if (typeof openWireStream !== 'function') {
        throw new Error('this Harness build does not expose the Gateway carrier stream opener')
      }
      // Harness 0.2.x moved the signal from slot 3 to slot 5 and added the peer
      // and a control controller; older builds keep `(endpoint, payload, signal)`.
      const control = new AbortController()
      const abort = () => control.abort(signal.reason)
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
      return openWireStream.length >= 5
        ? openWireStream.call(gateway, endpoint, payload, endedUplink(), peer, signal, control)
        : openWireStream.call(gateway, endpoint, payload, signal)
    },
  }
}

/** An uplink nobody sends on, so a Gateway-owned stream opens without buffering. */
function endedUplink() {
  return {
    [Symbol.asyncIterator]() {
      return { next: () => Promise.resolve({ done: true, value: undefined }) }
    },
  }
}

/**
 * This Host's identity and its trusted phones.
 *
 * Everything lives in the credentials service: private keys are secrets, and the
 * paired-phone list is a grant record. Nothing is written to the profile config,
 * which the plugin must never touch.
 */
class HostState {
  #ctx
  #hostName
  #relayUrl
  #loaded = null

  constructor(ctx, { hostName, relayUrl = null } = {}) {
    this.#ctx = ctx
    this.#hostName = hostName
    this.#relayUrl = typeof relayUrl === 'string' && relayUrl.length > 0 ? relayUrl : null
  }

  get #key() {
    return credentialKey(RECORD_SCOPE, RECORD_ID)
  }

  /** Reads the stored state, creating a fresh identity on first use. */
  async #record() {
    if (this.#loaded !== null) return this.#loaded
    this.#loaded = (async () => {
      const store = this.#ctx.credentials
      if (store === undefined) throw new Error('the credentials service is unavailable')
      const existing = await store.readRecord(this.#key)
      const payload = existing?.kind === 'grant' ? existing.payload : null
      if (payload !== null && typeof payload.privateKey === 'string') return payload

      const privateKey = randomBytes(32)
      const created = {
        deviceId: newDeviceId(),
        privateKey: Buffer.from(privateKey).toString('base64url'),
        // The pairing secret lives with its expiry so a stale code cannot be
        // replayed after the person let it lapse.
        pairing: { secret: randomBytes(24).toString('base64url'), expiresAt: 0 },
        paired: {},
      }
      await this.#save(created)
      return created
    })()
    return this.#loaded
  }

  /** Persists the whole state; the credentials service is the only writer. */
  async #save(payload) {
    this.#loaded = Promise.resolve(payload)
    await this.#ctx.credentials.modifyRecord(this.#key, async () => ({ kind: 'grant', payload }))
  }

  /** The key pair and device id a phone sees in its pairing code. */
  async identity() {
    const record = await this.#record()
    const privateKey = Buffer.from(record.privateKey, 'base64url')
    return { deviceId: record.deviceId, privateKey, publicKey: x25519PrivateToPublic(privateKey) }
  }

  /**
   * The relay room this Host occupies, created on first use.
   *
   * It is stored beside the identity rather than regenerated, because the QR code
   * on screen embeds it: a restart must not silently orphan a code the person is
   * about to scan.
   */
  async relayRoom() {
    const record = await this.#record()
    if (typeof record.relay?.room === 'string' && record.relay.room.length > 0) return record.relay.room
    const relay = { room: randomBytes(16).toString('hex'), token: randomBytes(24).toString('base64url') }
    record.relay = relay
    await this.#save(record)
    return relay.room
  }

  /** The shared secret a relay requires before it forwards anything. */
  async relayToken() {
    const record = await this.#record()
    if (typeof record.relay?.token === 'string' && record.relay.token.length > 0) return record.relay.token
    await this.relayRoom()
    const latest = await this.#record()
    return latest.relay.token
  }

  /**
   * Builds a fresh pairing code.
   *
   * The secret is rotated whenever the previous code expired, so a screenshot of
   * an old code stops working, while phones that already paired are unaffected:
   * they are admitted by their pinned key and never touch this secret again.
   */
  async newTicket(port) {
    const record = await this.#record()
    const identity = await this.identity()
    const now = Date.now()
    const current = record.pairing
    const fresh = typeof current?.secret === 'string' && current.secret.length > 0 && current.expiresAt > now
    if (!fresh) {
      record.pairing = { secret: randomBytes(24).toString('base64url'), expiresAt: now + PAIRING_TICKET_TTL_MS }
      await this.#save(record)
    }
    // A relay is only advertised when one is configured, so a code never sends a
    // phone hunting for a service that is not there.
    const relay = this.#relayUrl === null ? {} : { relayUrl: this.#relayUrl }
    if (this.#relayUrl !== null) {
      relay.relayRoom = await this.relayRoom()
      relay.relayToken = await this.relayToken()
    }
    return createTicket({
      hostDeviceId: identity.deviceId,
      hostPublicKey: identity.publicKey,
      hostName: this.#hostName,
      lanEndpoints: lanEndpoints(port),
      ...relay,
      pairingSecret: record.pairing.secret,
      ttlMs: record.pairing.expiresAt - now,
    })
  }
  /**
   * Decides whether an inbound hello may proceed.
   *
   * A phone that is already trusted is admitted on its device id alone and then
   * pinned to the key it proves during the Noise handshake. A new phone must
   * present a valid proof, which only someone holding the pairing code can do.
   */
  async authorize({ connectionId, clientDeviceId, proof }) {
    const record = await this.#record()
    const createPeer = () => this.#createPeer()
    const trusted = record.paired[clientDeviceId]

    if (typeof trusted === 'string' && trusted.length > 0) {
      return {
        ok: true,
        pinnedKey: Buffer.from(trusted, 'base64url'),
        createPeer,
        pinKey: async () => {},
      }
    }

    if (typeof proof !== 'string') return { ok: false, reason: 'not-paired' }
    const pairing = record.pairing
    if (typeof pairing?.secret !== 'string' || !(pairing.expiresAt > Date.now())) {
      return { ok: false, reason: 'pairing-expired' }
    }
    const expected = pairingProof(pairing.secret, connectionId, clientDeviceId).toString('base64url')
    if (proof.length !== expected.length || proof !== expected) return { ok: false, reason: 'bad-proof' }

    return {
      ok: true,
      pinnedKey: null,
      createPeer,
      // Called once the handshake proved which key the phone really holds.
      pinKey: async remoteStatic => {
        const latest = await this.#record()
        latest.paired[clientDeviceId] = Buffer.from(remoteStatic).toString('base64url')
        await this.#save(latest)
        this.#ctx.logger?.info?.('pocket-harness: pinned a new phone')
      },
    }
  }

  /**
   * Creates the Peer a phone's calls are attributed to.
   *
   * `owner` is what DSH requires for full access, and this plugin only ever
   * reaches this point after the Noise handshake proved the caller holds the key
   * the pairing code bound it to — the identity is established here, in-process,
   * and no wire field can influence it.
   */
  async #createPeer() {
    const connection = this.#ctx.get('connection', false)
    if (connection === undefined || typeof connection.createPeer !== 'function') {
      throw new Error('the connection service cannot create a Peer')
    }
    const peer = connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' })
    this.#ctx.effect(() => () => {
      void peer.dispose?.()
    }, 'pocket-harness: phone Peer lifetime')
    return peer
  }
}

/**
 * Every address a phone on the same network could dial.
 *
 * Loopback is included so a phone that runs inside an emulator on this machine
 * (which reaches the Host through `10.0.2.2` or, for a plain port forward,
 * `127.0.0.1`) can connect while developing.
 */
function lanEndpoints(port) {
  const addresses = new Set(['127.0.0.1'])
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue
      if (entry.family !== 'IPv4') continue
      addresses.add(entry.address)
    }
  }
  return [...addresses].map(address => `${address}:${port}`)
}
