// 用真实 Host 校验全局设置。
//
// 单测钉住形状，这里钉住「Host 真的这么答」。
//
// 写也真写一次，但**写回原值**：实测写同值不递增 revision，所以这一步既验证了
// `settings/update` 的请求形状（含 `expectedRevision`），又不会在这台电脑上留下
// 任何改动。真的换一个模型是人的决定，不该由回归脚本替他做。

import {
  DEFAULT_MODEL_NS,
  findNamespace,
  readSettings,
  summarize,
  updateRequest,
  describeSettingsError,
} from '../src/settings'
import { readModelSelection, routeLabel, readModelCatalog } from '../src/models'
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
  console.log('LIVE SETTINGS CHECKS (against the running Host)')
  let link: LiveLink | null = null
  try {
    link = await connectLive()
    const answer = await link.rpc.call('settings/describe', {}, 20000)
    const snapshot = readSettings(answer)
    ok('the Host describes at least one namespace', snapshot.namespaces.length > 0,
      `${snapshot.namespaces.length}`)
    console.log(`  namespaces: ${snapshot.namespaces.length}, writable: ${snapshot.writable}`)

    let nameless = 0
    for (const entry of snapshot.namespaces) {
      if (entry.ns.length === 0) nameless += 1
    }
    ok('every namespace has a name', nameless === 0)

    const model = findNamespace(snapshot, DEFAULT_MODEL_NS)
    ok(`"${DEFAULT_MODEL_NS}" is present`, model !== null)
    if (model !== null) {
      console.log(`  ${model.ns}: ${summarize(model)} (revision ${model.revision})`)
      ok('the default model namespace carries a provider and a model',
        typeof model.value['provider'] === 'string' && typeof model.value['model'] === 'string')

      // 写回原值：形状走通、revision 不变、电脑上的配置不动。
      const request = updateRequest(model, model.value)
      const written = await link.rpc.call('settings/update', request, 20000)
      const after = readSettings({ namespaces: [written] } as JsonObject).namespaces[0]
      ok('writing the same value is accepted', after !== undefined)
      if (after !== undefined) {
        ok('writing the same value keeps the revision', after.revision === model.revision,
          `${model.revision} -> ${after.revision}`)
        ok('the value came back unchanged',
          JSON.stringify(after.value) === JSON.stringify(model.value))
      }
      console.log(`  update round trip left ${model.ns} at revision ${model.revision}`)
    }

    // 一个过期的 revision 必须被拒绝，而不是悄悄覆盖电脑上的值。
    const stale = readSettings({ namespaces: [Object.assign({}, answer['namespaces'][0] as JsonObject, {
      revision: 99999,
    })] } as JsonObject).namespaces[0]
    const first = snapshot.namespaces[0]
    let refused = ''
    try {
      await link.rpc.call('settings/update',
        { ns: first.ns, patch: first.value, expectedRevision: stale.revision }, 20000)
    } catch (error) {
      refused = describeSettingsError(error as Object)
    }
    ok('a stale revision is refused instead of overwriting', refused.length > 0, refused)
    ok('the refusal explains what to do',
      refused.includes('刚被改过') || refused.includes('电脑拒绝'), refused)

    // 默认模型能不能被界面读成一句人话。
    const catalog = readModelCatalog(await link.rpc.call('session/modelCatalog', {}, 20000))
    const selection = readModelSelection(model === null ? null : model.value)
    ok('the default model reads as a route', selection !== null)
    ok('the default route shows up as a label', routeLabel(catalog, selection).length > 0,
      routeLabel(catalog, selection))
    console.log(`  default route label: ${routeLabel(catalog, selection)}`)

    if (failures.length > 0) {
      console.log(`\n${failures.length} CHECK(S) FAILED`)
      process.exit(1)
    }
    console.log('REAL SETTINGS PARSE AND ROUND TRIP (live Host)')
  } catch (error) {
    console.log(`FAILED: ${describeError(error as Object)}`)
    process.exit(1)
  } finally {
    if (link !== null) await link.close()
  }
}

main()
