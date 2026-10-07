import type { PluginServerContext } from "@getpaseo/plugin/server";
import { catalogThumbnail, installSkin, listCatalog, listSkins, removeSkin, skinImage } from "./shared/rpc";
import { resolveDataDir } from "./server/paths";
import { SkinService } from "./server/service";

export default function contribute(server: PluginServerContext) {
  const service = new SkinService(resolveDataDir());

  server.handle(listCatalog, (input) => service.listCatalog(input));
  server.handle(catalogThumbnail, (input) => service.thumbnail(input));
  server.handle(installSkin, (input) => service.install(input));
  server.handle(listSkins, async () => ({ skins: await service.list() }));
  server.handle(skinImage, (input) => service.image(input));
  server.handle(removeSkin, (input) => service.remove(input));

  return () => {};
}
