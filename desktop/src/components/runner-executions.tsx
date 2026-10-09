"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, FlaskConical, RefreshCw } from "lucide-react";
import type { WorkflowExecutionState } from "../hooks/use-workflow-execution";
import { RunnerNodeData } from "./runner-node-data";
import { Button } from "./ui/button";
import { Dropdown } from "./ui/dropdown";
import { Textarea } from "./ui/textarea";
import { Stack } from "./ui/stack";
import { Grid } from "./ui/grid";
import { Text } from "./ui/text";
import { Toolbar, ToolbarButton } from "./ui/toolbar";
import styles from "./runner-executions.module.css";

export function RunnerExecutions({ state, open, full, dirty, onToggle, onRun, canRun, automatic = false }: {
  state: WorkflowExecutionState; open: boolean; full: boolean; dirty: boolean; onToggle: () => void;
  onRun: () => void; canRun: boolean; automatic?: boolean;
}) {
  const [stepId, setStepId] = useState("");
  const { execution, error } = state;
  const step = execution?.steps.find(item => item.id === stepId) || execution?.steps.at(-1);
  return <section className={styles.panel} data-full={full || undefined} aria-label="Workflow executions">
    <Stack direction="row" align="center" justify="space-between" gap={2} className={styles.bar}>
      <Toolbar density="compact" aria-label="Execution log"><ToolbarButton asChild><Button onClick={onToggle} aria-expanded={open} aria-controls="workflow-log-body">
        Logs {open ? <ChevronDown /> : <ChevronUp />}
      </Button></ToolbarButton></Toolbar>
      <Stack direction="row" align="center" gap={2}>
        {execution && <Text variant="meta" role="status">Execution {execution.status}</Text>}
        <Toolbar density="compact" aria-label="Execution actions"><ToolbarButton asChild><Button aria-label="Refresh executions" onClick={state.refresh}><RefreshCw /></Button></ToolbarButton></Toolbar>
      </Stack>
    </Stack>
    {open && <div id="workflow-log-body" className={styles.body}>
      {error && <Text role="alert" className={styles.error}>{error.message}</Text>}
      <Grid gap={0} className={styles.columns}>
        <Stack gap={4} className={styles.list}>
          <Dropdown label="Execution" value={state.selected} onValueChange={state.setSelected}
            options={[...state.list, ...(execution && !state.list.some(run => run.id === execution.id) ? [execution] : [])]
              .map(run => ({ value: run.id, label: `${new Date(run.createdAt).toLocaleTimeString()} · ${run.id === execution?.id ? execution.status : run.status}` }))} />
          {!automatic && <><Textarea label="Test input (JSON)" rows={4} value={state.input} spellCheck={false} onChange={event => state.setInput(event.target.value)} />
          {dirty && <Text variant="meta" tone="secondary">Save changes before executing.</Text>}
          <Button disabled={!canRun} onClick={onRun}><FlaskConical />{state.active ? "Executing..." : "Execute workflow"}</Button></>}
          {execution?.steps.map(item => <Button key={item.id} className={styles.step} data-selected={item.id === step?.id || undefined}
            onClick={() => setStepId(item.id)}><span>{item.label}</span><Text variant="meta" tone="secondary">{item.status}</Text></Button>)}
          <Text variant="meta" tone="muted">{automatic ? "Events run automatically." : "Runs real actions."} Data is stored locally.</Text>
        </Stack>
        <Grid gap={0} className={styles.data}>
          <RunnerNodeData title="Input" available={!!step} value={step?.input} />
          <RunnerNodeData title="Output" available={!!step && "output" in step} value={step?.output} error={step?.error || execution?.error} />
        </Grid>
      </Grid>
    </div>}
  </section>;
}
