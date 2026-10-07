import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { coverRect, decodeImage, encodeJpeg, resampleRect } from "./decode";
import { writeFileAtomic } from "./fs-atomic";
import { readImageInfo } from "./image-info";
import { MAX_PIXELS } from "./manifest";

export const THUMB_WIDTH = 512;
export const THUMB_HEIGHT = 288;
export const WEBP_PASSTHROUGH_LIMIT = 1.5 * 1024 * 1024;
export const THUMBNAIL_UNAVAILABLE = "Preview unavailable";
const JPEG_QUALITY = 80;

export interface ThumbnailImage {
  base64: string;
  mimeType: "image/jpeg" | "image/webp";
}

/** A ≤512×288 cover crop around the focal point. WebP cannot be decoded here and passes through when small. */
export function makeThumbnail(original: Uint8Array, focal: { x: number; y: number }): ThumbnailImage {
  const info = readImageInfo(original);
  if (!info) throw new Error(THUMBNAIL_UNAVAILABLE);
  if (info.mimeType === "image/webp") {
    if (original.byteLength > WEBP_PASSTHROUGH_LIMIT) throw new Error(THUMBNAIL_UNAVAILABLE);
    return { base64: Buffer.from(original).toString("base64"), mimeType: "image/webp" };
  }
  if (info.width * info.height > MAX_PIXELS) throw new Error(THUMBNAIL_UNAVAILABLE);
  const pixels = decodeImage(original, info.mimeType);
  if (!pixels) throw new Error(THUMBNAIL_UNAVAILABLE);
  const rect = coverRect(pixels.width, pixels.height, THUMB_WIDTH / THUMB_HEIGHT, focal);
  const scale = Math.min(1, THUMB_WIDTH / rect.width);
  const resized = resampleRect(
    pixels,
    rect,
    Math.max(1, Math.round(rect.width * scale)),
    Math.max(1, Math.round(rect.height * scale)),
  );
  return { base64: encodeJpeg(resized, JPEG_QUALITY).toString("base64"), mimeType: "image/jpeg" };
}

/** Runs at most `limit` jobs at once; the rest wait in arrival order. */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<Result>(job: () => Promise<Result>): Promise<Result> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active += 1;
    try {
      return await job();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

function cacheName(key: string, mimeType: ThumbnailImage["mimeType"]): string {
  return `${key.replace(/[^a-z0-9.-]/gi, "_")}.${mimeType === "image/jpeg" ? "jpg" : "webp"}`;
}

/** Thumbnails on disk, keyed by catalog id, entry version and original size. */
export class ThumbnailCache {
  constructor(private readonly dataDir: string) {}

  async read(key: string): Promise<ThumbnailImage | null> {
    for (const mimeType of ["image/jpeg", "image/webp"] as const) {
      try {
        const bytes = await readFile(join(this.dataDir, "thumbs", cacheName(key, mimeType)));
        return { base64: bytes.toString("base64"), mimeType };
      } catch {
        // Not cached under this type.
      }
    }
    return null;
  }

  async write(key: string, image: ThumbnailImage): Promise<void> {
    await writeFileAtomic(
      join(this.dataDir, "thumbs", cacheName(key, image.mimeType)),
      Buffer.from(image.base64, "base64"),
    );
  }
}
