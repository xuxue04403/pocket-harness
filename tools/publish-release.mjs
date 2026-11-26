// 创建 GitHub release 并上传 dist/ 里的附件。
//
// 和 publish-git.mjs 一样，所有 HTTPS 都走 Node 的 OpenSSL（本机 git/curl 走 schannel，
// 沙箱内拿不到凭证，见 tools/publish-git.mjs 顶部注释）。
//
// 用法：
//   node tools/publish-release.mjs --owner <账号> [--repo pocket-harness]
//                                  [--tag v0.1.7] [--dist dist/v0.1.7]
//                                  [--name "Pocket Harness v0.1.7"] [--draft] [--no-prerelease]
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
const tag = arg('tag', 'v0.1.7');
const distDir = path.resolve(root, arg('dist', path.join('dist', tag)));
const releaseName = arg('name', `Pocket Harness ${tag}`);
const draft = has('draft');
// `v0.1.0-beta` 是预发布，`v0.1.6` 不是。默认按 tag 判断，因为「记得加
// --no-prerelease」这件事每次都忘：前几版全都挂成了 pre-release，GitHub 的
// `/releases/latest` 于是指向一个旧版本，而手动访问页面的人看到的也是「预发布」标签。
const looksPrerelease = /-(?:alpha|beta|rc|pre|dev)[.\d]*$/i.test(tag);
const prerelease = has('prerelease') ? true : has('no-prerelease') ? false : looksPrerelease;

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
    let res;
    let text;
    try {
      res = await fetch(apiBase + pathname, {
        ...init,
        headers: { ...baseHeaders, ...(init.headers || {}) },
      });
      text = await res.text();
    } catch (err) {
      // 连不上：退避重试。api.github.com 在国内常被 reset，值得多试几次。
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    // 5xx 也是「这次没成」，不是「服务端说你错了」：502/503 重试一次往往就好了。
    // 之前只对网络异常重试，于是 GitHub 抖一下就把一次发版打死在第一步。
    if (res.status >= 500 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* 保留 text，错误信息里能看出发生了什么 */
    }
    return { res, json, text };
  }
}

// ---------- 1. release ----------

const notesPath = path.join(distDir, 'RELEASE_NOTES.md');
if (!fs.existsSync(notesPath)) {
  console.error(`找不到 ${notesPath}`);
  process.exit(2);
}
const notes = fs.readFileSync(notesPath, 'utf8');

// SHA256SUMS.txt 是发布物的一部分，少了它等于这次发版没法校验。之前只查了说明文件，
// 于是漏掉校验和的一版照样发出去，下载页面上就少一行「怎么验」。
const sumsPath = path.join(distDir, 'SHA256SUMS.txt');
if (!fs.existsSync(sumsPath)) {
  console.error(`找不到 ${sumsPath}（先跑 node tools/hash-release-dir.mjs --dir ${distDir}）`);
  process.exit(2);
}
const sums = fs.readFileSync(sumsPath, 'utf8');
if (!sums.trim()) {
  console.error(`${sumsPath} 是空的`);
  process.exit(2);
}

// 建 release 之前先确认远端真有这个 tag。POST /releases 在 tag 不存在时不会报错，
// 而是拿 target_commitish（默认分支 HEAD）**自动建一个轻量 tag**：打错一个字，
// 或者先跑 publish-release 后跑 publish-git，远端就多出一个指向 HEAD 的同名轻量
// tag，之后 publish-git.mjs 见 `oldTag !== null` 只会拒绝（--force 也只能把注解 tag
// 硬指到那个位置），release 页面已经挂在错的提交上，只能手工删 tag 再删 release 重来。
{
  const { res } = await api(`/git/ref/tags/${encodeURIComponent(tag)}`);
  if (res.status === 404) {
    // 409 是「Git Repository is empty」，也当作 tag 不存在，让后面的创建自己去报。
    console.error(`远端还没有 tag ${tag}。先推 tag，再建 release：`);
    console.error(`  node tools/publish-git.mjs --owner ${owner} --branch master --tag ${tag}`);
    process.exit(2);
  }
  if (!res.ok && res.status !== 409) {
    console.error(`查 tag ${tag} 失败：${res.status}`);
    process.exit(1);
  }
}

