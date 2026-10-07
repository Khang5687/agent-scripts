import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { MAX_PAGE_SIZE, type CatalogEntry } from "../shared/rpc";
import { writeFileAtomic } from "./fs-atomic";
import { fetchBytes, requireHttps } from "./http";
import { isPermissiveLicense } from "../shared/license";

export const CATALOG_URL = "https://huangguang1999.github.io/paseo-skins/catalog.json";
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
export const MAX_CATALOG_BYTES = 1024 * 1024;

const RawEntrySchema = z.looseObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  name: z.string().optional(),
  englishName: z.string().optional(),
  author: z.string().optional(),
  license: z.string().optional(),
  licenseUrl: z.string().optional(),
  sourceUrl: z.string().optional(),
  tags: z.array(z.string()).optional(),
  preview: z.string().optional(),
  manifest: z.string(),
  version: z.string().optional(),
  imageBytes: z.number().optional(),
  popularRank: z.number().optional(),
});
const RawCatalogSchema = z.looseObject({ themes: z.array(z.unknown()) });

export interface CatalogSource {
  id: string;
  name: string;
  originalName: string;
  author: string;
  license: string;
  licenseUrl: string | null;
  sourceUrl: string | null;
  appearance: "light" | "dark" | null;
  tags: string[];
  manifestUrl: URL;
  /** File extension of the preview image, lowercase, without the dot. */
  previewExtension: string | null;
  version: string;
  imageBytes: number | null;
  popularRank: number | null;
}

function httpUrlOrNull(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function appearanceFromTags(tags: readonly string[]): "light" | "dark" | null {
  if (tags.includes("深色")) return "dark";
  if (tags.includes("浅色")) return "light";
  return null;
}

/** Manifest and image must live under the catalog's own origin and directory. */
export function resolveCatalogUrl(relative: string, catalogUrl: URL = new URL(CATALOG_URL)): URL {
  const url = requireHttps(new URL(relative, catalogUrl));
  const base = new URL("./", catalogUrl);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
    throw new Error(`Catalog entry points outside the catalog directory: ${relative}`);
  }
  return url;
}

export function parseCatalog(bytes: Uint8Array, catalogUrl: URL = new URL(CATALOG_URL)): CatalogSource[] {
  const root = RawCatalogSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  const sources: CatalogSource[] = [];
  for (const candidate of root.themes) {
    const entry = RawEntrySchema.safeParse(candidate);
    if (!entry.success) continue;
    const raw = entry.data;
    let manifestUrl: URL;
    try {
      manifestUrl = resolveCatalogUrl(raw.manifest, catalogUrl);
    } catch {
      continue;
    }
    const tags = raw.tags ?? [];
    const name = (raw.englishName ?? raw.name ?? raw.id).trim() || raw.id;
    sources.push({
      id: raw.id,
      name,
      originalName: raw.name?.trim() ?? name,
      author: raw.author?.trim() ?? "Unknown",
      license: raw.license?.trim() ?? "",
      licenseUrl: httpUrlOrNull(raw.licenseUrl),
      sourceUrl: httpUrlOrNull(raw.sourceUrl),
      appearance: appearanceFromTags(tags),
      tags,
      manifestUrl,
      previewExtension: raw.preview?.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? null,
      version: raw.version ?? "0",
      imageBytes: raw.imageBytes ?? null,
      popularRank: raw.popularRank ?? null,
    });
  }
  return sources;
}

export interface CatalogQuery {
  query?: string;
  appearance?: "light" | "dark";
  licenseFilter: "permissive" | "all";
  page: number;
  pageSize: number;
}

export function filterCatalog(sources: readonly CatalogSource[], query: CatalogQuery): CatalogSource[] {
  const needle = query.query?.trim().toLowerCase();
  return sources
    .filter((source) => query.licenseFilter === "all" || isPermissiveLicense(source.license))
    .filter((source) => !query.appearance || source.appearance === query.appearance)
    .filter(
      (source) =>
        !needle ||
        [source.id, source.name, source.originalName, source.author, ...source.tags].some((field) =>
          field.toLowerCase().includes(needle),
        ),
    )
    .sort(
      (left, right) =>
        (left.popularRank ?? Number.MAX_SAFE_INTEGER) - (right.popularRank ?? Number.MAX_SAFE_INTEGER) ||
        left.name.localeCompare(right.name),
    );
}

