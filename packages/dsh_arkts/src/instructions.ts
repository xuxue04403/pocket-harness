/**
 * AGENTS 类指令文件：agent 在每次请求前读进去的那些规则。
 *
 * 端点挂在 `pocketInstructions` 命名空间下，是**插件自己的**（不是 DSH 的 Remote API）。
 * 工作区文件接口只有 stat/list/read/readBytes/search/render/changes，**没有写端点**，
 * 所以「在手机上改 AGENTS.md」这件事只能由 Host 插件补上。
 *
 *   pocketInstructions/describe  { cwd? }                      → { projectRoot, cwd, files }
 *   pocketInstructions/read      { path }                      → { path, text, bytes }
 *   pocketInstructions/write     { path, text, create? }        → { path, bytes }
 *
 * 五个必须记住的事实：
 * - 加载顺序是**全局链在前、项目链在后**；项目链从项目根（以 `.git` 为界）一路到会话目录，
 *   每一层里基础候选（`AGENTS.md`/`CLAUDE.md`）在前、本地覆盖（`.local.md`）在后。
 *   界面照这个顺序排，就是 agent 实际读的顺序。
 * - 只允许四个文件名。Host 会拒绝其他名字（否则这个端点就成了通用写文件接口），
 *   所以手机上也不要提供会被拒的选择。
 * - 只允许落在「已经是该用户指令 scope」的目录里：两个全局根之内，或在某个有 `.git`
 *   的项目根之内。别的地方一律 `OUTSIDE_SCOPE`。
 * - 写不存在的文件必须显式 `create: true`，否则报 `NOT_FOUND`。这是有意的：默认不悄悄
 *   造文件，免得手滑打错一个目录名就在别处生出一份空指令。
 * - `cwd` 缺失不是错误：没有工作目录的会话照样有用户级链路。
 */

import { arrayField, numberField, stringField, type JsonObject } from './json'

/** 四个候选名，顺序与加载器一致：基础在前，本地覆盖在后。 */
export const INSTRUCTION_FILE_NAMES: string[] = [
  'AGENTS.md',
  'CLAUDE.md',
  'AGENTS.local.md',
  'CLAUDE.local.md',
]

/** `scope` 的两个取值。 */
export const INSTRUCTION_SCOPE_GLOBAL = 'global'
export const INSTRUCTION_SCOPE_PROJECT = 'project'

/** 一个指令文件。 */
export interface InstructionFile {
  /** `global` 或 `project`。 */
  readonly scope: string
  /** 放给人看的短标签：`~/.dsh`、`~/.agents`、`.`、`packages/app`。 */
  readonly label: string
  /** 电脑上的绝对路径，read/write 都用它。 */
  readonly path: string
  readonly name: string
  readonly bytes: number
  /** 修改时间（毫秒）；Host 没给就是 0。 */
  readonly modifiedAt: number
}

/** 一次列出。 */
export interface InstructionsSnapshot {
  /** 项目根；不在任何项目里时是空串（不是 null —— ArkTS 里不用可空收口）。 */
  readonly projectRoot: string
  /** 会话目录；没传就是空串。 */
  readonly cwd: string
  readonly files: InstructionFile[]
}

/** 用户级文件（来自 `~/.dsh` 或 `~/.agents`）。 */
export function isGlobalInstruction(file: InstructionFile): boolean {
  return file.scope === INSTRUCTION_SCOPE_GLOBAL
}

/** 读一条；名字或路径缺失就丢弃。 */
export function readInstructionFile(value: JsonObject): InstructionFile | null {
  const path = stringField(value, 'path')
  const name = stringField(value, 'name')
  if (path.length === 0 || name.length === 0) return null
  return {
    scope: stringField(value, 'scope', INSTRUCTION_SCOPE_PROJECT),
    label: stringField(value, 'label'),
    path,
    name,
    bytes: numberField(value, 'bytes', 0),
    modifiedAt: numberField(value, 'modifiedAt', 0),
  }
}

/**
 * 读一次 `describe` 的回答。
 *
 * 坏条目跳过而不是让整页空白：一个奇怪的文件名不该把另外三个正常的也藏起来。
 */
export function readInstructions(answer: JsonObject): InstructionsSnapshot {
  const files: InstructionFile[] = []
  for (const raw of arrayField(answer, 'files')) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const file = readInstructionFile(raw as JsonObject)
    if (file !== null) files.push(file)
  }
  return {
    projectRoot: stringField(answer, 'projectRoot'),
    cwd: stringField(answer, 'cwd'),
    files,
  }
}

/**
 * 新建时该落在哪个目录。
 *
 * 项目根优先于会话目录：根上的 `AGENTS.md` 对所有子目录生效，而「加第一份指令」这件事
 * 几乎总是指这个意思。没有项目时，会话目录是 Host 唯一还会接受的另一处 scope。
 * 空串表示两处都没有，界面上就不要画「新建」按钮 —— 画了再被拒是最差的体验。
 */
