// Exercises the relay path with the real relay server.
//
// The relay is the only way a phone reaches a Host that is not on the same
// network, so it is worth testing rather than assuming: these cases prove the
// Host's dialer joins a room, that a phone is handed a transport, that the room
// survives one phone leaving (the next phone must still get in), and that a
// wrong token is refused.

import assert from 'node:assert/strict'
import test from 'node:test'

import { createRelay } from '../relay/server.mjs'
import { RelayDialer } from './relay-client.js'

const TOKEN = 'relay-test-token-0123456789'

/** Starts a relay on an ephemeral port and returns it with its URL. */
async function startRelay() {
  const relay = createRelay({ token: TOKEN })
  const port = await relay.listen({ port: 0, host: '127.0.0.1' })
  return { relay, url: `ws://127.0.0.1:${port}/relay` }
}

/** A phone stand-in: joins as the client and waits for the room to be ready. */
function dialPhone(url, room, token = TOKEN) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    // The browser default is a Blob, which cannot be read synchronously; the app
    // and this test both ask for raw bytes instead.
    socket.binaryType = 'arraybuffer'
    const timer = setTimeout(() => reject(new Error('the phone never paired')), 5_000)
    socket.addEventListener('open', () => socket.send(JSON.stringify({ v: 1, role: 'client', room, token })))
    socket.addEventListener('message', event => {
      if (typeof event.data !== 'string' || !event.data.includes('"ready"')) return
      clearTimeout(timer)
      resolve(socket)
    })
    socket.addEventListener('close', event => {
      clearTimeout(timer)
      reject(new Error(`the relay closed the phone (${event.code})`))
    })
  })
}

/** Waits until [predicate] holds, so the test never sleeps a fixed time. */
async function until(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(message)
}

test('the Host dialer hands a paired phone to the link server', async () => {
  const { relay, url } = await startRelay()
  const handed = []
  const dialer = new RelayDialer({
    url,
    room: 'test-room-0001',
    token: TOKEN,
    onTransport: transport => handed.push(transport),
  })
  dialer.start()
  try {
    const phone = await dialPhone(url, 'test-room-0001')
    await until(() => handed.length === 1, 'the Host was never handed the relay transport')
    assert.equal(dialer.served, 1)
    assert.equal(dialer.connected, true)
    phone.close()
  } finally {
    await dialer.close()
    await relay.close()
  }
})

// A Host legitimately waits for a phone in an empty room. The dialer used to
// treat "no phone yet" as a failed handshake and drop the room every 15 seconds,
// which showed up as a Host flapping between joined and closed in the log.
test('an empty room is kept open instead of timing out', async () => {
  const { relay, url } = await startRelay()
  const handed = []
  const dialer = new RelayDialer({
    url,
    room: 'test-room-0003',
    token: TOKEN,
    onTransport: transport => handed.push(transport),
  })
  dialer.start()
  try {
    await until(() => dialer.connected, 'the Host never joined the room')
    // Longer than HANDSHAKE_TIMEOUT_MS (15s) is impractical in a unit test, so
    // this asserts the state the timeout keys off: joined, no phone, no drop.
    await until(() => relay.rooms.has('test-room-0003'), 'the room disappeared')
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(dialer.connected, true, 'an empty room must not close the dial')
    assert.equal(handed.length, 0)
  } finally {
    await dialer.close()
    await relay.close()
  }
})

test('a phone that leaves does not block the next one', async () => {
  const { relay, url } = await startRelay()
  const handed = []
  const dialer = new RelayDialer({
    url,
    room: 'test-room-0002',
    token: TOKEN,
    onTransport: transport => handed.push(transport),
  })
  dialer.start()
  try {
    const first = await dialPhone(url, 'test-room-0002')
    await until(() => handed.length === 1, 'the first phone was never handed over')
    first.close()

    // The Host must re-join after the first phone leaves, otherwise the room keeps
    // a host slot nobody can take and the second phone can never pair.
    const second = await dialPhone(url, 'test-room-0002')
    await until(() => handed.length === 2, 'the Host did not re-join for the second phone')
    assert.equal(dialer.served, 2)
    second.close()
  } finally {
    await dialer.close()
    await relay.close()
  }
})

test('a wrong relay token is refused', async () => {
  const { relay, url } = await startRelay()
  try {
    await assert.rejects(dialPhone(url, 'test-room-0003', 'not-the-token-at-all-x'), /closed the phone/)
  } finally {
    await relay.close()
  }
})

test('bytes cross the relay unchanged', async () => {
  const { relay, url } = await startRelay()
  const handed = []
  const dialer = new RelayDialer({
    url,
    room: 'test-room-0004',
    token: TOKEN,
    onTransport: transport => handed.push(transport),
  })
  dialer.start()
  try {
    const phone = await dialPhone(url, 'test-room-0004')
    await until(() => handed.length === 1, 'the Host was never handed the relay transport')
    const transport = handed[0]

    const received = new Promise(resolve => transport.onFrame(resolve))
    // Binary payload: the relay must not touch it, which is what lets Noise run
    // end to end without the operator ever seeing a key or a prompt.
    phone.send(new Uint8Array([1, 2, 3, 4, 5]).buffer)
    assert.deepEqual([...new Uint8Array(await received)], [1, 2, 3, 4, 5])

    // Skip the relay's own text notices: only binary messages are payload.
    const back = new Promise(resolve => {
      const listener = event => {
        if (typeof event.data === 'string') return
        phone.removeEventListener('message', listener)
        resolve(new Uint8Array(event.data))
      }
      phone.addEventListener('message', listener)
    })
    transport.send(Buffer.from([9, 8, 7]))
    assert.deepEqual([...(await back)], [9, 8, 7])
    phone.close()
  } finally {
    await dialer.close()
    await relay.close()
  }
})
