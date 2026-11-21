import { build } from 'esbuild'

const shared = { bundle: true, format: 'esm', sourcemap: false, logLevel: 'info' }

await build({ ...shared, entryPoints: ['src/index.ts'], outfile: 'build/index.mjs', platform: 'neutral', target: 'es2022' })
await build({ ...shared, entryPoints: ['test/vectors.ts'], outfile: 'build/vectors.mjs', platform: 'node', target: 'es2022' })
await build({ ...shared, entryPoints: ['test/protocol.ts'], outfile: 'build/protocol.mjs', platform: 'node', target: 'es2022' })
await build({ ...shared, entryPoints: ['test/framing.ts'], outfile: 'build/framing.mjs', platform: 'node', target: 'es2022' })
await build({ ...shared, entryPoints: ['test/client.ts'], outfile: 'build/client.mjs', platform: 'node', target: 'es2022' })
await build({ ...shared, entryPoints: ['test/live.ts'], outfile: 'build/live.mjs', platform: 'node', target: 'es2022' })
