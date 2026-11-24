// Checks the pairing page the Host serves: the QR drawn on it must decode back to
// a ticket the Host would accept, and the page must stay off the network.
//
// Run: node probe/pair-page-check.mjs
import { ok, strictEqual } from 'node:assert/strict'

import { apply, sameProof } from '../host/index.js'
import { decodeTicket, isTicketValid } from '../host/pairing.js'
import { decodeMatrix } from '../packages/dsh_arkts/build/index.mjs'

let passed = 0
let failed = 0

function check(name, run) {
  try {
    run()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

/** The credentials service, in memory, with the shape the plugin reads. */
function fakeCredentials() {
  const records = new Map()
  return {
    records,
    async readRecord(key) {
      return records.get(key) ?? null
    },
    async modifyRecord(key, change) {
      const next = await change(records.get(key) ?? null)
      records.set(key, next)
      return next
    },
  }
}

/** The web server service, kept small enough to read. */
function fakeWebServer() {
  const routes = new Map()
  return {
    routes,
    register(route) {
      routes.set(`${route.kind}:${route.path}`, route)
      return () => routes.delete(`${route.kind}:${route.path}`)
    },
  }
}

/** A response object that records what the handler wrote instead of sending it. */
function fakeResponse() {
  const response = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers = {}) {
      response.status = status
      response.headers = { ...headers }
      return response
    },
    end(chunk) {
      if (typeof chunk === 'string') response.body += chunk
      if (chunk instanceof Uint8Array) response.body += Buffer.from(chunk).toString('utf8')
      response.ended = true
      return response
    },
    ended: false,
  }
  return response
}

/** A bare request: the handler only looks at these fields. */
function fakeRequest({ method = 'GET', host = '127.0.0.1:55996', origin, url = '/api/pocket-harness/pair' } = {}) {
  const headers = { host }
  if (origin !== undefined) headers.origin = origin
  return { method, url, headers }
}

/** Pulls the QR matrix back out of the inline SVG the page drew. */
function matrixFromSvg(svg) {
  const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(svg)
  strictEqual(viewBox === null, false, 'the page drew an SVG with a viewBox')
  const size = Number(viewBox[1])
  const cells = Array.from({ length: size }, () => Array.from({ length: size }, () => false))
  const path = /<path d="([^"]*)"/.exec(svg)
  strictEqual(path === null, false, 'the SVG has a path')
  for (const [, column, row] of path[1].matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    cells[Number(row)][Number(column)] = true
  }
  return cells
}

const credentials = fakeCredentials()
const webServer = fakeWebServer()
const disposables = []
const logged = []
const ctx = {
  logger: {
    info(message) {
      logged.push(String(message))
    },
    warn() {},
    error() {},
  },
  credentials,
  effect(disposer, label) {
    disposables.push(typeof disposer === 'function' ? disposer : () => {})
    void label
  },
  inject(services, callback) {
    strictEqual(services.includes('webServer'), true)
    callback({ webServer, effect: (factory, label) => ctx.effect(factory(), label) })
  },
}

apply(ctx, { hostName: 'probe host' })

// The plugin publishes asynchronously: let the identity be created and the first
// code be produced before asking for the page.
await new Promise(resolve => setTimeout(resolve, 50))

const route = webServer.routes.get('exact:/api/pocket-harness/pair')
check('the plugin registered the pairing route', () => {
  strictEqual(route === undefined, false)
})

function render(options) {
  const response = fakeResponse()
  route.handler(fakeRequest(options), response)
  return response
}

const page = render()
check('a loopback GET is served', () => {
  strictEqual(page.status, 200)
  strictEqual(page.headers['content-type'], 'text/html; charset=utf-8')
  strictEqual(page.headers['cache-control'], 'no-store')
})

const matrix = matrixFromSvg(page.body)
const decoded = decodeMatrix(matrix)
check('the QR on the page decodes to a pairing ticket', () => {
  strictEqual(typeof decoded.text, 'string')
  strictEqual(decoded.text.startsWith('pocketharness://pair?t='), true)
  const ticket = decodeTicket(decoded.text)
  strictEqual(isTicketValid(ticket), true)
  strictEqual(ticket.hostName, 'probe host')
})

