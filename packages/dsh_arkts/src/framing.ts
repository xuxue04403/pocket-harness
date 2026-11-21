/**
 * TCP 上的长度前缀切帧。
 *
 * 线上口径与 Dart 的 `FramedSocket` 一致：`[uint32 大端长度][帧]`。把它单独抽出来
 * 的理由是这条逻辑两端都要用（Node 的 `test/live.ts` 与鸿蒙的 `@ohos.net.socket`），
 * 而**只有纯函数部分能在 Node 里测**——真正的 socket 只能靠 ArkTS 编译 + 设备运行。
 */

/** 一条帧的上限，与 Host 侧对齐。 */
export const MAX_FRAMED_BYTES = 4 * 1024 * 1024 + 64

/** 累加器：喂入任意切分的字节块，吐出完整的帧。 */
export class FrameSplitter {
  private buffer: Uint8Array = new Uint8Array(0)
  private broken: string | null = null

  /** 已经缓存但还没成帧的字节数。 */
  get pending(): number {
    return this.buffer.length
  }

  /** 一旦超限就永久报错：后续帧的边界已经不可信。 */
  get failure(): string | null {
    return this.broken
  }

  /**
   * 追加一段字节，返回本次凑齐的所有帧。
   *
   * 长度前缀声称超过上限时直接抛出并记住失败原因：继续解析只会产出垃圾帧。
   */
  push(chunk: Uint8Array): Uint8Array[] {
    if (this.broken !== null) throw new Error(this.broken)
    this.buffer = join(this.buffer, chunk)
    const frames: Uint8Array[] = []
    for (;;) {
      if (this.buffer.length < 4) break
      const length = readUint32BE(this.buffer, 0)
      if (length > MAX_FRAMED_BYTES) {
        this.broken = `a ${length}-byte frame exceeds the ${MAX_FRAMED_BYTES}-byte limit`
        throw new Error(this.broken)
      }
      if (this.buffer.length < 4 + length) break
      frames.push(this.buffer.subarray(4, 4 + length))
      this.buffer = this.buffer.subarray(4 + length)
    }
    return frames
  }
}

/** 给一条帧加上长度前缀。 */
export function frameWithLength(payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_FRAMED_BYTES) {
    throw new Error(`a ${payload.length}-byte frame exceeds the ${MAX_FRAMED_BYTES}-byte limit`)
  }
  const out = new Uint8Array(4 + payload.length)
  writeUint32BE(out, 0, payload.length)
  out.set(payload, 4)
  return out
}

function join(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right
  const out = new Uint8Array(left.length + right.length)
  out.set(left, 0)
  out.set(right, left.length)
  return out
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
}

function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff
  bytes[offset + 1] = (value >>> 16) & 0xff
  bytes[offset + 2] = (value >>> 8) & 0xff
  bytes[offset + 3] = value & 0xff
}
