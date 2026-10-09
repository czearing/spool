export type Runner = {
  id: string; name?: string; enabled: boolean; connected: boolean; running: boolean; healthy: boolean; stopping: boolean;
  phase: "not_started" | "starting" | "scanning" | "ready" | "degraded" | "stopped";
  lastRunAt: string | null; lastSuccessAt: string | null; lastRunFailed: boolean;
  script: string; intervalSeconds: number; activeIntervalSeconds: number | null; error: string | null;
  repository: { mode: "on-demand" | "workflow" | "none"; state: "unknown" | "updating" | "interrupted" | "succeeded" | "failed";
    lastUpdatedAt: string | null; lastAttemptAt: string | null; error: string | null };
};
export type RunnerSnapshot = { checkedAt: string; configured: boolean; runners: Runner[] };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const interval = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const message = (value: unknown) => value === null || typeof value === "string" && value.length <= 300;
function details(row: Record<string, unknown>, checkedAt: number) {
  const repo = row.repository;
  return row.script === `runners\\${row.id}\\run.mjs` && interval(row.intervalSeconds) &&
    (row.activeIntervalSeconds === null || interval(row.activeIntervalSeconds)) && message(row.error) &&
    record(repo) && typeof repo.mode === "string" && ["on-demand", "workflow", "none"].includes(repo.mode) &&
    typeof repo.state === "string" && ["unknown", "updating", "interrupted", "succeeded", "failed"].includes(repo.state) &&
    ["lastUpdatedAt", "lastAttemptAt"].every(key => repo[key] === null || date(repo[key]) && Date.parse(repo[key]) <= checkedAt + 1000) &&
    message(repo.error) && (repo.state !== "updating" || row.connected === true) &&
    (repo.state !== "succeeded" || date(repo.lastUpdatedAt));
}
export function isRunnerSnapshot(value: unknown): value is RunnerSnapshot {
  if (!record(value) || !date(value.checkedAt) || typeof value.configured !== "boolean" || !Array.isArray(value.runners)) return false;
  const checkedAt = Date.parse(value.checkedAt);
  return (value.configured || !value.runners.length) && new Set(value.runners.map(row => record(row) ? row.id : null)).size === value.runners.length &&
    value.runners.every(row => record(row) && typeof row.id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(row.id) &&
      (row.name === undefined || typeof row.name === "string" && row.name.length <= 80) &&
      ["enabled", "connected", "running", "healthy", "stopping", "lastRunFailed"].every(key => typeof row[key] === "boolean") &&
      typeof row.phase === "string" && ["not_started", "starting", "scanning", "ready", "degraded", "stopped"].includes(row.phase) &&
      ["lastRunAt", "lastSuccessAt"].every(key => row[key] === null || date(row[key]) && Date.parse(row[key]) <= checkedAt + 1000) &&
      (!row.connected || row.running) && (!row.healthy || row.connected && !row.stopping) && details(row, checkedAt));
}
export function runnerInterval(seconds: number) {
  return seconds % 60 === 0 ? `Every ${seconds / 60} min` : `Every ${seconds} sec`;
}
export function repositoryActivity(runner: Runner) {
  const { mode, state } = runner.repository;
  return mode === "none" ? "Not supported" : state === "updating" ? "Updating" :
    state === "failed" ? "Update failed" : state === "interrupted" ? "Interrupted" : mode === "workflow" ? "Workflow action" : "Before handoff";
}
export function runnerConnection(runner: Runner) {
  return runner.connected ? "Connected" : runner.running ? "Unconfirmed" : "Offline";
}
export function runnerActivity(runner: Runner) {
  if (!runner.running) return runner.enabled ? "Stopped" : "Disabled";
  if (!runner.connected) return "Unknown";
  if (runner.stopping) return "Stopping";
  if (runner.phase === "scanning") return "Running";
  if (runner.phase === "starting") return "Starting";
  return runner.healthy ? "Idle" : "Error";
}
