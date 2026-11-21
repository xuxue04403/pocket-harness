// 技能清单与会话里的插入文本。
//
// `skills/list` 回的是「这台电脑按这个会话的目录与预设能用的技能」；调用方式是
// 在输入框里写一条 `/name` 斜杠命令，而不是另发一条 RPC。所以这里只负责把清单
// 收口成界面能用的行，并提供「插进去的文本」这一件事。
//
// 两条与 Flutter 端一致的口径：
// - `name` 是 kebab-case 的调用名，`description` 才是给人看的；
// - 有些技能标了 `modelInvocable: false`，表示只能由人手动调用 —— 界面要能标出来，
//   否则用户会以为模型自己也能挑到它。

import { stringField } from './json'
import type { JsonObject } from './json'

/** 一条可用技能。 */
export interface SkillEntry {
  /** 调用名，kebab-case；插入时写成 `/name`。 */
  readonly name: string
  readonly description: string
  /** 电脑建议什么时候用它，可能为空。 */
  readonly whenToUse: string
  /** 有文件系统提供者时是 `SKILL.md` 的绝对路径。 */
  readonly path: string
  /** 模型是否也能自己挑到它。 */
  readonly modelInvocable: boolean
}

/**
 * 读一个技能条目。没有 `name` 的直接丢弃 —— 一条插不进去的行比少一行更糟。
 */
export function readSkill(value: JsonObject): SkillEntry | null {
  const name = stringField(value, 'name')
  if (name.length === 0) return null
  return {
    name,
    description: stringField(value, 'description'),
    whenToUse: stringField(value, 'whenToUse'),
    path: stringField(value, 'path'),
    modelInvocable: value['modelInvocable'] === true,
  }
}

/** 读 `skills/list` 的回答。坏条目跳过，不让一条畸形记录清空整个清单。 */
export function readSkills(answer: JsonObject): SkillEntry[] {
  const raw = answer['skills']
  if (!Array.isArray(raw)) return []
  const skills: SkillEntry[] = []
  for (const entry of raw as Object[]) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const skill = readSkill(entry as JsonObject)
    if (skill !== null) skills.push(skill)
  }
  return skills
}

/**
 * 按名字、说明或用途筛。
 *
 * 空查询返回**全部**（清单本来就是这个会话的可用集合），与 Flutter 端的
 * `filterSkills` 同口径 —— 那里会话过滤反过来是「空查询返回空」，两者别搞混。
 */
export function filterSkills(skills: SkillEntry[], query: string): SkillEntry[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return skills.slice()
  return skills.filter((skill) => {
    if (skill.name.toLowerCase().includes(needle)) return true
    if (skill.description.toLowerCase().includes(needle)) return true
    return skill.whenToUse.toLowerCase().includes(needle)
  })
}

/** 插进输入框的文本：`/name` 后面带一个空格，好继续写字。 */
export function skillInvocation(skill: SkillEntry): string {
  return `/${skill.name} `
}

/**
 * 把一条技能追加到已有草稿后面。
 *
 * 原文末尾不是空白就先补一个空格，否则 `/a /b` 会粘成 `/a/b`；原文为空时不留
 * 前导空格。返回拼好的新文本，调用方负责设置光标到末尾。
 */
export function appendSkill(draft: string, skill: SkillEntry): string {
  const invocation = skillInvocation(skill)
  if (draft.length === 0) return invocation
  const last = draft.charAt(draft.length - 1)
  if (last === ' ' || last === '\n' || last === '\t') return draft + invocation
  return `${draft} ${invocation}`
}

/** 已知的调用前缀，界面用来判断「这行是不是一条斜杠命令」。 */
export const SKILL_PREFIX = '/'
