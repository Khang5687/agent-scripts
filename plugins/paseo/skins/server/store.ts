import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { type InstalledSkin, InstalledSkinSchema, SKIN_ID_PATTERN } from "../shared/rpc";
import { writeFileAtomic } from "./fs-atomic";
import type { ImageMime } from "./image-info";

const EXTENSIONS: Record<ImageMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** Installed skins on disk: `skins/<id>/skin.json` plus the verified original `image.<ext>`. */
export class SkinStore {
  constructor(private readonly dataDir: string) {}

  private skinDir(id: string): string {
    if (!SKIN_ID_PATTERN.test(id)) throw new Error(`Invalid skin id: ${id}`);
    return join(this.dataDir, "skins", id);
  }

  private imagePath(skin: InstalledSkin): string {
    return join(this.skinDir(skin.id), `image.${EXTENSIONS[skin.mimeType]}`);
  }

  async save(skin: InstalledSkin, image: Uint8Array): Promise<void> {
    // The record is the commit point: write the image first so a listed skin always has bytes.
    await writeFileAtomic(this.imagePath(skin), image);
    await writeFileAtomic(join(this.skinDir(skin.id), "skin.json"), JSON.stringify(skin, null, 2));
  }

  async get(id: string): Promise<InstalledSkin | null> {
    try {
      const record = InstalledSkinSchema.parse(JSON.parse(await readFile(join(this.skinDir(id), "skin.json"), "utf8")));
      return record.id === id ? record : null;
    } catch {
      return null;
    }
  }

  async list(): Promise<InstalledSkin[]> {
    let names: string[];
    try {
      names = await readdir(join(this.dataDir, "skins"));
    } catch {
      return [];
    }
    const records = await Promise.all(
      names.filter((name) => SKIN_ID_PATTERN.test(name)).map((name) => this.get(name)),
    );
    return records
      .filter((record): record is InstalledSkin => record !== null)
      .sort((left, right) => right.installedAt.localeCompare(left.installedAt));
  }

  async readImage(id: string): Promise<{ skin: InstalledSkin; bytes: Uint8Array }> {
    const skin = await this.get(id);
    if (!skin) throw new Error(`Skin ${id} is not installed`);
    return { skin, bytes: await readFile(this.imagePath(skin)) };
  }

  async remove(id: string): Promise<boolean> {
    const directory = this.skinDir(id);
    const existed = (await this.get(id)) !== null;
    await rm(directory, { recursive: true, force: true });
    return existed;
  }

  async ensureRoot(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
  }
}
