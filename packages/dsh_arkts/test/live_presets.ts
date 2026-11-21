// 用真实 Host 校验预设清单。
//
// 单测钉住形状，这里钉住「Host 真的这么答」。不新建会话：那会在电脑上留下一条
// 会话记录，而 `createSessionRequest` 的请求体形状已经有单测与假 Host 双重覆盖。

import { defaultPreset, followDesktopLabel, readPresets } from '../src/agent_presets'
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
  console.log('LIVE PRESET CHECKS (against the running Host)')
  let link: LiveLink | null = null
  try {
    link = await connectLive()
    const answer = await link.rpc.call('agentPresets/list', {}, 20000)
    const presets = readPresets(answer)
    ok('the Host lists at least one preset', presets.length > 0, `${presets.length}`)
    let nameless = 0
    for (const preset of presets) {
      if (preset.label.length === 0) nameless += 1
    }
    ok('every preset has a label', nameless === 0, `${nameless} nameless`)
    ok('a default preset is marked', defaultPreset(presets) !== null, followDesktopLabel(presets))
    console.log(`  ids: ${presets.map((preset) => preset.id).join(', ')}`)
    console.log(`  label for follow-desktop: ${followDesktopLabel(presets)}`)

    if (failures.length > 0) {
      console.log(`\n${failures.length} CHECK(S) FAILED`)
      process.exit(1)
    }
    console.log('REAL PRESET LIST PARSES (live Host)')
  } catch (error) {
    console.log(`FAILED: ${describeError(error as Object)}`)
    process.exit(1)
  } finally {
    if (link !== null) await link.close()
  }
}

main()
