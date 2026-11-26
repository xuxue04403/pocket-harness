// Regression tests for relay control messages.
//
// A relay sees ciphertext, but it still owns when a room is considered paired.
// These checks keep that control plane small: exactly the documented JSON
// notices count, malformed or repeated notices cannot hand a socket over twice,
// and payload bytes pass through untouched.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { RelaySocket } from './relay-socket.js'

function messageSocket() {
  const listeners = new Map()
  return {
    sent: [],
    closed: false,
    binaryType: 'blob',
    addEventListener(type, handler) {
      const list = listeners.get(type) ?? []
      list.push(handler)
      listeners.set(type, list)
    },
    send(value) {
      this.sent.push(value)
    },
    close() {
      this.closed = true
    },
    emit(type, data) {
      for (const handler of listeners.get(type) ?? []) handler(data)
    },
  }
}

test('only a valid ready notice hands the room over', () => {
  const socket = messageSocket()
  const relay = new RelaySocket(socket)
  let ready = 0
  relay.on('ready', () => ready++)

  socket.emit('message', { data: 'not ready yet' })
  socket.emit('message', { data: '{"v":1,"ok":true,"role":"host"}' })
  assert.equal(ready, 0, 'the join acknowledgement is not a phone pairing')

  socket.emit('message', { data: '{"v":1,"type":"ready"}' })
  assert.equal(ready, 1)
  socket.emit('message', { data: '{"v":1,"type":"ready"}' })
  assert.equal(ready, 1, 'a repeated notice must not create a second handoff')
})

test('a ready notice in the wrong protocol or role state is ignored', () => {
  const socket = messageSocket()
  const relay = new RelaySocket(socket)
  let ready = 0
  relay.on('ready', () => ready++)

  socket.emit('message', { data: '{"v":2,"type":"ready"}' })
  socket.emit('message', { data: '{"v":1,"type":"almost-ready"}' })
  socket.emit('message', { data: '{"v":1,"ok":true,"role":"host","paired":false}' })
  assert.equal(ready, 0, 'a Host must join before it can be paired')

  socket.emit('message', { data: '{"v":1,"ok":true,"role":"host","paired":false}' })
  socket.emit('message', { data: '{"v":1,"type":"ready"}' })
  assert.equal(ready, 1)
})

test('only an exact peer-gone notice closes the payload pipe', () => {
  const socket = messageSocket()
  const relay = new RelaySocket(socket)
  const frames = []
  relay.onFrame(frame => frames.push(frame))

  socket.emit('message', { data: 'the peer has not gone away' })
  assert.equal(relay.closed, false)
  socket.emit('message', { data: '{"v":1,"type":"peer-gone"}' })
  assert.equal(relay.closed, true)
  assert.equal(socket.closed, true)
})

test('payload remains binary and is never mistaken for a control notice', () => {
  const socket = messageSocket()
  const relay = new RelaySocket(socket)
  const frames = []
  relay.onFrame(frame => frames.push([...frame]))

  const payload = Uint8Array.from([123, 34, 114, 101, 97, 100, 121, 34, 58, 116, 114, 117, 101, 125])
  socket.emit('message', { data: payload.buffer })
  assert.deepEqual(frames, [[...payload]])
  assert.equal(relay.closed, false)
})
