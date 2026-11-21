// 客户端连接流程的自检：一条内存管道上跑完整的 hello → Noise → RPC。
//
// 真实 Host 只在 `test/live.ts` 里验一次（需要跑着 Harness），这里用同一套协议
// 原语在进程内扮演 Host，好让 CI 也能覆盖 `LinkClient` —— 鸿蒙 App 用的正是这条
// 路径，它出问题的话协议层全绿也没用。

import { randomBytes } from 'node:crypto'

import { decodeBase64Url, encodeBase64Url, fromUtf8, utf8 } from '../src/bytes'
import { newDeviceIdentity } from '../src/identity'
import { createNoisePrologue, NoiseIkSession } from '../src/noise'
import { decodeTicket, encodeTicket, type DeviceIdentity, type PairingTicket } from '../src/pairing'
import { SecureChannel, type FrameTransport } from '../src/secure_channel'
import {
  FRAME_KIND,
  decodeFrame,
  encodeEnvelope,
  encodeFrame,
  errorEnvelope,
  eventEnvelope,
  responseEnvelope,
  type Envelope,
} from '../src/wire'
import { decodeHello, encodeHello, verifyHelloProof } from '../src/link_protocol'
import { LinkClient, LinkRefusedError } from '../src/client'
import { RpcError } from '../src/rpc'
import { RemoteEvents } from '../src/remote_events'
import { APPROVAL_ALLOWED_ONCE, QUESTION_APPROVAL, readQuestion } from '../src/questions'
import { x25519PublicKey } from '../src/curve25519'
import type { JsonObject } from '../src/json'

const failures: string[] = []

function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures.push(label)
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

function same(label: string, actual: Object, expected: Object): void {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  ok(label, left === right, `got ${left}, expected ${right}`)
}

function random(length: number): Uint8Array {
  return new Uint8Array(randomBytes(length))
}

/** 一对互相投递的传输，用来在一个进程里扮演两端。 */
class Pipe implements FrameTransport {
  peer: Pipe | null = null
  closed = false
  private frameHandler: (frame: Uint8Array) => void = () => undefined
  private closeHandler: () => void = () => undefined

