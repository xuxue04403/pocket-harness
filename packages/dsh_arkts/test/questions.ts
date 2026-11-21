/**
 * 提问解析的断言。
 *
 * 这些形状全部来自 DSH 的 `$events` 转发流（Host 侧 `host/rpc.js` 的
 * `isGatewayEndpoint` 分支）与 `dsh-user-approval` / `dsh-user-questions` 的类型。
 * 一条错判的代价很高：手机没渲染出来又不 delegate，整个 turn 会永远卡在
 * waterfall 上等一个不会到来的答案。
 */

import type { RemoteInvocation } from '../src/remote_events'
import {
  APPROVAL_ALLOWED_ONCE,
  APPROVAL_REJECTED,
  QUESTION_APPROVAL,
  QUESTION_CHOICE,
  answerValue,
  readChoices,
  readQuestion,
} from '../src/questions'
import type { JsonObject } from '../src/json'

let failures = 0
function check(name: string, run: () => void): void {
  try {
    run()
  } catch (error) {
    failures += 1
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`FAILED ${name}: ${message}\n`)
  }
}
function equal<T>(actual: T, expected: T, what: string): void {
  if (actual !== expected) throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`)
}
function ok(condition: boolean, what: string): void {
  if (!condition) throw new Error(what)
}

function invocation(event: string, request: JsonObject): RemoteInvocation {
  return { event, eventId: 'evt-1', agentId: 'agent-1', request }
}

// 审批：工具名 + 理由，拼成一行能读的标题。
check('an approval names the tool and the reason', () => {
  const read = readQuestion(invocation('approval/request', { toolName: 'bash', reason: 'run a command' }))
  ok(read !== null, 'expected a question')
  equal(read?.kind, QUESTION_APPROVAL, 'kind')
  equal(read?.toolName, 'bash', 'toolName')
  equal(read?.title, 'bash: run a command', 'title')
  equal(read?.questions.length, 0, 'no choices')
})

// displayReason 优先于裸 reason，且优先英文（手机没有 Host 语言的翻译）。
check('displayReason wins and prefers English', () => {
  const read = readQuestion(invocation('approval/request', {
    toolName: 'pwsh',
    reason: 'fallback',
    displayReason: { zh: '执行命令', en: 'run a command' },
  }))
  equal(read?.title, 'pwsh: run a command', 'title')
})

check('a displayReason without English takes the first string', () => {
  const read = readQuestion(invocation('approval/request', {
    toolName: 'pwsh',
    displayReason: { zh: '执行命令' },
  }))
  equal(read?.title, 'pwsh: 执行命令', 'title')
})

// 没有理由时也要能读——不能因为缺字段就不显示审批。
check('an approval with no reason still reads', () => {
  const read = readQuestion(invocation('approval/request', { toolName: 'read' }))
  equal(read?.title, 'read 想要执行', 'title')
})

check('an approval with no tool name falls back to a noun', () => {
  const read = readQuestion(invocation('approval/request', {}))
  equal(read?.title, '某个工具 想要执行', 'title')
})

// 选择题：两种选项形状都要收。
check('choices read both option shapes', () => {
  const read = readQuestion(invocation('user-questions/request', {
    questions: [
      {
        id: 'q1',
        question: 'Which colour?',
        header: 'Colour',
        detail: 'pick one',
        options: [{ label: 'green', description: 'like grass' }, 'blue'],
      },
    ],
  }))
  ok(read !== null, 'expected a question')
  equal(read?.kind, QUESTION_CHOICE, 'kind')
  equal(read?.title, 'Which colour?', 'title')
  equal(read?.questions.length, 1, 'count')
  equal(read?.questions[0].options.length, 2, 'options')
  equal(read?.questions[0].options[0].description, 'like grass', 'described')
  equal(read?.questions[0].options[1].label, 'blue', 'bare string')
})

// 多题时标题只报数量，避免把一整段正文塞进标题栏。
check('several questions become a count', () => {
  const read = readQuestion(invocation('user-questions/request', {
    questions: [
      { id: 'a', question: 'First?' },
      { id: 'b', question: 'Second?' },
    ],
  }))
  equal(read?.title, '2 个问题', 'title')
  equal(read?.questions.length, 2, 'count')
})

// 没有 id 的题目用位置兜底：整批里丢一条比丢整批更糟。
check('a question without an id gets a positional one', () => {
  const choices = readChoices({ questions: [{ question: 'Free text?' }] })
  equal(choices.length, 1, 'count')
  equal(choices[0].id, 'question-0', 'id')
})

// 不能渲染的东西返回 null——调用方据此 delegate，别把 waterfall 挂死。
check('an unknown event is not rendered', () => {
  equal(readQuestion(invocation('something/else', {})), null, 'unknown')
  equal(readQuestion(invocation('user-questions/request', { questions: [] })), null, 'no questions')
  equal(readQuestion(invocation('user-questions/request', { questions: [{ id: 'x' }] })), null, 'no text')
})

// 答案的形状必须与 DSH 的 AskUserQuestionAnswer 一致。
check('the answer batch matches the Host shape', () => {
  const choices = readChoices({
    questions: [
      { id: 'q1', question: 'One?', multiSelect: false },
      { id: 'q2', question: 'Two?', multiSelect: true },
      { id: 'q3', question: 'Three?' },
    ],
  })
  const value = answerValue(
    choices,
    new Map<string, string[]>([['q1', ['green']], ['q2', ['a', 'b']]]),
    new Map<string, string>([['q3', 'my own answer']]),
  )
  const answers = value['answers'] as Object[]
  equal(answers.length, 3, 'count')
  const first = answers[0] as JsonObject
  equal(first['id'], 'q1', 'first id')
  equal((first['selected'] as string[]).join(','), 'green', 'first selected')
  const second = answers[1] as JsonObject
  equal((second['selected'] as string[]).join(','), 'a,b', 'multi selected')
  const third = answers[2] as JsonObject
  equal(third['custom'], 'my own answer', 'custom')
  equal((third['selected'] as string[]).length, 0, 'skipped is empty')
})

// 空的自定义答案不该出现在载荷里：Host 会把空字符串当成一次作答。
check('an empty custom answer is omitted', () => {
  const choices = readChoices({ questions: [{ id: 'q1', question: 'One?' }] })
  const value = answerValue(choices, new Map<string, string[]>([['q1', ['a']]]), new Map<string, string>([['q1', '']]))
  const entry = (value['answers'] as Object[])[0] as JsonObject
  ok(!('custom' in entry), 'custom must be absent')
})

// 审批的两个取值必须与 dsh-user-approval 的字面量一致，否则 fail-closed 会变成
// "每次都拒绝"，用户会以为手机批准按钮坏了。
check('the approval literals match the Host', () => {
  equal(APPROVAL_ALLOWED_ONCE, 'allowed-once', 'allow')
  equal(APPROVAL_REJECTED, 'rejected', 'reject')
})

if (failures > 0) {
  process.stderr.write(`${failures} question checks failed\n`)
  process.exit(1)
}
process.stdout.write('ALL QUESTION CHECKS PASS (typescript core)\n')
