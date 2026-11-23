import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import path from "node:path";

const failures = new Map(), pending = new Map();
let chain = Promise.resolve();
const eligible = task => (task.error == null || typeof task.error === "string") &&
  typeof task.id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,179}$/.test(task.id) &&
  (task.status === "failed" || typeof task.error === "string" && !!task.error);
const keyFor = (root, task) => JSON.stringify([root, task.id, task.updated_at ?? null, task.error ?? null]);
const summary = task => ({ id: task.id, updated_at: task.updated_at, error: task.error, status: task.status });
export const failureOriginDirectory = root => path.join(root, "controls", "failure-origins");

function receipt(line, task, calls) {
  if (line.length > 1024 * 1024 || !line.includes("tool.execution_")) return false;
  let event;
  try { event = JSON.parse(line.toString("utf8")); } catch { return false; }
  const data = event?.data;
  if (event?.type === "tool.execution_start" &&
      /(?:^|[-_])spool_update_task_status$/.test(data?.toolName ?? "")) {
    let args = data.arguments;
    if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = null; } }
    if (args?.status === "failed" && (args.error ?? null) === (task.error ?? null) && typeof data.toolCallId === "string") {
      if (calls.size >= 4096) calls.delete(calls.keys().next().value);
      calls.add(data.toolCallId);
    }
  } else if (event?.type === "tool.execution_complete" && calls.has(data?.toolCallId)) {
    calls.delete(data.toolCallId);
    const result = data.result;
    return data.success === true && result?.isError !== true &&
      (result?.content === "Task status updated to failed" ||
       [result?.contents, result?.content].some(items => Array.isArray(items) &&
         items.some(item => item?.text === "Task status updated to failed")));
  }
  return false;
}

async function scan(name, task) {
  const calls = new Set();
  let pending = Buffer.alloc(0), skipping = false;
  for await (const chunk of createReadStream(name, { highWaterMark: 64 * 1024 })) {
    let bytes = pending.length ? Buffer.concat([pending, chunk]) : chunk, start = 0, end;
    while ((end = bytes.indexOf(10, start)) >= 0) {
      if (!skipping && receipt(bytes.subarray(start, end), task, calls)) return true;
      skipping = false; start = end + 1;
    }
    pending = bytes.subarray(start);
    if (pending.length > 1024 * 1024 || skipping) { pending = Buffer.alloc(0); skipping = true; }
    await setImmediate();
  }
  return !skipping && receipt(pending, task, calls);
}

async function reconcile(root, task, key) {
  const name = path.join(root, "logs", `${task.id}.log`);
  try {
    const info = await stat(name, { bigint: true });
    const version = `${info.dev}:${info.ino}:${info.birthtimeNs}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    if (failures.get(key)?.version === version) { failures.get(key).checked = Date.now(); return; }
    const directory = failureOriginDirectory(root);
    const receipt = path.join(directory, `${createHash("sha256").update(key).digest("hex")}.json`);
    let saved;
    try { saved = JSON.parse(await readFile(receipt, "utf8")); }
    catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    const reported = saved?.version === version && typeof saved.reported === "boolean"
      ? saved.reported : await scan(name, task);
    const value = { version, reported, checked: Date.now() };
    failures.set(key, value);
    if (failures.size > 10000) failures.delete(failures.keys().next().value);
    if (saved?.version !== version || saved.reported !== reported) {
      await mkdir(directory, { recursive: true });
      const temporary = `${receipt}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify({ version, reported }));
      await rename(temporary, receipt);
    }
  } catch (error) {
    if (error.code === "ENOENT") failures.set(key, { reported: false, checked: Date.now() });
    else console.error(`Cannot backfill failure provenance for ${task.id}:`, error);
  }
}

export function agentReportedFailure(root, task) {
  if (!eligible(task)) return false;
  if (task.failure_origin && (task.failure_origin.error ?? null) === (task.error ?? null))
    return task.failure_origin.source === "agent";
  if (!root) return false;
  const key = keyFor(root, task), known = failures.get(key);
  if (!pending.has(key) && (!known || Date.now() - known.checked >= 5000)) {
    // Historical evidence is reconciled in bounded asynchronous chunks, never in a UI read.
    const operation = chain.then(() => reconcile(root, summary(task), key));
    chain = operation.catch(() => {});
    pending.set(key, operation);
    void operation.finally(() => pending.delete(key));
  }
  return known?.reported === true;
}

export async function settleFailureBackfill() { await chain; }
export async function backfillTaskFailures(root, tasks) {
  for (const task of tasks) {
    if (!eligible(task) || task.failure_origin) continue;
    const key = keyFor(root, task);
    if (!pending.has(key)) {
      const operation = chain.then(() => reconcile(root, task, key));
      chain = operation.catch(() => {});
      pending.set(key, operation);
      void operation.finally(() => pending.delete(key));
    }
  }
  await chain;
}

export function taskFailurePresentation(root, task) {
  if (!agentReportedFailure(root, task)) return {};
  return { ...(task.status === "failed" ? { status: "blocked", queueStatus: "failed" } : {}), error: null };
}
