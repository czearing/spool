import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { acquireProcessLock } from "../packages/bohemia-agent-tooling/src/index.js";
import { writeJson } from "./spool-files.mjs";
import { boundedJson } from "./workflow-data.mjs";
import { executionSettings } from "./workflow-schema.mjs";
import { eventSource } from "@spool/workflow";

export const workflowKey = workflow => createHash("sha256").update(JSON.stringify(executionSettings(workflow))).digest("hex");
export function newRun(workflow, input, { id = randomUUID(), source = "manual" } = {}) {
  const data = boundedJson(input);
  return { id: runId(id), key: workflowKey(workflow), source, input: data,
    inputHash: createHash("sha256").update(JSON.stringify(data)).digest("hex"),
    createdAt: new Date().toISOString(), status: "queued", steps: [] };
}
const runId = id => {
  if (typeof id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))
    throw Object.assign(new Error("Invalid execution ID; use a UUID."), { status: 400 });
  return id;
};
const folder = runtime => path.join(runtime, "executions");
export function readRun(runtime, id) {
  const file = path.join(folder(runtime), `${runId(id)}.json`);
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
export function writeRun(runtime, record) {
  mkdirSync(folder(runtime), { recursive: true });
  writeJson(path.join(folder(runtime), `${runId(record.id)}.json`), record);
  const { id, key, source, createdAt, status, startedAt, finishedAt, error, taskId } = record;
  writeJson(path.join(folder(runtime), `${id}.summary.json`), { id, key, source, createdAt, status, startedAt, finishedAt, error, taskId });
  if (finishedAt) for (const previous of listRuns(runtime).filter(run => run.finishedAt).slice(200)) {
    const file = path.join(folder(runtime), `${previous.id}.json`);
    // Keep a small tombstone so an old idempotency key cannot replay side effects.
    writeJson(file, { ...previous, inputHash: readRun(runtime, previous.id)?.inputHash, expired: true, steps: [] });
    unlinkSync(path.join(folder(runtime), `${previous.id}.summary.json`));
  }
}
export function listRuns(runtime) {
  if (!existsSync(folder(runtime))) return [];
  return readdirSync(folder(runtime)).filter(name => /^[a-f0-9-]{36}\.summary\.json$/.test(name))
    .map(name => JSON.parse(readFileSync(path.join(folder(runtime), name), "utf8"))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function enqueueRun(workflow, runtime, input, { id = randomUUID(), source = "manual" } = {}) {
  if (workflow.kind !== "custom" || eventSource(workflow)) throw Object.assign(new Error("Integration events cannot be manually executed here."), { status: 400 });
  const candidate = newRun(workflow, input, { id, source }), { key, inputHash } = candidate;
  mkdirSync(runtime, { recursive: true });
  const release = await acquireProcessLock(path.resolve(runtime).toLowerCase(), { namespace: "workflow-events", timeoutMs: 5000 });
  try {
    const existing = readRun(runtime, id);
    if (existing) {
      if (existing.key !== key || existing.source !== source || existing.inputHash !== inputHash)
        throw Object.assign(new Error("Execution ID was already used with different input or configuration."), { status: 409 });
      if (!existing.expired && !existsSync(path.join(folder(runtime), `${id}.summary.json`))) writeRun(runtime, existing);
      return existing;
    }
    if (listRuns(runtime).filter(run => ["queued", "running"].includes(run.status)).length >= 100)
      throw Object.assign(new Error("Workflow event queue is full."), { status: 429 });
    const record = candidate;
    mkdirSync(folder(runtime), { recursive: true });
    writeRun(runtime, record);
    return record;
  } finally { await release(); }
}
export function nextRun(runtime, workflow) {
  const pending = listRuns(runtime).filter(run => ["queued", "running"].includes(run.status)).reverse();
  for (const summary of pending) {
    const run = readRun(runtime, summary.id);
    if (!run) throw new Error("Pending execution record is missing.");
    if (!["queued", "running"].includes(run.status)) {
      writeRun(runtime, run);
      continue;
    }
    if (run.key !== workflowKey(workflow)) {
      writeRun(runtime, { ...run, status: "failed", error: "Workflow changed after this event was accepted. Submit a new run.", finishedAt: new Date().toISOString() });
      continue;
    }
    if (run.status === "running") {
      writeRun(runtime, { ...run, status: "interrupted", error: "Execution was interrupted. Inspect side effects before running again.", finishedAt: new Date().toISOString() });
      continue;
    }
    return run;
  }
  return null;
}
