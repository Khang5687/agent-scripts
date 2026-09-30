import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSwitch,
  type SettingsInputHandle,
} from "@getpaseo/plugin/client/ui";
import { useRef, useState } from "react";
import { DEFAULT_MODELS, MODEL_CHOICES } from "../shared/config";
import type { ReadyConfig } from "./styles";

export function ModelsSection({ settings }: { settings: ReadyConfig }) {
  const models = settings.values.models;
  const [draft, setDraft] = useState("");
  const input = useRef<SettingsInputHandle>(null);
  const catalogIds = new Set(MODEL_CHOICES.map((choice) => choice.id));
  const custom = models.filter((id) => !catalogIds.has(id));

  const saveModels = (next: string[]) => void settings.save({ ...settings.values, models: next }, settings.revision);
  const toggle = (id: string, on: boolean) =>
    saveModels(on ? [...models.filter((model) => model !== id), id] : models.filter((model) => model !== id));
  const addCustom = () => {
    const id = draft.trim().toLowerCase();
    if (!id || models.includes(id)) return;
    saveModels([...models, id]);
    input.current?.replaceText("");
    setDraft("");
  };

  return (
    <SettingsSection
      title="Models pxpipe may compress"
      info="Prefix match: `claude-opus-5-5` also covers `claude-opus-5-5-…`. Models outside this list pass through byte-identical. Takes effect on the next request."
    >
      <SettingsCard>
        {MODEL_CHOICES.map((choice) => (
          <SettingsSwitch
            key={choice.id}
            label={choice.label}
            hint={`${choice.id} · ${choice.quality}`}
            value={models.includes(choice.id)}
            disabled={settings.saving}
            onValueChange={(on) => toggle(choice.id, on)}
          />
        ))}
        {custom.map((id) => (
          <SettingsSwitch
            key={id}
            label={id}
            hint="Custom model base"
            value
            disabled={settings.saving}
            onValueChange={(on) => toggle(id, on)}
          />
        ))}
      </SettingsCard>
      <SettingsCard>
        <SettingsInput
          ref={input}
          label="Add a model base"
          hint="Any model id pxpipe should image, for example claude-fable-5-1."
          placeholder="model-id"
          onChangeText={setDraft}
          disabled={settings.saving}
        />
        <SettingsAction
          label="Add model"
          actionLabel="Add"
          disabled={!draft.trim() || settings.saving}
          onPress={addCustom}
        />
        <SettingsAction
          label="Restore defaults"
          hint={DEFAULT_MODELS.join(", ")}
          actionLabel="Restore"
          disabled={settings.saving}
          onPress={() => saveModels([...DEFAULT_MODELS])}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
