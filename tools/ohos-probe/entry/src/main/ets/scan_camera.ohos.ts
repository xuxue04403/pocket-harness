// 用系统相机拍一张，再从照片里解出配对码。
//
// 为什么走「拍一张」而不是自己拉预览流：相机实时取帧需要 XComponent + 预览输出 +
// ImageReceiver 三样一起配，而它们没有一样能在没有真机的情况下验证。系统相机的
// `cameraPicker.pick` 是官方给的「App 申请拍照」入口，返回一个文件 URI，之后就是
// 纯粹的图片解码 —— 这条路上的每一步都能在电脑上先测。

import { camera, cameraPicker } from '@kit.CameraKit'
import { image } from '@kit.ImageKit'
import { fileIo } from '@kit.CoreFileKit'

import { decodeMatrix } from './core/qr/decode'
import { grayFromRgba, shrinkGray } from './core/qr/frame'
import { matrixFromFrame } from './core/qr/scan'
import { findTicket, readTicketText } from './core/pairing_text'

/** 拍照并解码的结果。 */
export interface ScanOutcome {
  /** 解出来的配对码文本；没解出时为空串。 */
  readonly ticketText: string;
  /** 给用户看的一句话。 */
  readonly message: string;
  /** 是否成功。 */
  readonly ok: boolean;
}

/** 相机没拍到东西时用户看到的话。 */
const CANCELLED = '没有拍照，已取消。'

/**
 * 调系统相机拍一张，然后从照片里找配对码。
 *
 * 失败都是「说清楚为什么」而不是抛异常：扫码失败是最常见的路径（手抖、没对准、
 * 光线不对），界面上要能直接显示原因，而不是一个空白的错误框。
 */
export async function scanTicketWithCamera(context: Context): Promise<ScanOutcome> {
  let uri = ''
  try {
    const result = await cameraPicker.pick(context, [cameraPicker.PickerMediaType.PHOTO], {
      cameraPosition: camera.CameraPosition.CAMERA_POSITION_BACK,
    })
    uri = result.resultUri
  } catch (error) {
    return { ticketText: '', message: '打不开相机：' + describe(error), ok: false }
  }
  if (uri.length === 0) {
    return { ticketText: '', message: CANCELLED, ok: false }
  }

  let pixels: ArrayBuffer
  let width = 0
  let height = 0
  let rowStride = 0
  let source: image.ImageSource | null = null
  let pixelMap: image.PixelMap | null = null
  try {
    // 先读文件再解码，比让解码器自己打开 URI 稳定：相机返回的 URI 有时是
    // 「公共媒体路径」，直接打开需要额外权限。
    const file = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY)
    try {
      const size = fileIo.statSync(file.fd).size
      const buffer = new ArrayBuffer(size)
      fileIo.readSync(file.fd, buffer)
      source = image.createImageSource(buffer)
    } finally {
      fileIo.closeSync(file)
    }
    // 只要求 RGBA_8888：解码成别的格式（比如 YUV）还要自己处理平面布局，
    // 而拍照只发生一次，解成 RGBA 的代价可以接受。
    pixelMap = await source.createPixelMap({ desiredPixelFormat: image.PixelMapFormat.RGBA_8888 })
    const info = await pixelMap.getImageInfo()
    width = info.size.width
    height = info.size.height
    rowStride = info.stride > 0 ? info.stride : width
    pixels = new ArrayBuffer(rowStride * height * 4)
    await pixelMap.readPixelsToBuffer(pixels)
  } catch (error) {
    return { ticketText: '', message: '读不出这张照片：' + describe(error), ok: false }
  } finally {
    if (pixelMap !== null) await pixelMap.release()
    if (source !== null) await source.release()
  }

  try {
    const gray = grayFromRgba(new Uint8Array(pixels), width, height, rowStride)
    // 手机照片动辄四千万像素，全分辨率找定位图案太贵。先降一半扫一次，
    // 扫不到再回全分辨率 —— 二维码在照片里通常只占一小块，降采样反而更容易
    // 让定位图案的行程比例稳定。
    const attempts: string[] = []
    let matrix: boolean[][] | null = null
    const half = shrinkGray(gray, 2)
    try {
      matrix = matrixFromFrame(half)
    } catch (error) {
      attempts.push('半分辨率：' + describe(error))
    }
    if (matrix === null) {
      try {
        matrix = matrixFromFrame(gray)
      } catch (error) {
        attempts.push('原分辨率：' + describe(error))
      }
    }
    if (matrix === null) {
      return { ticketText: '', message: '这张照片里没找到二维码。' + attempts.join('；'), ok: false }
    }
    const decoded = decodeMatrix(matrix)
    // 照片里可能拍到别的二维码（商品码、海报），所以这里还要确认它长得像配对码。
    const found = findTicket(decoded.text)
    if (found === null) {
      return { ticketText: '', message: '二维码解出来了，但不是配对码：' + decoded.text.slice(0, 40), ok: false }
    }
    const read = readTicketText(found)
    if (read.ticket === null) {
      return { ticketText: '', message: read.problem, ok: false }
    }
    return { ticketText: found, message: '扫到了配对码。', ok: true }
  } catch (error) {
    return { ticketText: '', message: '解这张照片时出错：' + describe(error), ok: false }
  }
}

/** 把错误说成一句人话。 */
function describe(error: Object): string {
  if (error instanceof Error) return error.message
  return '' + error
}
