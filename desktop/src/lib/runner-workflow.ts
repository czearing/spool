import { nodeCatalog, stepDefinition, validateWorkflow, eventSource, type RunnerWorkflow, type WorkflowStep } from "@spool/workflow";
export type { WorkflowStep, WorkflowConnection, RunnerWorkflow } from "@spool/workflow";
export function newRunnerWorkflow(): RunnerWorkflow {
  return { id: `runner-${crypto.randomUUID().slice(0, 8)}`, name: "New runner", kind: "custom", enabled: false,
    workspace: "", intervalSeconds: 300, revision: "",
    nodes: [], edges: [] };
}
export function workflowError(value: RunnerWorkflow): string | undefined {
  if (!value.name.trim()) return "Enter a runner name.";
  if (!value.workspace.trim() && eventSource(value) !== "pr-updater") return "Choose a working directory in runner settings.";
  if (!Number.isSafeInteger(value.intervalSeconds) || value.intervalSeconds < 1 || value.intervalSeconds > 604800)
    return "Check interval must be between 1 second and 7 days.";
  if (!value.nodes.length) return "Choose a trigger to start your workflow.";
  try { validateWorkflow(value); } catch (error) { return error instanceof Error ? error.message : "Invalid workflow."; }
}
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
