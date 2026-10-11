import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { samePath, digest, writeJson } from "./spool-files.mjs";
import { continueTask } from "./native-continuation.mjs";

export async function submit(input) {
  const { key, agent, title, prompt, workspace, resumeId = null } = input;
  let metadata = input.metadata || {};
  this.validateAgent(agent);
  if (resumeId) return continueTask(this, input);
  const submitted = this.submission(key);
  if (submitted) return submitted.task;
  const existing = this.receipt(key);
  const savedPayload = existing?.phase === "pending" ? existing.payload : null;
  if (metadata.independentWorkspace) throw new Error("Independent continuation requires an original-session PR task");
  this.assertIdle(agent, workspace);
  const id = existing?.taskId || `srun-${digest(key).slice(0, 32)}`;
  const acceptance = metadata.acceptance ?? savedPayload?.acceptance;
  if (acceptance) {
    if (acceptance.kind !== "bundle-v2" || acceptance.version !== 2 || !metadata.preparation?.ready ||
        !metadata.preparation.branch || !samePath(metadata.preparation.repoRoot, workspace)) {
      throw new Error("Bundle acceptance requires its verified prepared workspace and versioned contract");
    }
    metadata = { ...metadata, acceptance };
  }
  const now = new Date().toISOString();
  const task = savedPayload || {
    ...(acceptance ? { acceptance } : {}),
    id, agent, title, prompt, workspace, status: "incoming", independent_workspace: false,
    session_id: null, created_at: now, updated_at: now, turns: 0, cost: {}, comments: [], error: null,
  };
  delete task.file;
  const target = path.join(this.queues, "incoming", `${id}.json`);
  const temporary = path.join(this.queues, "incoming", `${id}.${randomUUID()}.tmp`);
  const receipt = { taskId: id, key, ...metadata, phase: "pending", payload: task, previous: null };
  writeJson(path.join(this.records, `${digest(key)}.json`), receipt);
  writeJson(path.join(this.records, `task-${id}.json`), receipt);
  if (acceptance) writeJson(path.join(this.records, "bundle-contracts", `${id}.json`), {
    version: 1, taskId: id, agent, workspace, branch: metadata.preparation.branch, acceptance,
  });
  try {
    writeFileSync(temporary, JSON.stringify(task, null, 2));
    this.publish(temporary, target);
  } finally { rmSync(temporary, { force: true }); }
  const published = { ...receipt, phase: "published", publishedAt: new Date().toISOString(), payload: undefined, previous: undefined };
  writeJson(path.join(this.records, `${digest(key)}.json`), published);
  writeJson(path.join(this.records, `task-${id}.json`), published);
  return { ...task, file: target };
}
