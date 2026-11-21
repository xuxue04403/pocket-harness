/**
 * 历史消息里的图片：只认「引用」，字节要另外取。
 *
 * 三个来自实测的形状，全部由 Dart 侧的探针确认过：
 * - 事件里的图片块是 `{type:'image', attachment:{...}}`，**不含字节**；把字节塞进
 *   会话事件会让每一条历史记录都变重，所以 Host 只在附件表里存着；
 * - 取字节走 `session/attachment`，参数是 `{request:{sessionId, attachment}}`，
 *   把整个引用原样回传即可（Host 按 `attachmentId` 找）；
 * - 回来的 `data` 是**标准 base64**（`+/`，带 `=`），不是配对码用的 base64url。
 *
 * 手机上不预取：一条历史里有几张图就发几次往返，而大多数时候用户并不看那些
 * 图。所以这里只解析引用，取字节由界面按需触发。
 */

import { arrayField, numberField, objectField, stringField, type JsonObject } from './json'

/** 一张图片引用。`bytes`/`width`/`height` 缺省为 0 —— 不是所有 Host 都给。 */
export interface ImageRef {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name: string
}

/**
 * 读一个引用。
 *
 * 没有 `attachmentId` 就返回 null：那个字段是取字节的唯一钥匙，缺了它这块就只能
 * 显示成一句「一张图片」，留着反而是个点了没反应的空盒子。
 */
export function readImageRef(value: Object): ImageRef | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const map = value as JsonObject
  const attachmentId = stringField(map, 'attachmentId', '')
  if (attachmentId.length === 0) return null
  return {
    attachmentId,
    mediaType: stringField(map, 'mediaType', ''),
    bytes: numberField(map, 'bytes', 0),
    width: numberField(map, 'width', 0),
    height: numberField(map, 'height', 0),
    name: stringField(map, 'name', ''),
  }
}

/** 从内容块数组里取出所有图片引用（跳过读不出来的）。 */
export function imageRefsOf(content: Object): ImageRef[] {
  if (!Array.isArray(content)) return []
  const refs: ImageRef[] = []
  for (const block of content as Object[]) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
    const map = block as JsonObject
    if (stringField(map, 'type', '') !== 'image') continue
    const ref = readImageRef(map['attachment'] ?? null)
    if (ref !== null) refs.push(ref)
  }
  return refs
}

/**
 * `session/attachment` 的请求体。
 *
 * 引用要**原样**送回去：Host 只按 `attachmentId` 查，但重排键名或漏掉
 * `mediaType` 会在边界校验里被判成「不是有效的图片引用」。
 */
export function attachmentRequest(sessionId: string, ref: ImageRef): JsonObject {
  const attachment: JsonObject = {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
  }
  return { request: { sessionId, attachment } }
}

/** 从 `session/attachment` 的回答里取 base64（没有就是空串）。 */
export function attachmentData(answer: JsonObject): string {
  return stringField(answer, 'data', '')
}

/** 一张图一行摘要，用来在没有缩略图时给个交代。 */
export function imageSummary(ref: ImageRef): string {
  const name = ref.name
  if (name.length > 0) return name
  if (ref.bytes > 0) {
    if (ref.bytes >= 1024 * 1024) return `${(ref.bytes / (1024 * 1024)).toFixed(1)} MB`
    if (ref.bytes >= 1024) return `${Math.round(ref.bytes / 1024)} KB`
    return `${ref.bytes} B`
  }
  return '一张图片'
}

/** 内容块里有没有图片（与 `transcript.countImages` 同一口径，只是返回引用）。 */
export function hasImages(content: Object): boolean {
  return imageRefsOf(content).length > 0
}

/** 摄取事件里的 `records` 之外，`user/message` 的 content 也可能来自这里。 */
export function contentOfMessage(message: JsonObject | undefined): Object {
  if (message === undefined) return []
  return arrayField(message, 'content')
}

/** 便利：从一条 `user/message` 或 `assistant/message` 的 data 取图片引用。 */
export function imageRefsOfData(data: JsonObject): ImageRef[] {
  const message = objectField(data, 'message')
  const content = message === undefined ? data['content'] : message['content']
  return imageRefsOf(content ?? [])
}
