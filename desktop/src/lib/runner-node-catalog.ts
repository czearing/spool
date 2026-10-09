import type { RunnerWorkflow, WorkflowStep } from "./runner-workflow";
import { isTrigger, type NodeChoice } from "@spool/workflow";
export { nodeCatalog, isTrigger, stepDefinition, repositoryOperations, type NodeChoice, type RepositoryOperation } from "@spool/workflow";
export function insertWorkflowStep(value: RunnerWorkflow, choice: NodeChoice, after?: string): RunnerWorkflow {
  const trigger = choice.group === "Triggers", current = value.nodes.find(isTrigger);
  if (trigger && current) return { ...value, nodes: value.nodes.map(node => node.id === current.id
    ? { id: node.id, kind: choice.kind, operation: choice.operation, label: choice.label, position: node.position,
      ...Object.fromEntries(choice.fields.map(field => [field.key, field.defaultValue ?? field.options?.[0] ?? ""])) } : node) };
  let previous = value.nodes.find(node => node.id === after) ??
    value.nodes.find(node => !value.edges.some(edge => edge.source === node.id));
  if (previous?.kind === "agent") {
    const incoming = value.edges.find(edge => edge.target === previous?.id);
    previous = value.nodes.find(node => node.id === incoming?.source);
  }
  const next = value.edges.find(edge => edge.source === previous?.id);
  const id = `step-${crypto.randomUUID()}`;
  const node: WorkflowStep = { id, kind: choice.kind, label: choice.label,
    ...("operation" in choice ? { operation: choice.operation } : {}),
    ...Object.fromEntries(choice.fields.map(field => [field.key, field.defaultValue ?? field.options?.[0] ??
      (field.key === "prompt" && choice.operation?.endsWith("-event") ? "{{event.prompt}}" : "")])),
    position: { x: previous ? previous.position.x + 224 : 0, y: previous?.position.y ?? 0 } };
  return { ...value, nodes: [...value.nodes.map(step => next && step.position.x > (previous?.position.x ?? 0)
    ? { ...step, position: { ...step.position, x: step.position.x + 224 } } : step), node],
    edges: [...value.edges.filter(edge => edge !== next),
      ...(previous ? [{ id: `edge-${crypto.randomUUID()}`, source: previous.id, target: id }] : []),
      ...(next ? [{ id: `edge-${crypto.randomUUID()}`, source: id, target: next.target }] : [])] };
}
export function removeWorkflowStep(value: RunnerWorkflow, id: string): RunnerWorkflow {
  const before = value.edges.find(edge => edge.target === id), after = value.edges.find(edge => edge.source === id);
  return { ...value, nodes: value.nodes.filter(node => node.id !== id),
    edges: [...value.edges.filter(edge => edge.source !== id && edge.target !== id),
      ...(before && after ? [{ id: `edge-${crypto.randomUUID()}`, source: before.source, target: after.target }] : [])] };
}
