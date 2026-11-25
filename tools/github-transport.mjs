// 和 GitHub 通信的这一层：
//   * 找一条真能连上的边缘地址（这台机器上 github.com / api.github.com 的默认 DNS
//     地址经常直接 reset，而同一组里的别的地址是通的）；
//   * REST 走 JSON，推送走 git 的 receive-pack 线上协议。
//
// 为什么不用 `git push`：本机 git 只编了 schannel，沙箱里拿不到客户端凭证
// （SEC_E_NO_CREDENTIALS）；为什么不用 isomorphic-git 的 push：它在「没有东西要
// 更新」时会把连接挂到超时，而且只处理 refs/heads/*，tag 会被静默丢掉。
import fs from 'node:fs';
import https from 'node:https';
import tls from 'node:tls';
import dns from 'node:dns';
import { promisify } from 'node:util';

const lookup = promisify(dns.lookup);

// 这些是 GitHub 的边缘地址，同一个域名会解析到好几个；逐个握手，能成的留着用。
const EDGES = {
  'api.github.com': ['140.82.112.6', '140.82.114.6', '20.205.243.168', '20.26.156.215'],
  'github.com': ['20.247.166.64', '20.205.243.166', '20.27.177.113', '140.82.112.3'],
};

function probe(host, address, timeoutMs) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: address, servername: host, port: 443, timeout: timeoutMs }, () => {
      socket.end();
      resolve(true);
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

export function createTransport({ token, owner, repo, log = () => {} }) {
  if (!token) throw new Error('a token is required');
  const auth = {
    bearer: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'pocket-harness-publisher' },
    basic: { Authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` },
  };

  const reachable = new Map();

  async function addresses(host) {
    if (reachable.has(host)) return reachable.get(host);
    const candidates = new Set();
    try {
      for (const entry of await lookup(host, { all: true })) candidates.add(entry.address);
    } catch {
      /* DNS 挂了就只用内置地址 */
    }
    for (const address of EDGES[host] ?? []) candidates.add(address);
    const alive = [];
    for (const address of candidates) {
      if (await probe(host, address, 6000)) alive.push(address);
    }
    // 探测全失败也别直接放弃：可能是探针本身的限制，让调用方按顺序试。
    const ordered = alive.length > 0 ? alive : [...candidates];
    reachable.set(host, ordered);
    log(`  ${host}: ${ordered.length} 个地址可用`);
    return ordered;
  }

  function call({ address, servername, method, path, headers, body, timeoutMs = 30000 }) {
    return new Promise((resolve, reject) => {
      const req = https.request({ host: address, servername, path, method, timeout: timeoutMs, headers }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error('socket timed out')));
      req.on('error', reject);
      if (body === undefined) {
        req.end();
        return;
      }
      // 大 body 分片写：一次性 write 会让某些出口中途 reset。
      const slice = 16384;
      let offset = 0;
      const pump = () => {
        while (offset < body.length) {
          const next = body.subarray(offset, offset + slice);
          offset += slice;
          if (!req.write(next)) {
            req.once('drain', pump);
            return;
          }
        }
        req.end();
      };
      pump();
    });
  }

  async function apiJson(path, init = {}) {
    let lastError = null;
    for (const address of await addresses('api.github.com')) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const res = await call({
            address,
            servername: 'api.github.com',
            method: init.method ?? 'GET',
            path: `/repos/${owner}/${repo}${path}`,
            headers: { Host: 'api.github.com', ...auth.bearer, ...(init.headers ?? {}) },
            body: init.body,
            timeoutMs: init.timeoutMs ?? 30000,
          });
          const text = res.body.toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            /* 非 JSON 保留 text */
          }
          if (res.status === 404) return { status: 404, json: null, text };
          if (res.status >= 500) {
            lastError = new Error(`api ${res.status}`);
            continue;
          }
          if (res.status >= 400) return { status: res.status, json, text };
          return { status: res.status, json, text };
        } catch (error) {
          lastError = error;
        }
      }
    }
    throw lastError ?? new Error('api.github.com 连不上');
  }

  const FLUSH = Buffer.from('0000', 'ascii');

  function pkt(text) {
    const length = Buffer.byteLength(text) + 4;
    return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), Buffer.from(text, 'utf8')]);
  }

  // 服务端回来的 report-status：正常是 pkt-line，但有的实现直接给裸文本。
  function readReport(buf) {
    const text = buf.toString('utf8');
    if (buf.length < 4) return text;
    const first = parseInt(buf.toString('ascii', 0, 4), 16);
    if (!Number.isFinite(first) || first < 4 || first > buf.length) return text;
    let said = '';
    for (let i = 0; i + 4 <= buf.length; ) {
      const size = parseInt(buf.toString('ascii', i, i + 4), 16);
      if (!Number.isFinite(size) || size < 4) {
        i += 4;
        continue;
      }
      const chunk = buf.subarray(i + 4, i + size);
      i += size;
      said += chunk[0] === 1 || chunk[0] === 2 ? chunk.subarray(1).toString('utf8') : chunk.toString('utf8');
    }
    return said;
  }

  // 推一条 ref。pack 是要送的对象（调用方负责准备），old/new 是远端与本地 sha。
  async function receivePack(refName, oldSha, newSha, pack) {
    const body = Buffer.concat([
      pkt(`${oldSha} ${newSha} ${refName}\u0000report-status side-band-64k agent=pocket-harness/0.1.0`),
      FLUSH,
      pack,
    ]);
    let lastError = null;
    for (const address of await addresses('github.com')) {
      try {
        const res = await call({
          address,
          servername: 'github.com',
          method: 'POST',
          path: `/${owner}/${repo}.git/git-receive-pack`,
          headers: {
            Host: 'github.com',
            ...auth.basic,
            'Content-Type': 'application/x-git-receive-pack-request',
            Accept: 'application/x-git-receive-pack-result',
            'User-Agent': 'git/2.0',
            'Content-Length': String(body.length),
          },
          body,
          timeoutMs: 240000,
        });
        const said = readReport(res.body).replace(/\u0000/g, '').replace(/\r/g, '\n').trim();
        if (res.status >= 200 && res.status < 300 && !/unpack (?!ok)/.test(said) && !/^ng /m.test(said)) {
          return { ok: true, said };
        }
        lastError = new Error(`被拒（HTTP ${res.status}）：${said.split('\n').filter(Boolean).slice(-3).join(' / ') || '(服务端没说话)'}`);
      } catch (error) {
        lastError = error;
      }
    }
    return { ok: false, error: lastError };
  }

  return { apiJson, receivePack, addresses };
}

export function readToken(file) {
  return fs.readFileSync(file, 'utf8').trim();
}
