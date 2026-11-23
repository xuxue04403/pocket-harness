// 把仓库推到 GitHub：分支走 isomorphic-git，annotated tag 走原生 receive-pack。
//
// 为什么不用 `git push`：这台 Windows 上 git 走的是 schannel 后端，而沙箱里
// schannel 拿不到客户端凭证（AcquireCredentialsHandle: SEC_E_NO_CREDENTIALS），
// 于是任何 https:// I/O 都失败；Git for Windows 只编了 schannel，没有 openssl 后端。
// Node 自带 OpenSSL，走 undici 的 fetch 与 https 都正常，所以推送放在这里做。
//
// 为什么 tag 要另走一条路：isomorphic-git 的 push 只会推 `refs/heads/*`，refspec 里
// 写 `refs/tags/x:refs/tags/x` 会被静默忽略（返回体里连这个 ref 都不出现），
// 而 REST 的 POST /git/refs 需要那个 tag 对象先存在于远端——先有鸡还是先有蛋。
// 所以就按 git 的线上协议手工发一次 receive-pack：单对象的 packfile 装 tag 本体，
// pkt-line 里给 old/new sha。这样远端得到的 tag 对象 sha 与本地注解 tag **逐字节相同**，
// `git describe` / `git clone --branch` 才对得上。
//
// 用法（token 只从文件读，不进命令行、不进 .git/config）：
//   node tools/publish-git.mjs --owner <账号> [--repo pocket-harness]
//                              [--branch master] [--tag v0.1.0-beta] [--force]
//
// 环境变量 POCKET_HARNESS_TOKEN_FILE 可换 token 路径，默认 probe/_gh_token.txt。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// isomorphic-git 不是本仓库的运行时依赖（只有发版时才用），所以不装进 package.json：
// 谁要发版谁装一次。这里按候选路径找，找不到就说清怎么装，而不是抛 ERR_MODULE_NOT_FOUND。
async function loadFrom(specifier, candidates) {
  for (const dir of candidates) {
    const target = path.join(dir, 'node_modules', specifier, 'package.json');
    if (!fs.existsSync(target)) continue;
    const base = path.dirname(target);
    const pkg = JSON.parse(fs.readFileSync(target, 'utf8'));
    const entry = pkg.module || pkg.main || 'index.js';
    return { mod: await import(pathToFileURL(path.join(base, entry)).href), dir: base };
  }
  console.error(`找不到 ${specifier}。发版前先装一次：`);
  console.error(`  cd ${path.relative(root, candidates[0])} && npm install ${specifier.split('/')[0]} --no-save`);
  process.exit(2);
}

const searchDirs = [path.join(root, 'probe', '_publisher'), root];
const { mod: gitMod, dir: gitDir } = await loadFrom('isomorphic-git', searchDirs);
const git = gitMod.default || gitMod;
// isomorphic-git 的 HTTP 客户端是独立入口，从同一个安装目录里按相对路径取。
const httpMod = await import(pathToFileURL(path.join(gitDir, 'http', 'node', 'index.js')).href);
const http = httpMod.default || httpMod;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const has = (name) => process.argv.includes(`--${name}`);

const owner = arg('owner');
const repo = arg('repo', 'pocket-harness');
const tag = arg('tag', 'v0.1.0-beta');
const branch = arg('branch', 'master');
const force = has('force');

if (!owner) {
  console.error('缺少 --owner');
  process.exit(2);
}

const tokenFile = process.env.POCKET_HARNESS_TOKEN_FILE || path.join(root, 'probe', '_gh_token.txt');
if (!fs.existsSync(tokenFile)) {
  console.error(`找不到 token 文件：${tokenFile}`);
  process.exit(2);
}
const token = fs.readFileSync(tokenFile, 'utf8').trim();
if (token.length < 20) {
  console.error('token 看起来没写完整。');
  process.exit(2);
}

const apiBase = `https://api.github.com/repos/${owner}/${repo}`;
const apiHeaders = {
  Authorization: `Bearer ${token}`,
  'User-Agent': 'pocket-harness-publisher',
  Accept: 'application/vnd.github+json',
};

