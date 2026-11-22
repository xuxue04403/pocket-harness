// 用真实 Host 校验 `pocketInstructions` 的三条端点。
//
// 这条脚本是「手机改 AGENTS 类文件」的唯一端到端证据：单测用临时目录证明逻辑
// 对，这里证明运行中的 Host 真的把字节写到了电脑盘上。
//
// 它会真写文件，但只写一份临时内容再原样写回，最后断言内容回到出发点；如果
// 中途失败，`finally` 里也会尝试写回，不把用户的指令文件留在半路。

import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { connectLive, describeError, type LiveLink } from './live_common'
import { arrayField, stringField, type JsonObject } from '../src/json'
import {
  createDirectory,
  describeRequest,
  instructionPath,
  readInstructions,
  readInstructionText,
  writeInstructionRequest,
} from '../src/instructions'

const failures: string[] = []

/** 这个仓库本身：它带 `.git`，所以项目链一定能被发现。 */
const REPO = 'D:\\IDE\\dsh-bot'

/**
 * 仓库里一份带指令文件的嵌套检出。
 *
 * `dsh-bot` 根目录本身没有 `AGENTS.md`（指令在 harness 的全局链里），直接用根
 * 目录断言「项目链非空」会红得莫名其妙。这里改用 `ref/dsh-go`：它自带 `.git`
 * 与两份 `AGENTS.md`/`CLAUDE.md`，既证明项目链能找到文件，也证明上溯会在最近的
 * 项目标记处停下、不会跑到外层仓库。
 */
const NESTED = 'D:\\IDE\\dsh-bot\\ref\\dsh-go'

function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures.push(label)
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/** 所有被描述的文件的绝对路径。 */
function pathsOf(answer: JsonObject): string[] {
  const paths: string[] = []
  for (const row of arrayField(answer, 'files')) {
    if (row === null || typeof row !== 'object') continue
    const path = stringField(row as JsonObject, 'path', '')
    if (path.length > 0) paths.push(path)
  }
  return paths
}

/**
 * 项目链里的第一份文件。
 *
 * 写入优先挑项目链：用户级那份（`~/.dsh/AGENTS.md`）是全机器共用的，回归脚本
 * 不该拿它当实验台；项目链里的文件属于某一次检出，改坏了代价小得多。
 */
function projectPathsOf(answer: JsonObject): string[] {
  const paths: string[] = []
  for (const row of arrayField(answer, 'files')) {
    if (row === null || typeof row !== 'object') continue
    const object = row as JsonObject
    if (stringField(object, 'scope') !== 'project') continue
    const path = stringField(object, 'path', '')
    if (path.length > 0) paths.push(path)
  }
  return paths
}

