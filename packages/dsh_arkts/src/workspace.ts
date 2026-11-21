// 工作区文件：列目录、按行读、按名字搜。
//
// 三个端点都挂在 `workspaceFiles` 命名空间下，参数是**扁平的命名参数**，没有
// `request` 包装（只有 `search` 的第二个字段叫 `request`）：
//
//   workspaceFiles/list    { workspaceFileScopeId, path }
//   workspaceFiles/read    { workspaceFileScopeId, path, range: { offset, limit } }
//   workspaceFiles/search  { workspaceFileScopeId, request: { query, excludedPaths, includeHidden, respectGitignore } }
//
// 四个坑，每一个都真的踩过：
// - `workspaceFileScopeId` 的值是 **Session id**，不是工作区 id。Host 自己据会话推出
//   工作区根，所以手机只能看到这个会话拥有的目录，也永远出不去。
// - 根目录必须传 `'.'`。空字符串会被 Host 以 `path is required` 拒绝，`'/'` 会被
//   以 `outside-workspace` 拒绝。
// - `search` 的四个字段**全部必填**，少一个就是边界校验失败。
// - 包一层 `request` 会得到 `args fields do not match the descriptor`。

import { arrayField, numberField, stringField } from './json'
import type { JsonObject } from './json'

/** 根目录的写法：空串会被拒成 `path is required`，`'/'` 会被拒成 `outside-workspace`。 */
export const ROOT_PATH = '.'
/** 一页读多少行；Host 还会按自己的 `maxLines` 再截一次。 */
export const DEFAULT_READ_LINES = 400

/** 目录里的一个条目。 */
export interface WorkspaceEntry {
  readonly name: string
  /** `directory` 或 `file`，Host 的原样说法。 */
  readonly type: string
  /** 文件字节数；目录没有。 */
  readonly size: number
}

/** 一次目录列出的结果。 */
export interface WorkspaceListing {
  /** 工作区根是空串，往下是 `/` 连接的相对路径。 */
  readonly path: string
  readonly entries: WorkspaceEntry[]
  /** Host 的条目上限截掉了一部分。 */
  readonly truncated: boolean
}

/** 一页文本。 */
export interface WorkspaceFileText {
  readonly absolutePath: string
  readonly text: string
  /** 这一页从第几行开始（1 起）。 */
  readonly offset: number
  readonly lines: number
  readonly bytes: number
  /** 这一页是否已经到文件末尾。 */
  readonly eof: boolean
}

/** 搜索结果里的一个命中。 */
export interface WorkspaceMatch {
  /** 相对工作区根的 `/` 路径，不会是空串。 */
  readonly path: string
  readonly type: string
}

/** 读一个条目；没有名字的丢弃。 */
export function readEntry(value: JsonObject): WorkspaceEntry | null {
  const name = stringField(value, 'name')
  if (name.length === 0) return null
  return { name, type: stringField(value, 'type', 'file'), size: numberField(value, 'size', -1) }
}

/** 读一次列目录的回答。坏条目跳过，不因为一个奇怪的名字让整页空白。 */
export function readListing(answer: JsonObject): WorkspaceListing {
  const entries: WorkspaceEntry[] = []
  for (const raw of arrayField(answer, 'entries')) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = readEntry(raw as JsonObject)
    if (entry !== null) entries.push(entry)
  }
  return { path: stringField(answer, 'path'), entries, truncated: answer['truncated'] === true }
}

/** 读一页文本。 */
export function readFileText(answer: JsonObject): WorkspaceFileText {
  return {
    absolutePath: stringField(answer, 'absolutePath'),
    text: stringField(answer, 'text'),
    offset: numberField(answer, 'offset', 1),
    lines: numberField(answer, 'lines', 0),
    bytes: numberField(answer, 'bytes', 0),
    eof: answer['eof'] === true,
  }
}

/** 读搜索回答。 */
export function readMatches(answer: JsonObject): WorkspaceMatch[] {
  const matches: WorkspaceMatch[] = []
  for (const raw of arrayField(answer, 'matches')) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const path = stringField(raw as JsonObject, 'path')
    if (path.length === 0) continue
    matches.push({ path, type: stringField(raw as JsonObject, 'type', 'file') })
  }
  return matches
}

