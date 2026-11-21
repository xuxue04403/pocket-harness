// Turning a camera frame into a grayscale picture.
//
// Two things make this more than a memcpy. First, camera buffers are YUV, and a
// QR code only needs the luma plane — the chroma planes carry nothing for a
// black-and-white symbol. Second, the luma plane is *strided*: the buffer's row
// length is `rowStride`, which is usually larger than the image width, because
// the hardware aligns each row. Reading it as if it were tightly packed shears
// the picture, which looks like a code that will not decode.

/** 8-bit grayscale pixels, `width * height` bytes, 0 = black. */
export interface GrayImage {
  readonly width: number
  readonly height: number
  readonly pixels: Uint8Array
}

/** One YUV frame as the camera hands it over. */
export interface LumaFrame {
  /** The luma plane, `rowStride * height` bytes (may be the whole YUV buffer). */
  readonly luma: ArrayBuffer;
  readonly width: number;
  readonly height: number;
  /** Bytes per row in `luma`; **not** the width. */
  readonly rowStride: number;
  /** Bytes per pixel in `luma`; 1 or 2 depending on the frame format. */
  readonly pixelStride: number;
}

/**
 * Copy a strided luma plane into a tightly packed grayscale image.
 *
 * `pixelStride` of 2 shows up on devices that interleave luma with something
 * else; taking every other byte is the correct read there, and treating it as 1
 * would halve the picture's width and decode nothing.
 */
export function grayFromLuma(frame: LumaFrame): { width: number; height: number; pixels: Uint8Array } {
  const { width, height, rowStride, pixelStride } = frame
  if (width <= 0 || height <= 0) throw new Error('the frame has no area')
  if (pixelStride <= 0) throw new Error('the frame has no pixel stride')
  const source = new Uint8Array(frame.luma)
  const needed = rowStride * (height - 1) + width * pixelStride
  if (source.length < needed) {
    throw new Error(`the luma plane is ${source.length} bytes but a ${width}x${height} frame needs ${needed}`)
  }
  if (pixelStride === 1 && rowStride === width) {
    // The common case: already packed, so hand back a copy of exactly the pixels.
    return { width: width, height: height, pixels: source.slice(0, width * height) }
  }
  const pixels = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * rowStride
    const out = y * width
    for (let x = 0; x < width; x += 1) pixels[out + x] = source[row + x * pixelStride]
  }
  return { width: width, height: height, pixels: pixels }
}

/**
 * Shrink a grayscale picture by an integer factor, averaging each block.
 *
 * Why bother: locating a symbol scans every pixel, and a 1080p frame is two
 * million of them. Halving twice cuts the scan to an eighth and a QR code's
 * modules stay several pixels wide, so nothing is lost. Averaging rather than
 * picking one pixel matters — point sampling on a fine module grid is exactly
 * how a code turns into moiré.
 */
export function shrinkGray(image: { width: number; height: number; pixels: Uint8Array }, factor: number): { width: number; height: number; pixels: Uint8Array } {
  if (factor <= 1) return image
  const width = Math.floor(image.width / factor)
  const height = Math.floor(image.height / factor)
  // Whether the result is still big enough to hold a symbol is the caller's
  // question, not this function's: refusing to shrink here would silently hand
  // back a picture the caller believes it has already shrunk.
  if (width < 1 || height < 1) return image
  const pixels = new Uint8Array(width * height)
  const area = factor * factor
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0
      for (let dy = 0; dy < factor; dy += 1) {
        const row = (y * factor + dy) * image.width + x * factor
        for (let dx = 0; dx < factor; dx += 1) sum += image.pixels[row + dx]
      }
      pixels[y * width + x] = Math.round(sum / area)
    }
  }
  return { width: width, height: height, pixels: pixels }
}