async function main(): Promise<void> {
  console.log('LIVE INSTRUCTION CHECKS (against the running Host)')
  let link: LiveLink | null = null
  let restore: { path: string; text: string } | null = null
  try {
    link = await connectLive()

    // 用户级链与 cwd 无关，所以不传 cwd 也必须有内容。
    const globalOnly = await link.rpc.call('pocketInstructions/describe', {}, 20000)
    const globalPaths = pathsOf(globalOnly)
    ok('describe answers without a working directory', globalOnly !== null)
    ok('the user chain is listed', globalPaths.length > 0,
      `${globalPaths.length} file(s)`)
    if (globalPaths.length > 0) console.log(`  user: ${globalPaths.join(', ')}`)

    // 用这个仓库当 cwd：它带 .git，项目链一定能被发现。
    const described = await link.rpc.call(
      'pocketInstructions/describe', { cwd: REPO } as JsonObject, 20000)
    const projectRoot = stringField(described, 'projectRoot', '')
    ok('the project root was found from the cwd', projectRoot.length > 0, projectRoot)
    ok('the project root is this repository',
      projectRoot.toLowerCase().endsWith('dsh-bot'), projectRoot)

    const allPaths = pathsOf(described)
    ok('the cwd still carries the user chain', allPaths.length > 0, `${allPaths.length}`)

    // 根目录没有指令文件是正常的：指令在这台电脑的用户级链里。真正要证明的是
    // 「有 .git 的子目录里的指令能被发现」，所以换一个嵌套检出再问一次。
    const nested = await link.rpc.call(
      'pocketInstructions/describe', { cwd: NESTED } as JsonObject, 20000)
    const nestedRoot = stringField(nested, 'projectRoot', '')
    ok('a nested checkout is its own project root',
      nestedRoot.toLowerCase().endsWith('dsh-go'), nestedRoot)
    let projectRows = 0
    for (const row of arrayField(nested, 'files')) {
      if (row !== null && typeof row === 'object') {
        if (stringField(row as JsonObject, 'scope') === 'project') projectRows += 1
      }
    }
    ok('the nested checkout contributes its own instruction files', projectRows > 0,
      `${projectRows} project file(s)`)
    ok('the walk stops at the nearest project marker',
      nestedRoot.toLowerCase() === NESTED.toLowerCase(),
      nestedRoot)

    ok('at least one file exists to edit', allPaths.length > 0, allPaths.join(', '))
    if (allPaths.length === 0) throw new Error('no instruction file to exercise')

    // 优先改项目链里的那份：用户级 `~/.dsh/AGENTS.md` 是全机器共用的，回归脚本
    // 不该拿它当实验台。
    const target = projectPathsOf(nested)[0] ?? projectPathsOf(described)[0] ?? allPaths[0]
    ok('the file really is on this computer', existsSync(target), target)
    console.log(`  target: ${target}`)

    const before = await link.rpc.call(
      'pocketInstructions/read', { path: target } as JsonObject, 20000)
    const originalText = stringField(before, 'text', '')
    ok('read returns the text', originalText.length > 0, `${originalText.length} chars`)
    if (originalText.length === 0) throw new Error('read returned no text')

    // 写一次可辨认的内容，随后断言盘上的字节真的变了。
    const marker = `${originalText}\n<!-- pocket-harness live check ${Date.now()} -->`
    restore = { path: target, text: originalText }
    const written = await link.rpc.call(
      'pocketInstructions/write', { path: target, text: marker } as JsonObject, 20000)
    ok('write answers', written !== null)
    ok('write reports the new size',
      (written['bytes'] as number) === Buffer.byteLength(marker, 'utf8'),
      `${written['bytes']} vs ${Buffer.byteLength(marker, 'utf8')}`)
    ok('the bytes on the computer changed',
      readFileSync(target, 'utf8') === marker)

    // 读回来必须与写的一致：Host 不做任何规范化。
    const after = await link.rpc.call(
      'pocketInstructions/read', { path: target } as JsonObject, 20000)
    ok('reading it back returns what was written',
      stringField(after, 'text') === marker)

    // 写回原样，并验证恢复到出发点。
    await link.rpc.call(
      'pocketInstructions/write', { path: target, text: originalText } as JsonObject, 20000)
    ok('the original text was restored', readFileSync(target, 'utf8') === originalText)
    restore = null

    // 越界必须被拒：一个候选文件名、但目录不在任何 scope 里。
    let outside = ''
    try {
      await link.rpc.call('pocketInstructions/write', {
        path: 'C:\\Windows\\Temp\\AGENTS.md',
        text: 'nope',
        create: true,
      } as JsonObject, 20000)
    } catch (error) {
      outside = describeError(error as Object)
    }
    ok('a directory outside every scope is refused', outside.length > 0, outside)

    // 非候选文件名必须被拒：否则这个端点就是通用写文件接口。
    let wrongName = ''
    try {
      await link.rpc.call(
        'pocketInstructions/read', { path: `${REPO}\\package.json` } as JsonObject, 20000)
    } catch (error) {
      wrongName = describeError(error as Object)
    }
    ok('a file that is not an instruction file is refused', wrongName.length > 0, wrongName)

    // 新建：手机上的「新建」走的就是这条。落点按 `createDirectory` 的规则挑，
    // 断言的是「盘上真的多出这个文件」「再 describe 一次它在列表里」「能删掉」。
    //
    // 名字用 `AGENTS.local.md` 而不是 `AGENTS.md`：前者是本地覆盖、通常不进版本库，
    // 在一个 git 检出里留下又删掉它，比动 `AGENTS.md` 风险小。
    const describedNested = readInstructions(nested)
    const directory = createDirectory(describedNested.projectRoot, describedNested.cwd)
    ok('there is a directory to create in', directory.length > 0, directory)
    if (directory.length > 0) {
      const created = instructionPath(directory, 'AGENTS.local.md')
      const alreadyThere = existsSync(created)
      console.log(`  create target: ${created}${alreadyThere ? ' (already present, skipping)' : ''}`)
      if (!alreadyThere) {
        const body = `# live check ${Date.now()}\n`
        const answer = await link.rpc.call(
          'pocketInstructions/write', writeInstructionRequest(created, body, true), 20000)
        ok('creating a missing file with create: true succeeds', answer !== null)
        ok('the new file is really on the computer', existsSync(created))
        if (existsSync(created)) {
          ok('it holds what was sent', readFileSync(created, 'utf8') === body)
        }
        // 再问一次：新文件必须出现在列表里，否则界面上的「新建」看起来没生效。
        const again = await link.rpc.call(
          'pocketInstructions/describe', describeRequest(directory), 20000)
        const listedPaths = pathsOf(again)
        ok('the listing now includes the new file', listedPaths.includes(created),
          listedPaths.join(', '))
        // 读得回来，说明它不是一份只有一半的文件。
        const back = await link.rpc.call(
          'pocketInstructions/read', { path: created } as JsonObject, 20000)
        ok('the new file reads back', readInstructionText(back) === body)
        // 收尾：删掉，别在别人的检出里留垃圾。
        try {
          unlinkSync(created)
          ok('the scratch file was removed', !existsSync(created))
        } catch (error) {
          console.log(`  WARNING: could not remove ${created}: ${describeError(error as Object)}`)
        }
      }
      // 不带 create 的写入对不存在的文件必须被拒：默认不悄悄造文件。
      const missing = instructionPath(directory, 'CLAUDE.local.md')
      if (!existsSync(missing)) {
        let refused = ''
        try {
          await link.rpc.call(
            'pocketInstructions/write', writeInstructionRequest(missing, 'nope', false), 20000)
        } catch (error) {
          refused = describeError(error as Object)
        }
        ok('writing a missing file without create is refused', refused.length > 0, refused)
      }
    }

    if (failures.length > 0) {
      console.log(`\n${failures.length} CHECK(S) FAILED`)
      process.exit(1)
    }
    console.log('REAL INSTRUCTIONS LIST, READ AND WRITE (live Host)')
  } catch (error) {
    console.log(`FAILED: ${describeError(error as Object)}`)
    process.exit(1)
  } finally {
    // 中途失败时也要把原内容写回去，别把用户的指令文件留在半路。
    if (restore !== null && link !== null) {
      try {
        await link.rpc.call('pocketInstructions/write',
          { path: restore.path, text: restore.text } as JsonObject, 20000)
        console.log(`  (restored ${restore.path})`)
      } catch (error) {
        console.log(`  WARNING: could not restore ${restore.path}: ${describeError(error as Object)}`)
      }
    }
    if (link !== null) await link.close()
  }
}

main()
