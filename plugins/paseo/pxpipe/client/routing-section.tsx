import { usePaseo } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Text } from "react-native";
import { type ReadyConfig, type Theme, useDashboardStyles } from "./styles";

/** Providers verified to send Anthropic requests to ANTHROPIC_BASE_URL. */
const READS_ANTHROPIC_BASE_URL: Record<string, true> = { claude: true, omp: true };

export function RoutingSection({
  settings,
  theme,
  compact,
}: {
  settings: ReadyConfig;
  theme: Theme;
  compact: boolean;
}) {
  const styles = useDashboardStyles(theme, compact);
  const paseo = usePaseo();
  const providers = useQuery({ queryKey: ["pxpipe", "providers"], queryFn: () => paseo.providers.snapshot() });

  const routed = settings.values.routedProviders;
  const entries = (providers.data?.entries ?? []).filter((entry) => entry.enabled || routed.includes(entry.provider));
  const known = new Set(entries.map((entry) => entry.provider));
  const missing = routed.filter((id) => !known.has(id));

  const toggle = (provider: string, on: boolean) => {
    const next = on ? [...routed.filter((id) => id !== provider), provider] : routed.filter((id) => id !== provider);
    void settings.save({ ...settings.values, routedProviders: next }, settings.revision);
  };

  return (
    <SettingsSection
      title="Route agents through pxpipe"
      info="Sets ANTHROPIC_BASE_URL for agents opened, resumed, or refreshed after the change. Running agents keep their current route until refreshed."
    >
      <SettingsCard>
        {entries.map((entry) => {
          const verified = READS_ANTHROPIC_BASE_URL[entry.provider] === true;
          return (
            <SettingsSwitch
              key={entry.provider}
              label={entry.label ?? entry.provider}
              hint={
                verified
                  ? `${entry.provider} · Anthropic requests only`
                  : `${entry.provider} · Only affects it if this provider reads ANTHROPIC_BASE_URL. Skip profiles that set their own base URL.`
              }
              value={routed.includes(entry.provider)}
              disabled={settings.saving}
              onValueChange={(on) => toggle(entry.provider, on)}
            />
          );
        })}
        {missing.map((provider) => (
          <SettingsSwitch
            key={provider}
            label={provider}
            hint="Not enabled on this host"
            value
            disabled={settings.saving}
            onValueChange={(on) => toggle(provider, on)}
          />
        ))}
      </SettingsCard>
      {providers.isLoading ? <Text style={styles.muted}>Loading providers…</Text> : null}
      {providers.error ? <Text style={styles.danger}>{String(providers.error)}</Text> : null}
    </SettingsSection>
  );
}
