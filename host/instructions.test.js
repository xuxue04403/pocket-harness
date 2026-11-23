// The instruction-file endpoints, tested against a throwaway directory tree.
//
// The rules worth pinning are the ones a refactor would quietly loosen: which
// file names are allowed, where a write may land, and whether a missing file is
// an error rather than an implicit create.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import {
  BASE_CANDIDATES,
  CANDIDATE_NAMES,
  LOCAL_CANDIDATES,
  describeInstructions,
  describeEntry,
  findProjectRoot,
  isInside,
  readInstruction,
  serveInstructions,
  writeInstruction,
} from './instructions.js'

let root
let env

/** A project with a marker, a nested directory, and a global home beside it. */
before(() => {
  root = mkdtempSync(join(tmpdir(), 'pocket-instructions-'))
  env = { HOME: join(root, 'home'), DSH_HOME: join(root, 'dsh'), DSH_AGENTS_HOME: join(root, 'agents') }
  mkdirSync(env.DSH_HOME, { recursive: true })
  mkdirSync(env.DSH_AGENTS_HOME, { recursive: true })
  mkdirSync(join(root, 'project', '.git'), { recursive: true })
  mkdirSync(join(root, 'project', 'packages', 'app'), { recursive: true })
  mkdirSync(join(root, 'elsewhere'), { recursive: true })
  writeFileSync(join(env.DSH_HOME, 'AGENTS.md'), 'global rules\n')
  writeFileSync(join(root, 'project', 'AGENTS.md'), 'project rules\n')
  writeFileSync(join(root, 'project', 'packages', 'app', 'AGENTS.md'), 'app rules\n')
  writeFileSync(join(root, 'project', 'AGENTS.local.md'), 'local overlay\n')
  writeFileSync(join(root, 'elsewhere', 'notes.md'), 'not an instruction\n')
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

test('the candidate lists match what the loader documents', () => {
  assert.deepEqual(BASE_CANDIDATES, ['AGENTS.md', 'CLAUDE.md'])
  assert.deepEqual(LOCAL_CANDIDATES, ['AGENTS.local.md', 'CLAUDE.local.md'])
  assert.equal(CANDIDATE_NAMES.length, 4)
})

test('a project root is found by its marker, and absent outside one', () => {
  assert.equal(findProjectRoot(join(root, 'project', 'packages', 'app')), join(root, 'project'))
  assert.equal(findProjectRoot(join(root, 'project')), join(root, 'project'))
  assert.equal(findProjectRoot(join(root, 'elsewhere')), null)
})

test('containment rejects siblings and parents', () => {
  assert.equal(isInside(join(root, 'project', 'a'), join(root, 'project')), true)
  assert.equal(isInside(join(root, 'project'), join(root, 'project')), true)
  assert.equal(isInside(join(root, 'projectX'), join(root, 'project')), false)
  assert.equal(isInside(join(root), join(root, 'project')), false)
})

test('describe lists global files before the project chain, broad to specific', () => {
  const listing = describeInstructions(join(root, 'project', 'packages', 'app'), env)
  assert.equal(listing.projectRoot, join(root, 'project'))
  const names = listing.files.map(file => `${file.scope}:${file.label}:${file.name}`)
  assert.deepEqual(names, [
    'global:~/.dsh:AGENTS.md',
    'project:.:AGENTS.md',
    'project:.:AGENTS.local.md',
    'project:packages/app:AGENTS.md',
  ])
  assert.equal(listing.files[0].bytes, 'global rules\n'.length)
})

test('a directory with no instructions contributes nothing', () => {
  const listing = describeInstructions(join(root, 'elsewhere'), env)
  assert.equal(listing.projectRoot, null)
  assert.deepEqual(listing.files.map(file => file.scope), ['global'])
})

test('null cwd still reports the global chain', () => {
  const listing = describeInstructions(null, env)
  assert.equal(listing.projectRoot, null)
  assert.equal(listing.cwd, null)
  assert.equal(listing.files.length, 1)
})

test('read returns the text of an existing instruction file', () => {
  const read = readInstruction(join(root, 'project', 'AGENTS.md'))
  assert.equal(read.text, 'project rules\n')
  assert.equal(read.bytes, 'project rules\n'.length)
})

test('read refuses a name the loader would never load', () => {
  assert.throws(() => readInstruction(join(root, 'elsewhere', 'notes.md')), /is not one of/)
})

test('read refuses a missing file instead of inventing one', () => {
  assert.throws(() => readInstruction(join(root, 'project', 'CLAUDE.md')), /does not exist/)
})

test('a relative path is refused', () => {
  assert.throws(() => readInstruction('AGENTS.md'), /must be absolute/)
})

test('write saves an existing file and reports the new size', () => {
  const target = join(root, 'project', 'AGENTS.local.md')
  const written = writeInstruction(target, 'rewritten overlay\n', { env })
  assert.equal(written.bytes, 'rewritten overlay\n'.length)
  assert.equal(readInstruction(target).text, 'rewritten overlay\n')
})

test('write refuses a missing file unless create is set', () => {
  const target = join(root, 'project', 'packages', 'app', 'CLAUDE.md')
  assert.throws(() => writeInstruction(target, 'x', { env }), /does not exist yet/)
  const written = writeInstruction(target, 'created\n', { create: true, env })
  assert.equal(written.path, target)
  assert.equal(readInstruction(target).text, 'created\n')
})

test('write stays inside an instruction scope', () => {
  assert.throws(
    () => writeInstruction(join(root, 'elsewhere', 'AGENTS.md'), 'x', { create: true, env }),
    /not an instruction scope/,
  )
})

test('write cannot be used as a general file writer', () => {
  assert.throws(
    () => writeInstruction(join(root, 'project', 'package.json'), '{}', { create: true, env }),
    /is not one of/,
  )
})

test('oversized content is refused with a clear limit', () => {
  const huge = 'x'.repeat(600 * 1024)
  assert.throws(() => writeInstruction(join(root, 'project', 'AGENTS.md'), huge, { env }), /the limit is/)
})

test('non-string content is refused', () => {
  assert.throws(() => writeInstruction(join(root, 'project', 'AGENTS.md'), 42, { env }), /must be a string/)
})

test('serve routes the four methods and rejects the rest', () => {
  const listing = serveInstructions({ method: 'describe', args: { cwd: join(root, 'project') } }, env)
  // The global chain, the project base file, and the local overlay.
  assert.equal(listing.files.length, 3)
  assert.equal(serveInstructions({ method: 'read', args: { path: join(root, 'project', 'AGENTS.md') } }, env).text, 'project rules\n')
  serveInstructions({ method: 'write', args: { path: join(root, 'project', 'AGENTS.md'), text: 'via serve\n' } }, env)
  assert.equal(readInstruction(join(root, 'project', 'AGENTS.md')).text, 'via serve\n')
  assert.throws(() => serveInstructions({ method: 'delete' }, env), /has no method/)
})
test('a file that vanishes between listing and describing is skipped, not fatal', () => {
  // Listing checks each candidate and then stats it. A `git checkout`, an atomic
  // save, or someone deleting the file in that window makes the stat fail; one
  // vanished file must not take the whole page down on the phone.
  const row = describeEntry({
    scope: 'project',
    label: '.',
    path: join(root, 'project', 'AGENTS.md'),
    name: 'AGENTS.md',
  })
  assert.equal(row.name, 'AGENTS.md')
  // Another test may have rewritten this file, so compare with what is on disk now.
  assert.equal(row.bytes, statSync(join(root, 'project', 'AGENTS.md')).size)
  assert.equal(describeEntry({
    scope: 'project',
    label: '.',
    path: join(root, 'project', 'CLAUDE.md'),
    name: 'CLAUDE.md',
  }), null)
})