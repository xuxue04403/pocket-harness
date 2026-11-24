// How many sessions actually carry a working directory?
//
// The phone groups by `cwd`, so if the Host rarely sends one, every session
// lands in the same bucket and the tree looks exactly as flat as before.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect as netConnect } from 'node:net';

import { FrameSplitter, LinkClient, decodeBase64Url, decodeTicket, identityFromPrivateKey, frameWithLength } from '../packages/dsh_arkts/build/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ticket = decodeTicket(readFileSync(join(root, 'probe', '_live-ticket.txt'), 'utf8').trim());
const lines = readFileSync(join(root, 'probe', '_probe-identity.txt'), 'utf8').trim().split(/\r?\n/);
const identity = identityFromPrivateKey(lines[0], decodeBase64Url(lines[1]));

function openTcp(host, port) {
  return new Promise((resolveTransport, rejectTransport) => {
    const splitter = new FrameSplitter();
    const socket = netConnect({ host, port });
    let onFrame = null;
    let onClose = null;
    socket.setNoDelay(true);
    socket.on('connect', () => {
      socket.setTimeout(0);
      resolveTransport({
        send: (frame) => socket.write(Buffer.from(frameWithLength(frame))),
        close: () => socket.destroy(),
        onFrame: (handler) => { onFrame = handler; },
        onClose: (handler) => { onClose = handler; },
      });
    });
    socket.on('data', (chunk) => {
      for (const frame of splitter.push(new Uint8Array(chunk))) {
        if (onFrame !== null) onFrame(frame);
      }
    });
    socket.on('close', () => { if (onClose !== null) onClose(); });
    socket.on('error', (error) => { rejectTransport(error); if (onClose !== null) onClose(); });
    socket.setTimeout(15000, () => {
      socket.destroy();
      rejectTransport(new Error(`the Host did not answer at ${host}:${port}`));
    });
  });
}

const link = await LinkClient.connect({
  ticket,
  identity,
  random: (length) => new Uint8Array(randomBytes(length)),
  openTransport: openTcp,
  timeoutMs: 15000,
});

try {
  const answer = await link.rpc.call('session/list', { _request: {} }, 30000);
  const items = Array.isArray(answer.items) ? answer.items : [];
  const withCwd = new Map();
  let noCwd = 0;
  for (const item of items) {
    const values = item?.projections?.values ?? {};
    const cwd = typeof values.workingDirectory === 'string' ? values.workingDirectory : '';
    if (cwd === '') { noCwd += 1; continue; }
    withCwd.set(cwd, (withCwd.get(cwd) ?? 0) + 1);
  }
  console.log(`sessions total : ${items.length}`);
  console.log(`without a cwd  : ${noCwd}`);
  console.log(`distinct cwds  : ${withCwd.size}`);
  const top = [...withCwd.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  for (const [cwd, count] of top) console.log(`  ${String(count).padStart(4)}  ${cwd}`);
} finally {
  await link.close();
}
process.exit(0);