export function createDirectory(projectRoot: string, cwd: string): string {
  if (projectRoot.length > 0) return projectRoot
  if (cwd.length > 0) return cwd
  return ''
}

/**
 * 拼一个指令文件路径。
 *
 * 分隔符跟着**目录自己的风格**走，不跟着手机的平台走：这些路径活在电脑上，
 * 而那台电脑未必和手机同一个操作系统。已经以分隔符结尾的目录不再补第二个。
 */
export function instructionPath(directory: string, name: string): string {
  if (directory.length === 0) return name
  const last = directory.charAt(directory.length - 1)
  if (last === '\\' || last === '/') return directory + name
  const separator = directory.indexOf('\\') >= 0 ? '\\' : '/'
  return directory + separator + name
}

/** 一个候选名是干什么用的，免得四个选项看起来一模一样。 */
export function instructionNameHint(name: string): string {
  if (name === 'AGENTS.md') return '通用的项目指令'
  if (name === 'CLAUDE.md') return '同一批指令的别名，内容重复时只加载一次'
  if (name === 'AGENTS.local.md') return '本地覆盖，通常不进版本库'
  if (name === 'CLAUDE.local.md') return '本地覆盖的别名'
  return ''
}

/** `describe` 的请求体。空 `cwd` 就不带这个字段。 */
export function describeRequest(cwd: string): JsonObject {
  if (cwd.length === 0) return {}
  return { cwd }
}

/** `read` 的请求体。 */
export function readInstructionRequest(path: string): JsonObject {
  return { path }
}

/** `write` 的请求体。`create` 只在真的要新建时才带真值。 */
export function writeInstructionRequest(path: string, text: string, create: boolean): JsonObject {
  if (create) return { path, text, create: true }
  return { path, text }
}

/** 读 `read` 的回答里的正文。 */
export function readInstructionText(answer: JsonObject): string {
  return stringField(answer, 'text')
}

/** 读 `write` 的回答里的字节数；缺了就用正文自己的字节数兜底。 */
export function readWrittenBytes(answer: JsonObject, text: string): number {
  const bytes = numberField(answer, 'bytes', -1)
  if (bytes >= 0) return bytes
  return byteLength(text)
}

/**
 * UTF-8 字节数。
 *
 * ArkTS 没有 `TextEncoder`，而 `text.length` 是 UTF-16 码元数 —— 一句中文在这里是
 * 3 个字节、1 个码元，用 `length` 报字节数会小两倍。代理对算 4 个字节。
 */
export function byteLength(text: string): number {
  let total = 0
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index)
    if (unit < 0x80) {
      total += 1
    } else if (unit < 0x800) {
      total += 2
    } else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        total += 4
        index += 1
      } else {
        total += 3
      }
    } else {
      total += 3
    }
  }
  return total
}

/** 大小文案。 */
export function instructionSizeLabel(bytes: number): string {
  if (bytes < 0) return ''
  if (bytes < 1024) return bytes + ' 字节'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

/** 一行副标题：`用户级 · ~/.dsh · 547 字节` 或 `项目 · packages/app · 22 字节`。 */
export function instructionSubtitle(file: InstructionFile): string {
  const scope = isGlobalInstruction(file) ? '用户级' : '项目'
  const parts: string[] = [scope]
  if (file.label.length > 0) parts.push(file.label)
  const size = instructionSizeLabel(file.bytes)
  if (size.length > 0) parts.push(size)
  return parts.join(' · ')
}

/** 列表头的一句总结。 */
export function instructionsSummary(snapshot: InstructionsSnapshot): string {
  const count = snapshot.files.length
  if (count === 0) return '这个目录没有 AGENTS.md 一类的指令文件。'
  return '共 ' + count + ' 个文件，按 agent 实际加载的顺序排列。'
}

/**
 * 编辑前后是否算有改动。
 *
 * 只比较文本本身，不比较「有没有点过键盘」：光标移一圈又移回来不算改动，
 * 这样返回键不会平白弹一个「要放弃吗」。
 */
export function isDirty(current: string, initial: string): boolean {
  return current !== initial
}

/** 保存失败的说明文案。 */
export function describeInstructionError(error: Object): string {
  const text = '' + error
  if (text.includes('OUTSIDE_SCOPE')) {
    return '这个位置不在 agent 会读指令的目录里，换到项目根或用户级目录再试。'
  }
  if (text.includes('NOT_AN_INSTRUCTION_FILE')) {
    return '只能写 AGENTS.md、CLAUDE.md、AGENTS.local.md、CLAUDE.local.md 这四个名字。'
  }
  if (text.includes('NOT_FOUND')) {
    return '这个文件已经不在了。刷新一次，或者用「新建」重建。'
  }
  if (text.includes('FILE_TOO_LARGE')) {
    return '这个文件太大了，超过 512 KB 的指令文件 agent 也不会读。'
  }
  if (text.includes('ENOENT') || text.includes('no such file')) {
    return '这个文件已经不在了，可能刚被移走或改名。'
  }
  return text
}
