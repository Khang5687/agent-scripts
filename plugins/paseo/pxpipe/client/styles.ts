import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { SettingsState } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Platform } from "react-native";
import type { pxpipeConfig } from "../shared/config";

export type Theme = PluginSurfaceProps["theme"];
export type ReadyConfig = Extract<SettingsState<typeof pxpipeConfig.schema>, { status: "ready" }>;

const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, monospace" });

export function useDashboardStyles(theme: Theme, compact: boolean) {
  return useMemo(
    () => ({
      text: { color: theme.colors.foreground, fontSize: 14 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      small: { color: theme.colors.foregroundMuted, fontSize: 12 },
      danger: { color: theme.colors.statusDanger, fontSize: 13 },
      success: { color: theme.colors.statusSuccess, fontSize: 13 },
      warning: { color: theme.colors.statusWarning, fontSize: 13 },
      headline: { color: theme.colors.foreground, fontSize: compact ? 22 : 26, fontWeight: "600" as const },
      mono: { color: theme.colors.foreground, fontSize: 12, fontFamily: MONO },
      stack: { gap: 4, flexShrink: 1 },
      panel: { paddingHorizontal: compact ? 12 : 16, paddingVertical: 12, gap: 4 },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      barTrack: {
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.surface2,
        overflow: "hidden" as const,
        flexGrow: 1,
        minWidth: 80,
      },
      logBox: {
        maxHeight: 240,
        padding: 8,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      textArea: {
        minHeight: 96,
        padding: 8,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        color: theme.colors.foreground,
        fontFamily: MONO,
        fontSize: 12,
        textAlignVertical: "top" as const,
      },
      listItem: { paddingVertical: 8, gap: 2, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
    }),
    [theme, compact],
  );
}
