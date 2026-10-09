"use client";

import { FlaskConical } from "lucide-react";
import { useEffect, useState } from "react";
import { workflowError, type RunnerWorkflow } from "../lib/runner-workflow";
import { insertWorkflowStep, isTrigger, removeWorkflowStep } from "../lib/runner-node-catalog";
import { RunnerNodePicker } from "./runner-node-picker";
import { RunnerWorkflowCanvas } from "./runner-workflow-canvas";
import { RunnerWorkflowFields } from "./runner-workflow-fields";
import { RunnerExecutions } from "./runner-executions";
import { RunnerWorkflowToolbar } from "./runner-workflow-toolbar";
import { useWorkflowExecution } from "../hooks/use-workflow-execution";
import type { WorkflowExecutionApi } from "../lib/workflow-executions";
import { Button } from "./ui/button";
import { Text } from "./ui/text";
import styles from "./runner-workflow.module.css";
import { eventSource } from "@spool/workflow";

export function RunnerWorkflowEditor({ initial, onSave, onBack, onDirtyChange, onBrowse, onBrowseFile, agents = [], agentsError, executions }: {
  initial: RunnerWorkflow; onSave: (value: RunnerWorkflow) => Promise<RunnerWorkflow>; onBack: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onBrowse: (signal: AbortSignal) => Promise<string | null>;
  onBrowseFile: (signal: AbortSignal) => Promise<string | null>;
  agents?: string[]; agentsError?: string; executions?: WorkflowExecutionApi;
}) {
  const [value, setValue] = useState(initial), [baseline, setBaseline] = useState(initial);
  const [selected, setSelected] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ trigger: boolean; after?: string } | null>(null);
  const [canvasContainer, setCanvasContainer] = useState<HTMLDivElement | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState<string>(), [saved, setSaved] = useState(false);
  const [showExecutions, setShowExecutions] = useState(false), [view, setView] = useState("editor");
  const automatic = value.kind === "managed" || !!eventSource(value);
  const runs = useWorkflowExecution(executions, value.revision);
  const dirty = JSON.stringify(value) !== JSON.stringify(baseline), invalid = workflowError(value);
  const canRun = !!executions && !automatic && !dirty && !pending && !!value.revision && !runs.active && !invalid;
  const execute = () => { setShowExecutions(true); if (canRun) runs.run(); };
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const change = (next: RunnerWorkflow) => { if (!pending) { setValue(next); setSaved(false); } };
  const save = async () => {
    if (invalid) { setError(invalid); return; }
    setPending(true); setError(undefined);
    try { const result = await onSave(value); setValue(result); setBaseline(result); setSaved(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save runner."); }
    finally { setPending(false); }
  };
  const remove = (id: string) => {
    change(removeWorkflowStep(value, id));
    setSelected(null);
  };
  return <main className={styles.editor} aria-label="Runner editor">
    <RunnerWorkflowToolbar name={value.name} pending={pending} dirty={dirty || !baseline.revision} saved={saved} managed={automatic && !executions}
      view={view} onView={next => { setView(next); setPicker(null); }} onBack={onBack} onSettings={() => setSelected("settings")} onSave={() => void save()} />
    {error && <Text role="alert" className={styles.notice}>{error}</Text>}
    <div className={styles.workspace} ref={setCanvasContainer} hidden={view !== "editor"}>
    <RunnerWorkflowCanvas value={value} onChange={change} onEdit={setSelected} execution={runs.execution}
      onAdd={after => { if (!pending) setPicker({ trigger: !value.nodes.some(isTrigger), after }); }} />
    {!automatic && <Button variant="primary" className={styles.execute} disabled={!canRun} onClick={execute}
      title={dirty ? "Save changes before executing" : "Runs real actions, including when disabled"}>
      <FlaskConical className={styles.icon} />{runs.active ? "Executing..." : "Execute workflow"}
    </Button>}
    {picker && <RunnerNodePicker container={canvasContainer} trigger={picker.trigger} source={eventSource(value)} existing={value.kind === "managed"}
      onClose={() => setPicker(null)} onSelect={choice => {
      const next = insertWorkflowStep(value, choice, picker.after);
      change(next); setPicker(null);
      setSelected(picker.trigger ? next.nodes.find(isTrigger)!.id : next.nodes.at(-1)!.id);
    }} />}
    </div>
    {selected && <RunnerWorkflowFields key={selected} value={value} selected={selected} onChange={change} onBrowse={onBrowse} onBrowseFile={onBrowseFile}
      execution={runs.execution} webhookUrl={executions?.webhookUrl}
      agents={agents} agentsError={agentsError} onChangeTrigger={() => { setSelected(null); setPicker({ trigger: true }); }}
      onClose={() => setSelected(null)} onRemove={remove} />}
    {(!automatic || executions) && <RunnerExecutions state={runs} open={showExecutions || view === "executions"} full={view === "executions"} dirty={dirty} automatic={automatic}
      canRun={canRun} onRun={execute} onToggle={() => {
        if (view === "executions") { setView("editor"); setShowExecutions(false); }
        else setShowExecutions(open => !open);
      }} />}
  </main>;
}
