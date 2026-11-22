// The Host's side of a phone link: one TCP connection, one peer, one RPC server.
//
// Everything here is transport and admission — the business methods live in the
// DSH gateway this server forwards to, so a new DSH feature needs no change in
// this file. The class is deliberately free of Cordis imports so it can be
// exercised from plain node, which is how the loopback probe tests it.

import { createHmac } from 'node:crypto'
import net from 'node:net'

import { FRAME_KIND, decodeFrame, encodeFrame } from './frames.js'
import { FramedSocket } from './framed-socket.js'
import { isDeviceId } from './ids.js'
import { NoiseIkResponder, createNoisePrologue } from './noise.js'
import { formatEndpoint } from './pairing.js'
import { RpcServer } from './rpc.js'
import { SecureChannel } from './secure-channel.js'

/** How long a fresh connection may stay silent before the first hello frame. */
export const HELLO_TIMEOUT_MS = 8_000
/** How many phone connections one Host serves at once. */
export const MAX_CONNECTIONS = 8
/** Version of the plaintext hello exchange. */
const HELLO_VERSION = 1

/**
 * Proof that a client scanned the pairing code.
 *
 * The secret itself never crosses the wire: both ends derive the same tag from
 * it, the connection id and the client id, so a sniffer learns nothing reusable.
 * Replaying the tag gets an attacker past admission but not past Noise — they
 * would still need the client's static private key to finish the handshake.
 */
export function pairingProof(secret, connectionId, clientDeviceId) {
  return createHmac('sha256', secret)
    .update(`v1\u0000${connectionId}\u0000${clientDeviceId}`, 'utf8')
    .digest()
}

/**
 * Accepts phone connections and serves one RPC peer per connection.
 *
 * `createGateway(peer)` returns `{invoke, stream}` bound to that connection's
 * Peer; `authorize(request)` decides whether an inbound hello may proceed.
 */
export class LinkServer {
  #identity
  #createGateway
  #authorize
  #logger
  #hostName
  #server = null
  #links = new Set()
  #port = 0

  constructor({ identity, createGateway, authorize, logger, hostName }) {
    this.#identity = identity
    this.#createGateway = createGateway
    this.#authorize = authorize
    this.#logger = logger
    this.#hostName = hostName
  }

  /** Port actually bound, or 0 while not listening. */
  get port() {
    return this.#port
  }

  get connections() {
    return this.#links.size
  }

  /** @internal — collaborators handed to each accepted link. */
  get internals() {
    return {
      identity: this.#identity,
      createGateway: this.#createGateway,
      authorize: this.#authorize,
      logger: this.#logger,
      hostName: this.#hostName,
    }
  }

  /**
   * Starts listening.
   *
   * [host] defaults to all interfaces so a phone on the LAN can reach it; pass
   * `127.0.0.1` to keep the port private to this machine.
   *
   * [fallbackToAnyPort] decides what happens when the port is already taken.
   * With it set, a busy port costs the caller nothing: the kernel hands out a
   * free one and the pairing code carries the real number, so a phone still
   * finds this Host. Without it the error is the caller's to handle — which is
   * what an explicitly configured port should do, because silently moving away
   * from a port the operator opened in a firewall would look like a broken
   * install.
   */
  async listen({ port, host = '0.0.0.0', fallbackToAnyPort = false } = {}) {
    if (this.#server !== null) throw new Error('the link server is already listening')
    const server = net.createServer(socket => this.#accept(socket))
    server.on('error', error => this.#logger?.warn?.(`pocket-harness: link server error (${error.code ?? 'unknown'})`))
    const bind = wanted => new Promise((resolve, reject) => {
      const onError = error => {
        server.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(wanted, host)
    })
    try {
      await bind(port ?? 0)
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || !fallbackToAnyPort || port === undefined || port === 0) throw error
      this.#logger?.warn?.(
        `pocket-harness: port ${port} is already in use, listening on a free port instead `
        + '(the pairing code always carries the real port)',
      )
      await bind(0)
    }
    this.#server = server
    this.#port = server.address().port
    return this.#port
  }

  /** Endpoint a LAN client should dial, as `host:port`. */
  endpointFor(address) {
    return formatEndpoint(address, this.#port)
  }

  async close() {
    const server = this.#server
    this.#server = null
    this.#port = 0
    for (const link of [...this.#links]) await link.close()
    this.#links.clear()
    if (server !== null) {
      await new Promise(resolve => server.close(() => resolve()))
    }
  }

  #accept(socket) {
    if (this.#links.size >= MAX_CONNECTIONS) {
      socket.destroy()
      this.#logger?.warn?.('pocket-harness: refused a connection over the limit')
      return
    }
    socket.setNoDelay(true)
    socket.setKeepAlive(true, 30_000)
    const transport = new FramedSocket(socket)
    this.attach(transport)
  }

  /**
   * Adopts an already-open byte pipe.
   *
   * Used for relay connections, where the Host dials out and gets a WebSocket
   * rather than an accepted socket. Both transports expose the same
   * `onFrame`/`onClose`/`send`/`close` shape, so admission and Noise below this
   * point run identically and do not know which one they are on.
   */
  attach(transport) {
    if (this.#links.size >= MAX_CONNECTIONS) {
      this.#logger?.warn?.('pocket-harness: refused a connection over the limit')
      void transport.close?.()
      return null
    }
    const link = new Link({ transport, server: this })
    this.#links.add(link)
    link.closed.then(() => this.#links.delete(link))
    link.start()
    return link
  }
}

/** One admitted phone connection. */
class Link {
  #transport
  #server
  #channel = null
  #rpc = null
  #peer = null
  #timer = null
  #closed = false
  #admitting = false
  #resolveClosed
  #queued = []
  connectionId = null
  clientDeviceId = null
  closed

  constructor({ transport, server }) {
    this.#transport = transport
    this.#server = server
    this.closed = new Promise(resolve => {
      this.#resolveClosed = resolve
    })
  }

  start() {
    const { logger } = this.#server.internals
    this.#timer = setTimeout(() => {
      logger?.warn?.('pocket-harness: a connection sent no hello in time')
      void this.close()
    }, HELLO_TIMEOUT_MS)
    this.#timer.unref?.()
    this.#transport.onClose(error => {
      if (error !== null && error !== undefined && !this.#closed) {
        logger?.info?.(`pocket-harness: link closed before admit (${error.code ?? 'unknown'})`)
      }
      void this.close()
    })
    this.#transport.onFrame(frame => this.#onFrame(frame))
  }

  /**
   * Routes one inbound frame.
   *
   * While admission is in flight the client may already be sending its handshake
   * message; those frames are queued rather than dropped, because the socket's
   * delivery is not tied to our await points.
   */
  #onFrame(frame) {
    if (this.#channel !== null) {
      this.#channel.acceptFrame(frame)
      return
    }
    if (this.#admitting) {
      this.#queued.push(frame)
      return
    }
    void this.#admit(frame)
  }