export function paginate<Item>(items: readonly Item[], page: number, pageSize: number) {
  const size = Math.min(pageSize, MAX_PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(1, page), pageCount);
  return { items: items.slice((current - 1) * size, current * size), page: current, pageCount };
}

export function toCatalogEntry(source: CatalogSource, installed: ReadonlySet<string>): CatalogEntry {
  return {
    id: source.id,
    name: source.name,
    author: source.author,
    license: source.license,
    licenseUrl: source.licenseUrl,
    sourceUrl: source.sourceUrl,
    appearance: source.appearance,
    installed: installed.has(source.id),
    popularRank: source.popularRank,
    imageBytes: source.imageBytes,
  };
}

interface LoadedCatalog {
  sources: CatalogSource[];
  fetchedAt: number;
  stale: boolean;
}

/** catalog.json held in memory and on disk for six hours; a stale copy still serves when offline. */
export class CatalogStore {
  private memory: { sources: CatalogSource[]; fetchedAt: number } | null = null;
  private inflight: Promise<LoadedCatalog> | null = null;
  /** After a failed refresh, keep serving the stale copy for a minute instead of retrying every call. */
  private retryAfter = 0;

  constructor(
    private readonly dataDir: string,
    private readonly now: () => number = Date.now,
    private readonly fetchCatalog: (url: URL, maxBytes: number) => Promise<Uint8Array> = fetchBytes,
  ) {}

  private get diskPath(): string {
    return join(this.dataDir, "catalog.json");
  }

  private async readDisk(): Promise<{ sources: CatalogSource[]; fetchedAt: number } | null> {
    try {
      const wrapper = z
        .object({ fetchedAt: z.number(), body: z.string() })
        .parse(JSON.parse(await readFile(this.diskPath, "utf8")));
      const sources = parseCatalog(new TextEncoder().encode(wrapper.body));
      return { sources, fetchedAt: wrapper.fetchedAt };
    } catch {
      return null;
    }
  }

  async load(): Promise<LoadedCatalog> {
    if (this.memory && this.now() - this.memory.fetchedAt < CATALOG_TTL_MS) {
      return { ...this.memory, stale: false };
    }
    if (this.memory && this.now() < this.retryAfter) return { ...this.memory, stale: true };
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async refresh(): Promise<LoadedCatalog> {
    const disk = this.memory ? null : await this.readDisk();
    if (disk && this.now() - disk.fetchedAt < CATALOG_TTL_MS) {
      this.memory = disk;
      return { ...disk, stale: false };
    }
    try {
      const bytes = await this.fetchCatalog(new URL(CATALOG_URL), MAX_CATALOG_BYTES);
      const sources = parseCatalog(bytes);
      const fetchedAt = this.now();
      this.memory = { sources, fetchedAt };
      await writeFileAtomic(
        this.diskPath,
        JSON.stringify({ fetchedAt, body: new TextDecoder().decode(bytes) }),
      ).catch((error: unknown) => console.warn(`could not cache catalog: ${String(error)}`));
      return { sources, fetchedAt, stale: false };
    } catch (error) {
      const fallback = this.memory ?? disk;
      if (!fallback) throw new Error(`Could not load the skin catalog: ${String(error instanceof Error ? error.message : error)}`);
      this.memory = fallback;
      this.retryAfter = this.now() + 60_000;
      return { ...fallback, stale: true };
    }
  }

  async find(id: string): Promise<CatalogSource> {
    const { sources } = await this.load();
    const source = sources.find((candidate) => candidate.id === id);
    if (!source) throw new Error(`Skin ${id} is not in the catalog`);
    return source;
  }
}
