// Greps one file inside the Harness asar archive.
//
// The archive cannot be listed by normal tools, so this runs under
// ELECTRON_RUN_AS_NODE where electron's patched `fs` understands asar paths.
//
// Usage: <exe> probe/asar-grep.mjs <asar file> <regex> [contextLines]

import { readFileSync } from 'node:fs'

const [file, pattern, context] = process.argv.slice(2)
if (!file || !pattern) {
  process.stderr.write('usage: asar-grep.mjs <file> <regex> [contextLines]\n')
  process.exit(2)
}

const lines = readFileSync(file, 'utf8').split(/\r?\n/)
const regex = new RegExp(pattern)
const span = Number.parseInt(context ?? '0', 10)

for (let index = 0; index < lines.length; index += 1) {
  if (!regex.test(lines[index])) continue
  const from = Math.max(0, index - span)
  const to = Math.min(lines.length - 1, index + span)
  for (let cursor = from; cursor <= to; cursor += 1) {
    const marker = cursor === index ? '>' : ' '
    process.stdout.write(`${marker} ${cursor + 1}: ${lines[cursor]}\n`)
  }
  if (to > from) process.stdout.write('---\n')
}
