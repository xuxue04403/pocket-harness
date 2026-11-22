/**
 * 会话列表的一行 —— 从 Host 的 `session/list` 响应里取出来。
 *
 * 与 Dart 侧 `SessionSummary.fromJson` 同一口径，三个实测出来的形状细节：
 * - 主键字段是 `sessionId`，不是 `id`；
 * - 标题在 `projections.values.title`，**不在顶层**；
 * - `projections` 是可选的（本地实测 854 个会话里 41 个没有），缺了就退化，
 *   不能抛错。
 */

import { arrayField, flagField, numberField, objectField, stringField, type JsonObject } from './json'

/** 界面要用的那几项。 */
export interface SessionRow {
  readonly sessionId: string
  readonly title: string
  readonly detail: string
  readonly running: boolean
  readonly updatedAt: number
}

/** 未命名会话的占位文案，与 Dart 侧保持一致。 */
export const UNTITLED_SESSION = '未命名会话'

/** 一条记录；没有 `sessionId` 就无法定位会话，返回 null。 */
export function readSessionRow(value: JsonObject): SessionRow | null {
  const sessionId = stringField(value, 'sessionId', '')
  if (sessionId.length === 0) return null

  let title = ''
  let cwd = stringField(value, 'cwd', '')
  const projections = objectField(value, 'projections')
  if (projections !== undefined) {
    const bag = objectField(projections, 'values')
    if (bag !== undefined) {
      title = stringField(bag, 'title', '')
      if (cwd.length === 0) cwd = stringField(bag, 'workingDirectory', '')
    }
  }
  if (title.length === 0) title = UNTITLED_SESSION
  const updatedAt = numberField(value, 'updatedAt', 0)
  const detail = cwd.length > 0 ? cwd : relativeLabel(updatedAt)
  return { sessionId, title, detail, running: flagField(value, 'running'), updatedAt }
}

/**
 * 这个会话的工作目录，读不出来就是空串。
 *
 * `detail` 有两种填法：有工作目录时是那个目录的绝对路径，否则是一句相对时间
 * （`3 小时前`）。界面要拿目录去问「哪些 AGENTS 类文件生效」，所以这两种情况
 * 必须分开 —— 把时间当目录传下去只会让 Host 找不到项目根，界面上看起来就像
 * 「这个项目一份指令文件都没有」。
 */
export function cwdOf(row: SessionRow): string {
  const detail = row.detail
  if (detail.indexOf('\\') >= 0 || detail.indexOf('/') >= 0) return detail
  return ''
}

/** 把 `session/list` 的返回值读成行，跳过所有读不出来的条目。 */
export function readSessionRows(value: JsonObject): SessionRow[] {
  const rows: SessionRow[] = []
  for (const item of arrayField(value, 'items')) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const row = readSessionRow(item as JsonObject)
    if (row !== null) rows.push(row)
  }
  return rows
}

/**
 * 排序：运行中的排前面，然后新的排前面。
 *
 * 这个部署一次返回 800 多个会话且没有分页，界面必须自己把「正在跑的」顶上来，
 * 否则用户要滚很久才能看到自己刚才在看的那个。
 */
export function sortSessionRows(rows: SessionRow[]): SessionRow[] {
  const copy = rows.slice()
  copy.sort((left: SessionRow, right: SessionRow): number => {
    if (left.running !== right.running) return left.running ? -1 : 1
    return right.updatedAt - left.updatedAt
  })
  return copy
}

function relativeLabel(updatedAt: number): string {
  if (updatedAt <= 0) return '时间未知'
  const delta = Date.now() - updatedAt
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
  return `${Math.floor(delta / 86_400_000)} 天前`
}

/**
 * 按标题或目录筛会话。
 *
 * 与 `filterSkills` 的空查询规则相反：这里**空查询返回全部**。理由是两个列表的默认
 * 状态不同 —— 技能面板是「点了才出现」的挑选器，空输入时没有什么可选；会话列表是
 * 一打开就在那儿的全部内容，空输入时必须还是全部，否则一进页面就空白。
 *
 * 匹配的是 `title` 与 `detail`（目录或相对时间）。不匹配 `sessionId`：那是一串机器
 * 生成的 id，没人会想起来去搜它。
 */
export function filterSessionRows(rows: SessionRow[], query: string): SessionRow[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return rows.slice()
  return rows.filter((row: SessionRow): boolean =>
    row.title.toLowerCase().includes(needle) || row.detail.toLowerCase().includes(needle))
}

