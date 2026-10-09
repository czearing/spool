"use client";

import { Background, ReactFlow, ReactFlowProvider, Panel, MarkerType, useReactFlow, useStore, applyNodeChanges, applyEdgeChanges,
  type Connection, type NodeChange } from "@xyflow/react";
import { Maximize, ZoomOut, ZoomIn, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { RunnerWorkflow } from "../lib/runner-workflow";
import type { WorkflowRun } from "../lib/workflow-executions";
import { isTrigger, removeWorkflowStep } from "../lib/runner-node-catalog";
import { runnerInterval } from "../lib/runners";
import { RunnerWorkflowNode, type WorkflowNode } from "./runner-workflow-node";
import { RunnerWorkflowEdge, type WorkflowEdge } from "./runner-workflow-edge";
import { Button } from "./ui/button";
import { Stack } from "./ui/stack";
import { Text } from "./ui/text";
import { Toolbar, ToolbarButton } from "./ui/toolbar";
import styles from "./runner-workflow.module.css";
import "@xyflow/react/dist/style.css";
import { stepDefinition } from "@spool/workflow";

const nodeTypes = { step: RunnerWorkflowNode };
const edgeTypes = { workflow: RunnerWorkflowEdge };
function CanvasTools({ onAdd, managed, count }: { onAdd: () => void; managed: boolean; count: number }) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const width = useStore(state => state.width), height = useStore(state => state.height);
  useEffect(() => {
    if (!width || !height) return;
    const frame = requestAnimationFrame(() => void fitView({ padding: 0.4, maxZoom: 1 }));
    return () => cancelAnimationFrame(frame);
  }, [width, height, count, fitView]);
  return <>
    {!managed && <Panel position="top-right"><Toolbar density="compact" aria-label="Workflow actions" className={styles.tools}>
      <ToolbarButton asChild><Button onClick={onAdd} disabled={count >= 32} aria-label="Add step" title="Add node"><Plus className={styles.icon} aria-hidden="true" /></Button></ToolbarButton>
    </Toolbar></Panel>}
    <Panel position="bottom-left"><Toolbar density="compact" aria-label="Canvas controls" className={styles.tools}>
      <ToolbarButton asChild><Button aria-label="Fit workflow" onClick={() => void fitView({ padding: 0.4, maxZoom: 1 })}><Maximize className={styles.icon} /></Button></ToolbarButton>
      <ToolbarButton asChild><Button aria-label="Zoom in" onClick={() => void zoomIn()}><ZoomIn className={styles.icon} /></Button></ToolbarButton>
      <ToolbarButton asChild><Button aria-label="Zoom out" onClick={() => void zoomOut()}><ZoomOut className={styles.icon} /></Button></ToolbarButton>
    </Toolbar></Panel>
  </>;
}
export function RunnerWorkflowCanvas({ value, onChange, onEdit, onAdd, execution }: {
  value: RunnerWorkflow; onChange: (value: RunnerWorkflow) => void; onEdit: (id: string) => void;
  onAdd: (after?: string) => void; execution?: WorkflowRun;
}) {
  const managed = value.nodes.some(node => !!node.block);
  const [selection, setSelection] = useState<{ nodes: Set<string>; edges: Set<string> }>({ nodes: new Set(), edges: new Set() });
  const nodes: WorkflowNode[] = useMemo(() => value.nodes.map(step => ({
    id: step.id, type: "step", position: step.position, width: 96, height: 96,
    selected: selection.nodes.has(step.id), deletable: !managed && !isTrigger(step),
    data: { step, managed, onEdit, onAdd, status: execution?.steps.find(item => item.id === step.id)?.status,
      onRemove: id => onChange(removeWorkflowStep(value, id)),
      canAdd: !managed && step.kind !== "agent" && value.nodes.length < 32 &&
      !value.edges.some(edge => edge.source === step.id),
      summary: step.operation ? stepDefinition(step)?.label || step.operation : step.block ? step.label : step.kind === "schedule" ? runnerInterval(value.intervalSeconds) :
        step.kind === "file-change" ? step.path || "Choose a file" :
        step.kind === "repository" ? "Bohemia" : step.kind === "agent" ? step.agent || "Choose an agent" :
        step.kind === "command" ? "PowerShell" : step.kind === "runner" ? "Managed scanner" :
        step.kind === "http" ? step.method || "GET" : step.kind === "webhook" ? "POST · authenticated" :
        step.kind === "manual" ? "On demand" : step.kind === "filter" ? step.field || "Configure condition" : "JSON mapping" },
  })), [value, managed, onEdit, onAdd, onChange, selection.nodes, execution]);
  const edges: WorkflowEdge[] = value.edges.map(edge => ({ ...edge, type: "workflow", selected: selection.edges.has(edge.id), deletable: !managed,
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
    data: { managed, canAdd: value.nodes.length < 32, onAdd: () => onAdd(edge.source),
      onRemove: () => onChange({ ...value, edges: value.edges.filter(item => item.id !== edge.id) }) } }));
  const changed = (changes: NodeChange<WorkflowNode>[]) => {
    const selections = changes.filter(change => change.type === "select");
    if (selections.length) setSelection(current => {
      const nodes = new Set(current.nodes);
      for (const change of selections) { if (change.selected) nodes.add(change.id); else nodes.delete(change.id); }
      return { ...current, nodes };
    });
    const edits = changes.filter(change => change.type === "position" || change.type === "remove");
    if (!edits.length) return;
    const updated = applyNodeChanges(edits.filter(change => change.type === "position"), nodes);
    const remaining = edits.filter(change => change.type === "remove").reduce((draft, change) => removeWorkflowStep(draft, change.id), value);
    const kept = new Set(remaining.nodes.map(node => node.id));
    const ids = new Set(updated.map(node => node.id));
    onChange({ ...remaining, nodes: updated.filter(node => kept.has(node.id)).map(node => ({ ...node.data.step, position: node.position })),
      edges: remaining.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)) });
  };
  const connect = (connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target ||
      value.nodes.some(node => node.id === connection.target && isTrigger(node)) ||
      value.nodes.some(node => node.id === connection.source && node.kind === "agent")) return;
    onChange({ ...value, edges: [...value.edges.filter(edge => edge.source !== connection.source && edge.target !== connection.target),
      { id: `edge-${crypto.randomUUID()}`, source: connection.source, target: connection.target }] });
  };
  return <div className={styles.canvas}><ReactFlowProvider><ReactFlow<WorkflowNode, WorkflowEdge> nodes={nodes} edges={edges}
    nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={changed} onEdgesChange={changes => {
      const selections = changes.filter(change => change.type === "select");
      if (selections.length) setSelection(current => {
        const selected = new Set(current.edges);
        for (const change of selections) { if (change.selected) selected.add(change.id); else selected.delete(change.id); }
        return { ...current, edges: selected };
      });
      const edits = changes.filter(change => change.type === "remove");
      if (edits.length) onChange({ ...value, edges: applyEdgeChanges(edits, edges).map(({ id, source, target }) => ({ id, source, target })) });
    }}
    onConnect={connect} nodesConnectable={!managed} edgesReconnectable={false} onNodeDoubleClick={(_event, node) => onEdit(node.id)}
    fitView fitViewOptions={{ padding: 0.4, maxZoom: 1 }} minZoom={0.25} maxZoom={1.5} deleteKeyCode={managed ? null : ["Backspace", "Delete"]}
    panOnScroll selectionOnDrag panOnDrag={[1, 2]} snapToGrid snapGrid={[16, 16]} zoomOnDoubleClick={false} aria-label="Runner workflow"
    onError={(code, message) => console.error(`Workflow canvas ${code}: ${message}`)}>
    <Background gap={16} size={0.65} />
    <CanvasTools onAdd={() => onAdd()} managed={managed || !value.nodes.length} count={value.nodes.length} />
    {!value.nodes.length && <Panel position="top-center" className={styles.emptyCanvas}>
      <Stack align="center" gap={3}>
        <Button className={styles.firstNode} aria-label="Add first step" onClick={() => onAdd()}><Plus aria-hidden="true" /></Button>
        <Text variant="action">Add first step...</Text>
      </Stack>
    </Panel>}
  </ReactFlow></ReactFlowProvider></div>;
}
