import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createCatalogScreen } from "./client/catalog-screen";
import { SkinRegistry } from "./client/registry";
import { UnsupportedScreen } from "./client/unsupported-screen";
import { listSkins } from "./shared/rpc";

export default function contribute(client: PluginClientContext) {
  // Older apps have no skin API: keep the settings entry so the reason is visible.
  if (typeof client.addSkin !== "function") {
    const removeScreen = client.addSettingsScreen({
      id: "catalog",
      title: "Skin catalog",
      icon: "Palette",
      Component: UnsupportedScreen,
    });
    return () => {
      void removeScreen();
    };
  }

  const registry = new SkinRegistry(client);
  const removeScreen = client.addSettingsScreen({
    id: "catalog",
    title: "Skin catalog",
    icon: "Palette",
    Component: createCatalogScreen(registry),
    skinCatalog: true,
  });

  // Installed skins show up in Settings → Appearance → Background even when this screen is closed.
  client
    .rpc(listSkins, {})
    .then(({ skins }) => {
      for (const skin of skins) registry.register(skin);
    })
    .catch((error: unknown) => {
      console.warn(`paseo-skins: could not list installed skins: ${String(error)}`);
    });

  return () => {
    registry.dispose();
    void removeScreen();
  };
}
