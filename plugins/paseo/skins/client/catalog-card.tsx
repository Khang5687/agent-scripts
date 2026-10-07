import { useRpc } from "@getpaseo/plugin/client";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Image, Pressable, Text, View } from "react-native";
import { type CatalogEntry, catalogThumbnail } from "../shared/rpc";
import { type Theme, useCatalogStyles } from "./styles";

function Thumbnail({ id, theme }: { id: string; theme: Theme }) {
  const styles = useCatalogStyles(theme);
  const fetchThumbnail = useRpc(catalogThumbnail);
  const thumbnail = useQuery({
    queryKey: ["paseo-skins", "thumbnail", id],
    queryFn: () => fetchThumbnail({ id }),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  if (thumbnail.data) {
    return (
      <Image
        accessibilityIgnoresInvertColors
        source={{ uri: `data:${thumbnail.data.mimeType};base64,${thumbnail.data.base64}` }}
        resizeMode="cover"
        style={styles.thumb}
      />
    );
  }
  return (
    <View style={styles.thumbEmpty}>
      <Text style={styles.small}>{thumbnail.isError ? "Preview unavailable" : "Loading preview…"}</Text>
    </View>
  );
}

function ActionButton(props: {
  label: string;
  kind: "primary" | "secondary";
  disabled: boolean;
  onPress: () => void;
  theme: Theme;
}) {
  const styles = useCatalogStyles(props.theme);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={styles.button(props.kind, props.disabled)}
    >
      <Text style={styles.buttonText(props.kind)}>{props.label}</Text>
    </Pressable>
  );
}

export type CardBusy = "installing" | "removing" | "applying" | null;

export function CatalogCard(props: {
  entry: CatalogEntry;
  permissive: boolean;
  busy: CardBusy;
  theme: Theme;
  onInstall: () => void;
  onUse: () => void;
  onRemove: () => void;
}) {
  const { entry, theme, busy } = props;
  const styles = useCatalogStyles(theme);
  const working = busy !== null;
  return (
    <View style={styles.card}>
      <Thumbnail id={entry.id} theme={theme} />
      <View style={styles.cardBody}>
        <Text numberOfLines={1} style={styles.title}>
          {entry.name}
        </Text>
        <Text numberOfLines={1} style={styles.small}>
          {entry.author}
        </Text>
        <Text numberOfLines={2} style={props.permissive ? styles.small : styles.warning}>
          {entry.license || "No license stated"}
        </Text>
        <View style={[styles.row, { marginTop: 6 }]}>
          {entry.installed ? (
            <>
              <ActionButton
                label={busy === "applying" ? "Applying…" : "Use"}
                kind="primary"
                disabled={working}
                onPress={props.onUse}
                theme={theme}
              />
              <ActionButton
                label={busy === "removing" ? "Removing…" : "Remove"}
                kind="secondary"
                disabled={working}
                onPress={props.onRemove}
                theme={theme}
              />
            </>
          ) : (
            <ActionButton
              label={busy === "installing" ? "Installing…" : "Install & use"}
              kind="primary"
              disabled={working}
              onPress={props.onInstall}
              theme={theme}
            />
          )}
          {entry.sourceUrl ? (
            <ExternalLink href={entry.sourceUrl} accessibilityLabel={`Source of ${entry.name}`}>
              <Text style={styles.small}>Source</Text>
            </ExternalLink>
          ) : null}
        </View>
      </View>
    </View>
  );
}
