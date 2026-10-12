import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { digest, readJson, writeJson } from "./spool-files.mjs";
import { createMonitorControls } from "./monitor-controls.mjs";
import { continuationMessage } from "./message-payload.mjs";

const identity = key => digest(`runner-message:${key}`).slice(0, 32)
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
const commandFile = (store, folder, key) => path.join(store.root, "controls", folder, `${identity(key)}.json`);
const indexFile = (store, key) => path.join(store.records, `${digest(key)}.json`);
function savedCommand(store, key) {
  const index = readJson(indexFile(store, key));
  const saved = readJson(index?.nativeMessageId
    ? path.join(store.root, "controls", "commands", `${index.nativeMessageId}.json`) : commandFile(store, "commands", key));
  if (index?.nativeMessageId && !saved) throw new Error("Native submission command is missing; recovery held");
  return saved;
}

export function nativeReceipt(store, key) {
  const saved = savedCommand(store, key);
  if (!saved) return null;
  const input = saved.input, result = readJson(path.join(store.root, "controls", "results", `${input.id}.json`));
  if (input.kind !== "message" || input.metadata?.key !== key) throw new Error("Runner command identity collision");
  const accepted = result?.result?.status === "accepted";
  return { ...input.metadata.metadata, key, taskId: input.taskId, nativeMessageId: input.id,
    phase: accepted ? "published" : result?.result?.status === "failed" ? "interrupted" : "pending",
    publishedAt: accepted ? result.processedAt : undefined,
    error: result?.result?.error };
}

export function recoverNativeCommand(store, key) {
  if (nativeReceipt(store, key)?.phase !== "pending") return null;
  const saved = savedCommand(store, key);
  if (!saved) throw new Error("Native submission intent is missing");
  createMonitorControls(store).submit(saved.input);
  throw new Error("Native message acceptance is still pending; original task left untouched");
}

export async function continueTask(store, { key, agent, prompt, workspace, resumeId, expectedUpdatedAt, metadata = {} }) {
  const submitted = store.submission(key);
  if (submitted) return submitted.task;
  let saved = savedCommand(store, key);
  const previous = store.task(resumeId);
  if (!previous) throw new Error("Only an existing Spool task can be resumed");
  if (saved && nativeReceipt(store, key).phase === "interrupted") {
    if (previous.interaction?.applied_requests?.includes(saved.input.id)) {
      throw new Error("Native rejection followed a task commit; repair the original command before retrying");
    }
    saved = null;
  }
  if (!saved) store.assertIdle(agent, workspace, null, metadata.independentWorkspace
    ? { taskId: resumeId, sessionId: previous.session_id } : null);
  const snapshot = expectedUpdatedAt ?? previous.updated_at;
  const message = continuationMessage(store, prompt);
  const input = saved?.input || {
    id: identity(JSON.stringify([key, snapshot, agent, workspace, prompt, metadata])),
    kind: "message", taskId: resumeId, message,
    metadata: { key, agent, workspace, sessionId: previous.session_id,
      expectedUpdatedAt: snapshot, metadata },
  };
  if (input.taskId !== resumeId || input.message !== message || input.metadata?.key !== key) {
    throw new Error("Runner command identity was reused for different input");
  }
  const controls = createMonitorControls(store);
  controls.stage(input);
  writeJson(indexFile(store, key), { key, taskId: resumeId, nativeMessageId: input.id });
  controls.submit(input);
  for (let attempt = 0; attempt < 60; attempt++) {
    const receipt = controls.receipt(input.id);
    if (receipt?.result?.status === "failed") throw new Error(`Spool rejected runner continuation: ${receipt.result.error}`);
    const accepted = store.submission(key);
    if (accepted) return accepted.task;
    await setTimeout(100);
  }
  throw new Error("Waiting for native Spool confirmation; retry the same submission to recover its result");
}
