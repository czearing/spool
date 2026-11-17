import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { executionContext } from "../packages/bohemia-agent-tooling/src/publications.js";
import { SpoolStore, readJson, samePath } from "./spool-store.mjs";

export function ciExecutionContext({ root, taskId, environment = process.env } = {}) {
  let context;
  try { context = executionContext(environment, { allowTerminal: true }); }
  catch (error) {
    throw new Error(`CI command no longer belongs to the original active execution: ${error.message}`, { cause: error });
  }
  if (context?.agent !== "ci" || !context.taskId)
    throw new Error("CI commands require the original CI execution context");
  const inferredRoot = context.projectRoot;
  if (!inferredRoot || root && !samePath(root, inferredRoot) || taskId && taskId !== context.taskId)
    throw new Error("CI command cannot replace its original execution");
  const store = new SpoolStore(root || inferredRoot), task = store.task(context.taskId);
  if (task?.agent !== "ci" || task.session_id !== context.sessionId ||
      !samePath(context.workspace, task.workspace) ||
      context.providerToken && task.provider?.token !== context.providerToken)
    throw new Error("CI command no longer belongs to the original active execution");
  return { store, taskId: task.id };
}

function nativeBinary(store) {
  const capability = readJson(path.join(store.root, "controls", "capabilities.json"));
  const age = Date.now() - Date.parse(capability?.updatedAt);
  if (!Number.isSafeInteger(capability?.pid) || capability.pid <= 0 || !(age >= 0 && age < 12000))
    throw new Error("CI completion requires a live task runtime");
  const encoded = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference='Stop'; $p=Get-Process -Id ${capability.pid}; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p.Path))`],
  { encoding: "utf8", windowsHide: true, timeout: 10000 }).trim();
  const binary = Buffer.from(encoded, "base64").toString("utf8");
  if (!path.isAbsolute(binary) || !existsSync(binary) || path.basename(binary).toLowerCase() !== "spool.exe")
    throw new Error("Cannot identify the active task runtime for CI completion");
  return binary;
}

export function completeCiExecution(store, taskId, job, { binary, execute = spawnSync } = {}) {
  const task = store.task(taskId), outcome = job?.outcome;
  if (job?.taskId !== taskId || task?.agent !== "ci" || !outcome ||
      !["accepted", "rejected", "blocked"].includes(outcome.verdict) ||
      !samePath(task.workspace, job.workspace) || job.branch !== store.metadata(taskId)?.preparation?.branch)
    throw new Error("CI completion requires its verified original experiment outcome");
  const status = outcome.verdict === "accepted" ? "completed" : "failed";
  const recorded = readJson(path.join(store.records, "ci-jobs", `${taskId}.json`));
  if (!isDeepStrictEqual(recorded?.outcome, outcome))
    throw new Error("CI completion requires its recorded immutable experiment outcome");
  const verified = () => {
    const current = store.task(taskId);
    return current?.status === status && current.agent === task.agent &&
      current.session_id === task.session_id && samePath(current.workspace, task.workspace) &&
      (status !== "failed" || current.error === outcome.failed);
  };
  if (verified()) return;
  if (task.status !== "in_progress" || store.isPaused("ci") || task.interaction?.cancel_requested ||
      task.interaction?.paused || task.interaction?.status_change)
    throw new Error("CI completion held: original execution is inactive, paused, or interrupted");
  const requests = [
    { id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "ci-experiment", version: "1" } } },
    { method: "notifications/initialized" },
    { id: 2, method: "tools/call", params: { name: "spool_update_task_status",
      arguments: { status, ...(status === "failed" ? { error: outcome.failed } : {}) } } },
  ];
  const result = execute(binary || nativeBinary(store),
    ["--root", store.root, "mcp", "--agent", "ci", "--task", taskId], {
      input: requests.map(request => JSON.stringify({ jsonrpc: "2.0", ...request })).join("\n") + "\n",
      encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
    });
  if (!verified())
    throw new Error(`CI outcome saved, but task completion was not confirmed: ${result.error?.message ||
      result.stderr || result.stdout || `runtime exited ${result.status}`}`);
}
