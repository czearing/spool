"use client";

import { useState, type ComponentProps, type ReactNode } from "react";
import { themes } from "../lib/theme";
import { useModelSettings } from "../hooks/use-model-settings";
import { useSettings } from "./settings-provider";
import { Dialog } from "./ui/dialog";
import { Dropdown, type DropdownOption } from "./ui/dropdown";
import { Stack } from "./ui/stack";
import { Text } from "./ui/text";
import { Button } from "./ui/button";
import { AgentSettingsFields } from "./agent-settings-fields";

type DialogProps = {
  open: boolean; onOpenChange: (open: boolean) => void; onCloseAutoFocus?: ComponentProps<typeof Dialog>["onCloseAutoFocus"];
};
export function SettingsDialogView({ agent, model, options, loading, pending, error, onModelChange, onSave, onReload, children, ...dialog }: DialogProps & {
  agent?: string; model: string | null; options: readonly DropdownOption[]; loading?: boolean; pending?: boolean;
  error?: string; onModelChange: (model: string | null) => void; onSave: () => void; onReload: () => void; children?: ReactNode;
}) {
  const choices = [...(agent ? [{ value: "inherit", label: "Use project default" }] : []), ...options];
  if (model && !choices.some(({ value }) => value === model)) choices.push({ value: model, label: model });
  return <Dialog {...dialog} title={agent ? "Agent settings" : "Settings"}
    onOpenChange={(open) => { if (!pending) dialog.onOpenChange(open); }}
    footer={<Button variant="primary" onClick={onSave} disabled={loading || pending || !!error}>{pending ? "Saving..." : "Save settings"}</Button>}>
    <Stack gap={6}>
      {children}
      <Dropdown label={agent ? "Model" : "Default agent model"} value={model ?? (agent ? "inherit" : "")}
        options={choices} disabled={loading || pending} placeholder="Loading models..."
        onValueChange={(value) => onModelChange(value === "inherit" ? null : value)} />
      {error && <Stack gap={2}><Text role="alert">{error}</Text><Button onClick={onReload} disabled={pending}>Reload settings</Button></Stack>}
    </Stack>
  </Dialog>;
}
export function SettingsDialog({ project, agent, ...dialog }: DialogProps & { project: string; agent?: string }) {
  const { settings, ready, error, update } = useSettings();
  const model = useModelSettings(project, agent, dialog.open);
  const [imageBusy, setImageBusy] = useState(false);
  const limit = model.draft?.maxConcurrentRuns;
  const invalidLimit = agent && limit !== undefined && limit !== null && (!Number.isSafeInteger(limit) || limit < 1);
  const save = async () => {
    try { await model.save(); dialog.onOpenChange(false); }
    catch { /* The mutation exposes the server error without closing the dialog. */ }
  };
  return <SettingsDialogView {...dialog} agent={agent} model={model.draft?.model ?? null} options={model.options}
    loading={!ready || model.loading || !!invalidLimit} pending={model.pending || imageBusy} error={model.error}
    onModelChange={model.setModel} onSave={() => void save()} onReload={model.reload}>
    {!agent && <Dropdown label="Appearance" value={settings.theme} disabled={!ready}
      options={themes.map((theme) => ({ value: theme, label: theme[0].toUpperCase() + theme.slice(1) }))}
      onValueChange={(value) => { const theme = themes.find((theme) => theme === value); if (theme) update({ theme }); }} />}
    {!agent && error && <Text role="alert">{error}</Text>}
    {agent && model.draft && <AgentSettingsFields value={{ image: model.draft.image ?? null,
      maxConcurrentRuns: model.draft.maxConcurrentRuns ?? null }}
      onChange={model.setAgent} disabled={model.pending || model.loading} onBusyChange={setImageBusy} />}
    {invalidLimit && <Text role="alert">Enter a whole-number run limit of at least 1.</Text>}
  </SettingsDialogView>;
}
