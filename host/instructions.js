// Reading and editing the instruction files the agent actually loads.
//
// DSH loads `AGENTS.md`-style files from a user-global chain and a project chain
// (`@deepseek-ai/dsh-agent-instructions` decides which ones).  The Remote API can
// read workspace files but has no write endpoint, so a phone could see the file
// that shapes its agent and not touch it.  These four endpoints close that gap.
//
// Two rules keep this safe to expose:
//   * a write only ever targets a file name the loader itself would consider —
//     nothing else, at any path;
//   * a write only lands inside a directory that is already an instruction scope
//     for this user, so the phone cannot create an `AGENTS.md` anywhere it likes.
//
// Everything here is plain node: no `@deepseek-ai/*` imports, so it tests without
// a running Harness.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Names the loader loads as base candidates in every project directory. */
export const BASE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md']

/** Names loaded after the base ones as local overlays. */
export const LOCAL_CANDIDATES = ['AGENTS.local.md', 'CLAUDE.local.md']

/** Any file the loader might pick up. A write must name one of these. */
export const CANDIDATE_NAMES = [...BASE_CANDIDATES, ...LOCAL_CANDIDATES]

/** Refuse to ship something the loader would truncate anyway. */
export const MAX_INSTRUCTION_BYTES = 512 * 1024

/** Marker the loader uses to stop its upward search for the project root. */
const PROJECT_MARKERS = ['.git']

/** The namespace the phone calls; also what the Host adapter branches on. */
export const INSTRUCTIONS_NAMESPACE = 'pocketInstructions'

/** Where the user-global chains live, honouring the two documented overrides. */
export function globalRoots(env = process.env) {
  const home = env.DSH_HOME ?? join(homedir(), '.dsh')
  const agents = env.DSH_AGENTS_HOME ?? join(homedir(), '.agents')
  return [
    { scope: 'global', root: home, label: '~/.dsh' },
    { scope: 'global', root: agents, label: '~/.agents' },
  ]
}

/** True when `path` exists and is a regular file. */
function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** True when `path` exists and is a directory. */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Walks up from `start` to the first directory carrying a project marker.
 *
 * Returns null when the walk reaches the filesystem root without one: a stray
 * `AGENTS.md` outside any project is not a project instruction.
 */
