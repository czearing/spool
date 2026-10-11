import { mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { digest, writeJson } from "../spool-store.mjs";

export function finishTask(f, id, status = "completed", changes = {}) {
  const task = f.store.task(id), target = path.join(f.store.queues, status, `${id}.json`);
  writeJson(task.file, { ...task, file: undefined, updated_at: new Date().toISOString(), ...changes, status,
    interaction: { ...task.interaction, messages: (task.interaction?.messages || [])
      .map(message => ({ ...message, status: "delivered" })) } });
  if (task.file !== target) renameSync(task.file, target);
}

export function legacyInterrupted(f, { key, resumeId, prompt, workspace = f.workspace, metadata = {} }) {
  const original = f.store.task(resumeId);
  const archive = path.join(f.store.queues, ".runner-archive", `${resumeId}-legacy.json`);
  mkdirSync(path.dirname(archive), { recursive: true });
  const receipt = { taskId: resumeId, key, ...metadata, phase: "pending",
    payload: { ...original, file: undefined, prompt, workspace, status: "incoming" },
    previous: { status: original.status, archive, metadata: f.store.metadata(resumeId) } };
  renameSync(original.file, archive);
  writeJson(path.join(f.store.records, `${digest(key)}.json`), receipt);
  writeJson(path.join(f.store.records, `task-${resumeId}.json`), receipt);
  return receipt;
}
