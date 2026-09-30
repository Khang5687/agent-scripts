import { TextInput } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text } from "react-native";
import { parseExtraEnv, pxpipeConfig, type PxpipeConfig } from "../shared/config";
import { type ReadyConfig, type Theme, useDashboardStyles } from "./styles";

type DraftKey =
  | "port"
  | "command"
  | "anthropicUpstream"
  | "openaiUpstream"
  | "renderCacheMb"
  | "maxRequestMb"
  | "gptHistoryMaxImages"
  | "extraEnv";

const NUMBER_FIELDS: Record<string, true> = {
  port: true,
  renderCacheMb: true,
  maxRequestMb: true,
  gptHistoryMaxImages: true,
};

const FIELDS: { key: Exclude<DraftKey, "extraEnv">; label: string; hint: string; placeholder?: string }[] = [
  { key: "port", label: "Port", hint: "Loopback port pxpipe listens on." },
  {
    key: "command",
    label: "Command",
    hint: "Leave empty to run the pxpipe-proxy installed with this plugin.",
    placeholder: "/usr/local/bin/pxpipe",
  },
  {
    key: "anthropicUpstream",
    label: "Anthropic upstream",
    hint: "ANTHROPIC_UPSTREAM",
    placeholder: "https://api.anthropic.com",
  },
  { key: "openaiUpstream", label: "OpenAI upstream", hint: "OPENAI_UPSTREAM", placeholder: "https://api.openai.com" },
  { key: "renderCacheMb", label: "Render cache (MiB)", hint: "PXPIPE_RENDER_CACHE_BYTES. 0 disables it." },
  {
    key: "maxRequestMb",
    label: "Max request size (MiB)",
    hint: "PXPIPE_MAX_REQUEST_BYTES. Larger bodies get HTTP 413.",
  },
  {
    key: "gptHistoryMaxImages",
    label: "GPT history image cap",
    hint: "PXPIPE_GPT_HISTORY_MAX_IMAGES, 1–100. 0 keeps pxpipe's per-model default.",
  },
];

function toDraft(values: PxpipeConfig): Record<DraftKey, string> {
  return {
    port: String(values.port),
    command: values.command,
    anthropicUpstream: values.anthropicUpstream,
    openaiUpstream: values.openaiUpstream,
    renderCacheMb: String(values.renderCacheMb),
    maxRequestMb: String(values.maxRequestMb),
    gptHistoryMaxImages: String(values.gptHistoryMaxImages),
    extraEnv: values.extraEnv,
  };
}

function LaunchEditor({
  settings,
  theme,
  compact,
  onClose,
}: {
  settings: ReadyConfig;
  theme: Theme;
  compact: boolean;
  onClose(): void;
}) {
  const styles = useDashboardStyles(theme, compact);
  // Keep the opening revision so a concurrent save elsewhere conflicts instead of being overwritten.
  const [opened] = useState(() => ({ values: settings.values, revision: settings.revision }));
  const [draft, setDraft] = useState(() => toDraft(settings.values));
  const [error, setError] = useState<string | null>(null);
  const change = (key: DraftKey) => (text: string) => setDraft((current) => ({ ...current, [key]: text }));

  const save = async () => {
    const candidate: Record<string, unknown> = { ...opened.values };
    for (const [key, text] of Object.entries(draft)) {
      candidate[key] = NUMBER_FIELDS[key] ? Number(text.trim()) : text;
    }
    const env = parseExtraEnv(draft.extraEnv);
    if (!env.ok) {
      setError(env.error);
      return;
    }
    const parsed = pxpipeConfig.schema.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(issue ? `${issue.path.join(".")}: ${issue.message}` : "Invalid settings");
      return;
    }
    setError(null);
    if (await settings.save(parsed.data, opened.revision)) onClose();
  };

  return (
    <SettingsCard>
      {FIELDS.map((field) => (
        <SettingsInput
          key={field.key}
          label={field.label}
          hint={field.hint}
          placeholder={field.placeholder}
          initialValue={draft[field.key]}
          onChangeText={change(field.key)}
          disabled={settings.saving}
        />
      ))}
      <SettingsRow
        label="Extra environment"
        hint="KEY=VALUE per line, for any other pxpipe variable, e.g. PXPIPE_GPT_PROFILES or PXPIPE_LOG."
      >
        <TextInput
          accessibilityLabel="Extra environment"
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          value={draft.extraEnv}
          onChangeText={change("extraEnv")}
          placeholder="PXPIPE_DUMP_DIR=/tmp/pxpipe-pages"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={styles.textArea}
        />
      </SettingsRow>
      {error || settings.saveError ? <Text style={styles.danger}>{error ?? settings.saveError}</Text> : null}
      <SettingsAction
        label="Save and restart pxpipe"
        actionLabel="Save"
        disabled={settings.saving}
        onPress={() => void save()}
      />
      <SettingsAction label="Discard changes" actionLabel="Discard" disabled={settings.saving} onPress={onClose} />
    </SettingsCard>
  );
}

export function AdvancedSection({
  settings,
  theme,
  compact,
}: {
  settings: ReadyConfig;
  theme: Theme;
  compact: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const close = () => {
    setEditing(false);
    void settings.reload();
  };
  return (
    <SettingsSection
      title="Advanced"
      info="Changing these restarts a pxpipe this plugin started. Routed agents fall back to direct while it restarts. A pxpipe that was already running keeps its own launch settings."
    >
      <SettingsCard>
        <SettingsSwitch
          label="Use an existing pxpipe"
          hint="If a pxpipe already answers on the port, route through it instead of starting one. Model and compression changes then also apply to that pxpipe's other users and persist in its own config."
          value={settings.values.adoptExisting}
          disabled={settings.saving}
          onValueChange={(adoptExisting) =>
            void settings.save({ ...settings.values, adoptExisting }, settings.revision)
          }
        />
        <SettingsSwitch
          label="Persist session state"
          hint="PXPIPE_SESSION_STATE. Keeps history-freeze decisions across restarts."
          value={settings.values.sessionState}
          disabled={settings.saving}
          onValueChange={(sessionState) => void settings.save({ ...settings.values, sessionState }, settings.revision)}
        />
        <SettingsSwitch
          label="Capture 4xx request bodies"
          hint="PXPIPE_DEBUG_CAPTURE_4XX. Writes failing request bodies to ~/.pxpipe. They can contain prompts."
          value={settings.values.captureErrorBodies}
          disabled={settings.saving}
          onValueChange={(captureErrorBodies) =>
            void settings.save({ ...settings.values, captureErrorBodies }, settings.revision)
          }
        />
        <SettingsAction
          label="Launch settings"
          hint={`Port ${settings.values.port}${settings.values.command ? ` · ${settings.values.command}` : ""}`}
          actionLabel={editing ? "Close" : "Edit"}
          onPress={() => (editing ? close() : setEditing(true))}
        />
      </SettingsCard>
      {editing ? <LaunchEditor settings={settings} theme={theme} compact={compact} onClose={close} /> : null}
    </SettingsSection>
  );
}
