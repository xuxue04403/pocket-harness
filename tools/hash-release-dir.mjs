// 为一个发布目录生成 SHA256SUMS.txt。
//
// 发版时最容易被跳过的一步：三个 APK 换成了新构建，校验和却还是旧的，而
// verify-release.mjs 会拿服务端的 digest 跟上一次上传的 SHA256SUMS.txt 比，
// 于是「校验通过」变成了一句空话。所以每次换产物都重新算一遍，别手抄。
//
//   node tools/hash-release-dir.mjs dist/v0.1.1
//
// 只对目录里的产物算，不含 RELEASE_NOTES.md 与 SHA256SUMS.txt 自己：这两个是
// 说明文本，改了它们不该让安装包的校验值看起来变过。

import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? 'dist');
const SKIP = new Set(['SHA256SUMS.txt', 'RELEASE_NOTES.md']);

const names = readdirSync(dir)
  .filter((name) => !SKIP.has(name) && statSync(join(dir, name)).isFile())
  .sort();

if (names.length === 0) {
  console.error(`${dir} 里没有可校验的文件`);
  process.exit(1);
}

const lines = [];
for (const name of names) {
  const path = join(dir, name);
  const digest = await new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolveHash(hash.digest('hex')));
  });
  lines.push(`${digest}  ${name}`);
  console.log(`${name}  ${statSync(path).size}`);
}

// GNU coreutils 的格式：摘要、两个空格、文件名，行尾 LF。用 utf8 而不是 latin1：
// 文件名里可能带上发布说明中的中文，latin1 会把多字节字符截成一个个单字节。
writeFileSync(join(dir, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`, { encoding: 'utf8' });
console.log(`wrote ${join(dir, 'SHA256SUMS.txt')}`);
