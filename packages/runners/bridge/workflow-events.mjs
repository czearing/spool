import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { readJson, writeJson } from "./spool-store.mjs";
import { executionSettings, validateWorkflow } from "./workflow-schema.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
async function fingerprint(file) {
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("File-change triggers require a file, not a folder.");
    if (info.size > 10 * 1024 * 1024) throw new Error("Watched files must not exceed 10 MiB.");
    const content = await readFile(file);
    if (content.length > 10 * 1024 * 1024) throw new Error("Watched files must not exceed 10 MiB.");
    return digest(content);
  } catch (error) { if (error.code === "ENOENT") return "missing"; throw error; }
}
export function createWorkflowEvents(workflow, runtime) {
  const trigger = validateWorkflow(workflow)[0];
  const key = digest(JSON.stringify(executionSettings(workflow)));
  const file = path.join(runtime, "workflow-event.json");
  let state = readJson(file);
  if (state && (state.version !== 1 || typeof state.key !== "string" ||
      state.baseline !== null && typeof state.baseline !== "string" ||
      state.pending && (typeof state.pending.id !== "string" || typeof state.pending.fingerprint !== "string")))
    throw new Error("Invalid persisted workflow event state.");
  if (!state || state.key !== key) state = { version: 1, key, baseline: null, pending: null };
  const save = next => { writeJson(file, next); state = next; };
  return {
    async next() {
      if (state.pending) return state.pending;
      if (["manual", "webhook"].includes(trigger.kind)) return null;
      const current = trigger.kind === "file-change" ? await fingerprint(path.resolve(workflow.workspace, trigger.path)) : "schedule";
      if (trigger.kind === "file-change") {
        if (state.baseline === null) { save({ ...state, baseline: current }); return null; }
        if (current === state.baseline) return null;
      }
      save({ ...state, pending: { id: randomUUID(), fingerprint: current } });
      return state.pending;
    },
    complete(event) {
      if (state.pending?.id !== event.id) throw new Error("Workflow event changed before completion.");
      save({ ...state, baseline: event.fingerprint, pending: null });
    },
  };
}
