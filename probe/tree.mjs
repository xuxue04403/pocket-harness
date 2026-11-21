import fs from 'node:fs'
import path from 'node:path'

const root = process.argv[2] ?? 'C:/Users/xuexu/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-typert-registry'

function walk(dir, depth = 0) {
  if (depth > 3) return
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const full = path.posix.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      walk(full, depth + 1)
    } else {
      console.log(`${fs.statSync(full).size} ${full}`)
    }
  }
}

walk(root)
