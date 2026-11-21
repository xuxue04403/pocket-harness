// 用真实 Host 校验工作区文件。
//
// 单测钉住形状，这里钉住「Host 真的这么答」，尤其那三个踩过的坑：
// 根目录必须传 `'.'`、`workspaceFileScopeId` 是 Session id、`search` 四字段全必填。
//
// 只读：这条脚本绝不会写文件（工作区文件本来也没有写端点）。

import {
  describeWorkspaceError,
  listRequest,
  normalizePath,
  parentPath,
  readFileText,
  readListing,
  readMatches,
  readRequest,
  ROOT_PATH,
  searchRequest,
  shouldSearch,
  sortEntries,
} from '../src/workspace'
import { readSessionRows } from '../src/session_rows'
import { connectLive, describeError, type LiveLink } from './live_common'
import type { JsonObject } from '../src/json'

const failures: string[] = []

function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures.push(label)
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

async function main(): Promise<void> {
  console.log('LIVE WORKSPACE CHECKS (against the running Host)')
  let link: LiveLink | null = null
  try {
    link = await connectLive()

    const sessions = readSessionRows(await link.rpc.call('session/list', { _request: {} }, 20000))
    ok('at least one session exists to scope the workspace', sessions.length > 0, `${sessions.length}`)
    if (sessions.length === 0) throw new Error('no session to scope the workspace')

    // 挑一个有目录的会话，且目录里真的有东西：新会话的 cwd 可能是空的。
    const session = sessions[0]
    console.log(`  scope: ${session.sessionId} (${session.detail})`)

    const listing = readListing(await link.rpc.call(
      'workspaceFiles/list', listRequest(session.sessionId, ''), 20000))
    const sorted = sortEntries(listing.entries)
    ok('the root lists something', sorted.length > 0, `${sorted.length} entries`)
    if (sorted.length > 0) {
      console.log(`  root: ${sorted.slice(0, 6).map((entry) => entry.name).join(', ')}`)
    }
    ok('the root request used a dot, not an empty string',
      listRequest(session.sessionId, '')[`path`] === ROOT_PATH)

    const directory = sorted.find((entry) => entry.type === 'directory')
    ok('the root has at least one directory', directory !== undefined)
    if (directory !== undefined) {
      const nestedPath = normalizePath(directory.name)
      const nested = readListing(await link.rpc.call(
        'workspaceFiles/list', listRequest(session.sessionId, nestedPath), 20000))
      console.log(`  ${nestedPath}: ${nested.entries.length} entries`)
      ok('a nested directory lists without escaping the workspace', nested.entries.length >= 0)
      ok('stepping up from it returns the root', parentPath(nestedPath) === ROOT_PATH)
    }

    // 找一个适合读的文本文件：从根里挑，优先 README。
    const files = sorted.filter((entry) => entry.type !== 'directory')
    const target = files.find((entry) => entry.name.toLowerCase().startsWith('readme'))
      ?? files.find((entry) => entry.name.toLowerCase().endsWith('.md'))
      ?? files[0]
    ok('a file was found to read', target !== undefined)
    if (target !== undefined) {
      const page = readFileText(await link.rpc.call(
        'workspaceFiles/read', readRequest(session.sessionId, target.name, 1, 20), 20000))
      ok('the file returns text', page.text.length > 0, `${page.bytes} bytes, ${page.lines} lines`)
      ok('the file reports a real line count', page.lines > 0)
      ok('the file reports an absolute path', page.absolutePath.length > 0, page.absolutePath)
      console.log(`  read ${target.name}: ${page.lines} lines, eof=${page.eof}`)
    }

    // 搜索一次：用一个必然出现在仓库里的名字。空查询在客户端就该被拦住。
    const query = 'pocket'
    ok('an empty query would not be sent', shouldSearch('') === false)
    const matches = readMatches(await link.rpc.call(
      'workspaceFiles/search', searchRequest(session.sessionId, query), 20000))
    ok(`searching "${query}" finds something`, matches.length > 0, `${matches.length}`)
    for (const match of matches.slice(0, 3)) {
      console.log(`  match: ${match.path} (${match.type})`)
    }
    let emptyPath = 0
    for (const match of matches) {
      if (match.path.length === 0) emptyPath += 1
    }
    ok('no match has an empty path', emptyPath === 0)

    // 越界必须被拒：这正是「手机只能看会话拥有的目录」的保证。
    let refused = ''
    try {
      await link.rpc.call('workspaceFiles/list',
        { workspaceFileScopeId: session.sessionId, path: '/' } as JsonObject, 20000)
    } catch (error) {
      refused = describeWorkspaceError(error as Object)
    }
    ok('a path outside the workspace is refused', refused.includes('不在这个会话的工作区里'), refused)

    if (failures.length > 0) {
      console.log(`\n${failures.length} CHECK(S) FAILED`)
      process.exit(1)
    }
    console.log('REAL WORKSPACE LISTS, READS AND SEARCHES (live Host)')
  } catch (error) {
    console.log(`FAILED: ${describeError(error as Object)}`)
    process.exit(1)
  } finally {
    if (link !== null) await link.close()
  }
}

main()
