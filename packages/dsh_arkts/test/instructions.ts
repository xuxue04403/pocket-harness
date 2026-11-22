/**
 * AGENTS 类指令文件的断言。
 *
 * 这里的重点不是「字段读得到」，而是三件容易写错的事：
 * - 路径分隔符必须跟着**目录自己的风格**走，不跟手机平台走；
 * - `createDirectory` 必须先看项目根再看会话目录；
 * - 字节数不能拿 `text.length` 充数，中文在 UTF-16 里是两个码元、在 UTF-8 里是三个字节。
 */

import type { JsonObject } from '../src/json'
import {
  INSTRUCTION_FILE_NAMES,
  INSTRUCTION_SCOPE_GLOBAL,
  INSTRUCTION_SCOPE_PROJECT,
  byteLength,
  createDirectory,
  describeInstructionError,
  describeRequest,
  instructionNameHint,
  instructionPath,
  instructionSizeLabel,
  instructionSubtitle,
  instructionsSummary,
  isDirty,
  isGlobalInstruction,
  readInstructionFile,
  readInstructionText,
  readInstructions,
  readInstructionRequest,
  readWrittenBytes,
  writeInstructionRequest,
  type InstructionFile,
  type InstructionsSnapshot,
} from '../src/instructions'

let failures = 0

