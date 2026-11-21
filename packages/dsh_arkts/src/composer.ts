/**
 * 一条要发给 Host 的提示词：文字 + 图片，以及它们的内容块。
 *
 * Host 的 `PromptContentPart` 只认三种：`text`、`image`、`file`。手机上只用前两种，
 * 而 `image` 的 `data` 是 **base64 字符串**（不是 base64url，填充也要带上）——
 * 这个细节写错了 Host 会回 `gateway/input-invalid`，看起来像是图片本身有问题。
 *
 * 另外三条来自实测：
 * - `mediaType` 必须在 `image/png` / `image/jpeg` / `image/webp` / `image/gif` 里；
 * - 只发图片、不带文字是合法的（内容块数组非空即可）；
 * - 图片和文字都空时**不要发** —— Host 会把空 content 当成「继续上一轮」，
 *   于是一次误点变成让电脑重新跑一遍。
 */

import { encodeBase64 } from './bytes'
import type { JsonObject } from './json'

/** Host 接受的四种图片类型。 */
export const IMAGE_MEDIA_TYPES: string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** 手机上待发的一张图片。`data` 是原始字节的 base64。 */
export interface OutgoingImage {
  readonly mediaType: string
  readonly data: string
  readonly name: string
}

/**
 * 按文件名的扩展名猜类型。
 *
 * 相册回来的 uri 常常只有一串数字（`file://media/Photo/3/IMG_001/IMG_001.jpg`
 * 这种还算好的），所以大写的 `.JPG` 与带查询串的都要能认。
 */
export function mediaTypeFor(nameOrUri: string): string {
  if (nameOrUri.length === 0) return ''
  let path = nameOrUri
  const query = path.indexOf('?')
  if (query >= 0) path = path.substring(0, query)
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return ''
}

/** 造一张待发图片；类型不认识时报错而不是发一个 Host 会拒的块。 */
export function outgoingImage(bytes: Uint8Array, name: string): OutgoingImage {
  const mediaType = mediaTypeFor(name)
  if (mediaType.length === 0) {
    throw new Error(`不认识这个图片类型：${name}`)
  }
  if (bytes.length === 0) {
    throw new Error('这张图片是空的')
  }
  return { mediaType, data: encodeBase64(bytes), name }
}

/** 一张图片 → 一个内容块。 */
export function imagePart(image: OutgoingImage): JsonObject {
  const part: JsonObject = { type: 'image', mediaType: image.mediaType, data: image.data }
  if (image.name.length > 0) part['name'] = image.name
  return part
}

/** 一段文字 → 一个内容块。 */
export function textPart(text: string): JsonObject {
  return { type: 'text', text }
}

/**
 * 把草稿编成 `content` 数组。
 *
 * 文字在**前**：Host 与电脑上的界面都按顺序读，图片放前面会让「先说什么」变成
 * 「先看图」。空文字不产生空块（`{type:'text', text:''}` 是合法块但没意义，还会
 * 让「有没有内容」的判断变复杂）。
 */
export function buildContent(text: string, images: OutgoingImage[]): JsonObject[] {
  const parts: JsonObject[] = []
  const trimmed = text.trim()
  if (trimmed.length > 0) parts.push(textPart(trimmed))
  for (const image of images) parts.push(imagePart(image))
  return parts
}

/** 有没有东西可发。空 content 会被 Host 读成「继续上一轮」，所以必须拦住。 */
export function hasContent(text: string, images: OutgoingImage[]): boolean {
  return text.trim().length > 0 || images.length > 0
}

/** `session/prompt` 的请求体。`mode` 只有 `queue` 与 `steer` 两种。 */
export const PROMPT_MODE_QUEUE = 'queue'
export const PROMPT_MODE_STEER = 'steer'

export const PROMPT_MODES: string[] = [PROMPT_MODE_QUEUE, PROMPT_MODE_STEER]

/**
 * 造请求体。
 *
 * `requestId` 由**客户端**铸造：同一个 id 重发不会让电脑执行两次，所以它必须在
 * 发请求之前就定下来，而不是等回答回来再补。界面用 `phone-<毫秒>` 已经够用，
 * 这里只是要求调用方显式传进来，免得两处各生成一份。
 */
export function promptRequest(requestId: string, sessionId: string, content: JsonObject[],
  mode: string = PROMPT_MODE_QUEUE): JsonObject {
  if (requestId.length === 0) throw new Error('发出去的请求要带上 requestId')
  if (sessionId.length === 0) throw new Error('不知道要发给哪个会话')
  if (content.length === 0) throw new Error('没有内容可发')
  const safeMode = PROMPT_MODES.indexOf(mode) >= 0 ? mode : PROMPT_MODE_QUEUE
  return {
    requestId: requestId,
    sessionId,
    mode: safeMode,
    content,
  }
}

/** 为什么这次发送被拒 —— 界面要能照着做。 */
export function describePromptError(error: Object): string {
  const text = `${error}`
  if (text.includes('gateway/input-invalid')) return '电脑没接受这条消息，可能是图片太大或格式不支持。'
  if (text.includes('media type') || text.includes('mediaType')) return '这张图片的格式电脑不支持，换成 PNG 或 JPEG 再试。'
  if (text.includes('too large') || text.includes('bytes')) return '图片太大了，换一张小一点的。'
  if (text.includes('no such session') || text.includes('session-not-found')) return '这个会话在电脑上已经没有了。'
  if (text.includes('the link stopped answering') || text.includes('closed')) {
    return '连接已经断了。请返回上一页重新连接。'
  }
  // 认不出来的错误原样给出，但去掉 `Error: ` 前缀 —— 界面上那一行不是栈。
  return text.startsWith('Error: ') ? text.substring(7) : text
}
