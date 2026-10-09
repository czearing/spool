"use client";

import { BaseEdge, EdgeLabelRenderer, getBezierPath, getSmoothStepPath, type Edge, type EdgeProps } from "@xyflow/react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "./ui/button";
import { Stack } from "./ui/stack";
import styles from "./runner-workflow.module.css";

export type WorkflowEdge = Edge<{ onAdd: () => void; onRemove: () => void; managed: boolean; canAdd: boolean }, "workflow">;
export function RunnerWorkflowEdge(props: EdgeProps<WorkflowEdge>) {
  const [path, x, y] = props.data?.managed ? getSmoothStepPath({ ...props, offset: 64, borderRadius: 12 }) : getBezierPath(props);
  return <>
    <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} style={props.style} interactionWidth={24} />
    {props.selected && !props.data?.managed && <EdgeLabelRenderer>
      <Stack direction="row" gap={1} className={`${styles.edgeTools} nodrag nopan`}
        style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}>
        <Button aria-label="Insert action on connection" disabled={!props.data?.canAdd} onClick={props.data?.onAdd}>
          <Plus className={styles.icon} aria-hidden="true" /></Button>
        <Button aria-label="Delete connection" onClick={props.data?.onRemove}><Trash2 className={styles.icon} aria-hidden="true" /></Button>
      </Stack>
    </EdgeLabelRenderer>}
  </>;
}
