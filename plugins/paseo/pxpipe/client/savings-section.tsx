import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { getStats, type ModelTotals } from "../shared/rpc";
import { formatPercent, formatTokens, formatUsd, savedPercent } from "./format";
import { type ReadyConfig, type Theme, useDashboardStyles } from "./styles";

function Bar({ fraction, color, theme, compact }: { fraction: number; color: string; theme: Theme; compact: boolean }) {
  const styles = useDashboardStyles(theme, compact);
  const width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%` as const;
  return (
    <View style={styles.barTrack}>
      <View style={{ width, height: "100%", backgroundColor: color }} />
    </View>
  );
}

export function SavingsSection({
  settings,
  theme,
  compact,
}: {
  settings: ReadyConfig;
  theme: Theme;
  compact: boolean;
}) {
  const styles = useDashboardStyles(theme, compact);
  const fetchStats = useRpc(getStats);
  const paseo = usePaseo();
  const stats = useQuery({ queryKey: ["pxpipe", "stats"], queryFn: () => fetchStats({}), refetchInterval: 5_000 });
  const usage = useQuery({
    queryKey: ["pxpipe", "provider-usage"],
    queryFn: () => paseo.providers.listUsage(),
    refetchInterval: 60_000,
  });

  const models = stats.data?.log.models ?? [];
  const sum = (pick: (model: ModelTotals) => number) => models.reduce((total, model) => total + pick(model), 0);
  const baseline = sum((model) => model.baselineTokens);
  const actual = sum((model) => model.actualTokens);
  const measured = sum((model) => model.measured);
  const requests = sum((model) => model.requests);
  const compressed = sum((model) => model.compressed);
  const baselineWeighted = sum((model) => model.baselineWeighted);
  const actualWeighted = sum((model) => model.actualWeighted);
  const pricing = stats.data?.pricing;
  const savedUsd = pricing ? ((baselineWeighted - actualWeighted) * pricing.inputPerMtok) / 1e6 : 0;
  const routed = settings.values.routedProviders;
  const usageProviders = (usage.data?.providers ?? []).filter(
    (provider) => routed.includes(provider.providerId) && provider.status === "available",
  );

  return (
    <SettingsSection
      title="Savings"
      info="Totals cover pxpipe's whole events log, so they survive restarts. Token figures compare pxpipe's count_tokens baseline of each original request with the tokens billed, over requests where the probe succeeded; cache reads count at face value. Dollars use pxpipe's cache-weighted math on Anthropic requests."
    >
      <SettingsCard>
        <SettingsRow
          label="Input tokens (subscription usage view)"
          hint={stats.data ? `${measured} measured requests` : undefined}
        >
          {stats.data ? (
            <View style={styles.stack}>
              <Text style={styles.headline}>{formatPercent(savedPercent(baseline, actual))}</Text>
              <Text style={styles.muted}>
                {formatTokens(baseline)} → {formatTokens(actual)} tokens · {formatTokens(baseline - actual)} saved
              </Text>
            </View>
          ) : (
            <Text style={styles.muted}>Loading…</Text>
          )}
        </SettingsRow>
        <SettingsRow label="Dollars at API list price" hint={pricing?.source}>
          {stats.data && pricing ? (
            <View style={styles.stack}>
              <Text style={styles.headline}>{formatUsd(savedUsd)}</Text>
              <Text style={styles.muted}>
                {formatPercent(savedPercent(baselineWeighted, actualWeighted))} of cache-weighted input · $
                {pricing.inputPerMtok}/Mtok input
              </Text>
            </View>
          ) : (
            <Text style={styles.muted}>Loading…</Text>
          )}
        </SettingsRow>
        {stats.data ? (
          <SettingsRow label="Requests">
            <Text style={styles.muted}>
              {requests} total · {compressed} compressed · {requests - compressed} passed through
            </Text>
          </SettingsRow>
        ) : null}
      </SettingsCard>

      <SettingsCard>
        {models.length === 0 ? (
          <SettingsRow label="By model">
            <Text style={styles.muted}>{stats.isLoading ? "Loading…" : "No requests logged yet."}</Text>
          </SettingsRow>
        ) : (
          models.map((model) => {
            const saved = savedPercent(model.baselineTokens, model.actualTokens);
            const modelUsd = pricing
              ? ((model.baselineWeighted - model.actualWeighted) * pricing.inputPerMtok) / 1e6
              : 0;
            return (
              <SettingsRow
                key={model.model}
                label={model.model}
                hint={`${model.requests} requests · ${model.compressed} compressed · ${formatTokens(model.outputTokens)} output tokens${modelUsd !== 0 ? ` · ${formatUsd(modelUsd)} saved` : ""}`}
              >
                <View style={styles.row}>
                  <Bar fraction={saved / 100} color={theme.colors.accent} theme={theme} compact={compact} />
                  <Text style={styles.small}>
                    {model.measured > 0
                      ? `${formatPercent(saved)} · ${formatTokens(model.baselineTokens)} → ${formatTokens(model.actualTokens)}`
                      : "no baseline"}
                  </Text>
                </View>
              </SettingsRow>
            );
          })
        )}
      </SettingsCard>

      {usageProviders.length > 0 ? (
        <SettingsCard>
          {usageProviders.flatMap((provider) =>
            provider.windows.map((usageWindow) => {
              const remaining = usageWindow.remainingPct;
              const used =
                usageWindow.usedPct ?? (remaining !== null && remaining !== undefined ? 100 - remaining : null);
              const tone =
                usageWindow.tone === "danger"
                  ? theme.colors.statusDanger
                  : usageWindow.tone === "warning"
                    ? theme.colors.statusWarning
                    : theme.colors.accent;
              return (
                <SettingsRow
                  key={`${provider.providerId}:${usageWindow.id}`}
                  label={`${provider.displayName} · ${usageWindow.label}`}
                  hint={usageWindow.resetsAt ? `Resets ${new Date(usageWindow.resetsAt).toLocaleString()}` : undefined}
                >
                  <View style={styles.row}>
                    <Bar fraction={(used ?? 0) / 100} color={tone} theme={theme} compact={compact} />
                    <Text style={styles.small}>{used === null ? "—" : `${formatPercent(used)} used`}</Text>
                  </View>
                </SettingsRow>
              );
            }),
          )}
        </SettingsCard>
      ) : null}

      <Text style={styles.small}>
        {stats.data ? `Events log: ${stats.data.log.path} (${stats.data.log.rows} rows)` : ""}
      </Text>
      {stats.error ? <Text style={styles.danger}>{String(stats.error)}</Text> : null}
    </SettingsSection>
  );
}