/**
 * 把界面上的路径规整成 Host 要的样子。
 *
 * 根目录必须变成 `'.'`：空串会被拒成 `path is required`，而 `'/'` 会被拒成
 * `outside-workspace`。反斜杠要换成正斜杠，`.` 段与空段丢掉。
 */
export function normalizePath(path: string): string {
  // 先掐掉首尾空白：输入框里只打了几个空格时，那不是「一个名字是空格的目录」，
  // 那是「什么都没填」，应该回落到根目录。
  const cleaned = path.trim().replace(/\\/g, '/')
  const parts: string[] = []
  for (const segment of cleaned.split('/')) {
    if (segment.length === 0 || segment === '.') continue
    parts.push(segment)
  }
  return parts.length === 0 ? ROOT_PATH : parts.join('/')
}

/** 上一级；已经在根就还是根。 */
export function parentPath(path: string): string {
  const normalized = normalizePath(path)
  if (normalized === ROOT_PATH) return ROOT_PATH
  const cut = normalized.lastIndexOf('/')
  if (cut < 0) return ROOT_PATH
  return normalized.slice(0, cut)
}

/** 拼一个子路径。 */
export function childPath(path: string, name: string): string {
  const base = normalizePath(path)
  return base === ROOT_PATH ? name : base + '/' + name
}

/** 面包屑的最后一段，根显示成「工作区文件」。 */
export function pathLabel(path: string): string {
  const normalized = normalizePath(path)
  if (normalized === ROOT_PATH) return '工作区文件'
  const cut = normalized.lastIndexOf('/')
  return cut < 0 ? normalized : normalized.slice(cut + 1)
}

/** 列目录的请求体。 */
export function listRequest(sessionId: string, path: string): JsonObject {
  return { workspaceFileScopeId: sessionId, path: normalizePath(path) }
}

/** 按行读的请求体。 */
export function readRequest(sessionId: string, path: string, offset: number = 1, limit: number = DEFAULT_READ_LINES): JsonObject {
  return {
    workspaceFileScopeId: sessionId,
    path: normalizePath(path),
    range: { offset: offset, limit: limit },
  }
}

/**
 * 搜索的请求体。
 *
 * **四个字段全部必填**。少一个 `excludedPaths` 就是
 * `wire field "request" failed boundary validation`，所以在类型层就把它们都写出来，
 * 用默认值而不是让人省略。
 */
export function searchRequest(sessionId: string, query: string): JsonObject {
  return {
    workspaceFileScopeId: sessionId,
    request: {
      query: query,
      excludedPaths: [] as string[],
      includeHidden: false,
      respectGitignore: true,
    },
  }
}

/** 目录排在文件前面，同类按名字（不分大小写）排。 */
export function sortEntries(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  const copy = entries.slice()
  copy.sort((a: WorkspaceEntry, b: WorkspaceEntry): number => {
    if (a.type === 'directory' && b.type !== 'directory') return -1
    if (b.type === 'directory' && a.type !== 'directory') return 1
    const left = a.name.toLowerCase()
    const right = b.name.toLowerCase()
    if (left < right) return -1
    if (left > right) return 1
    return 0
  })
  return copy
}

/** 文件大小的短写法。 */
export function sizeLabel(size: number): string {
  if (size < 0) return ''
  if (size < 1024) return size + ' B'
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB'
  return (size / (1024 * 1024)).toFixed(1) + ' MB'
}

/** 这一页之后还有没有内容。 */
export function nextOffset(page: WorkspaceFileText): number {
  return page.offset + page.lines
}

/** 空查询不发请求 —— 那只会把整个工作区扫一遍，然后回一大堆无关的东西。 */
export function shouldSearch(query: string): boolean {
  return query.trim().length > 0
}

/** 读一页之外的东西时的说明文案。 */
export function describeWorkspaceError(error: Object): string {
  const text = '' + error
  // 两种写法都要认：有的构建带错误码前缀（`workspace-file/outside-workspace`），
  // 有的只给一句英文（`"/" is outside the workspace`）。第一版只认前者，在真 Host
  // 上就没翻成中文。
  if (text.includes('outside-workspace') || text.includes('is outside the workspace')) {
    return '这个路径不在这个会话的工作区里。'
  }
  if (text.includes('path is required')) return '请先选一个目录或文件。'
  if (text.includes('ENOENT') || text.includes('no such file')) return '这个文件已经不在了，可能刚被移走或改名。'
  return text
}
