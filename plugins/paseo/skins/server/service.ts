import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import {
  type InstalledSkin,
  type catalogThumbnail,
  type installSkin,
  type listCatalog,
  type removeSkin,
  type skinImage,
} from "../shared/rpc";
import { type CatalogSource, CatalogStore, filterCatalog, paginate, resolveCatalogUrl, toCatalogEntry } from "./catalog";
import { decodeImage, downscale } from "./decode";
import { fetchBytes } from "./http";
import { type Luminance, luminancePercentiles } from "./luminance";
import { MAX_IMAGE_BYTES, MAX_MANIFEST_BYTES, parseManifest } from "./manifest";
import { SkinStore } from "./store";
import { Semaphore, THUMBNAIL_UNAVAILABLE, ThumbnailCache, type ThumbnailImage, makeThumbnail } from "./thumbnail";
import { verifyImage } from "./verify";

const LUMINANCE_SAMPLE_SIDE = 128;
const THUMBNAIL_CONCURRENCY = 2;

export function measureLuminance(bytes: Uint8Array, mimeType: "image/png" | "image/jpeg" | "image/webp"): Luminance | null {
  const pixels = decodeImage(bytes, mimeType);
  if (!pixels) return null;
  return luminancePercentiles(downscale(pixels, LUMINANCE_SAMPLE_SIDE));
}

export class SkinService {
  private readonly thumbnails = new Semaphore(THUMBNAIL_CONCURRENCY);
  private readonly thumbnailJobs = new Map<string, Promise<ThumbnailImage>>();
  private readonly installJobs = new Map<string, Promise<InstalledSkin>>();
  private readonly thumbCache: ThumbnailCache;

  constructor(
    private readonly dataDir: string,
    private readonly store: SkinStore = new SkinStore(dataDir),
    private readonly catalog: CatalogStore = new CatalogStore(dataDir),
  ) {
    this.thumbCache = new ThumbnailCache(dataDir);
  }

  async listCatalog(input: RpcInput<typeof listCatalog>): Promise<RpcOutput<typeof listCatalog>> {
    const [{ sources, fetchedAt, stale }, installed] = await Promise.all([this.catalog.load(), this.store.list()]);
    const installedIds = new Set(installed.map((skin) => skin.id));
    const filtered = filterCatalog(sources, input);
    const { items, page, pageCount } = paginate(filtered, input.page, input.pageSize);
    return {
      entries: items.map((source) => toCatalogEntry(source, installedIds)),
      total: filtered.length,
      page,
      pageCount,
      fetchedAt,
      stale,
    };
  }

  thumbnail({ id }: RpcInput<typeof catalogThumbnail>): Promise<ThumbnailImage> {
    const existing = this.thumbnailJobs.get(id);
    if (existing) return existing;
    const job = this.thumbnails
      .run(() => this.buildThumbnail(id))
      .finally(() => this.thumbnailJobs.delete(id));
    this.thumbnailJobs.set(id, job);
    return job;
  }

  private async buildThumbnail(id: string): Promise<ThumbnailImage> {
    const installed = await this.store.get(id);
    if (installed) {
      const { bytes } = await this.store.readImage(id);
      return makeThumbnail(bytes, installed.focal);
    }
    const source = await this.catalog.find(id);
    const key = `${source.id}-${source.version}-${source.imageBytes ?? 0}`;
    const cached = await this.thumbCache.read(key);
    if (cached) return cached;
    if (
      source.previewExtension === "webp" &&
      (source.imageBytes ?? Number.POSITIVE_INFINITY) > 1.5 * 1024 * 1024
    ) {
      throw new Error(THUMBNAIL_UNAVAILABLE);
    }
    const { manifest, image } = await this.downloadVerified(source);
    const thumbnail = makeThumbnail(image, { x: manifest.art.focusX, y: manifest.art.focusY });
    await this.thumbCache.write(key, thumbnail).catch((error: unknown) => {
      console.warn(`could not cache thumbnail for ${id}: ${String(error)}`);
    });
    return thumbnail;
  }

  private async downloadVerified(source: CatalogSource) {
    const manifest = parseManifest(await fetchBytes(source.manifestUrl, MAX_MANIFEST_BYTES));
    if (manifest.id !== source.id) throw new Error(`Manifest id ${manifest.id} does not match ${source.id}`);
    const imageUrl = resolveCatalogUrl(manifest.image, source.manifestUrl);
    const image = await fetchBytes(imageUrl, Math.min(MAX_IMAGE_BYTES, manifest.integrity.bytes));
    const info = verifyImage(image, manifest.integrity);
    return { manifest, image, info };
  }

  install({ id }: RpcInput<typeof installSkin>): Promise<InstalledSkin> {
    const existing = this.installJobs.get(id);
    if (existing) return existing;
    const job = this.performInstall(id).finally(() => this.installJobs.delete(id));
    this.installJobs.set(id, job);
    return job;
  }

  private async performInstall(id: string): Promise<InstalledSkin> {
    const source = await this.catalog.find(id);
    const { manifest, image, info } = await this.downloadVerified(source);
    const skin: InstalledSkin = {
      id: source.id,
      name: source.name,
      version: manifest.integrity.sha256.slice(0, 12),
      sha256: manifest.integrity.sha256,
      appearance: manifest.appearance,
      focal: { x: manifest.art.focusX, y: manifest.art.focusY },
      intensity: {
        home: manifest.art.homeOpacity,
        workspace: manifest.art.workspaceOpacity,
        utility: manifest.art.utilityOpacity,
      },
      luminance: measureLuminance(image, info.mimeType),
      author: source.author,
      license: source.license,
      licenseUrl: source.licenseUrl,
      sourceUrl: source.sourceUrl,
      mimeType: info.mimeType,
      bytes: image.byteLength,
      width: info.width,
      height: info.height,
      installedAt: new Date().toISOString(),
    };
    await this.store.save(skin, image);
    return skin;
  }

  async list(): Promise<InstalledSkin[]> {
    return this.store.list();
  }

  async image({ id }: RpcInput<typeof skinImage>): Promise<{ base64: string; mimeType: InstalledSkin["mimeType"] }> {
    const { skin, bytes } = await this.store.readImage(id);
    return { base64: Buffer.from(bytes).toString("base64"), mimeType: skin.mimeType };
  }

  async remove({ id }: RpcInput<typeof removeSkin>): Promise<{ removed: boolean }> {
    const removed = await this.store.remove(id);
    return { removed };
  }
}
