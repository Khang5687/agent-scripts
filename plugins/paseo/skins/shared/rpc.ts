import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const SKIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_PAGE_SIZE = 24;

const skinId = z.string().regex(SKIN_ID_PATTERN);
const unit = z.number().min(0).max(1);

export const AppearanceSchema = z.enum(["light", "dark"]);
export type Appearance = z.infer<typeof AppearanceSchema>;

export const CatalogEntrySchema = z.object({
  id: skinId,
  name: z.string(),
  author: z.string(),
  license: z.string(),
  licenseUrl: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  appearance: AppearanceSchema.nullable(),
  installed: z.boolean(),
  popularRank: z.number().nullable(),
  imageBytes: z.number().nullable(),
});
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

export const ImageSchema = z.object({
  base64: z.string(),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
});

export const InstalledSkinSchema = z.object({
  id: skinId,
  name: z.string(),
  /** First 12 hex digits of the image SHA-256. Changes whenever the image does. */
  version: z.string(),
  sha256: z.string(),
  appearance: AppearanceSchema,
  focal: z.object({ x: unit, y: unit }),
  intensity: z.object({ home: unit, workspace: unit, utility: unit }),
  /** Null when the image format cannot be decoded on the daemon (WebP); the app then assumes black and white. */
  luminance: z.object({ low: unit, high: unit }).nullable(),
  author: z.string(),
  license: z.string(),
  licenseUrl: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  bytes: z.number(),
  width: z.number(),
  height: z.number(),
  installedAt: z.string(),
});
export type InstalledSkin = z.infer<typeof InstalledSkinSchema>;

export const listCatalog = defineRpc({
  name: "skins.catalog_list",
  input: z.object({
    query: z.string().max(100).optional(),
    appearance: AppearanceSchema.optional(),
    licenseFilter: z.enum(["permissive", "all"]),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE),
  }),
  output: z.object({
    entries: z.array(CatalogEntrySchema),
    total: z.number(),
    page: z.number(),
    pageCount: z.number(),
    /** Epoch milliseconds when the catalog was last fetched from the network. */
    fetchedAt: z.number(),
    stale: z.boolean(),
  }),
});

export const catalogThumbnail = defineRpc({
  name: "skins.catalog_thumbnail",
  input: z.object({ id: skinId }),
  output: ImageSchema,
});

export const installSkin = defineRpc({
  name: "skins.install",
  input: z.object({ id: skinId }),
  output: InstalledSkinSchema,
});

export const listSkins = defineRpc({
  name: "skins.list",
  input: z.object({}),
  output: z.object({ skins: z.array(InstalledSkinSchema) }),
});

export const skinImage = defineRpc({
  name: "skins.image",
  input: z.object({ id: skinId }),
  output: ImageSchema,
});

export const removeSkin = defineRpc({
  name: "skins.remove",
  input: z.object({ id: skinId }),
  output: z.object({ removed: z.boolean() }),
});

/** Plugin skin ids must start with a letter; catalog ids may start with a digit. */
export function contributionId(catalogId: string): string {
  return `catalog-${catalogId}`;
}
