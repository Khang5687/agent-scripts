import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";

export type Theme = PluginSurfaceProps["theme"];

export function useCatalogStyles(theme: Theme) {
  return useMemo(
    () => ({
      text: { color: theme.colors.foreground, fontSize: 14 },
      title: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      small: { color: theme.colors.foregroundMuted, fontSize: 12 },
      warning: { color: theme.colors.statusWarning, fontSize: 12 },
      danger: { color: theme.colors.statusDanger, fontSize: 13 },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      card: {
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        overflow: "hidden" as const,
      },
      cardBody: { padding: 10, gap: 4 },
      thumb: { width: "100%" as const, aspectRatio: 16 / 9, backgroundColor: theme.colors.surface2 },
      thumbEmpty: {
        width: "100%" as const,
        aspectRatio: 16 / 9,
        backgroundColor: theme.colors.surface2,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      chip: (active: boolean) => ({
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: active ? theme.colors.accent : theme.colors.border,
        backgroundColor: active ? theme.colors.accent : theme.colors.surface1,
      }),
      chipText: (active: boolean) => ({
        fontSize: 13,
        color: active ? theme.colors.accentForeground : theme.colors.foreground,
      }),
      button: (kind: "primary" | "secondary", disabled: boolean) => ({
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: kind === "primary" ? theme.colors.accent : theme.colors.border,
        backgroundColor: kind === "primary" ? theme.colors.accent : theme.colors.surface2,
        opacity: disabled ? 0.5 : 1,
      }),
      buttonText: (kind: "primary" | "secondary") => ({
        fontSize: 13,
        color: kind === "primary" ? theme.colors.accentForeground : theme.colors.foreground,
      }),
    }),
    [theme],
  );
}
