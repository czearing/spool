"use client";

import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { themes } from "../lib/theme";
import { useModelSettings } from "../hooks/use-model-settings";
import { appFetch } from "../platform/request";
import { useRouter } from "../platform/navigation";
import { useSettings } from "./settings-provider";
import { Dialog, DialogClose } from "./ui/dialog";
import { Dropdown, type DropdownOption } from "./ui/dropdown";
import { Stack } from "./ui/stack";
import { Text } from "./ui/text";
import { Button } from "./ui/button";
import { AgentSettingsFields } from "./agent-settings-fields";
import { Switch } from "./ui/switch";

type DialogProps = {
  open: boolean; onOpenChange: (open: boolean) => void; onCloseAutoFocus?: ComponentProps<typeof Dialog>["onCloseAutoFocus"];
};
export function SettingsDialogView({ agent, model, options, loading, pending, error, onModelChange, onSave, onReload,
  projectName, onDeleteProject, deleting, deleteError, autopilot, onAutopilotChange, children, ...dialog }: DialogProps & {
  agent?: string; model: string | null; options: readonly DropdownOption[]; loading?: boolean; pending?: boolean;
  error?: string; onModelChange: (model: string | null) => void; onSave: () => void; onReload: () => void; children?: ReactNode;
  projectName?: string; onDeleteProject?: () => void; deleting?: boolean; deleteError?: string;
  autopilot?: boolean; onAutopilotChange?: (enabled: boolean) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!dialog.open) setConfirming(false); }, [dialog.open]);
  const busy = pending || deleting;
  const choices = [...(agent ? [{ value: "inherit", label: "Use project default" }] : []), ...options];
  if (model && !choices.some(({ value }) => value === model)) choices.push({ value: model, label: model });
  return <><Dialog {...dialog} title={agent ? "Agent settings" : "Settings"}
    onOpenChange={(open) => { if (!busy) dialog.onOpenChange(open); }}
    footer={<Button variant="primary" onClick={onSave} disabled={loading || busy || !!error}>{pending ? "Saving..." : "Save settings"}</Button>}>
    <Stack gap={6}>
      {children}
      <Dropdown label={agent ? "Model" : "Default agent model"} value={model ?? (agent ? "inherit" : "")}
        options={choices} disabled={loading || busy} placeholder="Loading models..."
        onValueChange={(value) => onModelChange(value === "inherit" ? null : value)} />
      {!agent && onAutopilotChange && <Switch label="Autopilot" description="Use task-scoped objectives for new sessions."
        checked={autopilot ?? false} onCheckedChange={onAutopilotChange} disabled={loading || busy} />}
      {error && <Stack gap={2}><Text role="alert">{error}</Text><Button onClick={onReload} disabled={busy}>Reload settings</Button></Stack>}
      {!agent && onDeleteProject && <Button ref={deleteTrigger} disabled={busy} onClick={() => setConfirming(true)}>Delete active project</Button>}
    </Stack>
  </Dialog>
    {!agent && onDeleteProject && <Dialog open={dialog.open && confirming} onOpenChange={(open) => { if (!deleting) setConfirming(open); }}
      title="Delete active project?"
      onCloseAutoFocus={(event) => { event.preventDefault(); deleteTrigger.current?.focus(); }}
      description={`Remove ${projectName ? `"${projectName}"` : "the active project"} from Spool? Project files, job history, and agent workspaces are kept. Running agents are not stopped. Unsaved changes will be discarded.`}
      footer={<><DialogClose asChild><Button disabled={deleting}>Cancel</Button></DialogClose>
        <Button variant="primary" disabled={deleting} onClick={onDeleteProject}>{deleting ? "Deleting..." : "Delete project"}</Button></>}>
      {deleteError && <Text role="alert">{deleteError}</Text>}
    </Dialog>}
  </>;
}
export function SettingsDialog({ project, projectName, agent, ...dialog }: DialogProps & { project: string; projectName?: string; agent?: string }) {
  const { settings, ready, error, update } = useSettings();
  const router = useRouter(), client = useQueryClient();
  const model = useModelSettings(project, agent, dialog.open);
  const [imageBusy, setImageBusy] = useState(false);
  const [deleting, setDeleting] = useState(false), [deleteError, setDeleteError] = useState<string>();
  const limit = model.draft?.maxConcurrentRuns;
  const invalidLimit = agent && limit !== undefined && limit !== null && (!Number.isSafeInteger(limit) || limit < 1);
  const save = async () => {
    try { await model.save(); dialog.onOpenChange(false); }
    catch { /* The mutation exposes the server error without closing the dialog. */ }
  };
  const remove = async () => {
    setDeleting(true); setDeleteError(undefined);
    try {
      const response = await appFetch(`/api/projects/${encodeURIComponent(project)}`, { method: "DELETE" });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error(result && typeof result === "object" && "error" in result && typeof result.error === "string"
        ? result.error : "Could not delete the project. Try again.");
      if (!result || typeof result !== "object" || !("nextProject" in result)
        || (result.nextProject !== null && typeof result.nextProject !== "string")) throw new Error("Invalid project deletion response. Reload Spool.");
      dialog.onOpenChange(false);
      client.removeQueries({ predicate: query => query.queryKey[1] === project });
      void client.invalidateQueries({ queryKey: ["desktop-page"] });
      router.replace(result.nextProject ? `/${result.nextProject}` : "/");
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally { setDeleting(false); }
  };
  return <SettingsDialogView {...dialog} agent={agent} model={model.draft?.model ?? null} options={model.options}
    loading={!ready || model.loading || !!invalidLimit} pending={model.pending || imageBusy} error={model.error}
    projectName={projectName} onDeleteProject={agent ? undefined : () => void remove()} deleting={deleting} deleteError={deleteError}
    autopilot={model.draft?.autopilot} onAutopilotChange={model.setAutopilot}
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