// fetch 偶尔会被对端 reset（实测 api.github.com 的 HTTP/2 会这样），重试几次比直接失败好。
async function api(pathname, init = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(apiBase + pathname, {
        ...init,
        headers: { ...apiHeaders, ...(init.headers || {}) },
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* 非 JSON 就保留 text */
      }
      return { res, json, text };
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

// ---------- 1. 本地读 ref ----------

// 不用 `git` 子进程：沙箱里 spawn 会被拦（EPERM），直接读 .git 下的文件最稳。
function readGitDir() {
  const dotGit = path.join(root, '.git');
  if (fs.statSync(dotGit).isDirectory()) return dotGit;
  // worktree / submodule 的情况：.git 是个指向真实目录的文本文件
  const line = fs.readFileSync(dotGit, 'utf8').trim();
  const m = line.match(/^gitdir:\s*(.+)$/i);
  if (!m) throw new Error(`看不懂 .git 文件：${line}`);
  return path.resolve(root, m[1]);
}
const gitDirPath = readGitDir();

function readRef(ref) {
  const direct = path.join(gitDirPath, ref);
  if (fs.existsSync(direct)) return fs.readFileSync(direct, 'utf8').trim();
  const packed = path.join(gitDirPath, 'packed-refs');
  if (fs.existsSync(packed)) {
    for (const line of fs.readFileSync(packed, 'utf8').split('\n')) {
      if (!line || line.startsWith('#') || line.startsWith('^')) continue;
      const [sha, name] = line.trim().split(' ');
      if (name === ref) return sha;
    }
  }
  return null;
}

const branchSha = readRef(`refs/heads/${branch}`);
if (!branchSha) {
  console.error(`本地没有 refs/heads/${branch}`);
  process.exit(2);
}
const tagSha = readRef(`refs/tags/${tag}`);
if (!tagSha) {
  console.error(`本地没有 refs/tags/${tag}`);
  process.exit(2);
}

// ---------- 2. 推分支 ----------

// 先看远端是不是已经一样。isomorphic-git 在「没有东西要更新」时不会立刻收尾，
// 而是把连接挂在那里等超时（实测稳定复现 Request timed out），所以这个判断不是优化而是必需。
async function remoteBranchSha() {
  const { res, json } = await api(`/git/ref/heads/${encodeURIComponent(branch)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`查远端分支失败：${res.status} ${JSON.stringify(json)}`);
  return json.object.sha;
}

const remoteBranch = await remoteBranchSha();
if (remoteBranch === branchSha) {
  console.log(`分支 refs/heads/${branch} 远端已是最新（${branchSha.slice(0, 7)}），跳过推送。`);
} else {
  console.log(`推送分支 refs/heads/${branch} → ${owner}/${repo}（${(remoteBranch || '空').slice(0, 7)} → ${branchSha.slice(0, 7)}）`);
  await pushBranch();
}

async function pushBranch() {
  const result = await git.push({
  fs,
  http,
  dir: root,
  url: `https://github.com/${owner}/${repo}.git`,
  refspec: `refs/heads/${branch}:refs/heads/${branch}`,
  force,
  corsProxy: undefined,
  onAuth: () => ({ username: 'x-access-token', password: token }),
  onAuthFailure: () => {
    console.error('认证被拒：token 不对或没有 repo 写权限。');
    return { cancel: true };
  },
});
  if (!result.ok) {
    console.error('分支推送失败：');
    for (const [ref, r] of Object.entries(result.refs || {})) {
      console.error(`  ${ref}: ${r.error || 'unknown'}`);
    }
    process.exit(1);
  }
  for (const [ref, r] of Object.entries(result.refs || {})) {
    console.log(`  ${ref} → ${r.ok ? 'ok' : `failed: ${r.error}`}`);
  }
}

// ---------- 3. 推 tag（原生 receive-pack）----------

// tag 对象的本体在 .git/objects 里是 zlib 压缩的 loose object，直接解出来用，
// 不经过 `git cat-file`，保证发出去的字节与本地对象哈希一致。
function readLooseObject(sha) {
  const p = path.join(gitDirPath, 'objects', sha.slice(0, 2), sha.slice(2));
  if (!fs.existsSync(p)) {
    throw new Error(`找不到 loose object ${sha}（如果被 gc 打包进 packfile，请先 git unpack-objects 或改用 git push）`);
  }
  const raw = zlib.inflateSync(fs.readFileSync(p));
  const nul = raw.indexOf(0);
  const header = raw.subarray(0, nul).toString('utf8'); // "<type> <size>"
  const body = raw.subarray(nul + 1);
  const [type, size] = header.split(' ');
  if (Number(size) !== body.length) {
    throw new Error(`loose object ${sha} 头里的长度与实际不符`);
  }
  return { type, body };
}

const tagObj = readLooseObject(tagSha);
if (tagObj.type !== 'tag') {
  console.error(`refs/tags/${tag} 指向的是 ${tagObj.type}，不是 annotated tag。`);
  console.error('先打一个注解 tag：git tag -a ' + tag + ' -m "<说明>"');
  process.exit(2);
}

function pktLine(text) {
  const len = Buffer.byteLength(text) + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), Buffer.from(text, 'utf8')]);
}
const FLUSH = Buffer.from('0000', 'ascii');

