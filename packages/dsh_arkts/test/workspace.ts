// 工作区文件的断言。
//
// 重点：根目录必须变成 `'.'`（空串与 `'/'` 都会被 Host 拒）、`search` 的四个字段
// 一个都不能少、路径拼接与上一级不能出现 `..` 或双斜杠、坏条目跳过。

import {
  childPath,
  DEFAULT_READ_LINES,
  describeWorkspaceError,
  listRequest,
  nextOffset,
  normalizePath,
  parentPath,
  pathLabel,
  readEntry,
  readFileText,
  readListing,
  readMatches,
  readRequest,
  ROOT_PATH,
  searchRequest,
  shouldSearch,
  sizeLabel,
  sortEntries,
} from '../src/workspace'
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

function same(label: string, actual: Object, expected: Object): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  ok(label, a === b, `${a} !== ${b}`)
}

// ---- 路径 ----

ok('the root constant is a dot', ROOT_PATH === '.')
same('an empty path becomes the root', normalizePath(''), '.')
same('a blank path becomes the root', normalizePath('   '), '.')
same('a slash becomes the root', normalizePath('/'), '.')
same('a dot becomes the root', normalizePath('.'), '.')
same('a plain directory stays itself', normalizePath('lib'), 'lib')
same('a nested path stays joined with slashes', normalizePath('lib/src'), 'lib/src')
same('backslashes are accepted', normalizePath('lib\\src'), 'lib/src')
same('a leading slash is dropped', normalizePath('/lib/src'), 'lib/src')
same('a trailing slash is dropped', normalizePath('lib/src/'), 'lib/src')
same('a doubled slash collapses', normalizePath('lib//src'), 'lib/src')
same('a dot segment is dropped', normalizePath('./lib/./src'), 'lib/src')

same('the parent of a top-level directory is the root', parentPath('lib'), '.')
same('the parent of a nested path steps up one', parentPath('lib/src/pages'), 'lib/src')
same('the parent of the root is the root', parentPath('.'), '.')
same('the parent of a blank path is the root', parentPath(''), '.')
same('the parent of a trailing-slash path steps up', parentPath('lib/src/'), 'lib')

same('a child of the root is just the name', childPath('.', 'app.dart'), 'app.dart')
same('a child of a directory is joined', childPath('lib/src', 'app.dart'), 'lib/src/app.dart')
same('a child never produces a doubled slash', childPath('lib/', 'x'), 'lib/x')

same('the root is labelled in words', pathLabel('.'), '工作区文件')
same('a nested path is labelled by its last segment', pathLabel('lib/src/pages'), 'pages')
same('a top-level path is its own label', pathLabel('lib'), 'lib')

// ---- 请求体 ----

same('a list request carries the session and a normalized path',
  listRequest('session-1', ''), { workspaceFileScopeId: 'session-1', path: '.' })
same('a list request keeps a nested path',
  listRequest('session-1', 'lib\\src'), { workspaceFileScopeId: 'session-1', path: 'lib/src' })

same('a read request carries a range',
  readRequest('session-1', 'README.md'),
  { workspaceFileScopeId: 'session-1', path: 'README.md', range: { offset: 1, limit: DEFAULT_READ_LINES } })
same('a read request takes an explicit offset',
  readRequest('s', 'f.txt', 401, 200),
  { workspaceFileScopeId: 's', path: 'f.txt', range: { offset: 401, limit: 200 } })
ok('the default page size is 400 lines', DEFAULT_READ_LINES === 400)

const search = searchRequest('session-1', 'tool_labels')
same('a search request fills every required field', search, {
  workspaceFileScopeId: 'session-1',
  request: {
    query: 'tool_labels',
    excludedPaths: [],
    includeHidden: false,
    respectGitignore: true,
  },
})
ok('the search request nests under request, not beside it',
  search['workspaceFileScopeId'] === 'session-1' && typeof search['request'] === 'object')

ok('an empty query does not search', shouldSearch('') === false)
ok('a blank query does not search', shouldSearch('   ') === false)
ok('a real query searches', shouldSearch('readme') === true)

// ---- 解析 ----

same('a directory entry reads back', readEntry({ name: 'lib', type: 'directory' } as JsonObject),
  { name: 'lib', type: 'directory', size: -1 })
same('a file entry keeps its size', readEntry({ name: 'a.txt', type: 'file', size: 12 } as JsonObject),
  { name: 'a.txt', type: 'file', size: 12 })