  async #admit(frame) {
    this.#admitting = true
    const { logger, identity, createGateway, authorize, hostName } = this.#server.internals
    let hello
    try {
      const decoded = decodeFrame(frame)
      if (decoded.kind !== FRAME_KIND.control) throw new Error('the first frame must be a control frame')
      hello = JSON.parse(Buffer.from(decoded.payload).toString('utf8'))
    } catch (error) {
      logger?.info?.(`pocket-harness: rejected a malformed hello (${error.message})`)
      await this.close()
      return
    }
    if (hello === null || typeof hello !== 'object' || hello.v !== HELLO_VERSION) {
      await this.#refuse('unsupported-hello-version')
      return
    }
    const connectionId = hello.connection
    const clientDeviceId = hello.client
    if (typeof connectionId !== 'string' || connectionId.length === 0 || connectionId.length > 128) {
      await this.#refuse('bad-connection-id')
      return
    }
    if (!isDeviceId(clientDeviceId)) {
      await this.#refuse('bad-client-id')
      return
    }
    let decision
    try {
      decision = await authorize({
        connectionId,
        clientDeviceId,
        proof: typeof hello.proof === 'string' ? hello.proof : null,
      })
    } catch (error) {
      logger?.warn?.(`pocket-harness: admission failed (${error.message})`)
      await this.close()
      return
    }
    if (decision === null || !decision.ok) {
      await this.#refuse(decision?.reason ?? 'not-paired')
      return
    }
    if (this.#closed) return
    this.connectionId = connectionId
    this.clientDeviceId = clientDeviceId
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null
    this.#transport.send(encodeFrame(FRAME_KIND.control, Buffer.from(JSON.stringify({
      v: HELLO_VERSION,
      accepted: true,
      host: identity.deviceId,
      name: hostName,
    }), 'utf8')))

    let peer
    try {
      peer = await decision.createPeer()
    } catch (error) {
      logger?.warn?.(`pocket-harness: could not create a Peer for this link (${error.message})`)
      await this.close()
      return
    }
    if (this.#closed) {
      await peer?.dispose?.()
      return
    }
    this.#peer = peer

    const session = new NoiseIkResponder({
      localPrivateKey: identity.privateKey,
      localPublicKey: identity.publicKey,
      expectedRemoteStatic: decision.pinnedKey ?? null,
      prologue: createNoisePrologue(connectionId, identity.deviceId, clientDeviceId),
    })
    const channel = new SecureChannel({ transport: this.#transport, session })
    this.#channel = channel
    channel.on('error', error => {
      logger?.info?.(`pocket-harness: link failed (${error.code ?? error.message})`)
    })
    channel.on('established', () => {
      // Only now is the client's static key proven; pin it if it was new.
      const remote = session.remoteStatic
      if (decision.pinnedKey === null && remote !== null) void decision.pinKey?.(remote)
      logger?.info?.('pocket-harness: link established')
    })
    channel.on('close', () => {
      void this.close()
    })
    const gateway = await createGateway(peer)
    this.#rpc = new RpcServer({ channel, gateway, peer })
    this.#rpc.on('protocol-error', error => {
      logger?.info?.(`pocket-harness: dropped a bad envelope (${error.message})`)
      void this.close()
    })
    // The client's message one may have arrived while we were admitting it.
    const queued = this.#queued
    this.#queued = []
    for (const pending of queued) channel.acceptFrame(pending)
    // The responder never speaks first: without message one there is nothing to do.
    channel.start()
  }

  async #refuse(reason) {
    try {
      this.#transport.send(encodeFrame(FRAME_KIND.control, Buffer.from(JSON.stringify({
        v: HELLO_VERSION,
        accepted: false,
        reason,
      }), 'utf8')))
    } catch {
      // A socket that already died needs no refusal.
    }
    this.#server.internals.logger?.info?.(`pocket-harness: refused a connection (${reason})`)
    await this.close()
  }

  async close() {
    if (this.#closed) return
    this.#closed = true
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null
    this.#queued = []
    try {
      await this.#rpc?.close()
    } catch {
      // RPC teardown must not block closing the socket.
    }
    try {
      await this.#channel?.close()
    } catch {
      // Same for the channel.
    }
    try {
      await this.#transport.close()
    } catch {
      // And for the socket itself.
    }
    try {
      await this.#peer?.dispose?.()
    } catch {
      // A disposed Peer is already gone.
    }
    this.#peer = null
    this.#resolveClosed()
  }
}