export function findProjectRoot(start) {
  let current = resolve(start)
  for (;;) {
    for (const marker of PROJECT_MARKERS) {
      if (existsSync(join(current, marker))) return current
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/** True when `child` is `parent` or lives underneath it. */
export function isInside(child, parent) {
  const from = resolve(parent)
  const to = resolve(child)
  if (from === to) return true
  const step = relative(from, to)
  return step.length > 0 && !step.startsWith('..') && !isAbsolute(step)
}

/**
 * Every instruction file that applies to a session working in `cwd`.
 *
 * The order matches the loader's: the two user-global roots first, then each
 * directory from the project root down to `cwd`, base candidates before local
 * overlays. Directories without any candidate simply contribute nothing.
 */
export function listInstructionFiles(cwd, env = process.env) {
  const files = []
  for (const entry of globalRoots(env)) {
    for (const name of CANDIDATE_NAMES) {
      const path = join(entry.root, name)
      if (isFile(path)) files.push({ scope: entry.scope, label: entry.label, path, name })
    }
  }
  const projectRoot = cwd === null || cwd === undefined ? null : findProjectRoot(cwd)
  if (projectRoot === null) return { projectRoot: null, files }
  const chain = directoriesTo(projectRoot, resolve(cwd))
  for (const directory of chain) {
    // Labels go to a phone's screen, so keep them slash-separated on every OS.
    const label = relative(projectRoot, directory).split(sep).join('/') || '.'
    for (const name of CANDIDATE_NAMES) {
      const path = join(directory, name)
      if (isFile(path)) files.push({ scope: 'project', label, path, name })
    }
  }
  return { projectRoot, files }
}

/** `projectRoot` down to `cwd`, inclusive, refusing anything that escapes. */
function directoriesTo(projectRoot, cwd) {
  if (!isInside(cwd, projectRoot)) return [projectRoot]
  const chain = [projectRoot]
  let current = projectRoot
  const rest = relative(projectRoot, cwd)
  if (rest.length === 0) return chain
  for (const segment of rest.split(sep)) {
    current = join(current, segment)
    chain.push(current)
  }
  return chain
}

/** One row per file, with the metadata a phone needs to show a list. */
export function describeInstructions(cwd, env = process.env) {
  const { projectRoot, files } = listInstructionFiles(cwd, env)
  return {
    projectRoot,
    cwd: cwd ?? null,
    files: files.map(file => {
      const stats = statSync(file.path)
      return {
        scope: file.scope,
        label: file.label,
        path: file.path,
        name: file.name,
        bytes: stats.size,
        modifiedAt: stats.mtimeMs,
      }
    }),
  }
}

/** Reads one file, refusing anything the loader would not load. */
export function readInstruction(path) {
  const checked = guardPath(path)
  const stats = statSync(checked.path)
  if (stats.size > MAX_INSTRUCTION_BYTES) {
    throw coded('FILE_TOO_LARGE', `this file is ${stats.size} bytes; the limit is ${MAX_INSTRUCTION_BYTES}`)
  }
  return { path: checked.path, text: readFileSync(checked.path, 'utf8'), bytes: stats.size }
}

/**
 * Writes one file.
 *
 * `create` decides whether a missing file is written: the phone's editor saves
 * an existing file, its "new file" flow sets the flag. Either way the path is
 * checked first, so nothing outside the instruction scopes can be touched.
 */
export function writeInstruction(path, text, { create = false, env = process.env } = {}) {
  if (typeof text !== 'string') throw coded('BAD_ARGUMENT', 'the new content must be a string')
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_INSTRUCTION_BYTES) {
    throw coded('FILE_TOO_LARGE', `the new content is ${bytes} bytes; the limit is ${MAX_INSTRUCTION_BYTES}`)
  }
  const checked = guardPath(path, { forWrite: true, create, env })
  mkdirSync(dirname(checked.path), { recursive: true })
  writeFileSync(checked.path, text, 'utf8')
  return { path: checked.path, bytes }
}

/**
 * Validates a path against the candidate names and the existing scopes.
 *
 * Both checks matter: the name stops this from becoming a general file-write
 * endpoint, and the scope stops a phone from planting instructions in a random
 * directory where the loader would never even see them.
 */
function guardPath(path, { forWrite = false, create = false, env = process.env } = {}) {
  if (typeof path !== 'string' || path.length === 0) throw coded('BAD_ARGUMENT', 'a file path is required')
  if (!isAbsolute(path)) throw coded('BAD_ARGUMENT', 'the file path must be absolute')
  const target = resolve(path)
  const name = basename(target)
  if (!CANDIDATE_NAMES.includes(name)) {
    throw coded('NOT_AN_INSTRUCTION_FILE', `${name} is not one of ${CANDIDATE_NAMES.join(', ')}`)
  }
  const insideGlobal = globalRoots(env).some(entry => isInside(target, entry.root))
  // No project root means no project scope at all, so a stray file is refused.
  const projectRoot = findProjectRoot(dirname(target))
  const insideProject = projectRoot !== null && isInside(target, projectRoot)
  if (!insideGlobal && !insideProject) {
    throw coded('OUTSIDE_SCOPE', 'this directory is not an instruction scope for this user')
  }
  const exists = isFile(target)
  if (forWrite && !exists && !create) {
    throw coded('NOT_FOUND', 'this file does not exist yet; create it explicitly')
  }
  if (!forWrite) {
    if (!exists) throw coded('NOT_FOUND', 'this instruction file does not exist')
    if (!isDirectory(dirname(target))) throw coded('NOT_FOUND', 'this instruction file has no directory')
  }
  return { path: target }
}

/** An Error carrying a `code`, the shape the RPC layer forwards verbatim. */
export function coded(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Serves one `pocketInstructions/*` call.
 *
 * Returns the plain value the RPC layer sends back, and throws coded errors so
 * the phone can tell "not there" from "not allowed".
 */
export function serveInstructions(request, env = process.env) {
  const args = request?.args ?? {}
  switch (request?.method) {
    case 'describe':
      return describeInstructions(typeof args.cwd === 'string' ? args.cwd : null, env)
    case 'read':
      return readInstruction(args.path)
    case 'write':
      return writeInstruction(args.path, args.text, { create: args.create === true, env })
    default:
      throw coded('UNKNOWN_METHOD', `${INSTRUCTIONS_NAMESPACE} has no method ${request?.method}`)
  }
}
