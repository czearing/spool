import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ConversationError, validateTaskId, type TaskConversation } from "./task-conversation";
import { publishJson, readOptionalJson } from "./spool-publish";
import { hasCode } from "./file-snapshot";

export type StoredTask = TaskConversation["task"] & {
  created_at?: string; updated_at?: string; session_id?: string; sessionId?: string | null;
  provider?: { token?: string }; comments?: { author?: string; created_at?: string; message?: string; content?: string }[];
};
export class ConversationStore {
  constructor(readonly root: string) {}
  task(id: string): StoredTask | null {
    validateTaskId(id);
    for (const status of ["in_progress", "incoming", "completed", "failed"]) {
      try {
        const task = JSON.parse(readFileSync(join(this.root, "queues", status, `${id}.json`), "utf8"));
        if (task?.id !== id || typeof task.agent !== "string" || typeof task.prompt !== "string") {
          throw new Error("Invalid conversation task record.");
        }
        return { ...task, status };
      } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
    }
    return null;
  }
}
export type MessageInput = { id: string; kind: "message"; taskId: string; message: string };
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
export async function publishMessage(root: string, input: MessageInput) {
  const folder = (...parts: string[]) => join(root, "controls", ...parts);
  for (const name of ["commands", "requests", "results", "history", "manual", "manual-history", "workspace-holds"]) {
    await mkdir(folder(name), { recursive: true });
  }
  const file = folder("commands", `${input.id}.json`);
  const request = { ...input, createdAt: new Date().toISOString() };
  try { await publishJson(file, { input, request }); }
  catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
  const saved = await readOptionalJson(file);
  if (!saved || typeof saved !== "object" || !("input" in saved) || !("request" in saved) ||
      JSON.stringify(saved.input) !== JSON.stringify(input)) throw new ConversationError("Message identity collision.", 409);
  if (!await messageReceipt(root, input.id)) {
    try { await publishJson(folder("requests", `${input.id}.json`), saved.request); }
    catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
  }
}
