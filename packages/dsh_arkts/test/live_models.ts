// 用真实 Host 的回答校验模型清单与当前路由。
//
// 断言分两层：清单必须非空且每个条目都能定位（provider + model + name），
// 而每个会话报告的当前路由必须能在清单里找到 —— 找不到说明「电脑说它用的是 A，
// 但清单里没有 A」，这正是选择器最该显示清楚的退化情形。
//
// 不真的换模型：换模型会改这台电脑上真实会话的状态。选择动作的形状
// （参数名、扁平回答）由 `test/client.ts` 的假 Host 与 `test/models.ts` 的
// 两种形状断言钉住，`selectModel` 的实测记录写在规格文档 §4.7 里。

import {
  findChoice,
  readModelCatalog,
  readModelSelection,
  readProjectionSelection,
  routeLabel,
} from '../src/models'
import type { JsonObject } from '../src/json'
import { connectLive, describeError, type LiveLink } from './live_common'

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
  console.log('LIVE MODEL CHECKS (against the running Host)')
  let link: LiveLink | null = null
  try {
    link = await connectLive()

    const catalog = readModelCatalog(await link.rpc.call('session/modelCatalog', {}, 20000))
    ok('the catalog is not empty', catalog.choices.length > 0, `${catalog.choices.length}`)
    ok(
      'the default route is named',
      catalog.defaultProvider.length > 0 && catalog.defaultModel.length > 0,
      `${catalog.defaultProvider}/${catalog.defaultModel}`,
    )

    let unnamed = 0
    let providerless = 0
    for (const choice of catalog.choices) {
      if (choice.name.length === 0) unnamed += 1
      if (choice.provider.length === 0 || choice.providerName.length === 0) providerless += 1
    }
    ok('every entry has a display name', unnamed === 0, `${unnamed} unnamed`)
    ok('every entry has a provider and a provider name', providerless === 0, `${providerless} providerless`)

    const matching = catalog.choices.filter(
      (choice) => choice.provider === catalog.defaultProvider && choice.model === catalog.defaultModel,
    )
    ok('the default route appears in the catalog', matching.length === 1, `${matching.length} matches`)

    const list = await link.rpc.call('session/list', { _request: {} }, 20000)
    const items = list['items']
    ok('the session list is an array', Array.isArray(items))
    const sessions = (Array.isArray(items) ? items : []) as Object[]
    ok('there is at least one session', sessions.length > 0, `${sessions.length}`)

    let checked = 0
    let reported = 0
    let missing = 0
    for (const entry of sessions) {
      if (checked >= 6) break
      const session = entry as JsonObject
      const id = session['sessionId']
      if (typeof id !== 'string' || id.length === 0) continue
      const selection = readProjectionSelection(
        await link.rpc.call('session/projections', { request: { sessionId: id } }, 20000),
      )
      if (selection === null) continue
      reported += 1
      const label = routeLabel(catalog, selection)
      ok(`the route of ${id} renders`, label.length > 0, label)
      if (findChoice(catalog, selection) === null) missing += 1
      checked += 1
    }
    ok('at least one session reported a route', reported > 0, `${reported}`)
    ok('every reported route exists in the catalog', missing === 0, `${missing} not in the catalog`)

    // 扁平的 `selectModel` 回答形状：用清单里第一条自己拼一个，走同一套解析。
    const first = catalog.choices[0]
    const flat = readModelSelection({ provider: first.provider, model: first.model, reasoningEffort: 'high' })
    ok('a flat route parses', flat !== null && flat.model === first.model, `${flat}`)

    if (failures.length > 0) {
      console.log(`\n${failures.length} CHECK(S) FAILED`)
      process.exit(1)
    }
    console.log('REAL CATALOG AND ROUTES PARSE (live Host)')
  } catch (error) {
    console.log(`FAILED: ${describeError(error as Object)}`)
    process.exit(1)
  } finally {
    if (link !== null) await link.close()
  }
}

main()