check('the page shows the ticket the log published', () => {
  const printed = logged.find(line => line.startsWith('pocket-harness: pairing code '))
  strictEqual(printed === undefined, false)
  strictEqual(decoded.text, printed.slice('pocket-harness: pairing code '.length))
})


check('the ticket is not served to the network', () => {
  const remote = render({ host: '192.168.43.48:55996' })
  strictEqual(remote.status, 404)
  strictEqual(remote.body.includes('pocketharness://'), false)
})

check('a cross-site page cannot read the code', () => {
  const crossSite = render({ origin: 'https://evil.example' })
  strictEqual(crossSite.status, 404)
  strictEqual(crossSite.body.includes('pocketharness://'), false)
})

// The desktop app renders the settings card from a page that runs under the
// host's own `dsh-app:` scheme, so its origin can never equal the Host header.
// Rejecting it would leave the card blank in the app that ships it.
check('the desktop app may read the code', () => {
  const desktop = render({ origin: 'dsh-app://app' })
  strictEqual(desktop.status, 200)
  strictEqual(desktop.body.includes('pocketharness://'), true)
})

check('another web page cannot read it either', () => {
  const other = render({ origin: 'http://127.0.0.1:8080' })
  strictEqual(other.status, 404)
})

check('localhost and 127.0.0.1 count as the same reader', () => {
  const same = render({ host: 'localhost:55996', origin: 'http://127.0.0.1:55996' })
  strictEqual(same.status, 200)
})

check('a write is refused', () => {
  const post = render({ method: 'POST' })
  strictEqual(post.status, 405)
})

// The settings card reads this, and it draws the code from `path` alone, so the
// path has to survive the trip as a path and not as a matrix someone forgot to
// convert.
const jsonPage = render({ url: `${'/api/pocket-harness/pair'}?format=json` })
check('the settings card gets JSON', () => {
  strictEqual(jsonPage.status, 200)
  strictEqual(jsonPage.headers['content-type'], 'application/json; charset=utf-8')
  const snapshot = JSON.parse(jsonPage.body)
  strictEqual(snapshot.ready, true)
  strictEqual(snapshot.ticket, decoded.text)
  strictEqual(snapshot.size, matrix.length)
  strictEqual(typeof snapshot.path, 'string')
  ok(snapshot.path.startsWith('M'))
  strictEqual(snapshot.endpoints.length > 0, true)
  strictEqual(typeof snapshot.expiresAt, 'string')
})

// The card's path and the page's matrix must describe the same symbol, or the
// two surfaces would show a phone two different codes for one secret.
const fromPath = /M(\d+) (\d+)h1v1h-1z/g
check('the card path and the page matrix are the same symbol', () => {
  const snapshot = JSON.parse(jsonPage.body)
  const cells = Array.from({ length: snapshot.size }, () => Array.from({ length: snapshot.size }, () => false))
  let dark = 0
  for (const [, column, row] of snapshot.path.matchAll(fromPath)) {
    cells[Number(row)][Number(column)] = true
    dark += 1
  }
  strictEqual(dark > 0, true)
  strictEqual(JSON.stringify(cells), JSON.stringify(matrix))
})

check('JSON is refused off loopback too', () => {
  const remote = render({ host: '192.168.43.48:55996', url: '/api/pocket-harness/pair?format=json' })
  strictEqual(remote.status, 404)
  strictEqual(remote.body.includes('pocketharness://'), false)
})

check('the code is the one the log printed', () => {
  // The page must not mint a second secret: doing so would invalidate a code the
  // person may already be pointing a phone at.
  const first = matrixFromSvg(render().body)
  const second = matrixFromSvg(render().body)
  strictEqual(JSON.stringify(first), JSON.stringify(second))
})

console.log(`\n${passed} passed, ${failed} failed`)

// The plugin really did open a listener; leaving it bound would keep this process
// alive forever and block the next run on the same port.
for (const dispose of disposables.reverse()) {
  try {
    dispose()
  } catch {
    // A disposer that throws is the plugin's problem, not this check's.
  }
}
await new Promise(resolve => setTimeout(resolve, 100))
process.exit(failed > 0 ? 1 : 0)

