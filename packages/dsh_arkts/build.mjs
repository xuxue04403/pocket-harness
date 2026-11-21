import { build } from 'esbuild'

const shared = { bundle: true, format: 'esm', sourcemap: false, logLevel: 'info' }

await build({ ...shared, entryPoints: ['src/index.ts'], outfile: 'build/index.mjs', platform: 'neutral', target: 'es2022' })
await build({ ...shared, entryPoints: ['test/vectors.ts'], outfile: 'build/vectors.mjs', platform: 'node', target: 'es2022' })
await build({ ...shared, entryPoints: ['test/protocol.ts'], outfile: 'build/protocol.mjs', platform: 'node', target: 'es2022' })
await build({ ...shared, entryPoints: ['test/framing.ts'], outfile: 'build/framing.mjs', platform: 'node', target: 'es2022' })
await build({ ...shared, entryPoints: ['test/client.ts'], outfile: 'build/client.mjs', platform: 'node', target: 'es2022' })
await build({ ...shared, entryPoints: ['test/session_rows.ts'], outfile: 'build/session_rows.mjs', platform: 'node', target: 'es2022' })
await build({ ...shared, entryPoints: ['test/transcript.ts'], outfile: 'build/transcript.mjs', platform: 'node', target: 'es2022' })
await build({ ...shared, entryPoints: ['test/relay_protocol.ts'], outfile: 'build/relay_protocol.mjs', platform: 'node', target: 'es2022' })
await build({ ...shared, entryPoints: ['test/relay_contract.ts'], outfile: 'build/relay_contract.mjs', platform: 'node', target: 'es2022' })
await build({ ...shared, entryPoints: ['test/questions.ts'], outfile: 'build/questions.mjs', platform: 'node', target: 'es2022' })
await build({ ...shared, entryPoints: ['test/live.ts'], outfile: 'build/live.mjs', platform: 'node', target: 'es2022' })
await build({ ...shared, entryPoints: ['test/live_transcript.ts'], outfile: 'build/live_transcript.mjs', platform: 'node', target: 'es2022' })
await build({ ...shared, entryPoints: ['test/live_relay.ts'], outfile: 'build/live_relay.mjs', platform: 'node', target: 'es2022' })
