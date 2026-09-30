import type { PluginClientContext } from "@getpaseo/plugin/client";
import { PxpipeDashboard } from "./client/dashboard";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "dashboard",
    title: "pxpipe",
    icon: "Gauge",
    Component: PxpipeDashboard,
  });
  client.addCommandCenterItem({
    id: "open-dashboard",
    title: "Open pxpipe dashboard",
    icon: "Gauge",
    context: "global",
    onSelect({ openSettings }) {
      openSettings("dashboard");
    },
  });
  return () => {};
}
