import { z } from "zod";

export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_SIDE = 16384;
export const MAX_PIXELS = 50_000_000;

const unit = z.number().min(0).max(1);

/** Theme v2 (https://huangguang1999.github.io/paseo-skins/schema/paseo-theme-v2.schema.json), art and integrity only. */
export const ThemeManifestSchema = z.looseObject({
  schemaVersion: z.literal(2),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  version: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  image: z
    .string()
    .max(160)
    .regex(/^[^/\\]+\.(?:png|jpe?g|webp)$/i),
  appearance: z.enum(["light", "dark"]),
  art: z.looseObject({
    focusX: unit,
    focusY: unit,
    homeOpacity: unit,
    workspaceOpacity: unit,
    utilityOpacity: unit,
  }),
  integrity: z.looseObject({
    algorithm: z.literal("sha256"),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().min(1).max(MAX_IMAGE_BYTES),
    width: z.number().int().min(1).max(MAX_SIDE),
    height: z.number().int().min(1).max(MAX_SIDE),
  }),
});
export type ThemeManifest = z.infer<typeof ThemeManifestSchema>;

export function parseManifest(bytes: Uint8Array): ThemeManifest {
  if (bytes.byteLength > MAX_MANIFEST_BYTES) throw new Error("Manifest is too large");
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Manifest is not valid JSON");
  }
  const parsed = ThemeManifestSchema.safeParse(json);
  if (!parsed.success) throw new Error(`Manifest is invalid: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  return parsed.data;
}
