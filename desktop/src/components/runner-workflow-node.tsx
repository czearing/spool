"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Plus, Pencil, Trash2, Zap } from "lucide-react";
import type { WorkflowStep } from "../lib/runner-workflow";
import { isTrigger } from "../lib/runner-node-catalog";
import { stepIcon } from "./runner-node-picker";
import { Button } from "./ui/button";
import { Text } from "./ui/text";
import { Stack } from "./ui/stack";
import { Toolbar, ToolbarButton } from "./ui/toolbar";
import styles from "./runner-workflow.module.css";

export type WorkflowNode = Node<{ step: WorkflowStep; summary: string; onEdit: (id: string) => void;
  onAdd: (id: string) => void; onRemove: (id: string) => void; managed: boolean; canAdd: boolean; status?: string }, "step">;
export function RunnerWorkflowNode({ data, selected }: NodeProps<WorkflowNode>) {
  const { step, summary, onEdit, onAdd, onRemove, managed, canAdd } = data;
  const Icon = stepIcon(step);
  return <div className={styles.node} data-trigger={isTrigger(step) || undefined} data-selected={selected || undefined} data-status={data.status}>
    <Toolbar density="compact" aria-label={`${step.label} actions`} className={`${styles.nodeActions} nodrag nopan`}>
      <ToolbarButton asChild><Button aria-label={`Configure ${step.label}`} onClick={() => onEdit(step.id)}><Pencil /></Button></ToolbarButton>
      {!managed && !isTrigger(step) && <ToolbarButton asChild><Button aria-label={`Delete ${step.label}`} onClick={() => onRemove(step.id)}><Trash2 /></Button></ToolbarButton>}
    </Toolbar>
    {isTrigger(step) && <Zap className={styles.triggerMark} aria-hidden="true" />}
    {!isTrigger(step) && <Handle type="target" position={Position.Left} isConnectable={!managed} />}
    <Button className={styles.nodeButton} title={summary} aria-label={`Edit ${step.label}`} onClick={() => onEdit(step.id)}>
      <Icon aria-hidden="true" />
    </Button>
    <Stack className={styles.nodeDescription} gap={1}>
      <Text className={styles.nodeTitle} variant="action">{step.label}</Text>
      {step.operation && summary !== step.label && <Text variant="meta" tone="secondary">{summary}</Text>}
      {data.status && <Text variant="meta" className={styles.nodeStatus}>{data.status}</Text>}
    </Stack>
    {step.kind !== "agent" && <Handle type="source" position={Position.Right} isConnectable={!managed} />}
    {canAdd && <Button className={`${styles.addNode} nodrag nopan`} aria-label={`Add action after ${step.label}`}
      onClick={() => onAdd(step.id)}><Plus className={styles.icon} aria-hidden="true" /></Button>}
  </div>;
}
