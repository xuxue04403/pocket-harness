// 把仓库推到 GitHub：分支与 annotated tag 都走 git 的 receive-pack 线上协议。
//
// 为什么不用 `git push`：这台 Windows 上 git 只编了 schannel，沙箱里 schannel 拿不到
// 客户端凭证（AcquireCredentialsHandle: SEC_E_NO_CREDENTIALS），任何 https:// I/O 都失败。
// 为什么不用 isomorphic-git 的 push：它只推 `refs/heads/*`（tag 会被静默忽略），
// 而且在「远端已经一致、无事可做」时不会收尾，把连接挂到超时。
// 所以这里只借用 isomorphic-git 的**对象遍历与打包**，传输层自己走
// tools/github-transport.mjs（内置 GitHub 边缘地址探测 + 分片上传）。
//
// 用法（token 只从文件读，不进命令行、不进 .git/config）：
//   node tools/publish-git.mjs --owner <账号> [--repo pocket-harness]
//                              [--branch master] [--tag v0.1.7] [--force]
//
// 环境变量 POCKET_HARNESS_TOKEN_FILE 可换 token 路径，默认 probe/_gh_token.txt。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createTransport } from './github-transport.mjs';

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
const { mod: gitMod } = await loadFrom('isomorphic-git', searchDirs);
const git = gitMod.default || gitMod;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const has = (name) => process.argv.includes(`--${name}`);

const owner = arg('owner');
const repo = arg('repo', 'pocket-harness');
const tag = arg('tag', 'v0.1.7');
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

const transport = createTransport({ token, owner, repo, log: (line) => console.log(line) });
const ZERO = '0'.repeat(40);

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

// ---------- 2. 打包要送的对象 ----------

// 从某个 commit 出发，收集「提交 + 它引用的所有树与 blob」。
// isomorphic-git 没有 rev-list，所以要自己走一遍；返回的 oid 集合直接交给 packObjects。
//
// stopAt 是远端已有的提交：从它可达的对象一律不打包。远端每次只多几个提交，
// 不传这个参数就会把整部历史（近 2000 个对象、3 MB 以上）重新送一遍——那不是
// 体积问题，而是每次推 3 MB 都会更容易撞上本机那条不稳定的出口。
async function closureOf(commitSha, stopAt = null) {
  const skip = new Set();
  if (stopAt) {
    try {
      for (const commit of await git.log({ fs, dir: root, ref: stopAt })) skip.add(commit.oid);
    } catch (error) {
      // 远端的分支头在本地不存在：别的机器或网页上合过 PR。这里没法自己修
      // （本机 git 走 schannel，https 不可用），所以只把话说清楚，别让人对着
      // 一句 `Could not find <sha>` 猜。
      console.error(`远端 ${stopAt.slice(0, 7)} 在本地不存在，说明远端有本地没有的提交。`);
      console.error('先把它取回来再发版（在能用的环境里 `git fetch`），否则推送会因为非快进而被拒。');
      console.error(`（原始错误：${error.message}）`);
      process.exit(2);
    }
  }
  const seen = new Set();
  const addTree = async (oid) => {
    if (!oid || seen.has(oid)) return;
    seen.add(oid);
    const { type, object } = await git.readObject({ fs, dir: root, oid });
    if (type !== 'tree') return;
    for (const entry of object) {
      if (entry.type === 'tree') await addTree(entry.oid);
      else seen.add(entry.oid);
    }
  };
  const log = await git.log({ fs, dir: root, ref: commitSha });
  for (const commit of log) {
    if (seen.has(commit.oid) || skip.has(commit.oid)) continue;
    seen.add(commit.oid);
    const { object } = await git.readObject({ fs, dir: root, oid: commit.oid });
    await addTree(object.tree);
  }
  return [...seen];
}

async function packOf(oids) {
  const { packfile } = await git.packObjects({ fs, dir: root, oids });
  return Buffer.from(packfile);
}