// 单对象 packfile：类型 4 = tag。对象头是变长编码（低 4 位是 size 的低位，续位在最高位）。
function buildPackfile(typeCode, body) {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4); // version 2
  header.writeUInt32BE(1, 8); // 1 object

  const sizeBytes = [];
  let size = body.length;
  let byte = (typeCode << 4) | (size & 0x0f);
  size >>>= 4;
  while (size > 0) {
    sizeBytes.push(byte | 0x80);
    byte = size & 0x7f;
    size >>>= 7;
  }
  sizeBytes.push(byte);

  const entry = Buffer.concat([Buffer.from(sizeBytes), zlib.deflateSync(body)]);
  const noTrailer = Buffer.concat([header, entry]);
  return Buffer.concat([noTrailer, crypto.createHash('sha1').update(noTrailer).digest()]);
}

// 远端此刻这个 tag 指向什么？没有就是全 0（新建 ref）。
async function remoteTagSha() {
  const { res, json } = await api(`/git/ref/tags/${encodeURIComponent(tag)}`);
  if (res.status === 404) return '0'.repeat(40);
  if (!res.ok) throw new Error(`查远端 tag 失败：${res.status} ${JSON.stringify(json)}`);
  return json.object.sha;
}

const oldSha = await remoteTagSha();
if (oldSha === tagSha) {
  console.log(`tag ${tag} 远端已与本地一致（${tagSha.slice(0, 7)}），跳过。`);
} else {
  console.log(`推送 tag ${tag}：远端 ${oldSha.slice(0, 7)} → 本地 ${tagSha.slice(0, 7)}`);
  // 非快进需要 force：receive-pack 里靠 refspec 前的 "+" 表达，这里直接看 new/old 的祖先关系，
  // 简单起见只在显式 --force 或远端为空时允许覆盖历史 tag。
  if (oldSha !== '0'.repeat(40) && !force) {
    console.error(`远端已有 ${tag} 且指向别的对象；确认要覆盖请加 --force。`);
    process.exit(2);
  }
  const pack = buildPackfile(4, tagObj.body);
  const body = Buffer.concat([
    pktLine(`${oldSha} ${tagSha} refs/tags/${tag}\0report-status side-band-64k agent=pocket-harness/0.1.0`),
    FLUSH,
    pack,
  ]);
  const res = await fetch(`https://github.com/${owner}/${repo}.git/git-receive-pack`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
      'Content-Type': 'application/x-git-receive-pack-request',
      Accept: 'application/x-git-receive-pack-result',
      'User-Agent': 'pocket-harness-publisher',
    },
    body,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  // 响应是 side-band 多路复用的 pkt-line：通道 1 是状态，通道 2 是进度。
  let said = '';
  for (let i = 0; i + 4 <= buf.length; ) {
    const len = parseInt(buf.toString('ascii', i, i + 4), 16);
    if (!Number.isFinite(len) || len < 4) {
      i += 4; // flush-pkt(0000) 或 delim-pkt(0001/0002)
      continue;
    }
    const chunk = buf.subarray(i + 4, i + len);
    i += len;
    said += chunk[0] === 1 || chunk[0] === 2 ? chunk.subarray(1).toString('utf8') : chunk.toString('utf8');
  }
  said = said.replace(/\u0000/g, '').trim();
  if (!res.ok || /unpack (?!ok)/.test(said) || /\bng /.test(said)) {
    console.error(`tag 推送失败（HTTP ${res.status}）：`);
    console.error(said || '(服务端没说话)');
    process.exit(1);
  }
  console.log(`  refs/tags/${tag} → ok`);
}

// ---------- 4. 复查 ----------

const { res: refRes, json: refJson } = await api('/git/matching-refs/');
if (!refRes.ok) {
  console.error(`复查失败：${refRes.status}`);
  process.exit(1);
}
const wantBranch = `refs/heads/${branch}`;
const wantTag = `refs/tags/${tag}`;
const seen = new Map(refJson.map((r) => [r.ref, r.object]));
const branchOk = seen.get(wantBranch)?.sha === branchSha;
const tagOk = seen.get(wantTag)?.type === 'tag' && seen.get(wantTag)?.sha === tagSha;
console.log('远端复查：');
console.log(`  ${wantBranch} ${branchOk ? 'ok' : '不一致'}`);
for (const [ref, obj] of seen) {
  if (ref === wantBranch) continue;
  console.log(`  ${ref} ${obj.type}:${obj.sha.slice(0, 7)}`);
}
console.log(`  ${wantTag} ${tagOk ? 'ok（与本地注解 tag 同 sha）' : '不一致'}`);
process.exit(branchOk && tagOk ? 0 : 1);
