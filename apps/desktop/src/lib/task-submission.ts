import { validModel } from "./settings";

export type TaskDraft = { title: string; agent: string; prompt: string; model?: string };
export type TaskSubmission = TaskDraft & { requestId: string };
export type CreatedTask = { id: string; state: "accepted"; notice: string };
export class TaskSubmissionError extends Error {
  constructor(message: string, readonly status = 400, readonly rejected = false) { super(message); }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function validateSubmission(input: unknown): TaskSubmission {
  if (!input || typeof input !== "object") throw new TaskSubmissionError("Provide a task.");
  const text = (key: string, max: number) => {
    const value: unknown = Reflect.get(input, key);
    if (typeof value !== "string" || !value.trim() || value.includes("\0") || new TextEncoder().encode(value.trim()).length > max) {
      throw new TaskSubmissionError(`Enter ${key} (1 to ${max.toLocaleString("en-US")} UTF-8 bytes).`);
    }
    return value.trim();
  };
  const requestId = text("requestId", 36), agent = text("agent", 120);
  if (!uuid.test(requestId)) throw new TaskSubmissionError("Invalid task submission identity.");
  if ("workspace" in input) throw new TaskSubmissionError("Workspace selection belongs to the runner, not the task draft.");
  const model: unknown = Reflect.get(input, "model");
  if (model !== undefined && !validModel(model)) throw new TaskSubmissionError("Enter a valid model ID (up to 128 characters, without spaces).");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(agent)) throw new TaskSubmissionError("Choose a configured agent whose name starts with a letter or number.");
  return { requestId, agent, title: text("title", 500), prompt: text("prompt", 120000), ...(model ? { model } : {}) };
}
export function validateRequestId(id: string) {
  if (!uuid.test(id)) throw new TaskSubmissionError("Invalid task submission identity.");
  return id;
}
