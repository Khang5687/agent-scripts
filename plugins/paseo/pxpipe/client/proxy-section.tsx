import { useRpc } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import {
  ExternalLink,
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { getStatus, restartProxy, type Status } from "../shared/rpc";
import { ExternalCard, STATUS_QUERY_KEY } from "./external-card";
import { formatDuration } from "./format";
import { type ReadyConfig, type Theme, useDashboardStyles } from "./styles";

const STATE_LABEL: Record<Status["state"], string> = {
  disabled: "Off",
  starting: "Starting…",
  running: "Running",
  stopped: "Stopped",
  failed: "Failed",
};

export function ProxySection({ settings, theme, compact }: { settings: ReadyConfig; theme: Theme; compact: boolean }) {
  const styles = useDashboardStyles(theme, compact);
  const queryClient = useQueryClient();
  const fetchStatus = useRpc(getStatus);
  const restart = useRpc(restartProxy);
  const [showLog, setShowLog] = useState(false);
  const status = useQuery({ queryKey: STATUS_QUERY_KEY, queryFn: () => fetchStatus({}), refetchInterval: 2_000 });
  const restartMutation = useMutation({
    mutationFn: () => restart({}),
    onSuccess: (next) => queryClient.setQueryData(STATUS_QUERY_KEY, next),
  });

  const current = status.data;
  const stateStyle =
    current?.state === "running" ? styles.success : current?.state === "failed" ? styles.danger : styles.muted;
  const uptime = current?.startedAt ? (Date.now() - Date.parse(current.startedAt)) / 1000 : null;
  const external = current?.external ?? null;
  const adopted = external?.adopted === true;
  const liveCompression = current?.compressionEnabled;
  const compressionHint =
    liveCompression !== null && liveCompression !== undefined && liveCompression !== settings.values.compression
      ? "Applying…"
      : adopted
        ? "Off forwards every request unchanged. Applies to everything using this pxpipe, not only Paseo agents."
        : "Off forwards every request unchanged and keeps logging usage. Affects all routed agents immediately.";

  return (
    <SettingsSection title="Proxy">
      <SettingsCard>
        <SettingsRow label="Status" hint={current?.baseUrl}>
          <View style={styles.stack}>
            <Text style={stateStyle}>
              {current ? STATE_LABEL[current.state] : status.isError ? "Plugin unreachable" : "Loading…"}
              {current?.state === "running" && uptime !== null ? ` · up ${formatDuration(uptime)}` : ""}
              {current?.pid ? ` · pid ${current.pid}` : ""}
            </Text>
            {current?.lastError ? <Text style={styles.danger}>{current.lastError}</Text> : null}
          </View>
        </SettingsRow>
        <SettingsSwitch
          label="Run pxpipe"
          hint={
            adopted
              ? "Off stops routing through the existing pxpipe and leaves it running."
              : "Starts pxpipe with this daemon. Off stops it and routes new agents direct."
          }
          value={settings.values.enabled}
          disabled={settings.saving}
          onValueChange={(enabled) => void settings.save({ ...settings.values, enabled }, settings.revision)}
        />
        <SettingsSwitch
          label="Compression"
          hint={compressionHint}
          value={settings.values.compression}
          disabled={settings.saving || !settings.values.enabled}
          onValueChange={(compression) => void settings.save({ ...settings.values, compression }, settings.revision)}
        />
        <SettingsAction
          label="Restart pxpipe"
          hint={
            adopted ? "Restart the existing pxpipe where it was started." : "Clears pxpipe's in-memory image previews."
          }
          actionLabel={restartMutation.isPending ? "Restarting…" : "Restart"}
          disabled={restartMutation.isPending || !settings.values.enabled || adopted}
          onPress={() => restartMutation.mutate()}
        />
        <SettingsAction
          label="pxpipe output"
          actionLabel={showLog ? "Hide" : "Show"}
          onPress={() => setShowLog((value) => !value)}
        />
        <SettingsRow label="Full pxpipe dashboard" hint="Opens only on the Mac that runs this daemon.">
          <ExternalLink href={`${current?.baseUrl ?? `http://127.0.0.1:${settings.values.port}`}/`}>Open</ExternalLink>
        </SettingsRow>
      </SettingsCard>
      {external ? <ExternalCard external={external} settings={settings} theme={theme} compact={compact} /> : null}
      {settings.saveError ? <Text style={styles.danger}>{settings.saveError}</Text> : null}
      {restartMutation.error ? <Text style={styles.danger}>{String(restartMutation.error)}</Text> : null}
      {showLog ? (
        <ScrollView style={styles.logBox}>
          <Text selectable style={styles.mono}>
            {current?.logTail.length ? current.logTail.join("\n") : "No output yet."}
          </Text>
        </ScrollView>
      ) : null}
    </SettingsSection>
  );
}
