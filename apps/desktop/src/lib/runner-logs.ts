export type RunnerRun = {
  id: string; status: "queued" | "running" | "succeeded" | "failed" | "interrupted" | "filtered";
  source: string; createdAt: string; startedAt?: string; finishedAt?: string; error?: string;
};
export type RunnerLogs = { runs: RunnerRun[]; output: string; truncated: boolean };
export const isRunId = (value: string) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";
export function isRunnerRun(value: unknown): value is RunnerRun {
  return record(value) && typeof value.id === "string" && isRunId(value.id) &&
    typeof value.status === "string" && ["queued", "running", "succeeded", "failed", "interrupted", "filtered"].includes(value.status) &&
    typeof value.source === "string" && typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt)) &&
    ["startedAt", "finishedAt"].every(key => value[key] === undefined ||
      typeof value[key] === "string" && Number.isFinite(Date.parse(value[key]))) &&
    (value.error === undefined || typeof value.error === "string");
}
export function isRunnerLogs(value: unknown): value is RunnerLogs {
  return record(value) && Array.isArray(value.runs) && value.runs.every(isRunnerRun) &&
    typeof value.output === "string" && typeof value.truncated === "boolean";
}
