import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import type { ImageMime } from "./image-info";
import type { Pixels } from "./luminance";

const JPEG_DECODE_MEMORY_MB = 1024;

export function decodeImage(bytes: Uint8Array, mimeType: ImageMime): Pixels | null {
  if (mimeType === "image/png") {
    const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return { width: png.width, height: png.height, data: png.data };
  }
  if (mimeType === "image/jpeg") {
    const decoded = jpeg.decode(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      maxMemoryUsageInMB: JPEG_DECODE_MEMORY_MB,
    });
    return { width: decoded.width, height: decoded.height, data: decoded.data };
  }
  // No pure-JS WebP decoder is bundled.
  return null;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Area-average resample of `rect` in `source` into a `width`×`height` image. */
export function resampleRect(source: Pixels, rect: Rect, width: number, height: number): Pixels {
  const output = new Uint8Array(width * height * 4);
  for (let dy = 0; dy < height; dy += 1) {
    const y0 = rect.y + Math.floor((dy * rect.height) / height);
    const y1 = Math.max(y0 + 1, rect.y + Math.floor(((dy + 1) * rect.height) / height));
    for (let dx = 0; dx < width; dx += 1) {
      const x0 = rect.x + Math.floor((dx * rect.width) / width);
      const x1 = Math.max(x0 + 1, rect.x + Math.floor(((dx + 1) * rect.width) / width));
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const at = (y * source.width + x) * 4;
          red += source.data[at]!;
          green += source.data[at + 1]!;
          blue += source.data[at + 2]!;
          alpha += source.data[at + 3]!;
        }
      }
      const count = (y1 - y0) * (x1 - x0);
      const out = (dy * width + dx) * 4;
      output[out] = Math.round(red / count);
      output[out + 1] = Math.round(green / count);
      output[out + 2] = Math.round(blue / count);
      output[out + 3] = Math.round(alpha / count);
    }
  }
  return { width, height, data: output };
}

/** Shrinks so the long side is at most `maxLongSide`; never enlarges. */
export function downscale(source: Pixels, maxLongSide: number): Pixels {
  const scale = Math.min(1, maxLongSide / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  return resampleRect(source, { x: 0, y: 0, width: source.width, height: source.height }, width, height);
}

/** The largest `aspect`-shaped window of the image, centered as near the focal point as fits. */
export function coverRect(
  imageWidth: number,
  imageHeight: number,
  aspect: number,
  focal: { x: number; y: number },
): Rect {
  let width = imageWidth;
  let height = Math.round(width / aspect);
  if (height > imageHeight) {
    height = imageHeight;
    width = Math.min(imageWidth, Math.round(height * aspect));
  }
  width = Math.max(1, width);
  height = Math.max(1, height);
  const x = Math.min(imageWidth - width, Math.max(0, Math.round(focal.x * imageWidth - width / 2)));
  const y = Math.min(imageHeight - height, Math.max(0, Math.round(focal.y * imageHeight - height / 2)));
  return { x, y, width, height };
}

export function encodeJpeg(pixels: Pixels, quality: number): Buffer {
  // Flatten alpha over black so transparent PNG regions do not turn into noise.
  const flat = new Uint8Array(pixels.data.length);
  for (let at = 0; at < pixels.data.length; at += 4) {
    const alpha = pixels.data[at + 3]! / 255;
    flat[at] = Math.round(pixels.data[at]! * alpha);
    flat[at + 1] = Math.round(pixels.data[at + 1]! * alpha);
    flat[at + 2] = Math.round(pixels.data[at + 2]! * alpha);
    flat[at + 3] = 255;
  }
  return jpeg.encode({ width: pixels.width, height: pixels.height, data: flat }, quality).data;
}
