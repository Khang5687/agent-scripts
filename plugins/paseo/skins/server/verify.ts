import { createHash } from "node:crypto";
import { type ImageInfo, readImageInfo } from "./image-info";
import { MAX_IMAGE_BYTES, MAX_PIXELS, MAX_SIDE, type ThemeManifest } from "./manifest";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Throws unless the downloaded bytes are exactly the image the manifest promised. */
export function verifyImage(bytes: Uint8Array, integrity: ThemeManifest["integrity"]): ImageInfo {
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Image is larger than 16 MiB");
  if (bytes.byteLength !== integrity.bytes) {
    throw new Error(`Image is ${bytes.byteLength} bytes, manifest says ${integrity.bytes}`);
  }
  if (sha256Hex(bytes) !== integrity.sha256) throw new Error("Image checksum does not match the manifest");
  const info = readImageInfo(bytes);
  if (!info) throw new Error("Image is not a valid PNG, JPEG, or WebP");
  if (info.width !== integrity.width || info.height !== integrity.height) {
    throw new Error(
      `Image is ${info.width}×${info.height}, manifest says ${integrity.width}×${integrity.height}`,
    );
  }
  if (info.width > MAX_SIDE || info.height > MAX_SIDE || info.width * info.height > MAX_PIXELS) {
    throw new Error("Image is too large (limit 16384 px per side, 50 megapixels)");
  }
  return info;
}
