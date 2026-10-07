import type { PluginClientContext, PluginSkinContribution } from "@getpaseo/plugin/client";
import { catalogThumbnail, contributionId, type InstalledSkin, skinImage } from "../shared/rpc";

/** Tracks which installed skins this client has handed to Paseo, so removal can unregister them. */
export class SkinRegistry {
  private readonly removers = new Map<string, () => void | Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  constructor(private readonly client: PluginClientContext) {}

  private contribution(skin: InstalledSkin): PluginSkinContribution {
    const { client } = this;
    return {
      id: contributionId(skin.id),
      name: skin.name.slice(0, 60),
      version: skin.version,
      appearance: skin.appearance,
      focal: skin.focal,
      intensity: skin.intensity,
      ...(skin.luminance ? { luminance: skin.luminance } : {}),
      attribution: { author: skin.author, license: skin.license, sourceUrl: skin.sourceUrl ?? undefined },
      loadThumbnail: () => client.rpc(catalogThumbnail, { id: skin.id }),
      loadImage: () => client.rpc(skinImage, { id: skin.id }),
    };
  }

  /** Registers the skin, replacing an earlier registration of the same id. */
  register(skin: InstalledSkin): void {
    if (this.disposed) return;
    void this.removers.get(skin.id)?.();
    this.removers.set(skin.id, this.client.addSkin(this.contribution(skin)));
    this.emit();
  }

  unregister(id: string): void {
    const remove = this.removers.get(id);
    if (!remove) return;
    this.removers.delete(id);
    void remove();
    this.emit();
  }

  apply(id: string): Promise<void> {
    return this.client.applySkin(contributionId(id));
  }

  isRegistered(id: string): boolean {
    return this.removers.has(id);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  dispose(): void {
    this.disposed = true;
    for (const remove of this.removers.values()) void remove();
    this.removers.clear();
    this.listeners.clear();
  }
}
