import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsSection } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { pxpipeConfig } from "../shared/config";
import { ActivitySection } from "./activity-section";
import { AdvancedSection } from "./advanced-section";
import { ModelsSection } from "./models-section";
import { ProxySection } from "./proxy-section";
import { RoutingSection } from "./routing-section";
import { SavingsSection } from "./savings-section";
import { useDashboardStyles } from "./styles";

export function PxpipeDashboard({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(pxpipeConfig);
  const styles = useDashboardStyles(theme, layout.compact);

  if (settings.status === "loading") return <Text style={styles.muted}>Loading pxpipe settings…</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="pxpipe">
        <Text style={styles.danger}>{settings.error}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={() => void settings.reload()} />
        {settings.status === "invalid" ? (
          <SettingsAction label="Restore default settings" actionLabel="Reset" onPress={() => void settings.reset()} />
        ) : null}
      </SettingsSection>
    );
  }

  const section = { settings, theme, compact: layout.compact };
  return (
    <View style={{ gap: layout.compact ? 16 : 24 }}>
      <ProxySection {...section} />
      <SavingsSection {...section} />
      <RoutingSection {...section} />
      <ModelsSection settings={settings} />
      <ActivitySection theme={theme} compact={layout.compact} />
      <AdvancedSection {...section} />
    </View>
  );
}
