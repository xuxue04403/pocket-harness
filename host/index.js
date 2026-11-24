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

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { networkInterfaces } from 'node:os'

import { credentialKey } from './credentials-key.js'
import { createTicket, encodeTicket, PAIRING_TICKET_TTL_MS, ticketToJson } from './pairing.js'
import { INSTRUCTIONS_NAMESPACE, serveInstructions } from './instructions.js'
import { LinkServer, pairingProof } from './link.js'
import { newDeviceId } from './ids.js'
import { x25519PrivateToPublic } from './noise.js'
import { RelayDialer } from './relay-client.js'
import { encodeMatrix } from './qr_encode.js'

export const name = 'pocket-harness'

/** Services this plugin needs before it can serve a phone. */
export const inject = ['typertGateway', 'credentials']

/** Default TCP port; 0 asks the kernel for any free port. */
const DEFAULT_PORT = 48100

/** How the Host stores its own state inside the credentials service. */
const RECORD_SCOPE = 'dsh-pocketharness-host'
const RECORD_ID = 'identity'

/**
 * Where the pairing code is served.
 *
 * Under `/api/` like the other first-party routes, because that prefix is where the
 * shell's shared connection already applies its Host and Origin checks and its
 * browser authentication — a route outside it would have to re-earn all three.
 */
const PAGE_PATH = '/api/pocket-harness/pair'

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
    relayToken: config.relayToken ?? null,
  })
  let server = null
  let starting = null
  let dialer = null
  // Bumped by stop(). A start that began before the bump has lost its owner and
  // must undo whatever it bound, no matter how far along it has come: assigning
  // `server` happens before the port is bound, so `server !== current` is not a
  // usable signal — this counter is.
  let epoch = 0

  /** Opens the listener once, remembering the promise so calls can await it. */
  const start = () => {
    if (starting !== null) return starting
    const mine = ++epoch
    const started = (async () => {
      const identity = await state.identity()
      // stop() may have run while the identity was still being read. Nothing has
      // been bound yet, so the cheapest correct answer is to come up empty rather
      // than to create a listener the Harness no longer owns.
      if (epoch !== mine) return null
      const current = new LinkServer({
        identity,
        createGateway: peer => gatewayFor(ctx, peer),
        authorize: request => state.authorize(request),
        logger: ctx.logger,
        hostName: config.hostName ?? 'Pocket Harness Host',
      })
      server = current
      // A profile that never picked a port must still come up when 48100 is
      // taken, because the alternative is a plugin that silently serves nobody.
      // An explicitly configured port is honoured strictly: moving away from a
      // port the operator opened in a firewall would look like a broken install.
      const wanted = config.port
      const port = await current.listen({
        port: wanted ?? DEFAULT_PORT,
        host: config.bindHost ?? '0.0.0.0',
        fallbackToAnyPort: wanted === undefined,
      })
      // A stop() that arrived while the port was being bound already gave up on
      // this start. Without this check the socket would stay bound with nothing
      // holding a reference to it: the port would be taken for the life of the
      // process, a later start would land on a random port, and no pairing code
      // would ever name the address people are actually able to dial.
      if (epoch !== mine) {
        await current.close()
        return current
      }
      ctx.logger?.info?.(`pocket-harness: link server listening on port ${port}`)
      dialer = await startRelay(ctx, config, state, current)
      return current
    })()
    starting = started
    return started
  }

  /** Releases the port, the relay dial and every live phone link. */
  const stop = async () => {
    const current = server
    const currentDialer = dialer
    const pending = starting
    epoch += 1
    server = null
    dialer = null
    starting = null
    if (pending !== null) {
      // A start that is still binding must finish before the port can be called
      // released. It notices the epoch moved on and closes what it bound; waiting
      // here only makes the ordering explicit.
      await pending.catch(() => undefined)
    }
    if (currentDialer !== null) await currentDialer.close()
    if (current !== null) {
      await current.close()
      ctx.logger?.info?.('pocket-harness: link server stopped')
    }
  }

  // A restarted plugin must not leave the old port bound.
  ctx.effect(() => () => {
    // Teardown runs while the Harness is unloading this plugin, and an unhandled
    // rejection here would end that process instead of just leaving a port busy.
    // A stop that throws is logged and otherwise ignored.
    Promise.resolve()
      .then(() => stop())
      .catch(error => {
        ctx.logger?.warn?.(`pocket-harness: could not stop cleanly (${error?.message ?? error})`)
      })
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
    // A code for a listener that has already been stopped — or one that never
    // came up because it was unloaded while starting — would send people to a
    // closed port, and its refresh timer would outlive the plugin.
    if (current === null || server !== current) return
    const ticket = await state.newTicket(current.port)
    if (server !== current) return
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

  // Lets the phone page show the current code instead of people fishing the log
  // out of a terminal. The route only serves loopback: the code contains the
  // pairing secret, so anything that can read it can pair a new phone.
  //
  // A host without a web server is a legitimate deployment — the link listener is
  // the whole point of this plugin, and the page is a convenience — so a missing
  // service is not an error here, and neither is a bare test context that has no
  // `inject` to ask it through.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], host => {
      host.effect(
        () =>
          host.webServer.register({
            kind: 'exact',
            path: PAGE_PATH,
            handler: (request, response) => servePage(state, request, response),
          }),
        'pocket-harness: pairing page',
      )
    })
  }
}

