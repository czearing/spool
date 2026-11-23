import { nodeCatalog, stepDefinition, type RunnerWorkflow, type WorkflowStep } from "@spool/workflow";
export type { WorkflowStep, WorkflowConnection, RunnerWorkflow } from "@spool/workflow";
export function isRunnerWorkflow(value: unknown): value is RunnerWorkflow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return ["id", "name", "workspace", "revision"].every(key => typeof row[key] === "string") &&
    ["custom", "managed"].includes(String(row.kind)) && typeof row.enabled === "boolean" &&
    typeof row.intervalSeconds === "number" && Array.isArray(row.nodes) && Array.isArray(row.edges) &&
    row.nodes.every(node => node && typeof node.id === "string" && typeof node.label === "string" &&
      ["runner", ...nodeCatalog.map(item => item.kind)].includes(node.kind) &&
      node.position && Number.isFinite(node.position.x) && Number.isFinite(node.position.y) &&
      (node.block === undefined || typeof node.block === "string" && !!stepDefinition(node as WorkflowStep)) &&
      [...nodeCatalog.flatMap(item => item.fields), ...(stepDefinition(node as WorkflowStep)?.fields || [])]
        .every(field => node[field.key] === undefined || typeof node[field.key] === "string") &&
      (node.operation === undefined || nodeCatalog.some(item => item.kind === node.kind && item.operation === node.operation))) &&
    row.edges.every(edge => edge && ["id", "source", "target"].every(key => typeof edge[key] === "string"));
}
