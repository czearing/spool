"use client";

import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { RunnerWorkflow, WorkflowStep } from "../lib/runner-workflow";
import type { WorkflowRun } from "../lib/workflow-executions";
import { isTrigger, stepDefinition } from "../lib/runner-node-catalog";
import { stepIcon } from "./runner-node-picker";
import { Dialog } from "./ui/dialog";
import { Input } from "./ui/input";
import { Checkbox } from "./ui/checkbox";
import { FilePicker } from "./ui/file-picker";
import { RunnerBlockFields } from "./runner-block-fields";
import { RunnerNodeData } from "./runner-node-data";
import { RunnerPromptDetails } from "./runner-prompt-details";
import { Dropdown } from "./ui/dropdown";
import { Stack } from "./ui/stack";
import { Text } from "./ui/text";
import { Button } from "./ui/button";
import { Toolbar, ToolbarToggleGroup, ToolbarToggleItem } from "./ui/toolbar";
import styles from "./runner-node-details.module.css";
import { eventSource } from "@spool/workflow";

function ScheduleFields({ value, onChange }: { value: number; onChange: (seconds: number) => void }) {
  const [unit, setUnit] = useState(value % 3600 === 0 ? 3600 : value % 60 === 0 ? 60 : 1);
  return <Stack gap={4}>
    <Dropdown label="Trigger interval" value={String(unit)} options={[
      { value: "1", label: "Seconds" }, { value: "60", label: "Minutes" }, { value: "3600", label: "Hours" },
    ]} onValueChange={next => { const scale = Number(next); onChange(value / unit * scale); setUnit(scale); }} />
    <Input label="Check every" type="number" min={1} step={1} value={Number.isFinite(value) ? value / unit : ""}
      onChange={event => onChange(event.target.valueAsNumber * unit)} />
  </Stack>;
}
export function RunnerWorkflowFields({ value, selected, onChange, onClose, onRemove, onBrowse, onBrowseFile, onChangeTrigger, agents, agentsError, execution, webhookUrl }: {
  value: RunnerWorkflow; selected: string; onChange: (value: RunnerWorkflow) => void; onClose: () => void; onRemove: (id: string) => void;
  onBrowse: (signal: AbortSignal) => Promise<string | null>;
  onBrowseFile: (signal: AbortSignal) => Promise<string | null>;
  onChangeTrigger: () => void; agents: string[]; agentsError?: string; execution?: WorkflowRun; webhookUrl?: string;
}) {
  const [tab, setTab] = useState("parameters");
  const source = eventSource(value);
  const step = value.nodes.find(node => node.id === selected), settings = selected === "settings";
  if (!step && !settings) return null;
  const update = (patch: Partial<WorkflowStep>) => onChange({ ...value,
    ...(patch.operation === "update-requested" ? { workspace: "" } : {}),
    nodes: value.nodes.map(node => node.id === selected ? { ...node, ...patch } : node) });
  const workspace = (label: string) => <FilePicker label={label} value={value.workspace} kind="folder" onBrowse={onBrowse}
    onValueChange={workspace => onChange({ ...value, workspace })} />;
  if (settings) return <Dialog open title="Runner settings" onOpenChange={open => { if (!open) onClose(); }}
    footer={<Button onClick={onClose}>Done</Button>}>
    <Stack gap={4}>
      <Input label="Runner name" value={value.name} maxLength={80} onChange={event => onChange({ ...value, name: event.target.value })} />
      {source === "pr-updater" ? <Text tone="secondary">Uses each original agent&apos;s workspace.</Text> : workspace("Working directory")}
      <Checkbox label="Enabled" checked={value.enabled} onCheckedChange={enabled => onChange({ ...value, enabled: enabled === true })} />
    </Stack>
  </Dialog>;
  const node = step!, Icon = stepIcon(node), result = execution?.steps.find(item => item.id === node.id);
  const trigger = isTrigger(node), definition = stepDefinition(node);
  return <Dialog open title={node.label} presentation="node" onOpenChange={open => { if (!open) onClose(); }}>
    <Button className={styles.back} onClick={onClose}><ArrowLeft />Back to canvas</Button>
      <div className={styles.parameters}>
        <Stack direction="row" align="center" gap={2} className={styles.nodeHeading}>
          <Icon aria-hidden="true" /><Input label="Step name" labelHidden value={node.label} maxLength={80} onChange={event => update({ label: event.target.value })} />
        </Stack>
        <Toolbar density="compact" className={styles.tabs} aria-label="Node configuration">
          <ToolbarToggleGroup type="single" value={tab} onValueChange={next => { if (next) setTab(next); }} asChild>
            <Stack direction="row" gap={1}>
              <ToolbarToggleItem value="parameters" asChild><Button>Parameters</Button></ToolbarToggleItem>
              <ToolbarToggleItem value="settings" asChild><Button>Settings</Button></ToolbarToggleItem>
            </Stack>
          </ToolbarToggleGroup>
        </Toolbar>
        <Stack gap={6} className={styles.form}>
          {tab === "parameters" ? <>
            {["schedule", "file-change", "azure-devops", "repository-event"].includes(node.kind) && <ScheduleFields value={value.intervalSeconds}
              onChange={intervalSeconds => onChange({ ...value, intervalSeconds })} />}
            <RunnerBlockFields step={node} onChange={update} agents={agents} onBrowseFile={onBrowseFile} source={source} />
            {node.kind === "webhook" && webhookUrl && <details className={styles.help}><summary>Webhook URL</summary>
              <p><code>POST {webhookUrl}</code></p><p>Bearer authentication required. Send a UUID in Idempotency-Key to prevent duplicate events.</p>
            </details>}
            {node.kind === "repository" && source !== "pr-updater" && workspace("Repository directory")}
            {node.kind === "agent" && agentsError && <Text role="alert">{agentsError}</Text>}
            {node.kind === "agent" && <RunnerPromptDetails detail={value.inspection?.[node.id]} />}
            {["manual", "runner"].includes(node.kind) && <Text tone="secondary">{node.kind === "manual"
              ? "Execute the workflow to start this trigger." : `Uses the existing ${value.id} scanner.`}</Text>}
            <details className={styles.help}><summary>About this node</summary>
              <p>{definition?.description || "Managed scanner. Preparation and handoff safeguards stay intact."}</p>
              {definition?.fields.filter(field => field.description).map(field => <p key={field.key}><strong>{field.label}:</strong> {field.description}</p>)}
              <p>Map JSON with {"{{input.field}}"} or {"{{steps.node-id.field}}"}.</p>
              {node.kind === "repository" && <p>Uses the shared Bohemia tools. Occupied workspaces are protected.</p>}
              {node.kind === "agent" && <p>Agent handoff must be last; execution does not wait for agent completion.</p>}
            </details>
          </> : <>
            {source === "pr-updater" ? <Text tone="secondary">Uses the original creator&apos;s assigned checkout.</Text> : workspace("Working directory")}
            {trigger && <Button onClick={onChangeTrigger}>Change trigger</Button>}
            {!trigger && <Button onClick={() => onRemove(node.id)}>Delete step</Button>}
            <Text variant="meta" tone="secondary">Errors stop the workflow. Save changes from the canvas.</Text>
          </>}
          {result && <details className={styles.help}><summary>Last execution</summary>
            <RunnerNodeData title="Input" value={result.input} available />
            <RunnerNodeData title="Output" value={result.output} available={"output" in result} error={result.error} />
          </details>}
        </Stack>
      </div>
  </Dialog>;
}