/**
 * Joins a relay, when the profile configured one.
 *
 * A relay is what lets a phone reach this Host across the internet without a
 * public address: the Host dials out, so no port is opened and no router is
 * touched. The room name is kept with the Host identity because the pairing code
 * hands it to the phone, and it must survive restarts so a code already on
 * screen keeps working. The token is the operator's, not ours.
 *
 * The relay only ever sees Noise ciphertext; the token stops a stranger who
 * guessed a room name from taking the slot.
 *
 * A relay address without a token is a configuration mistake that would make
 * every dial fail, so it is reported once and the LAN listener keeps working.
 */
async function startRelay(ctx, config, state, server) {
  const url = config.relayUrl
  if (typeof url !== 'string' || url.length === 0) return null
  if (!state.advertisesRelay) {
    ctx.logger?.warn?.('pocket-harness: relayUrl is set but relayToken is missing; the LAN listener still works')
    return null
  }
  const room = await state.relayRoom()
  const token = state.relayToken()
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
    invoke: request => {
      if (request.namespace === INSTRUCTIONS_NAMESPACE) {
        return Promise.resolve().then(() => serveInstructions(request))
      }
      return gateway.invoke({ ...request, peer })
    },
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
  #relayToken
  #loaded = null

  /**
   * The most recent ticket, kept so the phone page can render it.
   *
   * It is a separate copy rather than a second read of the credentials record on
   * purpose: the page asks whenever it repaints, and re-deriving a ticket (which
   * mints a new secret when the old one lapsed) on every paint would rotate the
   * code out from under a phone that is already scanning.
   */
  #ticket = null

  constructor(ctx, { hostName, relayUrl = null, relayToken = null } = {}) {
    this.#ctx = ctx
    this.#hostName = hostName
    this.#relayUrl = typeof relayUrl === 'string' && relayUrl.length > 0 ? relayUrl : null
    this.#relayToken = typeof relayToken === 'string' && relayToken.length > 0 ? relayToken : null
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
    record.relay = { ...record.relay, room: randomBytes(16).toString('hex') }
    await this.#save(record)
    return record.relay.room
  }

  /**
   * The shared secret a relay requires before it forwards anything.
   *
   * This is the operator's token, not something this Host invents: the relay
   * compares it against the value it was started with, so a locally generated
   * secret could never match and every dial would be refused. A Host with a
   * relay address but no token is misconfigured, and says so instead of
   * generating a secret that cannot work.
   */
  relayToken() {
    if (this.#relayToken === null) {
      throw new Error('a relay address needs the matching relayToken in this profile')
    }
    return this.#relayToken
  }

  /** Whether a pairing code can offer a relay at all. */
  get advertisesRelay() {
    return this.#relayUrl !== null && this.#relayToken !== null
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
    const relay = {}
    if (this.advertisesRelay) {
      relay.relayUrl = this.#relayUrl
      relay.relayRoom = await this.relayRoom()
      relay.relayToken = this.relayToken()
    }
    const ticket = createTicket({
      hostDeviceId: identity.deviceId,
      hostPublicKey: identity.publicKey,
      hostName: this.#hostName,
      lanEndpoints: lanEndpoints(port),
      ...relay,
      pairingSecret: record.pairing.secret,
      ttlMs: record.pairing.expiresAt - now,
    })
    // Remembered so the phone page can show the code the log just showed, without
    // minting a second one whose secret would immediately supersede this one.
    this.#ticket = ticket
    return ticket
  }

  /**
   * The code most recently published, or null before the first one.
   *
   * Read-only by design: a page that repaints every second must not be able to
   * rotate the secret just by looking at it.
   */
  get latestTicket() {
    return this.#ticket
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
    // Constant time, for the same reason the relay compares its token that way:
    // `!==` on strings stops at the first differing character, so a caller willing
    // to time a few thousand attempts can recover the expected proof one byte at a
    // time and then replay it. Equal lengths are required by timingSafeEqual, and
    // are themselves not a secret — every proof this Host accepts is 43 base64url
    // characters long.
    if (!sameProof(proof, expected)) return { ok: false, reason: 'bad-proof' }

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
      // Same rule as the listener teardown: disposing a Peer is bookkeeping, and a
      // rejection from it must not take the Harness down while unloading.
      Promise.resolve()
        .then(() => peer.dispose?.())
        .catch(error => {
          this.#ctx.logger?.warn?.(`pocket-harness: could not dispose a phone Peer (${error?.message ?? error})`)
        })
    }, 'pocket-harness: phone Peer lifetime')
    return peer
  }
}

