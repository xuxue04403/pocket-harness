// 创建 GitHub release 并上传 dist/ 里的附件。
//
// 和 publish-git.mjs 一样，所有 HTTPS 都走 Node 的 OpenSSL（本机 git/curl 走 schannel，
// 沙箱内拿不到凭证，见 tools/publish-git.mjs 顶部注释）。
//
// 用法：
//   node tools/publish-release.mjs --owner <账号> [--repo pocket-harness]
//                                  [--tag v0.1.0-beta] [--dist dist/v0.1.0-beta]
//                                  [--name "Pocket Harness v0.1.0-beta"] [--draft] [--no-prerelease]
//
// 幂等：release 已存在就复用（只补缺失的附件），附件已存在就跳过。
// token 从 probe/_gh_token.txt 读，可用 POCKET_HARNESS_TOKEN_FILE 覆盖。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const has = (name) => process.argv.includes(`--${name}`);

const owner = arg('owner');
const repo = arg('repo', 'pocket-harness');
const tag = arg('tag', 'v0.1.0-beta');
const distDir = path.resolve(root, arg('dist', path.join('dist', tag)));
const releaseName = arg('name', `Pocket Harness ${tag}`);
const draft = has('draft');
const prerelease = !has('no-prerelease');

if (!owner) {
  console.error('缺少 --owner');
  process.exit(2);
}
if (!fs.existsSync(distDir)) {
  console.error(`找不到目录：${distDir}`);
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
const baseHeaders = {
  Authorization: `Bearer ${token}`,
  'User-Agent': 'pocket-harness-publisher',
  Accept: 'application/vnd.github+json',
};

async function api(pathname, init = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(apiBase + pathname, {
        ...init,
        headers: { ...baseHeaders, ...(init.headers || {}) },
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* 保留 text，错误信息里能看出发生了什么 */
      }
      return { res, json, text };
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

// ---------- 1. release ----------

const notesPath = path.join(distDir, 'RELEASE_NOTES.md');
if (!fs.existsSync(notesPath)) {
  console.error(`找不到 ${notesPath}`);
  process.exit(2);
}
const notes = fs.readFileSync(notesPath, 'utf8');

let release = null;
{
  const { res, json } = await api(`/releases/tags/${encodeURIComponent(tag)}`);
  if (res.ok) {
    release = json;
    console.log(`release ${tag} 已存在（id ${release.id}，草稿 ${release.draft}，预发布 ${release.prerelease}）`);
  } else if (res.status !== 404) {
    console.error(`查 release 失败：${res.status} ${JSON.stringify(json)}`);
    process.exit(1);
  }
}

if (!release) {
  const { res, json, text } = await api('/releases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      name: releaseName,
      body: notes,
      draft,
      prerelease,
    }),
  });
  if (!res.ok) {
    console.error(`创建 release 失败：${res.status} ${text.slice(0, 300)}`);
    process.exit(1);
  }
  release = json;
  console.log(`release 已创建：${release.html_url}`);
}

// ---------- 2. 附件 ----------

const CONTENT_TYPES = {
  '.apk': 'application/vnd.android.package-archive',
  '.bundle': 'application/octet-stream',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.zip': 'application/zip',
};

const have = new Set(release.assets.map((a) => a.name));
const files = fs.readdirSync(distDir).filter((f) => fs.statSync(path.join(distDir, f)).isFile()).sort();

let uploaded = 0;
for (const name of files) {
  if (have.has(name)) {
    console.log(`  跳过 ${name}（已存在）`);
    continue;
  }
  const abs = path.join(distDir, name);
  const body = fs.readFileSync(abs);
  const type = CONTENT_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream';
  const res = await fetch(
    `https://uploads.github.com/repos/${owner}/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: { ...baseHeaders, 'Content-Type': type, 'Content-Length': String(body.length) },
      body,
    },
  );
  if (!res.ok) {
    console.error(`  上传 ${name} 失败：${res.status} ${(await res.text()).slice(0, 200)}`);
    process.exit(1);
  }
  console.log(`  上传 ${name}（${(body.length / 1024 / 1024).toFixed(2)} MB）ok`);
  uploaded++;
}

// ---------- 3. 复查 ----------

const { res: checkRes, json: check } = await api(`/releases/tags/${encodeURIComponent(tag)}`);
if (!checkRes.ok) {
  console.error(`复查失败：${checkRes.status}`);
  process.exit(1);
}
const missing = files.filter((f) => !check.assets.some((a) => a.name === f && a.state === 'uploaded'));
console.log(`release ${check.tag_name}：${check.assets.length} 个附件，本次新增 ${uploaded} 个`);
for (const a of check.assets) {
  console.log(`  ${a.name} ${a.size} bytes ${a.state}`);
}
if (missing.length) {
  console.error(`仍缺：${missing.join(', ')}`);
  process.exit(1);
}
console.log(check.html_url);
process.exit(0);
