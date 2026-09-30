import { useRpc } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { getPreview, getRecent, getSessions } from "../shared/rpc";
import { formatAgo, formatTokens } from "./format";
import { type Theme, useDashboardStyles } from "./styles";

function Preview({ imageId, theme, compact }: { imageId: number; theme: Theme; compact: boolean }) {
  const styles = useDashboardStyles(theme, compact);
  const fetchPreview = useRpc(getPreview);
  const preview = useQuery({ queryKey: ["pxpipe", "preview", imageId], queryFn: () => fetchPreview({ imageId }) });
  if (preview.isLoading) return <Text style={styles.muted}>Loading page {imageId}…</Text>;
  if (preview.error) return <Text style={styles.danger}>{String(preview.error)}</Text>;
  const data = preview.data;
  if (!data) return null;
  const uri = data.pngBase64 ? `data:image/png;base64,${data.pngBase64}` : null;
  // pxpipe's meta starts with the page size, e.g. "1568×568 · 90.5 KB · image 1/2".
  const size = data.meta?.match(/(\d+)×(\d+)/);
  const aspect = size ? Number(size[1]) / Number(size[2]) : 1568 / 728;
  return (
    <View style={{ gap: 8 }}>
      {data.meta ? <Text style={styles.small}>{data.meta}</Text> : null}
      {uri ? (
        <Image
          accessibilityLabel={`Rendered page ${imageId}`}
          source={{ uri }}
          resizeMode="contain"
          style={{ width: "100%", aspectRatio: aspect, backgroundColor: theme.colors.surface1 }}
        />
      ) : (
        <Text style={styles.muted}>pxpipe has evicted this page, or it is too large to preview here.</Text>
      )}
      <Text style={styles.small}>Original text</Text>
      <ScrollView style={styles.logBox}>
        <Text selectable style={styles.mono}>
          {data.sourceText ?? "No source text kept for this page."}
        </Text>
      </ScrollView>
    </View>
  );
}

export function ActivitySection({ theme, compact }: { theme: Theme; compact: boolean }) {
  const styles = useDashboardStyles(theme, compact);
  const fetchRecent = useRpc(getRecent);
  const fetchSessions = useRpc(getSessions);
  const [selected, setSelected] = useState<number | null>(null);
  const [showSessions, setShowSessions] = useState(false);
  const recent = useQuery({
    queryKey: ["pxpipe", "recent"],
    queryFn: () => fetchRecent({ limit: 20 }),
    refetchInterval: 3_000,
  });
  const sessions = useQuery({
    queryKey: ["pxpipe", "sessions"],
    queryFn: () => fetchSessions({ limit: 15 }),
    enabled: showSessions,
    refetchInterval: showSessions ? 15_000 : false,
  });
  const now = Date.now();

  return (
    <SettingsSection
      title="Activity"
      info="Recent requests come from pxpipe's in-memory ring. Pick a compressed request to see what the model saw."
    >
      <SettingsCard>
        <View style={styles.panel}>
          <Text style={styles.text}>Recent requests</Text>
          {(recent.data?.rows ?? []).map((row) => {
            const pageId = row.imageIds[0];
            const saved =
              row.baselineInput !== null && row.actualInput !== null
                ? ` · ${formatTokens(row.baselineInput)} → ${formatTokens(row.actualInput)} weighted input`
                : "";
            const content = (
              <View style={styles.listItem}>
                <Text style={styles.text}>
                  {row.model ?? "unknown"} · {row.compressed ? "compressed" : "passthrough"}
                  {row.status >= 400 ? ` · HTTP ${row.status}` : ""}
                </Text>
                <Text style={styles.small}>
                  {formatAgo(row.ts, now)}
                  {saved}
                  {row.imageIds.length > 0 ? ` · ${row.imageIds.length} pages` : ""}
                </Text>
              </View>
            );
            return pageId === undefined ? (
              <View key={`${row.ts}:${row.model}`}>{content}</View>
            ) : (
              <Pressable
                key={`${row.ts}:${row.model}`}
                accessibilityRole="button"
                accessibilityLabel={`Preview request pages from ${formatAgo(row.ts, now)}`}
                onPress={() => setSelected(selected === pageId ? null : pageId)}
              >
                {content}
              </Pressable>
            );
          })}
          {recent.data?.rows.length === 0 ? <Text style={styles.muted}>No requests yet.</Text> : null}
          {recent.error ? <Text style={styles.muted}>pxpipe is not running.</Text> : null}
        </View>
      </SettingsCard>
      {selected !== null ? (
        <SettingsCard>
          <View style={styles.panel}>
            <Text style={styles.text}>Page {selected}</Text>
            <Preview imageId={selected} theme={theme} compact={compact} />
          </View>
        </SettingsCard>
      ) : null}
      <SettingsCard>
        <SettingsAction
          label="Sessions"
          hint="Grouped by first user message."
          actionLabel={showSessions ? "Hide" : "Show"}
          onPress={() => setShowSessions((value) => !value)}
        />
        {showSessions ? (
          <View style={styles.panel}>
            {(sessions.data?.sessions ?? []).map((session) => (
              <View key={session.id} style={styles.listItem}>
                <Text style={styles.text} numberOfLines={1}>
                  {session.preview ?? session.project ?? session.id}
                </Text>
                <Text style={styles.small}>
                  {session.lastSeen ? formatAgo(Date.parse(session.lastSeen), now) : ""} · {session.requestCount}{" "}
                  requests · ~{formatTokens(session.tokensSavedEst)} tokens saved
                </Text>
              </View>
            ))}
            {sessions.isLoading ? <Text style={styles.muted}>Loading…</Text> : null}
            {sessions.error ? <Text style={styles.danger}>{String(sessions.error)}</Text> : null}
          </View>
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}
