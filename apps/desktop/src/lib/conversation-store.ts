import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { ConversationError, validateTaskId, type TaskConversation } from "./task-conversation";
import { publishJson, readOptionalJson } from "./spool-publish";
import { hasCode } from "./file-snapshot";
import { applicationPaths } from "./application-paths";
import { readQueuedTask } from "../../../../packages/runners/bridge/task-records.mjs";

export type StoredTask = TaskConversation["task"] & {
  interaction?: TaskConversation["task"]["interaction"] & { applied_requests?: string[] };
  created_at?: string; updated_at?: string; session_id?: string; sessionId?: string | null;
  provider?: { token?: string }; comments?: { author?: string; created_at?: string; message?: string; content?: string }[];
};
export function readConversationTask(root: string, id: string): StoredTask | null {
  validateTaskId(id);
  return readQueuedTask<StoredTask>(join(root, "queues"), id);
}
export type MessageInput = { id: string; kind: "message"; taskId: string; message: string };
export type MessageRecoveryInput = { id: string; kind: "resolve_message"; taskId: string;
  metadata: { messageId: string; decision: "retry" | "dismiss" } };
export async function messageReceipt(root: string, id: string) {
  const value = await readOptionalJson(join(root, "controls", "results", `${id}.json`));
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || !("result" in value) || !value.result ||
      typeof value.result !== "object" || !("status" in value.result) || typeof value.result.status !== "string") {
    throw new Error("Invalid message receipt.");
  }
  const error = "error" in value.result && typeof value.result.error === "string" ? value.result.error : undefined;
  return { result: { status: value.result.status, error } };
}
async function bridgeModule(name: string) {
  return import(/* @vite-ignore */ pathToFileURL(join(applicationPaths().resources, "runners", "bridge", `${name}.mjs`)).href);
}
async function messageControls(root: string) {
  const [{ SpoolStore }, { createMonitorControls }] = await Promise.all([
    bridgeModule("spool-store"), bridgeModule("monitor-controls"),
  ]);
  return createMonitorControls(new SpoolStore(root));
}
export async function publishMessage(root: string, input: MessageInput | MessageRecoveryInput) {
  if (input.kind === "resolve_message") {
    const folder = (...parts: string[]) => join(root, "controls", ...parts);
    for (const name of ["commands", "requests", "results", "history"]) await mkdir(folder(name), { recursive: true });
    const file = folder("commands", `${input.id}.json`);
    try { await publishJson(file, { input, request: { ...input, createdAt: new Date().toISOString() } }); }
    catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
    const saved = await readOptionalJson(file);
    if (!saved || typeof saved !== "object" || !("input" in saved) || !("request" in saved) ||
        JSON.stringify(saved.input) !== JSON.stringify(input)) throw new ConversationError("Message identity collision.", 409);
    if (!await messageReceipt(root, input.id)) {
      try { await publishJson(folder("requests", `${input.id}.json`), saved.request); }
      catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
    }
    return;
  }
  return (await messageControls(root)).submit(input);
}
export async function pendingMessages(root: string, task: StoredTask): Promise<NonNullable<NonNullable<StoredTask["interaction"]>["messages"]>> {
  return (await bridgeModule("monitor-controls")).pendingMessages(root, task);
}
