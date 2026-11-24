// 把 release 的附件全部删掉，让 publish-release.mjs 重新上传本次构建的产物。
//
// 为什么需要单独一步：publish-release.mjs 是幂等的——同名附件已存在就跳过。
// 但这一版换了新的 APK（会话树形视图），跳过会让 release 上留着上一版的文件，
// 而 SHA256SUMS.txt 已经指向新的字节，两边就对不上了。所以先把旧的清空。
//
// 用法：node tools/reset-release-assets.mjs --owner <账号> --tag v0.1.0-beta
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
const tag = arg('tag', 'v0.1.0-beta');

if (!owner) {
  console.error('缺少 --owner');
  process.exit(1);
}

const tokenFile = process.env.POCKET_HARNESS_TOKEN_FILE ?? path.join(root, 'probe', '_gh_token.txt');
if (!fs.existsSync(tokenFile)) {
  console.error(`找不到 token 文件：${tokenFile}`);
  process.exit(1);
}
const token = fs.readFileSync(tokenFile, 'utf8').trim();
if (!token.startsWith('github_pat_') && !token.startsWith('ghp_')) {
  console.error('token 看起来没写完整。');
  process.exit(1);
}

const baseHeaders = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'pocket-harness-release-reset',
};

async function api(pathname, init = {}) {
  // api.github.com 偶发 ECONNRESET，退避重试比让人手动重跑更省事。
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const res = await fetch(`https://api.github.com${pathname}`, {
        ...init,
        headers: { ...baseHeaders, ...(init.headers ?? {}) },
      });
      const text = await res.text();
      let body = null;
      try {
        body = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      return { res, json: body };
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  throw new Error('unreachable');
}

const { res, json } = await api(`/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`);
if (!res.ok) {
  console.error(`查 release 失败：${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  process.exit(1);
}

if (json.assets.length === 0) {
  console.log('release 上没有附件，无需清理。');
  process.exit(0);
}

for (const asset of json.assets) {
  const del = await api(`/repos/${owner}/${repo}/releases/assets/${asset.id}`, { method: 'DELETE' });
  if (del.res.status === 204 || del.res.ok) {
    console.log(`  删除 ${asset.name}（${asset.size} bytes）ok`);
    continue;
  }
  console.error(`  删除 ${asset.name} 失败：${del.res.status} ${JSON.stringify(del.json).slice(0, 200)}`);
  process.exit(1);
}

const after = await api(`/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`);
console.log(`复查：release 现在有 ${after.json.assets.length} 个附件`);
process.exit(after.json.assets.length === 0 ? 0 : 1);
