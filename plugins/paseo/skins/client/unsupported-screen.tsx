import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Text } from "react-native";

export function UnsupportedScreen({ theme }: PluginSurfaceProps) {
  return (
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 14 }}>
      This Paseo version does not support skins. Update Paseo to browse the skin catalog.
    </Text>
  );
}
