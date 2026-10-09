"use client";

import { MoreHorizontal, Server } from "lucide-react";
import { Button } from "./ui/button";
import { Stack } from "./ui/stack";
import { Text } from "./ui/text";
import { Toolbar, ToolbarButton, ToolbarToggleGroup, ToolbarToggleItem } from "./ui/toolbar";
import styles from "./runner-workflow.module.css";

export function RunnerWorkflowToolbar({ name, pending, dirty, saved, view, onView, onBack, onSettings, onSave, managed = false }: {
  name: string; pending: boolean; dirty: boolean; saved: boolean; view: string;
  onView: (value: string) => void; onBack: () => void; onSettings: () => void; onSave: () => void;
  managed?: boolean;
}) {
  return <Stack asChild direction="row" align="center" justify="space-between" gap={3} className={styles.toolbar}><header>
    <Toolbar density="compact" aria-label="Workflow navigation" className={styles.breadcrumb}>
      <ToolbarButton asChild><Button aria-label="Back to runners" onClick={onBack} disabled={pending}>
        <Server className={styles.icon} /><span>Runners</span>
      </Button></ToolbarButton>
      <span className={styles.slash}>/</span>
      <Text asChild><h1 className={styles.title}>{name}</h1></Text>
    </Toolbar>
    {!managed && <Toolbar density="compact" aria-label="Workflow view" className={styles.viewTabs}>
      <ToolbarToggleGroup type="single" value={view} onValueChange={next => { if (next) onView(next); }} asChild>
        <Stack direction="row" gap={1}>
          <ToolbarToggleItem asChild value="editor"><Button>Editor</Button></ToolbarToggleItem>
          <ToolbarToggleItem asChild value="executions"><Button>Executions</Button></ToolbarToggleItem>
        </Stack>
      </ToolbarToggleGroup>
    </Toolbar>}
    <Stack direction="row" align="center" gap={3}>
      {saved && <Text role="status" variant="meta" tone="secondary">Saved</Text>}
      <Stack direction="row" gap={2}>
        <Button variant="primary" disabled={pending || !dirty} onClick={onSave}>{pending ? "Saving..." : "Save"}</Button>
        <Button aria-label="Runner settings" onClick={onSettings} disabled={pending}><MoreHorizontal className={styles.icon} /></Button>
      </Stack>
    </Stack>
  </header></Stack>;
}
