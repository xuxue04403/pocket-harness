/**
 * 从一段任意文本里挑出配对码，并说清它属于哪台电脑。
 *
 * 鸿蒙 SDK 里没有条码扫描接口（`@ohos.scan` 是打印扫描仪，`MetadataObjectType` 只是
 * 相机元数据里的检测类型，不给条码内容），所以配对入口只能靠「粘贴」。而粘贴这件事
 * 比想象中脏：从电脑日志里复制通常是整行
 *
 *     2026-11-22T04:00:00 INFO pocket-harness pocket-harness: pairing code pocketharness://pair?t=...
 *
 * 用户也可能复制了带引号或行尾标点的句子。所以这里的职责是：在文本里找出第一个像
 * 配对码的子串，交给 `decodeTicket` 判真伪，再把结果翻成一句人能核对的话。
 */

import { decodeTicket, isTicketValid, type PairingTicket } from './pairing'

/** 配对码的固定前缀。与 `pairing.ts` 里的 `PAIRING_SCHEME` 必须一致。 */
export const TICKET_PREFIX = 'pocketharness://pair?t='

/**
 * base64url 的字符集。配对码的载荷里只有这些字符，所以「下一个不是它的字符」就是
 * 配对码的结尾 —— 这比用正则去匹配整条 URL 更稳，也不会吃掉行尾的标点。
 */
function isTicketChar(code: number): boolean {
  const isDigit = code >= 48 && code <= 57
  const isUpper = code >= 65 && code <= 90
  const isLower = code >= 97 && code <= 122
  return isDigit || isUpper || isLower || code === 45 || code === 95
}

/**
 * 从任意文本里取出第一个配对码（已 trim 的完整字符串）。
 *
 * 找不到返回 null。**这里不做真伪校验**：调用方拿到的可能是伪造的码，`decodeTicket`
 * 才是判据。分开的理由是「找没找到」与「是不是有效的」是两种错误，界面上的说法完全不同。
 */
export function findTicket(text: string): string | null {
  if (typeof text !== 'string') return null
  const start = text.indexOf(TICKET_PREFIX)
  if (start < 0) return null
  let end = start + TICKET_PREFIX.length
  while (end < text.length && isTicketChar(text.charCodeAt(end))) end += 1
  const payload = text.slice(start + TICKET_PREFIX.length, end)
  // 空载荷不是配对码，是用户把前缀本身复制了过来。
  if (payload.length === 0) return null
  return text.slice(start, end)
}

/** 一段文本能不能直接当配对码用。界面用它决定「粘贴」按钮是否可点。 */
export function looksLikeTicket(text: string): boolean {
  return findTicket(text) !== null
}

/**
 * 把配对码读成票子；读不出来就给一句能照做的中文。
 *
 * 三种失败分开说：前缀不对（复制错了东西）、载荷解不开（复制时截断了）、
 * 版本或公钥不对（码是别的东西或者是被改过的）。
 */
export function readTicketText(text: string): { ticket: PairingTicket | null; problem: string } {
  const found = findTicket(text)
  if (found === null) {
    return { ticket: null, problem: '没在这段文字里找到配对码。配对码以 pocketharness://pair?t= 开头。' }
  }
  try {
    return { ticket: decodeTicket(found), problem: '' }
  } catch (error) {
    const code = (error as Error).message
    if (code.includes('not readable')) {
      return { ticket: null, problem: '配对码只复制到一半。请回到电脑日志里整行复制。' }
    }
    if (code.includes('public key') || code.includes('version')) {
      return { ticket: null, problem: '这不是这台电脑的配对码，或者它被改动过。' }
    }
    return { ticket: null, problem: `这个配对码读不出来：${code}` }
  }
}

/**
 * 配对码的一句话摘要，用来在真正连接前让用户核对「是不是这台电脑」。
 *
 * 带上过期时间：配对码 10 分钟就换一次，最常踩的坑正是拿昨天的码去扫。
 */
export function describeTicket(ticket: PairingTicket, now: number): string {
  const where = ticket.lanEndpoints.length > 0
    ? ticket.lanEndpoints.join('、')
    : (ticket.relayUrl !== null ? '经中继' : '没有可用地址')
  const expiry = ticket.expiresAt > 0 && !isTicketValid(ticket, now)
    ? '配对码已过期，但已配对的手机仍能连'
    : '配对码现在有效'
  return `${ticket.hostName} · ${where} · ${expiry}`
}

/**
 * 配对码还剩多久（毫秒）。永不过期的码返回 -1，界面据此不显示倒计时。
 */
export function ticketRemainingMs(ticket: PairingTicket, now: number): number {
  if (ticket.expiresAt <= 0) return -1
  return Math.max(0, ticket.expiresAt - now)
}

/** 剩余时间的口语说法。 */
export function remainingLabel(remainingMs: number): string {
  if (remainingMs < 0) return '不过期'
  if (remainingMs === 0) return '已过期'
  const minutes = Math.floor(remainingMs / 60000)
  if (minutes >= 1) return `还剩 ${minutes} 分钟`
  const seconds = Math.max(1, Math.floor(remainingMs / 1000))
  return `还剩 ${seconds} 秒`
}
