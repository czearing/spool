import { appFetch } from "../platform/request";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "filtered" | "interrupted";
export type RunSummary = { id: string; status: RunStatus; source: string; createdAt: string; error?: string };
export type RunStep = { id: string; label: string; status: RunStatus; input: unknown; output?: unknown; error?: string };
export type WorkflowRun = RunSummary & { input: unknown; steps: RunStep[] };
export type WorkflowExecutionApi = {
  list: (signal: AbortSignal) => Promise<RunSummary[]>;
  read: (id: string, signal: AbortSignal) => Promise<WorkflowRun>;
  run: (input: unknown, revision: string, id: string) => Promise<{ id: string }>;
  webhookUrl: string;
};
const statuses = ["queued", "running", "succeeded", "failed", "filtered", "interrupted"];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";
function summary(value: unknown): value is RunSummary {
  return object(value) && typeof value.id === "string" && statuses.includes(String(value.status)) &&
    typeof value.source === "string" && typeof value.createdAt === "string" && (value.error === undefined || typeof value.error === "string");
}
function run(value: unknown): value is WorkflowRun {
  return summary(value) && "steps" in value && Array.isArray(value.steps) && value.steps.every(step =>
    object(step) && typeof step.id === "string" && typeof step.label === "string" && statuses.includes(String(step.status)) &&
    (step.error === undefined || typeof step.error === "string"));
}
export function workflowExecutionApi(project: string, id: string): WorkflowExecutionApi {
  const base = `/api/projects/${encodeURIComponent(project)}/runners/${encodeURIComponent(id)}`;
  async function request(suffix: string, init?: RequestInit): Promise<unknown> {
    const response = await appFetch(`${base}/runs${suffix}`, init), value: unknown = await response.json();
    if (!response.ok) throw new Error(object(value) && typeof value.error === "string" ? value.error : "Execution request failed.");
    return value;
  }
  return {
    webhookUrl: `${base}/webhook`,
    async list(signal) {
      const value = await request("", { signal });
      if (!Array.isArray(value) || !value.every(summary)) throw new Error("Invalid execution list.");
      return value;
    },
    async read(id, signal) {
      const value = await request(`?execution=${encodeURIComponent(id)}`, { signal });
      if (!run(value)) throw new Error("Invalid execution record.");
      return value;
    },
    async run(input, revision, executionId) {
      const value = await request("", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input, revision, executionId }) });
      if (!object(value) || typeof value.id !== "string") throw new Error("Execution was not acknowledged.");
      return { id: value.id };
    },
  };
}