function ok(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok  ${label}`)
    return
  }
  failures += 1
  console.log(`  NO  ${label}`)
}

function same(label: string, actual: Object, want: Object): void {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(want)
  ok(`${label} (${left})`, left === right)
}

function file(scope: string, label: string, path: string, name: string, bytes: number): InstructionFile {
  return { scope, label, path, name, bytes, modifiedAt: 0 }
}

function checkCandidates(): void {
  same('exactly the four names the loader reads', INSTRUCTION_FILE_NAMES, [
    'AGENTS.md',
    'CLAUDE.md',
    'AGENTS.local.md',
    'CLAUDE.local.md',
  ])
  for (const name of INSTRUCTION_FILE_NAMES) {
    ok(`${name} has a hint`, instructionNameHint(name).length > 0)
  }
  same('an unknown name has no hint', instructionNameHint('NOTES.md'), '')
}

function checkParsing(): void {
  const parsed = readInstructionFile({
    scope: 'global',
    label: '~/.dsh',
    path: '/home/me/.dsh/AGENTS.md',
    name: 'AGENTS.md',
    bytes: 547,
    modifiedAt: 1700000000000,
  } as JsonObject)
  ok('a complete row parses', parsed !== null)
  if (parsed !== null) {
    ok('the scope survives', parsed.scope === INSTRUCTION_SCOPE_GLOBAL)
    ok('the byte count survives', parsed.bytes === 547)
    ok('the mtime survives', parsed.modifiedAt === 1700000000000)
  }

  ok('a row without a path is dropped', readInstructionFile({ name: 'AGENTS.md' } as JsonObject) === null)
  ok('a row without a name is dropped', readInstructionFile({ path: '/p/AGENTS.md' } as JsonObject) === null)
  ok('an empty string path is dropped', readInstructionFile({ path: '', name: 'AGENTS.md' } as JsonObject) === null)

  const defaults = readInstructionFile({ path: '/p/AGENTS.md', name: 'AGENTS.md' } as JsonObject)
  ok('a missing scope defaults to project', defaults !== null && defaults.scope === INSTRUCTION_SCOPE_PROJECT)
  ok('a missing byte count defaults to zero', defaults !== null && defaults.bytes === 0)

  const snapshot = readInstructions({
    projectRoot: '/home/me/project',
    cwd: '/home/me/project/packages/app',
    files: [
      { scope: 'global', label: '~/.dsh', path: '/g/AGENTS.md', name: 'AGENTS.md', bytes: 10 },
      { scope: 'project', label: '.', path: '/p/AGENTS.md', name: 'AGENTS.md', bytes: 20 },
      { junk: true },
      'not an object',
    ],
  } as JsonObject)
  same('junk rows are skipped, good ones survive', snapshot.files.length, 2)
  same('the project root survives', snapshot.projectRoot, '/home/me/project')
  same('the cwd survives', snapshot.cwd, '/home/me/project/packages/app')
  ok('the first file is global', isGlobalInstruction(snapshot.files[0]))
  ok('the second file is not global', !isGlobalInstruction(snapshot.files[1]))

  const empty = readInstructions({ files: [] } as JsonObject)
  same('an empty listing has no files', empty.files.length, 0)
  same('an empty listing has no project root', empty.projectRoot, '')
}

function checkCreateDirectory(): void {
  same('the project root wins', createDirectory('D:\\work\\app', 'D:\\work\\app\\src'), 'D:\\work\\app')
  same('no project falls back to the session directory', createDirectory('', '/tmp/x'), '/tmp/x')
  same('nowhere legal is empty', createDirectory('', ''), '')
}

function checkPath(): void {
  same('a windows directory joins with a backslash', instructionPath('D:\\work\\app', 'AGENTS.md'), 'D:\\work\\app\\AGENTS.md')
  same('a trailing backslash is not doubled', instructionPath('D:\\work\\app\\', 'AGENTS.md'), 'D:\\work\\app\\AGENTS.md')
  same('a posix directory keeps its slash', instructionPath('/home/me', 'AGENTS.md'), '/home/me/AGENTS.md')
  same('a trailing slash is not doubled', instructionPath('/home/me/', 'AGENTS.md'), '/home/me/AGENTS.md')
  same('no directory means just the name', instructionPath('', 'AGENTS.md'), 'AGENTS.md')
}

function checkBytes(): void {
  same('ascii is one byte each', byteLength('abc'), 3)
  same('an empty string is zero bytes', byteLength(''), 0)
  same('chinese is three bytes each', byteLength('指令'), 6)
  same('a latin-1 supplement char is two bytes', byteLength('é'), 2)
  same('an emoji is four bytes', byteLength('😀'), 4)
  same('mixed text adds up', byteLength('a指😀'), 1 + 3 + 4)
}

function checkLabels(): void {
  same('bytes label', instructionSizeLabel(547), '547 字节')
  same('kilobyte label', instructionSizeLabel(2048), '2.0 KB')
  same('a negative size has no label', instructionSizeLabel(-1), '')

  same(
    'a global subtitle names the scope, the root and the size',
    instructionSubtitle(file('global', '~/.dsh', '/g/AGENTS.md', 'AGENTS.md', 547)),
    '用户级 · ~/.dsh · 547 字节',
  )
  same(
    'a project subtitle says project',
    instructionSubtitle(file('project', '.', '/p/AGENTS.md', 'AGENTS.md', 22)),
    '项目 · . · 22 字节',
  )
  same(
    'a missing label and size leave no dangling separators',
    instructionSubtitle(file('project', '', '/p/AGENTS.md', 'AGENTS.md', 0)),
    '项目 · 0 字节',
  )

  const empty: InstructionsSnapshot = { projectRoot: '', cwd: '', files: [] }
  same('an empty snapshot says so', instructionsSummary(empty), '这个目录没有 AGENTS.md 一类的指令文件。')
  const two: InstructionsSnapshot = {
    projectRoot: '/p',
    cwd: '/p',
    files: [file('global', '~', '/g', 'AGENTS.md', 1), file('project', '.', '/p', 'AGENTS.md', 2)],
  }
  same('a populated snapshot counts them', instructionsSummary(two), '共 2 个文件，按 agent 实际加载的顺序排列。')
}

function checkRequests(): void {
  same('describe without a cwd sends nothing', describeRequest(''), {})
  same('describe with a cwd sends it', describeRequest('/p'), { cwd: '/p' })
  same('read sends the path', readInstructionRequest('/p/AGENTS.md'), { path: '/p/AGENTS.md' })
  same('write without create sends two fields', writeInstructionRequest('/p/a.md', 'x', false), {
    path: '/p/a.md',
    text: 'x',
  })
  same('write with create sends three', writeInstructionRequest('/p/a.md', 'x', true), {
    path: '/p/a.md',
    text: 'x',
    create: true,
  })
}

function checkResponse() {
  same('the text comes back', readInstructionText({ text: 'hi' } as JsonObject), 'hi')
  same('a missing text is empty', readInstructionText({} as JsonObject), '')
  same('the host byte count wins', readWrittenBytes({ bytes: 9 } as JsonObject, 'xxxx'), 9)
  same('a missing byte count falls back to the utf-8 length', readWrittenBytes({} as JsonObject, '指令'), 6)
}

function checkDirty(): void {
  ok('identical text is not dirty', !isDirty('a', 'a'))
  ok('changed text is dirty', isDirty('a', 'b'))
  ok('whitespace counts as a change', isDirty('a ', 'a'))
}

function checkErrors(): void {
  ok(
    'an outside scope explains where to go',
    describeInstructionError(new Error('OUTSIDE_SCOPE')).includes('项目根'),
  )
  ok(
    'a bad name lists the four names',
    describeInstructionError(new Error('NOT_AN_INSTRUCTION_FILE')).includes('AGENTS.local.md'),
  )
  ok('a missing file suggests rebuilding', describeInstructionError(new Error('NOT_FOUND')).includes('新建'))
  ok(
    'a huge file names the limit',
    describeInstructionError(new Error('FILE_TOO_LARGE')).includes('512 KB'),
  )
  same('an unknown error passes through', describeInstructionError(new Error('boom')), 'Error: boom')
}

function checkOrder(): void {
  // 加载顺序：全局链在前、项目链在后。界面照抄这个顺序就是 agent 读的顺序。
  const snapshot = readInstructions({
    projectRoot: '/p',
    cwd: '/p/packages/app',
    files: [
      { scope: 'global', label: '~/.dsh', path: '/g1/AGENTS.md', name: 'AGENTS.md', bytes: 1 },
      { scope: 'global', label: '~/.agents', path: '/g2/AGENTS.md', name: 'AGENTS.md', bytes: 2 },
      { scope: 'project', label: '.', path: '/p/AGENTS.md', name: 'AGENTS.md', bytes: 3 },
      { scope: 'project', label: '.', path: '/p/AGENTS.local.md', name: 'AGENTS.local.md', bytes: 4 },
      { scope: 'project', label: 'packages/app', path: '/p/packages/app/AGENTS.md', name: 'AGENTS.md', bytes: 5 },
    ],
  } as JsonObject)
  same(
    'the host decides the order and we keep it',
    snapshot.files.map((entry: InstructionFile): string => entry.label),
    ['~/.dsh', '~/.agents', '.', '.', 'packages/app'],
  )
  ok(
    'a global file is global and a project file is not',
    isGlobalInstruction(snapshot.files[0]) && !isGlobalInstruction(snapshot.files[2]),
  )
}

checkCandidates()
checkParsing()
checkCreateDirectory()
checkPath()
checkBytes()
checkLabels()
checkRequests()
checkResponse()
checkDirty()
checkErrors()
checkOrder()

if (failures > 0) {
  console.log(`\n${failures} INSTRUCTION CHECK(S) FAILED`)
  process.exit(1)
}
console.log('\nALL INSTRUCTION CHECKS PASS (typescript core)')