/**
 * Compares a pairing proof with the one this Host expects, in constant time.
 *
 * `timingSafeEqual` needs equal lengths, so the length check comes first. That
 * check is safe to be early: every proof is a base64url HMAC-SHA256 digest and
 * therefore always 43 characters, so the length tells an attacker nothing about
 * the value.
 *
 * Exported so a test can pin the edge cases a refactor could break: a difference
 * in the last character must be rejected exactly like one in the first, and a
 * non-string must never reach the compare at all.
 */
export function sameProof(actual, expected) {
  if (typeof actual !== 'string') return false
  const left = Buffer.from(actual, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
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

/**
 * Loopback only.
 *
 * The page contains the pairing secret: anything that can read it can pin a phone
 * of its own, so it is not offered to the network the Host is listening on. A
 * person at the keyboard reaches it through `127.0.0.1` from the Web GUI anyway.
 */
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function isLoopbackHost(request) {
  return LOOPBACK_NAMES.has(String(request.headers.host ?? '').toLowerCase().replace(/:\d+$/, ''))
}

/**
 * Reduces `host:port` to one spelling of loopback, so `localhost` and `127.0.0.1`
 * count as the same reader while another local process on a different port does
 * not. Returns null for anything that is not a loopback authority.
 */
function loopbackAuthority(authority) {
  const lowered = String(authority).toLowerCase()
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(lowered)
  if (match === null) return null
  const name = match[1] ?? ''
  if (!LOOPBACK_NAMES.has(name)) return null
  const port = match[2] ?? ''
  return `loopback:${port}`
}

/**
 * Refuses a cross-site page: another origin must not read this code via XHR.
 *
 * A missing Origin means a local native client, which could forge any header
 * anyway, so dropping the check there costs nothing. The desktop app is the case
 * worth naming: its page runs under the host's own `dsh-app:` protocol, so the
 * origin can never equal the Host header — but only the host itself can mint that
 * scheme, so accepting it does not widen what a web page can do.
 */
function isSameOriginRequest(request) {
  const origin = request.headers.origin
  if (origin === undefined || origin === '') return true
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol === 'dsh-app:') return true
  const mine = loopbackAuthority(request.headers.host)
  return mine !== null && loopbackAuthority(parsed.host) === mine
}

/**
 * Serves the pairing page: one code, its countdown, and how to use it.
 *
 * Returns 404 rather than 403 for a non-loopback caller, so a page that is
 * scanning ports learns nothing about what lives here.
 */
function servePage(state, request, response) {
  if (!isLoopbackHost(request) || !isSameOriginRequest(request)) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found\n')
    return
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
    response.end('method not allowed\n')
    return
  }
  // The settings card asks for JSON so it can repaint in place; a person who opens
  // the URL in a tab gets the page. Same data, same gate.
  const wantsJson = new URL(request.url ?? '/', 'http://placeholder').searchParams.get('format') === 'json'
  if (wantsJson) {
    const ticket = state.latestTicket
    const body = JSON.stringify(pairingSnapshot(ticket))
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    response.end(request.method === 'HEAD' ? undefined : body)
    return
  }
  const body = pairingPageHtml(state)
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    // The code itself must not be cached: a stale page would show a dead secret.
    'cache-control': 'no-store',
    // No external resources and no framing: the page holds a secret.
    'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
  })
  response.end(request.method === 'HEAD' ? undefined : body)
}

