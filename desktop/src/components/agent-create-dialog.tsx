"use client";

import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { useCreateAgent, type AgentDraft } from "../hooks/use-create-agent";
import { useModelCatalog } from "../hooks/use-model-settings";
import { AgentSettingsFields, type AgentFields } from "./agent-settings-fields";
import { Dialog } from "./ui/dialog";
import { Input } from "./ui/input";
import { Dropdown, type DropdownOption } from "./ui/dropdown";
import { Button } from "./ui/button";
import { Text } from "./ui/text";
import { Stack } from "./ui/stack";
import { Pivot, PivotContent, PivotList, PivotTrigger } from "./ui/pivot";
import { AgentImportPane } from "./agent-import-pane";
import { useAgentImport } from "../hooks/use-agent-import";

type Props = Pick<ComponentProps<typeof Dialog>, "open" | "onOpenChange" | "onCloseAutoFocus">;
export function AgentCreateDialogView({ options, pending, loading, error, onCreate, importPanel, onMethodChange, ...dialog }: Props & {
  options: readonly DropdownOption[]; pending?: boolean; loading?: boolean; error?: string; onCreate: (draft: AgentDraft) => void;
  importPanel?: { content: ReactNode; footer: ReactNode; pending: boolean };
  onMethodChange?: (method: string) => void;
}) {
  const id = useId();
  const [name, setName] = useState(""), [model, setModel] = useState<string | null>(null);
  const [fields, setFields] = useState<AgentFields>({ image: null, maxConcurrentRuns: 1 });
  const [imageBusy, setImageBusy] = useState(false);
  const [mode, setMode] = useState("new");
  const busy = pending || imageBusy || importPanel?.pending;
  const validLimit = fields.maxConcurrentRuns === null || Number.isSafeInteger(fields.maxConcurrentRuns) && fields.maxConcurrentRuns > 0;
  return <Dialog {...dialog} presentation="form" title="Add agent" onOpenChange={(open) => { if (!busy) dialog.onOpenChange?.(open); }}
    footer={mode === "import" ? importPanel?.footer :
      <Button variant="primary" type="submit" form={id} disabled={busy || !validLimit || !name.trim()}>{pending ? "Creating..." : "Create agent"}</Button>}>
    <Pivot value={mode} onValueChange={value => { setMode(value); onMethodChange?.(value); }}>
      <PivotList label="Add agent method"><PivotTrigger value="new" disabled={busy}>New agent</PivotTrigger>
        {importPanel && <PivotTrigger value="import" disabled={busy}>Import from project</PivotTrigger>}</PivotList>
      <PivotContent value="new" forceMount hidden={mode !== "new"}>
      <Stack asChild gap={4}><form id={id} onSubmit={(event) => {
      event.preventDefault();
      if (!validLimit || busy || !name.trim()) return;
      onCreate({ name, model, image: fields.image, max_concurrent_runs: fields.maxConcurrentRuns });
    }}>
      <Input label="Name" placeholder="researcher" required pattern="[a-z][a-z0-9-]{0,63}" maxLength={64}
        description="Lowercase letters, numbers and hyphens." value={name} disabled={pending}
        onChange={(event) => setName(event.target.value)} />
      <AgentSettingsFields value={fields} disabled={pending} onBusyChange={setImageBusy}
        onChange={(value) => setFields((fields) => ({ ...fields, ...value }))} />
      <Dropdown label="Model" value={model ?? "inherit"} disabled={pending || loading}
        options={[{ value: "inherit", label: "Use project default" }, ...options]}
        onValueChange={(value) => setModel(value === "inherit" ? null : value)} />
      {error && <Text role="alert">{error}</Text>}
    </form></Stack></PivotContent>
      {importPanel && <PivotContent value="import" forceMount hidden={mode !== "import"}>{importPanel.content}</PivotContent>}
    </Pivot>
  </Dialog>;
}
export function AgentCreateDialog({ project, onCreated, ...dialog }: Props & { project: string; onCreated: (name: string, editPrompt?: boolean) => void }) {
  const [method, setMethod] = useState("new");
  const mutation = useCreateAgent(project), catalog = useModelCatalog(!!dialog.open);
  const imported = useAgentImport(project, !!dialog.open && method === "import", name => { dialog.onOpenChange?.(false); onCreated(name); });
  const importId = useId(), preview = imported.preview;
  return <AgentCreateDialogView {...dialog} onMethodChange={setMethod} options={catalog.data ?? []} pending={mutation.isPending}
    loading={catalog.isPending} error={mutation.error?.message ?? catalog.error?.message}
    onCreate={(draft) => mutation.mutate(draft, { onSuccess: (agent) => { dialog.onOpenChange?.(false); onCreated(agent.name, true); } })}
    importPanel={{ pending: imported.mutation.isPending,
      content: <AgentImportPane id={importId} catalog={imported.catalog.data} source={imported.source} preview={preview.data}
        loading={imported.catalog.isPending} previewLoading={preview.isFetching} pending={imported.mutation.isPending}
        error={imported.mutation.error?.message ?? imported.catalog.error?.message ?? preview.error?.message}
        onSelect={imported.select} onImport={input => imported.mutation.mutate(input)}
        onReload={() => { imported.mutation.reset(); void imported.catalog.refetch(); if (imported.source) void preview.refetch(); }} />,
      footer: <Button variant="primary" type="submit" form={importId}
        disabled={!preview.data || preview.isFetching || !!preview.error || imported.mutation.isPending}>
        {imported.mutation.isPending ? "Importing..." : "Import agent"}</Button>,
    }} />;
}
