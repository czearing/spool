import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { hasCode } from "./file-snapshot";
import { runnerLocations } from "./runner-client";
import { readRunnerCatalog } from "./runner-catalog";
import { RunnerWorkflowError } from "./runner-workflow-client";
import { isRunId, isRunnerRun, type RunnerLogs } from "./runner-logs";

const maxLogBytes = 256 * 1024;
async function readText(file: string, limit: number, tail = false) {
  let handle;
  try { handle = await open(file, "r"); }
  catch (error) { if (hasCode(error, "ENOENT")) return null; throw error; }
  try {
    const { size } = await handle.stat(), truncated = size > limit;
    if (truncated && !tail) throw new Error("Runner record exceeds the supported size.");
    const start = tail ? Math.max(0, size - limit) : 0, buffer = Buffer.alloc(Math.min(size, limit));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start && text.includes("\n")) text = text.slice(text.indexOf("\n") + 1);
    return { text, truncated };
  } finally { await handle.close(); }
}
async function readRuns(directory: string) {
  let files: string[];
  try { files = await readdir(directory); }
  catch (error) { if (hasCode(error, "ENOENT")) return []; throw error; }
  const runs = await Promise.all(files.filter(file => /^[a-f0-9-]{36}\.summary\.json$/.test(file)).map(async file => {
    const source = await readText(join(directory, file), 65536);
    if (!source) return null; // Retention can remove a summary between listing and reading.
    const value: unknown = JSON.parse(source.text);
    if (!isRunnerRun(value)) throw new Error("Invalid runner run record.");
    return value;
  }));
  return runs.filter(run => run !== null).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
function executionOutput(value: unknown) {
  if (!value || typeof value !== "object" || !isRunnerRun(value) || !("steps" in value) || !Array.isArray(value.steps))
    throw new Error("Invalid runner execution record.");
  return value.steps.map((step: unknown) => {
    if (!step || typeof step !== "object" || !("id" in step) || typeof step.id !== "string" ||
      !("status" in step) || typeof step.status !== "string") throw new Error("Invalid runner step record.");
    const label = "label" in step && typeof step.label === "string" ? step.label : step.id;
    const time = "startedAt" in step && typeof step.startedAt === "string" ? step.startedAt : "";
    const output = "output" in step ? typeof step.output === "string" ? step.output : JSON.stringify(step.output, null, 2) : "";
    const error = "error" in step && typeof step.error === "string" ? step.error : "";
    return [`${time} [${label}] ${step.status}`, output, error].filter(Boolean).join("\n");
  }).concat(value.error || []).join("\n\n");
}
export async function readRunnerLogs(root: string, id: string, run?: string | null): Promise<RunnerLogs> {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || run && !isRunId(run)) throw new RunnerWorkflowError("Invalid runner or run identity.");
  const catalog = await readRunnerCatalog(root);
  if (catalog.error && !catalog.configured) throw new RunnerWorkflowError(catalog.error, 503);
  if (!catalog.runners.some(runner => runner.id === id)) throw new RunnerWorkflowError("Runner not found.", 404);
  const runtime = join(runnerLocations(root).runtime, "runners", id, ".runner"), executions = join(runtime, "executions");
  const runs = await readRuns(executions);
  if (run) {
    const source = await readText(join(executions, `${run}.json`), 4 * 1024 * 1024);
    if (!source) throw new RunnerWorkflowError("Run not found.", 404);
    return { runs, output: executionOutput(JSON.parse(source.text)), truncated: false };
  }
  const logs = await Promise.all(["runner.log", "runner-error.log"].map(name => readText(join(runtime, name), maxLogBytes, true)));
  // Older processes only persisted structured activity; their output cannot be recovered retroactively.
  const output = logs.some(log => log?.text) ? logs : await Promise.all(
    ["activity.jsonl", "jobs.jsonl"].map(name => readText(join(runtime, name), maxLogBytes, true)));
  return { runs, output: output.map(log => log?.text || "").filter(Boolean).join("\n"),
    truncated: output.some(log => log?.truncated) };
}