/**
 * What the settings card needs, and nothing more.
 *
 * The ticket text is included because the card draws the code itself; the QR is
 * not pre-rendered here so the browser does not have to trust an SVG string from
 * the server, and so a repaint costs one matrix instead of one string.
 */
function pairingSnapshot(ticket) {
  if (ticket === null) {
    return { ready: false, ticket: null, name: null, endpoints: [], expiresAt: null, size: 0, path: '' }
  }
  const json = ticketToJson(ticket)
  const { cells, version } = encodeMatrix(encodeTicket(ticket))
  return {
    ready: true,
    ticket: encodeTicket(ticket),
    name: typeof json.name === 'string' ? json.name : 'Pocket Harness Host',
    endpoints: Array.isArray(json.lan) ? json.lan : [],
    expiresAt: typeof json.exp === 'string' ? json.exp : null,
    version,
    size: cells.length,
    path: qrPath(cells),
  }
}

/** The dark modules of a matrix, as one SVG path. */
function qrPath(cells) {
  let path = ''
  for (let row = 0; row < cells.length; row += 1) {
    for (let column = 0; column < cells.length; column += 1) {
      if (cells[row][column]) path += `M${column} ${row}h1v1h-1z`
    }
  }
  return path
}

/** Escapes text that goes into the page. */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => {
    switch (character) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

/**
 * The QR code as one SVG path.
 *
 * A path of unit squares rather than a matrix of `<rect>`s: a version 13 symbol is
 * 69x69, and that many elements makes a page that is slow to paint for no gain.
 */
function qrSvg(ticketText) {
  const { cells, version } = encodeMatrix(ticketText)
  const size = cells.length
  return (
    `<svg viewBox="0 0 ${size} ${size}" width="320" height="320" role="img" ` +
    `aria-label="配对二维码" shape-rendering="crispEdges" data-version="${version}">` +
    `<rect width="${size}" height="${size}" fill="#ffffff"/>` +
    `<path d="${qrPath(cells)}" fill="#000000"/>` +
    `</svg>`
  )
}

/**
 * The page itself.
 *
 * One string rather than a template file so the plugin keeps its "no files beyond
 * the module" shape. The countdown is the only script: it re-asks the Host when the
 * code lapses instead of trusting a clock that may have been asleep.
 */
function pairingPageHtml(state) {
  const ticket = state.latestTicket
  if (ticket === null) {
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Pocket Harness</title>` +
      `<body style="font:16px/1.6 system-ui;padding:32px;max-width:520px;margin:auto">` +
      `<h1 style="font-size:20px">配对</h1>` +
      `<p>链接服务还没起来。稍等一下再刷新这个页面。</p>` +
      `</body></html>`
  }
  const text = encodeTicket(ticket)
  const json = ticketToJson(ticket)
  const expiresAt = typeof json.exp === 'string' ? json.exp : null
  const endpoints = Array.isArray(json.lan) ? json.lan : []
  const remaining = expiresAt === null ? 0 : Math.max(0, Date.parse(expiresAt) - Date.now())
  const minutes = Math.floor(remaining / 60000)
  const seconds = Math.floor((remaining % 60000) / 1000)
  const countdown = `${minutes}:${String(seconds).padStart(2, '0')}`
  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>配对 Pocket Harness</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 28px 20px 40px; }
  main { max-width: 520px; margin: 0 auto; }
  h1 { font-size: 19px; margin: 0 0 4px; }
  p.sub { margin: 0 0 22px; opacity: .68; }
  .card { display: flex; gap: 22px; align-items: center; flex-wrap: wrap; }
  .qr { background: #fff; padding: 14px; border-radius: 14px; box-shadow: 0 1px 3px rgba(0,0,0,.14); line-height: 0; }
  .meta { flex: 1 1 180px; min-width: 180px; }
  .meta dl { margin: 0; }
  .meta dt { font-size: 12px; opacity: .6; margin-top: 10px; }
  .meta dd { margin: 1px 0 0; font-variant-numeric: tabular-nums; word-break: break-all; }
  .clock { font-size: 15px; opacity: .8; }
  ol { padding-left: 20px; margin: 26px 0 0; }
  ol li { margin-bottom: 6px; }
  code { font-size: 13px; }
</style>
<main>
  <h1>配对 Pocket Harness</h1>
  <p class="sub">在手机上打开 App，点右上角的扫码按钮，对准下面的二维码。</p>
  <div class="card">
    <div class="qr">${qrSvg(text)}</div>
    <div class="meta">
      <dl>
        <dt>这台电脑</dt><dd>${escapeHtml(json.name ?? 'Pocket Harness Host')}</dd>
        <dt>局域网地址</dt><dd>${endpoints.length > 0 ? endpoints.map(escapeHtml).join('<br>') : '（暂无）'}</dd>
        <dt>有效期</dt><dd class="clock" id="clock" data-expires="${escapeHtml(expiresAt ?? '')}">${countdown}</dd>
      </dl>
    </div>
  </div>
  <ol>
    <li>手机和这台电脑连同一个 Wi-Fi。</li>
    <li>App 里扫码，或把这串字符粘进「手动输入配对码」：<br><code>${escapeHtml(text.slice(0, 32))}…</code></li>
    <li>码每 10 分钟换一次，过期后刷新本页即可。</li>
  </ol>
</main>
<script>
  (function () {
    var node = document.getElementById('clock')
    if (!node) return
    var expires = Date.parse(node.getAttribute('data-expires') || '')
    function tick() {
      var left = Math.max(0, expires - Date.now())
      var m = Math.floor(left / 60000)
      var s = Math.floor((left % 60000) / 1000)
      node.textContent = m + ':' + (s < 10 ? '0' + s : s)
      // A lapsed code is no longer scannable; reloading fetches the next one the
      // Host published, rather than showing a countdown that has stopped meaning
      // anything.
      if (left === 0) { setTimeout(function () { location.reload() }, 1500); return }
      setTimeout(tick, 1000)
    }
    tick()
  }())
</script>
</html>`
}
