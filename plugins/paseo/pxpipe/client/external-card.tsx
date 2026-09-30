import { useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput } from "@getpaseo/plugin/client/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { takeOverProxy, type Status } from "../shared/rpc";
import { type ReadyConfig, type Theme, useDashboardStyles } from "./styles";

export const STATUS_QUERY_KEY = ["pxpipe", "status"] as const;

/**
 * Shown while a pxpipe started outside Paseo holds the port. Explains what Paseo can and cannot
 * control, and offers the two ways to get full control: take the port over, or move to another.
 */
export function ExternalCard({
  external,
  settings,
  theme,
  compact,
}: {
  external: NonNullable<Status["external"]>;
  settings: ReadyConfig;
  theme: Theme;
  compact: boolean;
}) {
  const styles = useDashboardStyles(theme, compact);
  const queryClient = useQueryClient();
  const takeOver = useRpc(takeOverProxy);
  const [confirming, setConfirming] = useState(false);
  const [port, setPort] = useState(String(settings.values.port + 10));
  const [portError, setPortError] = useState<string | null>(null);
  const takeOverMutation = useMutation({
    mutationFn: () => takeOver({}),
    onSuccess: (next) => queryClient.setQueryData(STATUS_QUERY_KEY, next),
    onSettled: () => setConfirming(false),
  });

  const movePort = () => {
    const next = Number(port.trim());
    if (!Number.isInteger(next) || next < 1024 || next > 65535 || next === settings.values.port) {
      setPortError("Enter a free port between 1024 and 65535.");
      return;
    }
    setPortError(null);
    void settings.save({ ...settings.values, port: next, adoptExisting: false }, settings.revision);
  };

  const owner = [
    external.pid ? `pid ${external.pid}` : null,
    external.version ? `pxpipe-proxy ${external.version}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <SettingsCard>
      <View style={styles.panel}>
        <Text style={styles.text}>
          {external.adopted ? "Using a pxpipe started outside Paseo" : "Port taken by a pxpipe started outside Paseo"}
        </Text>
        {owner ? <Text style={styles.small}>{owner}</Text> : null}
        <Text style={styles.warning}>
          {external.adopted
            ? "Paseo routes agents through it but only controls its models and compression. Port, cache, upstream, and environment settings don't apply, and Restart is unavailable. Model and compression changes also affect its other users."
            : "Nothing is routed through pxpipe until you take over the port or move Paseo's pxpipe to another port."}
        </Text>
        {external.command ? (
          <Text selectable style={styles.mono} numberOfLines={2}>
            {external.command}
          </Text>
        ) : null}
      </View>
      <SettingsAction
        label="Take over this port"
        hint={
          confirming
            ? `Stops ${external.pid ? `process ${external.pid}` : "that pxpipe"}. Anything else using it, such as a terminal session, is cut off until Paseo's pxpipe is up a few seconds later.`
            : "Stop that pxpipe and run Paseo's own here, with every setting under Paseo's control."
        }
        actionLabel={takeOverMutation.isPending ? "Taking over…" : confirming ? "Stop it and take over" : "Take over"}
        disabled={takeOverMutation.isPending || !settings.values.enabled}
        onPress={() => (confirming ? takeOverMutation.mutate() : setConfirming(true))}
      />
      {confirming && !takeOverMutation.isPending ? (
        <SettingsAction label="Keep it running" actionLabel="Cancel" onPress={() => setConfirming(false)} />
      ) : null}
      <SettingsInput
        label="Or use another port"
        hint="Paseo starts its own pxpipe there and leaves the other one alone. Tools pointed at the old port keep using the other pxpipe."
        initialValue={port}
        onChangeText={setPort}
        error={portError}
        disabled={settings.saving}
      />
      <SettingsAction
        label="Move Paseo's pxpipe"
        actionLabel="Use this port"
        disabled={settings.saving}
        onPress={movePort}
      />
      {takeOverMutation.error ? <Text style={styles.danger}>{String(takeOverMutation.error)}</Text> : null}
    </SettingsCard>
  );
}