  send(frame: Uint8Array): void {
    if (this.closed) throw new Error('the pipe is closed')
    const target = this.peer
    if (target === null) return
    // 异步投递，避免一端在回调里重入自身的 handler。
    queueMicrotask(() => {
      if (target.closed) return
      target.frameHandler(new Uint8Array(frame))
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const target = this.peer
    queueMicrotask(() => {
      if (target !== null && !target.closed) target.closeHandler()
    })
  }

  onFrame(handler: (frame: Uint8Array) => void): void {
    this.frameHandler = handler
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler
  }
}

function pair(): [Pipe, Pipe] {
  const a = new Pipe()
  const b = new Pipe()
  a.peer = b
  b.peer = a
  return [a, b]
}

interface HostOptions {
  readonly hostId: string
  readonly hostPrivateKey: Uint8Array
  readonly clientPublicKey: Uint8Array
  readonly secret: string | null
  readonly sessions?: readonly JsonObject[]
  readonly jobs?: readonly JsonObject[]
  /** 答一个不属于票据的 host id，用来验证客户端会拒绝。 */
  readonly impersonate?: boolean
  /** 收下 hello 但不回任何东西，用来验证超时。 */
  readonly silent?: boolean
}

/** 进程内的 Host：hello → Noise responder → 一个只认几个端点的 RPC 服务。 */
class FakeHost {
  readonly transport: Pipe
  /** 手机打到 `$events/result` 的载荷，按到达顺序记下来。 */
  readonly outcomes: JsonObject[] = []
  private readonly options: HostOptions
  private channel: SecureChannel | null = null
  private hostId: string

  constructor(transport: Pipe, options: HostOptions) {
    this.transport = transport
    this.options = options
    this.hostId = options.impersonate === true ? 'a-different-host' : options.hostId
    let handshakeDone = false
    this.transport.onClose(() => undefined)
    this.transport.onFrame((frame) => {
      if (!handshakeDone) {
        handshakeDone = true
        this.admit(frame)
        return
      }
    })
  }

  private admit(frame: Uint8Array): void {
    if (this.options.silent === true) return
    const decoded = decodeFrame(frame)
    if (decoded.kind !== FRAME_KIND.control) throw new Error('the first frame must be control')
    const hello = decodeHello(decoded.payload)
    const admissible = this.options.secret !== null && verifyHelloProof(hello, this.options.secret)
    if (!admissible) {
      this.reply({ v: 1, accepted: false, reason: 'bad-proof' })
      return
    }
    this.reply({ v: 1, accepted: true, host: this.hostId, name: 'pipe-host' })

    const session = new NoiseIkSession({
      role: 'responder',
      localPrivateKey: this.options.hostPrivateKey,
      localPublicKey: x25519PublicKey(this.options.hostPrivateKey),
      remotePublicKey: this.options.clientPublicKey,
      prologue: createNoisePrologue(hello.connection, this.hostId, hello.client),
      random,
    })
    this.channel = new SecureChannel({
      transport: this.transport,
      session,
      onMessage: (plaintext) => {
        this.answer(JSON.parse(fromUtf8(plaintext)) as Envelope)
      },
    })
    this.channel.start()
  }

  private reply(value: JsonObject): void {
    this.transport.send(encodeFrame({ kind: FRAME_KIND.control, payload: utf8(JSON.stringify(value)) }))
  }

  private send(value: Envelope): void {
    // 必须走 encodeEnvelope：它会补上协议版本号，裸 JSON.stringify 少了 `v`
    // 会被对端的 decodeEnvelope 直接丢掉（第一次写这个假 Host 就踩了）。
    this.channel?.send(encodeEnvelope(value))
  }

  private answer(envelope: Envelope): void {
    if (envelope.type === 'ping') {
      this.send({ type: 'pong', payload: {} })
      return
    }
    if (envelope.type !== 'request') return
    const id = envelope.id ?? ''
    const endpoint = envelope.payload.endpoint
    const args = envelope.payload.payload as JsonObject | undefined
    const inner = args?.args as JsonObject | undefined

    if (endpoint === 'test/echo') {
      this.send(responseEnvelope(id, { echoed: inner ?? {}, peer: 'pipe-host' }))
      return
    }
    if (endpoint === 'session/list') {
      this.send(responseEnvelope(id, { items: this.options.sessions ?? [] }))
      return
    }
    if (endpoint === 'test/fail') {
      this.send(errorEnvelope(id, 'TEST_FAILURE', 'expected on purpose', { hint: 'ok' }))
      return
    }
    if (endpoint === '$events/result') {
      // 网关内部端点：手机答完一条 waterfall 后打这里。真网关对未知 eventId
      // 也返回成功，所以这里只记录并回 `{accepted:true}`。
      this.outcomes.push({ ...(inner ?? {}), clientId: inner?.['clientId'] })
      this.send(responseEnvelope(id, { accepted: true }))
      return
    }
    if (endpoint === 'link/stream.open') {
      const name = inner?.endpoint
      const streamId = 7
      this.send(responseEnvelope(id, { streamId }))
      if (name === '$events') {
        // 网关的转发事件流：先 ready，再推一条审批 waterfall。
        this.send(eventEnvelope({
          streamId,
          hasValue: true,
          value: { type: 'ready', clientId: 'client-under-test', host: { home: '/home/test' } },
        }))
        this.send(eventEnvelope({
          streamId,
          hasValue: true,
          value: {
            type: 'waterfall',
            event: 'approval/request',
            eventId: 'evt-1',
            agentId: 'agent-1',
            request: { toolName: 'bash', reason: 'run a command' },
          },
        }))
        return
      }
      const frames = name === 'job/list' ? (this.options.jobs ?? []) : []
      for (const frame of frames) {
        this.send(eventEnvelope({ streamId, hasValue: true, value: frame }))
      }
      this.send(eventEnvelope({ streamId, done: true }))
      return
    }
    this.send(errorEnvelope(id, 'NO_ENDPOINT', `no endpoint ${String(endpoint)}`))
  }
}

interface Fixture {
  readonly ticket: PairingTicket
  readonly ticketText: string
  readonly identity: DeviceIdentity
  readonly host: FakeHost
  readonly hostPipe: Pipe
  readonly phonePipe: Pipe
}

function fixture(overrides: Partial<HostOptions> = {}): Fixture {
  const hostPrivateKey = random(32)
  const identity = newDeviceIdentity(random)
  const hostId = '0192f0aa-1111-7000-8000-000000000001'
  const secret = 'a-shared-pairing-secret'
  const hostPipe = new Pipe()
  const phonePipe = new Pipe()
  hostPipe.peer = phonePipe
  phonePipe.peer = hostPipe
  const options: HostOptions = {
    hostId,
    hostPrivateKey,
    clientPublicKey: identity.publicKey,
    secret,
    sessions: [
      { sessionId: 'session-under-test', updatedAt: 1_700_000_000_000, running: false },
    ],
    jobs: [{ type: 'rows', jobs: [] }],
    ...overrides,
  }
  const ticket: PairingTicket = {
    version: 1,
    hostDeviceId: options.impersonate === true ? hostId : hostId,
    hostPublicKey: x25519PublicKey(hostPrivateKey),
    hostName: 'pipe-host',
    lanEndpoints: ['127.0.0.1:48100'],
    relayUrl: null,
    relayRoom: null,
    relayToken: null,
    pairingSecret: overrides.secret === null ? null : secret,
    expiresAt: 0,
  }
  return {
    ticket,
    ticketText: encodeTicket(ticket),
    identity,
    host: new FakeHost(hostPipe, options),
    hostPipe,
    phonePipe,
  }
}

function connectOptions(fixture: Fixture): {
  readonly ticket: PairingTicket
  readonly identity: DeviceIdentity
  readonly random: (length: number) => Uint8Array
  readonly openTransport: (host: string, port: number) => Promise<FrameTransport>
  readonly timeoutMs: number
  readonly heartbeat: boolean
} {
  return {
    ticket: fixture.ticket,
    identity: fixture.identity,
    random,
    openTransport: async () => fixture.phonePipe,
    timeoutMs: 4000,
    heartbeat: false,
  }
}

async function checkHandshakeAndCall(): Promise<void> {
  const f = fixture()
  const link = await LinkClient.connect(connectOptions(f))
  ok('the link reports the LAN route', link.route === 'lan', link.route)
  ok('the link reports where it connected', link.endpoint === '127.0.0.1:48100', link.endpoint)

  const echoed = await link.rpc.call('test/echo', { over: 'pipe' })
  same('a call round-trips through the encrypted channel', echoed.echoed, { over: 'pipe' })
  ok('the Host stamps its own identity on the answer', echoed.peer === 'pipe-host')
  link.close()
}

async function checkRefusal(): Promise<void> {
  const f = fixture()
  // 票据里的 secret 与 Host 认的不是同一个：Host 一定回 bad-proof。
  const wrong: PairingTicket = { ...f.ticket, pairingSecret: 'not-the-secret' }
  let caught: Object | null = null
  try {
    await LinkClient.connect({ ...connectOptions(f), ticket: wrong })
  } catch (error) {
    caught = error
  }
  ok('a wrong pairing secret is refused', caught instanceof LinkRefusedError, String(caught))
  ok(
    'the refusal carries the Host reason',
    caught instanceof LinkRefusedError && caught.reason === 'bad-proof',
    caught instanceof LinkRefusedError ? caught.reason : '',
  )
}

async function checkImpersonation(): Promise<void> {
  const f = fixture({ impersonate: true })
  let caught: Object | null = null
  try {
    await LinkClient.connect(connectOptions(f))
  } catch (error) {
    caught = error
  }
  ok(
    'a Host that answers with another id is rejected',
    caught instanceof Error && caught.message.includes('a-different-host'),
    caught instanceof Error ? caught.message : String(caught),
  )
}

async function checkErrorPropagation(): Promise<void> {
  const f = fixture()
  const link = await LinkClient.connect(connectOptions(f))
  let caught: Object | null = null
  try {
    await link.rpc.call('test/fail', {})
  } catch (error) {
    caught = error
  }
  ok('a Host failure arrives as an RpcError', caught instanceof RpcError, String(caught))
  ok(
    'the error keeps the Host code',
    caught instanceof RpcError && caught.code === 'TEST_FAILURE',
    caught instanceof RpcError ? caught.code : '',
  )
  ok(
    'the error keeps the Host details',
    caught instanceof RpcError && caught.details.hint === 'ok',
    caught instanceof RpcError ? JSON.stringify(caught.details) : '',
  )
  link.close()
}

async function checkStream(): Promise<void> {
  const f = fixture({ jobs: [{ type: 'rows', jobs: [] }] })
  const link = await LinkClient.connect(connectOptions(f))
  const seen: JsonObject[] = []
  for await (const frame of link.rpc.openStream('job/list', { request: { sessionId: 's' } }, { timeoutMs: 4000 })) {
    seen.push(frame)
  }
  ok('the stream yields every frame before it ends', seen.length === 1, `saw ${seen.length}`)
  ok('the stream value is the frame body', seen.length > 0 && seen[0].type === 'rows')
  link.close()
}

async function checkHelloTimeout(): Promise<void> {
  const f = fixture({ silent: true })
  let caught: Object | null = null
  try {
    await LinkClient.connect({ ...connectOptions(f), timeoutMs: 300 })
  } catch (error) {
    caught = error
  }
  ok(
    'a Host that never answers the hello times out',
    caught instanceof Error && caught.message.includes('did not answer the hello'),
    caught instanceof Error ? caught.message : String(caught),
  )
}

async function checkRelayRoute(): Promise<void> {
  // 只有中继坐标、没有任何局域网地址：这条路径以前因为把 `hasRelay` 当属性读
  // 而一直走不到 —— Node 只擦掉类型不做检查，`ticket.hasRelay` 求值是
  // undefined，条件永远为假，中继分支静默失效。
  const f = fixture()
  const relayed: PairingTicket = {
    ...f.ticket,
    lanEndpoints: [],
    relayUrl: 'ws://relay.example:8080/relay',
    relayRoom: 'room-under-test',
    relayToken: 'relay-token-under-test',
  }
  let asked = 0
  const link = await LinkClient.connect({
    ticket: relayed,
    identity: f.identity,
    random,
    openTransport: async () => {
      throw new Error('the LAN factory must not be used for a relay-only code')
    },
    openRelay: async () => {
      asked += 1
      return f.phonePipe
    },
    timeoutMs: 4000,
    heartbeat: false,
  })
  ok('a relay-only ticket dials the relay', asked === 1, `asked ${asked}`)
  ok('the link reports the relay route', link.route === 'relay', link.route)
  ok('the relay endpoint is the relay url', link.endpoint === 'ws://relay.example:8080/relay', link.endpoint)
  const echoed = await link.rpc.call('test/echo', { over: 'relay' })
  same('a call crosses the relayed channel', echoed.echoed, { over: 'relay' })
  link.close()
}

async function checkRemoteEvents(): Promise<void> {
  // 网关内部端点：`$events` 走流、`$events/result` 走 unary。这两个名字不是
  // 业务的 `namespace/method`，Host 侧靠 `$` 前缀把它们原样透传。鸿蒙手机上
  // 审批与提问全靠这条路径，一旦断掉 agent 会永远卡在 waterfall 上。
  const f = fixture()
  const link = await LinkClient.connect(connectOptions(f))
  const events = await RemoteEvents.open(link.rpc, 4000)
  ok('the event stream reports its client id', events.clientId === 'client-under-test', events.clientId)
  ok('the event stream reports the host home', events.home === '/home/test', events.home)

  const invocation = await events.nextInvocation()
  ok('a forwarded waterfall arrives', invocation !== null)
  ok('the waterfall names the event', invocation?.event === 'approval/request', invocation?.event ?? '')
  ok('the waterfall carries the request', invocation?.request['toolName'] === 'bash')

  const question = invocation === null ? null : readQuestion(invocation)
  ok('the waterfall parses into a question', question !== null)
  ok('the question is an approval', question?.kind === QUESTION_APPROVAL, question?.kind ?? '')

  await events.answer(invocation!, APPROVAL_ALLOWED_ONCE)
  ok('the answer reaches the Host', f.host.outcomes.length === 1, `saw ${f.host.outcomes.length}`)
  same('the answer echoes the client and event ids', {
    clientId: f.host.outcomes[0]?.['clientId'],
    eventId: f.host.outcomes[0]?.['eventId'],
  }, { clientId: 'client-under-test', eventId: 'evt-1' })
  same('the approval outcome is a result', f.host.outcomes[0]?.['outcome'], {
    kind: 'result',
    value: APPROVAL_ALLOWED_ONCE,
  })

  await events.answer(invocation!, null, true)
  same('delegating sends the next outcome', f.host.outcomes[1]?.['outcome'], { kind: 'next' })
  await events.close()
  link.close()
}

async function checkTicketRoundTrip(): Promise<void> {
  const f = fixture()
  ok('the ticket encodes to a pocketharness url', f.ticketText.startsWith('pocketharness://pair?t='))
  ok('the ticket carries a 32-byte public key', f.ticket.hostPublicKey.length === 32)
  const back = decodeTicket(f.ticketText)
  ok('the ticket decodes back to the same host', back.hostDeviceId === f.ticket.hostDeviceId)
  ok(
    'the ticket keeps the same public key',
    encodeBase64Url(back.hostPublicKey) === encodeBase64Url(f.ticket.hostPublicKey),
  )
}

async function main(): Promise<void> {
  console.log('client')
  await checkHandshakeAndCall()
  await checkRefusal()
  await checkImpersonation()
  await checkErrorPropagation()
  await checkStream()
  await checkHelloTimeout()
  await checkRelayRoute()
  await checkRemoteEvents()
  await checkTicketRoundTrip()

  if (failures.length > 0) {
    console.log(`\n${failures.length} CLIENT CHECK(S) FAILED`)
    process.exit(1)
  }
  console.log('\nALL CLIENT CHECKS PASS (typescript core)')
}

main().catch((error: Object) => {
  console.error(`FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(1)
})
