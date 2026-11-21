/**
 * 从系统相册选一张图，读成字节交给协议核心。
 *
 * 为什么要单独一个文件：`@ohos.file.photoAccessHelper` 与 `@ohos.file.fs` 都是鸿蒙
 * 专属 API，`packages/dsh_arkts/src` 里的代码要能在 Node 下跑金标测试，所以这段
 * 桥接只能放在探针工程里（和 `platform.ohos.ts` 同一个理由）。
 *
 * 两条鸿蒙口径：
 * - 相册回来的是 `file://media/...` 这样的 **uri**，不是普通路径；`fileIo.openSync`
 *   能直接吃这个 uri，但不要自己拼绝对路径。
 * - uri 末尾常常带 `?networkid=...` 之类的查询串，按扩展名判类型时要把查询串切掉，
 *   否则 `.jpg?networkid=1` 认不出是 jpeg。
 */

import photoAccessHelper from '@ohos.file.photoAccessHelper'
import { fileIo } from '@kit.CoreFileKit'
import { image } from '@kit.ImageKit'
import { decodeBase64 } from './core/bytes'
import { mediaTypeFor, outgoingImage, type OutgoingImage } from './core/composer'

/** 单张图片的上限：Host 侧的图片限制比这更严，先在手机上拦住明显过大的。 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** 选图的结果：要么给出一张图，要么给一句能显示的话，要么用户取消了。 */
export interface PickedImage {
  readonly image: OutgoingImage | null
  /** 用户取消时为空串 —— 取消不是错误，不该弹提示。 */
  readonly problem: string
  readonly cancelled: boolean
}

function fileSizeOf(uri: string): number {
  try {
    const stat = fileIo.statSync(uri)
    return stat.size
  } catch {
    // 拿不到大小就不拦：读的时候还有一次上限检查。
    return 0
  }
}

/** 把 `file://media/...` 整个读成字节。 */
export function readUriBytes(uri: string): Uint8Array {
  const size = fileSizeOf(uri)
  if (size > MAX_IMAGE_BYTES) {
    throw new Error(`这张图片有 ${Math.round(size / 1024 / 1024)} MB，太大了`)
  }
  const file = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY)
  try {
    // 大小未知时先按上限开缓冲，读回来再用实际长度截断。
    const capacity = size > 0 ? size : MAX_IMAGE_BYTES
    const buffer = new ArrayBuffer(capacity)
    const read = fileIo.readSync(file.fd, buffer)
    if (read <= 0) throw new Error('这张图片是空的')
    if (read > MAX_IMAGE_BYTES) throw new Error('这张图片太大了')
    return new Uint8Array(buffer.slice(0, read))
  } finally {
    fileIo.closeSync(file)
  }
}

/** 弹系统相册选一张图；返回可发的内容块原料。 */
export async function pickOneImage(): Promise<PickedImage> {
  const options = new photoAccessHelper.PhotoSelectOptions()
  options.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE
  options.maxSelectNumber = 1
  const picker = new photoAccessHelper.PhotoViewPicker()

  let result: photoAccessHelper.PhotoSelectResult
  try {
    result = await picker.select(options)
  } catch (error) {
    return { image: null, problem: `打不开相册：${error}`, cancelled: false }
  }
  if (result.photoUris.length === 0) {
    return { image: null, problem: '', cancelled: true }
  }

  const uri = result.photoUris[0]
  if (mediaTypeFor(uri).length === 0) {
    return { image: null, problem: '只支持 PNG、JPEG、WebP、GIF 图片。', cancelled: false }
  }
  try {
    const bytes = readUriBytes(uri)
    const slash = uri.lastIndexOf('/')
    const name = slash >= 0 ? uri.substring(slash + 1) : uri
    return { image: outgoingImage(bytes, name), problem: '', cancelled: false }
  } catch (error) {
    return { image: null, problem: `这张图片读不出来：${error}`, cancelled: false }
  }
}

/**
 * 把一个 PixelMap 压成 PNG 字节，方便界面按需取图后显示。
 *
 * 为什么要有这一步：ArkUI 的 `Image` 能吃 `PixelMap`，但**每次都要重新解码**。
 * 会话滚回去再看一遍时，一张 4000×3000 的照片会卡住主线程。所以取回来的 base64
 * 先解成 PixelMap 缓存住，只在这一张真的出现在屏幕上时才做。
 *
 * 两条鸿蒙口径：
 * - `image.createImageSource(buf)` 吃 `ArrayBuffer`，`Uint8Array.buffer` 可能是
 *   更大的底层缓冲区，必须先 `slice` 出真正的那一段，否则会把别的数据一起喂进去；
 * - `PixelMap` 用完要 `release()`，否则一张一张累积起来会 OOM。
 */
export async function pixelMapOfBase64(data: string): Promise<image.PixelMap> {
  const bytes = decodeBase64(data)
  const source = image.createImageSource(bytes.buffer.slice(
    bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  try {
    return await source.createPixelMap()
  } finally {
    source.release()
  }
}

/** 图片字节的上限之外，再拦一道解码后的尺寸：超过这个就先缩。 */
export const MAX_THUMBNAIL_EDGE = 1024

/** 生成缩略图：先解成 PixelMap，再按最长边缩到 `MAX_THUMBNAIL_EDGE`。 */
export async function thumbnailOfBase64(data: string): Promise<image.PixelMap> {
  const bytes = decodeBase64(data)
  const source = image.createImageSource(bytes.buffer.slice(
    bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  try {
    const info = await source.getImageInfo()
    const width = info.size.width
    const height = info.size.height
    const longest = width > height ? width : height
    const options: image.DecodingOptions = {}
    if (longest > MAX_THUMBNAIL_EDGE) {
      const scale = MAX_THUMBNAIL_EDGE / longest
      const size: image.Size = {
        width: Math.round(width * scale),
        height: Math.round(height * scale),
      }
      options.desiredSize = size
    }
    return await source.createPixelMap(options)
  } finally {
    source.release()
  }
}