let release = null;
{
  const { res, json, text } = await api(`/releases/tags/${encodeURIComponent(tag)}`);
  if (res.status === 404) {
    // GET /releases/tags/{tag} 看不见草稿 release。所以「404」只说明没有已发布的
    // release，草稿可能正躺在那里——而 POST /releases 对同名 tag 会回 422
    // already_exists，这一步就永远过不去，只能去网页上手工删。翻一遍列表，
    // 按 tag 名字把草稿认回来。
    const { res: listRes, json: listed, text: listText } = await api('/releases?per_page=100');
    if (!listRes.ok) {
      console.error(`列 release 失败：${listRes.status} ${String(listText ?? '').slice(0, 300)}`);
      process.exit(1);
    }
    if (!Array.isArray(listed)) {
      console.error('列 release 返回的不是数组。');
      process.exit(1);
    }
    const draftHit = listed.find((item) => item.draft === true && item.tag_name === tag);
    if (draftHit) {
      release = draftHit;
      console.log(`release ${tag} 是草稿（id ${release.id}），接着往它上面传。`);
    }
  } else if (res.ok) {
    release = json;
    console.log(`release ${tag} 已存在（id ${release.id}，草稿 ${release.draft}，预发布 ${release.prerelease}）`);
  } else {
    console.error(`查 release 失败：${res.status} ${String(text ?? '').slice(0, 300)}`);
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
} else if (release.body !== notes || release.prerelease !== prerelease || release.draft !== draft) {
  // 复用已有 release 时也要把说明与两个开关对齐，否则重发一版只会换掉附件，
  // 页面上的说明还停在上一次：附件是新的、文字是旧的，看起来像发了一半。
  const { res, json, text } = await api(`/releases/${release.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: releaseName, body: notes, draft, prerelease }),
  });
  if (!res.ok) {
    console.error(`更新 release 失败：${res.status} ${text.slice(0, 300)}`);
    process.exit(1);
  }
  release = json;
  console.log(`release 已更新：说明与预发布标记（预发布 ${release.prerelease}）`);
}

// ---------- 2. 附件 ----------

const CONTENT_TYPES = {
  '.apk': 'application/vnd.android.package-archive',
  '.bundle': 'application/octet-stream',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.zip': 'application/zip',
};

// 同名附件只比名字是不够的：重跑一版、本地文件重新构建过之后大小变了，名字没变，
// 就会被当成「已存在」跳过，页面上留着上一次的字节。比一下大小，不一致就报出来，
// 让人用 reset-release-assets.mjs 清掉再发。
const have = new Map(release.assets.map((a) => [a.name, a.size]));
const files = fs.readdirSync(distDir).filter((f) => fs.statSync(path.join(distDir, f)).isFile()).sort();

let uploaded = 0;
for (const name of files) {
  if (have.has(name)) {
    const localSize = fs.statSync(path.join(distDir, name)).size;
    if (have.get(name) === localSize) {
      console.log(`  跳过 ${name}（已存在，${localSize} bytes）`);
      continue;
    }
    console.error(`  ${name} 已存在但大小不同：远端 ${have.get(name)} bytes，本地 ${localSize} bytes。`);
    console.error('  先清掉旧附件再发：node tools/reset-release-assets.mjs --owner ' + owner + ' --tag ' + tag);
    process.exit(1);
  }
  const abs = path.join(distDir, name);
  const body = fs.readFileSync(abs);
  const type = CONTENT_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream';
  const url = `https://uploads.github.com/repos/${owner}/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
  // 这条出口传 13 MB 的 APK 会在几百 KB 处被 reset，而 uploads.github.com 不在
  // github-transport.mjs 的边缘地址表里，没法换地址。只能退避重试：每次重传都从
  // 头开始，GitHub 对同名附件的重复上传回 422 already_exists，所以真的传上去了
  // 那一半会以 422 收场——这里把 422 当作「已经在了」，交给第 3 步的复查去核对字节。
  let res = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) {
      const wait = 3000 * attempt;
      console.error(`  ${name} 第 ${attempt + 1} 次重试，先等 ${wait / 1000} 秒…`);
      await new Promise((r) => setTimeout(r, wait));
    }
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { ...baseHeaders, 'Content-Type': type, 'Content-Length': String(body.length) },
        body,
      });
    } catch {
      // 上一次留下的响应不能代表这一次：清掉它，否则最后的报错会是一个早就过期的状态码。
      res = null;
      continue;
    }
    if (res.ok || res.status === 422) break;
    if (res.status < 500) break;
  }
  if (!res) {
    console.error(`  上传 ${name} 失败：连接始终没建起来`);
    process.exit(1);
  }
  if (!res.ok && res.status !== 422) {
    console.error(`  上传 ${name} 失败：${res.status} ${(await res.text()).slice(0, 200)}`);
    process.exit(1);
  }
  console.log(`  上传 ${name}（${(body.length / 1024 / 1024).toFixed(2)} MB）${res.status === 422 ? '已在 release 上' : 'ok'}`);
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