ok('an entry with no name is dropped', readEntry({ type: 'file' } as JsonObject) === null)
ok('a missing type reads as a file',
  readEntry({ name: 'x' } as JsonObject)?.type === 'file')

same('a listing keeps its entries', (() => {
  const listing = readListing({
    path: 'lib',
    entries: [
      { name: 'src', type: 'directory' },
      { name: 'a.dart', type: 'file', size: 3 },
    ],
    truncated: false,
  } as JsonObject)
  return listing.path + ':' + listing.entries.map((entry) => entry.name).join(',') + ':' + listing.truncated
})(), 'lib:src,a.dart:false')
ok('malformed entries are skipped', (() => {
  const listing = readListing({
    path: '',
    entries: [{ name: 'ok', type: 'file' }, 'nope', null, 42, { type: 'file' }],
    truncated: true,
  } as JsonObject)
  return listing.entries.length === 1 && listing.truncated
})())
ok('a missing entries key reads as empty',
  readListing({} as JsonObject).entries.length === 0)
ok('a truncation flag must be literally true',
  readListing({ truncated: 'yes', entries: [] } as JsonObject).truncated === false)

same('a file page reads back', readFileText({
  absolutePath: 'D:/w/a.txt',
  text: 'one\ntwo\n',
  offset: 1,
  lines: 2,
  bytes: 8,
  eof: false,
} as JsonObject), {
  absolutePath: 'D:/w/a.txt',
  text: 'one\ntwo\n',
  offset: 1,
  lines: 2,
  bytes: 8,
  eof: false,
})
ok('a page with no text reads as an empty string', (() => {
  const page = readFileText({} as JsonObject)
  return page.text === '' && page.offset === 1 && page.eof === false
})())
same('the next offset advances by the lines read', nextOffset({
  absolutePath: '', text: '', offset: 401, lines: 400, bytes: 0, eof: false,
}), 801)

same('matches read back', readMatches({
  matches: [{ path: 'lib/a.dart', type: 'file' }, { path: 'lib', type: 'directory' }],
} as JsonObject), [
  { path: 'lib/a.dart', type: 'file' },
  { path: 'lib', type: 'directory' },
])
ok('matches with no path are dropped',
  readMatches({ matches: [{ type: 'file' }, { path: '' }] } as JsonObject).length === 0)
ok('a missing matches key reads as empty', readMatches({} as JsonObject).length === 0)

// ---- 排序与大小 ----

same('directories come first, then by name', sortEntries([
  { name: 'zeta', type: 'file', size: 1 },
  { name: 'Alpha', type: 'file', size: 2 },
  { name: 'src', type: 'directory', size: -1 },
  { name: 'docs', type: 'directory', size: -1 },
]).map((entry) => entry.name), ['docs', 'src', 'Alpha', 'zeta'])
ok('sorting does not change the input', (() => {
  const input = [
    { name: 'b', type: 'file', size: 1 },
    { name: 'a', type: 'file', size: 1 },
  ]
  const before = input.map((entry) => entry.name).join(',')
  sortEntries(input)
  return input.map((entry) => entry.name).join(',') === before
})())

ok('a small file shows bytes', sizeLabel(3) === '3 B')
ok('a kilobyte file shows KB', sizeLabel(2048) === '2.0 KB')
ok('a megabyte file shows MB', sizeLabel(3 * 1024 * 1024) === '3.0 MB')
ok('a directory has no size label', sizeLabel(-1) === '')

// ---- 错误文案 ----

ok('a path outside the workspace says so',
  describeWorkspaceError(new Error('workspace-file/outside-workspace "/" is outside the workspace'))
    .includes('不在这个会话的工作区里'))
ok('a missing path asks for one',
  describeWorkspaceError(new Error('RpcException(gateway/bad-request): path is required'))
    .includes('请先选一个目录或文件'))
ok('a vanished file says it may have moved',
  describeWorkspaceError(new Error('ENOENT: no such file or directory'))
    .includes('可能刚被移走'))
ok('an unknown failure keeps its own words',
  describeWorkspaceError(new Error('the link stopped answering')).includes('stopped answering'))

if (failures.length > 0) {
  console.log(`\n${failures.length} WORKSPACE CHECK(S) FAILED`)
  process.exit(1)
}
console.log('\nALL WORKSPACE CHECKS PASS (typescript core)')
