// 模型清单与当前路由的解析。
//
// 每条断言都照抄自本机 Host 的真实回答（`probe/samples/model_catalog.json`
// 与 `probe/samples/session_projections.json`），因为这些形状是猜不出来的：
// 模型在 groups[].models[] 里、provider 名在 groups[].name、
// selectModel 回扁平路由而 projections 套 next/lastUsed。

import {
  EMPTY_CATALOG,
  defaultEffortOf,
  effortsOf,
  findChoice,
  readModelCatalog,
  readModelSelection,
  readProjectionSelection,
  routeLabel,
  type ModelChoice,
} from '../src/models'
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

/** 与真实回答同形的清单：两个 provider、三种形状的模型。 */
function catalogAnswer(): JsonObject {
  return {
    default: { provider: 'deepseek-account', model: 'deepseek-flash' },
    routableProviders: ['deepseek-official', 'gateway'],
    failures: [],
    groups: [
      {
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [
          {
            id: 'deepseek-flash',
            name: 'DeepSeek-V4.1-Flash',
            reasoning: {
              efforts: [
                { id: 'off', name: 'Off', description: 'Use for simple tasks that do not need reasoning.' },
                { id: 'low', name: 'Low' },
                { id: 'high', name: 'High' },
                { id: 'max', name: 'Max' },
              ],
              defaultEffort: 'high',
            },
          },
          {
            id: 'deepseek-v4-pro',
            name: 'DeepSeek-V4-Pro',
            description: 'Stronger agentic coding.',
            reasoning: {
              efforts: [{ id: 'high', name: 'High' }],
              defaultEffort: 'high',
            },
          },
        ],
      },
      {
        id: 'gateway',
        name: 'DSH Model Gateway',
        models: [
          { id: 'agnes-3.0-flash', name: 'agnes-3.0-flash', reasoning: { efforts: [{ id: 'off', name: 'Off' }] } },
          { id: 'claude-haiku-5-5', name: 'claude-haiku-5-5' },
        ],
      },
    ],
  }
}

function checkCatalog(): void {
  const catalog = readModelCatalog(catalogAnswer())
  ok('every provider group is flattened', catalog.choices.length === 4, `${catalog.choices.length}`)
  ok('the first choice keeps its provider', catalog.choices[0].provider === 'deepseek-official')
  ok('the provider name comes from the group', catalog.choices[0].providerName === 'DeepSeek')
  ok('the model id is the wire value', catalog.choices[0].model === 'deepseek-flash')
  ok('the display name is separate from the id', catalog.choices[0].name === 'DeepSeek-V4.1-Flash')
  ok('efforts are read in order', catalog.choices[0].efforts.length === 4)
  ok('an effort keeps its description', catalog.choices[0].efforts[0].description.length > 0)
  ok('an effort without a name falls back to its id', catalog.choices[0].efforts[1].name === 'Low')
  ok('the default effort survives', catalog.choices[0].defaultEffort === 'high')
  ok('a model with a description keeps it', catalog.choices[1].description.length > 0)
  ok('a model without a description reads as empty', catalog.choices[3].description === '')
  ok('a model without reasoning has no efforts', catalog.choices[3].efforts.length === 0)
  ok('the catalog default is kept', catalog.defaultProvider === 'deepseek-account' && catalog.defaultModel === 'deepseek-flash')

  // 畸形输入不能让整个选择器崩掉：坏条目跳过，好的照读。
  const broken: JsonObject = {
    groups: [
      { models: [{ id: 'no-provider' }] },
      { id: 'ok', name: 'OK', models: [{ id: 'good' }, { name: 'no-id' }, 'not-an-object'] },
      'not-a-group',
    ],
  }
  const partial = readModelCatalog(broken)
  ok('a group without an id is skipped', partial.choices.length === 1, `${partial.choices.length}`)
  ok('a model without an id is skipped', partial.choices.length === 1 && partial.choices[0].model === 'good')
  ok('a missing default reads as empty', partial.defaultProvider === '' && partial.defaultModel === '')

  ok('an empty answer yields an empty catalog', readModelCatalog({}).choices.length === 0)
  ok('EMPTY_CATALOG is empty', EMPTY_CATALOG.choices.length === 0)
}

