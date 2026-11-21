import fs from 'node:fs'
import path from 'node:path'

const roots = [
  'C:/Users/xuexu/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules',
  'C:/Users/xuexu/.dsh/profiles/desktop/node_modules',
]

for (const root of roots) {
  let entries = []
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { continue }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (/qr/i.test(entry.name)) console.log('DIR', path.posix.join(root, entry.name))
    if (!entry.name.startsWith('@')) continue
    const scope = path.posix.join(root, entry.name)
    let inner = []
    try { inner = fs.readdirSync(scope, { withFileTypes: true }) } catch { continue }
    for (const sub of inner) {
      if (/qr/i.test(sub.name)) console.log('DIR', path.posix.join(scope, sub.name))
    }
  }
}
