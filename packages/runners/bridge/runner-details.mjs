import path from "node:path";
import { profile } from "./sources.mjs";
import { readJson, samePath, writeJson } from "./spool-store.mjs";
import { runnerDefinitions } from "./config.mjs";
import { eventSource } from "@spool/workflow";

const errors = [
  [/unauthori[sz]ed|authentication|authorization|AADSTS|\b(?:401|403)\b/i, "Authentication failed. Check the runner's account access."],
  [/dirty|uncommitted|unpublished|diverged|another git operation/i, "Workspace changes prevented preparation. Existing work was preserved."],
  [/original.*(?:session|owner)|originating work item|creator.*(?:missing|unavailable)/i, "The original agent or session could not be verified. Handoff was held."],
  [/timed?\s*out|ETIMEDOUT|timeout/i, "An external operation timed out. Check the local runner log."],
  [/install|ERR_PNPM|dependency/i, "Dependency installation failed. Check the local preparation log."],
  [/disk|free.*GiB|capacity/i, "Workspace capacity is insufficient. Free space before retrying."],
  [/build failed|checks? failed|validation failed/i, "Repository validation failed. Check the local preparation log."],
];
export function runnerErrorSummary(error) {
  if (!error) return null;
  return errors.find(([pattern]) => pattern.test(String(error)))?.[1] ?? "The operation failed. Check the local runner log for details.";
}
const date = value => value === null || typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.now() + 1000;
function readRefresh(runtime) {
  const value = readJson(path.join(runtime, "repository-refresh.json"));
  if (value && (value.version !== 1 || !["running", "succeeded", "failed"].includes(value.state) ||
      !date(value.lastUpdatedAt) || value.state === "succeeded" && !value.lastUpdatedAt ||
      !date(value.lastAttemptAt) || !value.lastAttemptAt ||
      typeof value.instanceId !== "string" || !Number.isSafeInteger(value.pid) ||
      value.error !== null && ![...errors.map(([, message]) => message), runnerErrorSummary("unknown")].includes(value.error))) {
    throw new Error("Invalid repository refresh record");
  }
  return value;
}

export async function trackRepositoryRefresh(runtime, lifecycle, name, args, action) {
  if (!runtime || name !== "bohemia_prepare" || args.operation === "setup") return action();
  const previous = readRefresh(runtime);
  const record = { version: 1, state: "running", pid: process.pid, instanceId: lifecycle.status.instanceId,
    lastAttemptAt: new Date().toISOString(), lastUpdatedAt: previous?.lastUpdatedAt ?? null, error: null };
  const file = path.join(runtime, "repository-refresh.json");
  writeJson(file, record);
  try {
    const result = await action();
    if (!result?.ready || !samePath(result.repoRoot, args.repoRoot) || !result.branch || !/^[a-f0-9]{40}$/i.test(result.commit ?? "")) {
      throw new Error("Preparation did not confirm the requested repository");
    }
    writeJson(file, { ...record, state: "succeeded", lastUpdatedAt: new Date().toISOString() });
    return result;
  } catch (error) {
    writeJson(file, { ...record, state: "failed", error: runnerErrorSummary(error?.message ?? String(error)) });
    throw error;
  }
}

export function runnerDetails(row, setting, runtime) {
  const intervalSeconds = setting.intervalSeconds ?? setting.scan_interval_seconds ?? profile(row.runner).pollSeconds ?? 60;
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 1) throw new Error("Invalid runner scan interval");
  const refresh = readRefresh(runtime);
  const current = row.connected && refresh?.instanceId === row.instanceId && refresh?.pid === row.pid;
  const state = !refresh ? "unknown" : refresh.state === "running" ? current ? "updating" : "interrupted" : refresh.state;
  return {
    script: `runners\\${row.runner}\\run.mjs`, intervalSeconds,
    activeIntervalSeconds: row.connected && Number.isSafeInteger(row.pollSeconds) && row.pollSeconds > 0 ? row.pollSeconds : null,
    error: runnerErrorSummary(row.lastError),
    repository: { mode: runnerDefinitions[eventSource(setting) || row.runner]?.repositoryUpdate ??
      (setting.nodes?.some(node => node.kind === "repository" && node.operation === "refresh") ? "workflow" : "none"), state,
      lastUpdatedAt: refresh?.lastUpdatedAt ?? null, lastAttemptAt: refresh?.lastAttemptAt ?? null,
      error: state === "interrupted" ? "Repository refresh was interrupted. No successful update was recorded." : refresh?.error ?? null },
  };
}
