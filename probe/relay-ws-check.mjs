// 从本机（公网侧）真的走一遍 wss://<domain>/ph-relay，确认 443 → nginx → relay 的
// 升级链路是通的。relay 只做房间配对，所以这里扮一个 host，收到 {ok:true} 就算成功。
//
// 用法：
//   POCKET_HARNESS_RELAY_URL=wss://<你的域名>/ph-relay node probe/relay-ws-check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WebSocket = (await import('file:///' + path.join(root, 'relay/node_modules/ws/index.js').replace(/\\/g, '/'))).default;

const url = process.env.POCKET_HARNESS_RELAY_URL;
if (!url) {
  console.error('POCKET_HARNESS_RELAY_URL is not set');
  process.exit(1);
}

const tokenFile = process.env.POCKET_HARNESS_RELAY_TOKEN_FILE ?? path.join(root, 'relay', '.relay-token');
const token = process.env.POCKET_HARNESS_RELAY_TOKEN ?? fs.readFileSync(tokenFile, 'utf8').trim();

const room = 'probe' + Date.now().toString(36) + 'abc';
const failures = [];
const step = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures.push(label);
};

const hello = await new Promise((resolve) => {
  const socket = new WebSocket(url);
  const timer = setTimeout(() => {
    socket.terminate();
    resolve({ timeout: true });
  }, 15_000);
  socket.on('open', () => socket.send(JSON.stringify({ role: 'host', room, token })));
  socket.on('message', (data, isBinary) => {
    if (isBinary) return;
    const value = JSON.parse(data.toString('utf8'));
    if (value.ok === true) {
      clearTimeout(timer);
      socket.close();
      resolve({ reply: value });
    }
  });
  socket.on('error', (error) => {
    clearTimeout(timer);
    resolve({ error: String(error?.message ?? error) });
  });
  socket.on('unexpected-response', (_request, response) => {
    clearTimeout(timer);
    resolve({ status: response.statusCode });
  });
});

step(hello.reply !== undefined, `wss upgrade + hello accepted (${url})`);
if (hello.reply !== undefined) {
  step(hello.reply.role === 'host', 'the relay acknowledged the host role');
  step(hello.reply.paired === false, 'an empty room reports unpaired');
}
if (hello.status !== undefined) step(false, `the upgrade was answered with HTTP ${hello.status}`);
if (hello.error !== undefined) step(false, `error: ${hello.error}`);
if (hello.timeout === true) step(false, 'the relay never answered the hello (15s)');

const badToken = await new Promise((resolve) => {
  const socket = new WebSocket(url);
  const timer = setTimeout(() => {
    socket.terminate();
    resolve('timeout');
  }, 15_000);
  socket.on('open', () => socket.send(JSON.stringify({ role: 'client', room, token: 'x'.repeat(43) })));
  socket.on('close', (code) => {
    clearTimeout(timer);
    resolve(code);
  });
  socket.on('error', () => {});
});
step(badToken === 4403, `a wrong token is refused with 4403 (got ${badToken})`);

console.log(failures.length === 0 ? 'RELAY REACHABLE OVER 443' : `${failures.length} check(s) failed`);
process.exit(failures.length === 0 ? 0 : 1);