// 单对象 packfile：类型 4 = tag。对象头是变长编码（低 4 位是 size 的低位，续位在最高位）。
function buildPackfile(typeCode, body) {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(1, 8);
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

// ---------- 3. 推分支 ----------

async function remoteSha(refName) {
  const { status, json } = await transport.apiJson(`/git/ref/${refName}`);
  // 404 是「这个 ref 还没有」；空仓库则对任何 ref 都回 409 "Git Repository is empty"。
  // 两者对这里都是「远端什么都没有」，否则新建仓库后的第一次发版会在这里炸掉。
  if (status === 404 || status === 409) return null;
  if (status !== 200) throw new Error(`查远端 ${refName} 失败：HTTP ${status}`);
  return json.object.sha;
}

const remoteBranch = await remoteSha(`heads/${branch}`);
if (remoteBranch === branchSha) {
  console.log(`分支 refs/heads/${branch} 远端已是最新（${branchSha.slice(0, 7)}），跳过推送。`);
} else {
  console.log(`推送分支 refs/heads/${branch} → ${owner}/${repo}（${(remoteBranch || '空').slice(0, 7)} → ${branchSha.slice(0, 7)}）`);
  const oids = await closureOf(branchSha, remoteBranch);
  console.log(`  打包 ${oids.length} 个对象…`);
  const pack = await packOf(oids);
  console.log(`  ${(pack.length / 1024 / 1024).toFixed(2)} MB`);
  const result = await transport.receivePack(`refs/heads/${branch}`, remoteBranch || ZERO, branchSha, pack);
  if (!result.ok) {
    console.error(`分支推送失败：${result.error?.message ?? result.said ?? '未知原因'}`);
    process.exit(1);
  }
  console.log(`  refs/heads/${branch} → ok`);
}

// ---------- 4. 推 tag（单对象 pack）----------

const tagSha = readRef(`refs/tags/${tag}`);
if (!tagSha) {
  console.error(`本地没有 refs/tags/${tag}`);
  console.error('先打一个注解 tag：git tag -a ' + tag + ' -m "<说明>"');
  process.exit(2);
}

// tag 对象的本体在 .git/objects 里是 zlib 压缩的 loose object，直接解出来用，
// 不经过 `git cat-file`，保证发出去的字节与本地对象哈希一致。
//
// 但 git 的自动 gc 会把 loose object 压进 packfile（实测打过几次 tag 之后就会发生），
// 这时文件根本不存在。不能因此报错退出：回落到 isomorphic-git 的 readObject 取
// `format: 'content'`，它给的同样是解压后的原始字节，算出来的 sha 与本地一致。
function readLooseObject(sha) {
  const p = path.join(gitDirPath, 'objects', sha.slice(0, 2), sha.slice(2));
  if (!fs.existsSync(p)) return null;
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

async function readObjectBody(sha) {
  const loose = readLooseObject(sha);
  if (loose) return loose;
  const { type, object } = await git.readObject({ fs, dir: root, oid: sha, format: 'content' });
  return { type, body: Buffer.from(object) };
}

const tagObj = await readObjectBody(tagSha);
if (tagObj.type !== 'tag') {
  console.error(`refs/tags/${tag} 指向的是 ${tagObj.type}，不是 annotated tag。`);
  process.exit(2);
}

const oldTag = await remoteSha(`tags/${tag}`);
if (oldTag === tagSha) {
  console.log(`tag ${tag} 远端已与本地一致（${tagSha.slice(0, 7)}），跳过。`);
} else {
  console.log(`推送 tag ${tag}：远端 ${(oldTag || '空').slice(0, 7)} → 本地 ${tagSha.slice(0, 7)}`);
  if (oldTag !== null && !force) {
    console.error(`远端已有 ${tag} 且指向别的对象；确认要覆盖请加 --force。`);
    process.exit(2);
  }
  const pack = buildPackfile(4, tagObj.body);
  const result = await transport.receivePack(`refs/tags/${tag}`, oldTag || ZERO, tagSha, pack);
  if (!result.ok) {
    console.error(`tag 推送失败：${result.error?.message ?? result.said ?? '未知原因'}`);
    process.exit(1);
  }
  console.log(`  refs/tags/${tag} → ok`);
}

// ---------- 5. 复查 ----------

// 复查要列全远端 ref：GitHub 的 matching-refs 默认每页 30 条，翻页参数写错或漏了
// 就会在 ref 多起来之后把一次成功的发版判成「不一致」。
const seen = new Map();
for (let page = 1; page <= 20; page += 1) {
  const { status, json } = await transport.apiJson(`/git/matching-refs/?per_page=100&page=${page}`);
  if (status !== 200) {
    console.error(`复查失败：HTTP ${status}`);
    process.exit(1);
  }
  if (!Array.isArray(json) || json.length === 0) break;
  for (const r of json) seen.set(r.ref, r.object);
  if (json.length < 100) break;
}
const wantBranch = `refs/heads/${branch}`;
const wantTag = `refs/tags/${tag}`;
const branchOk = seen.get(wantBranch)?.sha === branchSha;
const tagOk = seen.get(wantTag)?.type === 'tag' && seen.get(wantTag)?.sha === tagSha;
console.log('远端复查：');
console.log(`  ${wantBranch} ${branchOk ? 'ok' : '不一致'}`);
for (const [ref, obj] of seen) {
  if (ref === wantBranch || ref === wantTag) continue;
  console.log(`  ${ref} ${obj.type}:${obj.sha.slice(0, 7)}`);
}
console.log(`  ${wantTag} ${tagOk ? 'ok（与本地注解 tag 同 sha）' : '不一致'}`);
process.exit(branchOk && tagOk ? 0 : 1);
