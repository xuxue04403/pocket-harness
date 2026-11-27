// 校验 release 上的附件与 SHA256SUMS.txt 是否真的对得上。
//
// 上传是分两次做的（先 SHA256SUMS.txt 再各附件），中间若有任何一个文件被重新
// 生成，release 上就会是一组自相矛盾的产物。所以这里把附件本身下回来重新算一遍，
// 而不是相信上传时的返回值。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const owner = arg('owner');
const repo = arg('repo', 'pocket-harness');
const tag = arg('tag', 'v0.1.7');
const forceDownload = process.argv.includes('--download');

if (!owner) {
  console.error('缺少 --owner');
  process.exit(1);
}

const tokenFile = process.env.POCKET_HARNESS_TOKEN_FILE ?? path.join(root, 'probe', '_gh_token.txt');
if (!fs.existsSync(tokenFile)) {
  console.error(`找不到 token 文件 ${tokenFile}（放一个 GitHub token 进去，或用 POCKET_HARNESS_TOKEN_FILE 指路）`);
  process.exit(2);
}
const token = fs.readFileSync(tokenFile, 'utf8').trim();
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'pocket-harness-release-verify',
};

// 下载附件走 `asset.url`（`/releases/assets/<id>`）而不是 `browser_download_url`：
// 后者先打到 github.com 再 302 到 objects，本机到 github.com 的连接经常在传输中途
// 被 reset，而 api.github.com 一直通。`Accept: application/octet-stream` 让同一个
// URL 直接回字节而不是 JSON。
async function get(url, asJson = true, attempts = 6) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { ...headers, ...(asJson ? {} : { Accept: 'application/octet-stream' }) } });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const bytes = asJson ? null : Buffer.from(await res.arrayBuffer());
      // 空 body 也算失败重试：连接被中途掐断时 fetch 有时不抛错，只回 0 字节。
      if (bytes !== null && bytes.length === 0) throw new Error('空响应');
      return asJson ? await res.json() : bytes;
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
  throw lastError;
}

const release = await get(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`);
const sums = release.assets.find((a) => a.name === 'SHA256SUMS.txt');
if (!sums) {
  console.error('release 上没有 SHA256SUMS.txt');
  process.exit(1);
}

const text = (await get(sums.url, false)).toString('utf8');
const expected = new Map();
for (const line of text.split(/\r?\n/)) {
  const match = /^([0-9a-f]{64})\s+(.+)$/.exec(line.trim());
  if (match) expected.set(match[2], match[1]);
}

console.log(`SHA256SUMS.txt 列出 ${expected.size} 个文件`);

// GitHub 给每个附件算了一个 sha256 digest，服务端算的、跟着附件一起返回。
// 本机到 github.com 的连接经常中途断掉（下载 URL 要经过它 302 到 objects），
// 所以有 digest 就用 digest 比对；没有才把文件下回来自己算。`--download` 强制每
// 个附件都下回来重算，用来验证「本机能真的取到完整字节」，而不只是服务端记账。
const useDigest = (asset) => !forceDownload && typeof asset.digest === 'string' && asset.digest.startsWith('sha256:');

let bad = 0;
let downloaded = 0;
for (const [name, want] of expected) {
  const asset = release.assets.find((a) => a.name === name);
  if (!asset) {
    console.error(`  缺附件 ${name}`);
    bad += 1;
    continue;
  }
  let got;
  if (useDigest(asset)) {
    got = asset.digest.slice('sha256:'.length);
  } else {
    got = crypto.createHash('sha256').update(await get(asset.url, false)).digest('hex');
    downloaded += 1;
  }
  if (got === want) {
    console.log(`  ok   ${name} ${asset.size} bytes`);
  } else {
    console.error(`  BAD  ${name} 期望 ${want.slice(0, 12)}… 实际 ${got.slice(0, 12)}…`);
    bad += 1;
  }
}

console.log(`（${expected.size - downloaded} 个用服务端 digest，${downloaded} 个下载后自算）`);

console.log(bad === 0 ? 'RELEASE ASSETS VERIFIED' : `${bad} 个附件对不上`);
process.exit(bad === 0 ? 0 : 1);
