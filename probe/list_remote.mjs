// Enumerates every Remote endpoint declared by the installed DSH packages.
// Reads the shipped TypeScript sources (the asar keeps `src/` next to `lib/`)
// and prints `namespace/method` candidates with their marked decorators.
import fs from 'node:fs'
import path from 'node:path'

const packages = 'C:/Users/xuexu/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai'
const only = process.argv[2]

function* sources(dir, depth = 0) {
  if (depth > 4) return
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const full = path.posix.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'lib') continue
      yield* sources(full, depth + 1)
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      yield full
    }
  }
}

for (const name of fs.readdirSync(packages)) {
  if (only && !name.includes(only)) continue
  const dir = path.posix.join(packages, name)
  if (!fs.statSync(dir).isDirectory()) continue
  for (const file of sources(dir)) {
    const text = fs.readFileSync(file, 'utf8')
    if (!text.includes('@Remote')) continue
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      if (!/@Remote\b/.test(lines[i])) continue
      const marker = lines[i].trim()
      let signature = ''
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j += 1) {
        if (/^\s*(public |private |protected )?(async )?[A-Za-z_$][\w$]*\s*\(/.test(lines[j])) {
          signature = lines[j].trim()
          break
        }
      }
      console.log(`${name} | ${marker} ${signature}`)
    }
  }
}