function checkSelection(): void {
  // projections 的套层形状：取 next 而不是 lastUsed。
  const projections: JsonObject = {
    lastUsed: { provider: 'gateway', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
    next: { provider: 'gateway', model: 'agnes-3.0-flash', reasoningEffort: 'low' },
  }
  const next = readModelSelection(projections)
  ok('projections give the next route', next !== null && next.model === 'agnes-3.0-flash', `${next}`)
  ok('the reasoning effort travels with the route', next !== null && next.reasoningEffort === 'low')
  ok('a route without an effort reads as empty', readModelSelection({ provider: 'a', model: 'b' })?.reasoningEffort === '')

  // selectModel 的扁平形状。
  const flat = readModelSelection({ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' })
  ok('the flat selectModel answer is read', flat !== null && flat.provider === 'deepseek-official')
  ok('the flat answer keeps the effort', flat !== null && flat.reasoningEffort === 'max')

  // 只给 lastUsed 时退回去用它：会话还没跑过下一轮。
  const onlyLast: JsonObject = { lastUsed: { provider: 'gateway', model: 'm' } }
  ok('lastUsed is the fallback', readModelSelection(onlyLast)?.provider === 'gateway')

  ok('no selection at all reads as null', readModelSelection(null) === null)
  ok('an empty object reads as null', readModelSelection({}) === null)
  ok('a route missing the model reads as null', readModelSelection({ provider: 'a' }) === null)
  ok('a non-object reads as null', readModelSelection('nope' as Object) === null)

  // projections 回答的完整形状。
  const answer: JsonObject = { kind: 'sequenced', asOfSeq: 2, values: { modelSelection: projections } }
  ok('the selection is found inside projections', readProjectionSelection(answer)?.model === 'agnes-3.0-flash')
  ok('projections without a selection read as null', readProjectionSelection({ values: {} }) === null)
  ok('projections without values read as null', readProjectionSelection({}) === null)
}

function checkLabels(): void {
  const catalog = readModelCatalog(catalogAnswer())
  const selection = { provider: 'gateway', model: 'agnes-3.0-flash', reasoningEffort: 'off' }

  const choice = findChoice(catalog, selection)
  ok('a known route is found', choice !== null && choice.name === 'agnes-3.0-flash')

  ok('a known route shows its name and effort', routeLabel(catalog, selection) === 'agnes-3.0-flash · off', routeLabel(catalog, selection))
  ok(
    'a route without an effort shows only the name',
    routeLabel(catalog, { provider: 'gateway', model: 'claude-haiku-5-5', reasoningEffort: '' }) === 'claude-haiku-5-5',
  )
  ok(
    'an unknown route still shows its model id',
    routeLabel(catalog, { provider: 'gone', model: 'retired-model', reasoningEffort: '' }) === 'retired-model',
  )
  ok('no selection says the default applies', routeLabel(catalog, null) === '默认模型')
  ok('the pretty model name is preferred over the id', routeLabel(catalog, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'high',
  }) === 'DeepSeek-V4-Pro · high')

  const pro = findChoice(catalog, { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: '' })
  ok('efforts are exposed for a known model', pro !== null && effortsOf(pro).length === 1)
  ok('no choice means no efforts', effortsOf(null).length === 0)
  const flash = findChoice(catalog, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: '' })
  ok('the default effort is preferred when picking one', flash !== null && defaultEffortOf(flash) === 'high')

  // 没有 defaultEffort 时取第一个；两者都没有时是空串。
  const noDefault: ModelChoice = {
    provider: 'p',
    providerName: 'P',
    model: 'm',
    name: 'M',
    description: '',
    efforts: [{ id: 'first', name: 'First', description: '' }],
    defaultEffort: '',
  }
  ok('without a default effort the first one is used', defaultEffortOf(noDefault) === 'first')
  const bare: ModelChoice = {
    provider: 'p',
    providerName: 'P',
    model: 'm',
    name: 'M',
    description: '',
    efforts: [],
    defaultEffort: '',
  }
  ok('a model with no efforts picks nothing', defaultEffortOf(bare) === '')
}

function main(): void {
  console.log('MODEL CATALOG CHECKS (typescript core)')
  checkCatalog()
  checkSelection()
  checkLabels()
  if (failures.length > 0) {
    console.log(`\n${failures.length} CHECK(S) FAILED`)
    process.exit(1)
  }
  console.log('ALL MODEL CATALOG CHECKS PASS (typescript core)')
}

main()
