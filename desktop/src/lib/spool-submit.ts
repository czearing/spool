import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { readAgentPrompt, withAgentLock } from "./agents";
import { hasCode } from "./file-snapshot";
import { publishJson, readOptionalJson } from "./spool-publish";
import { validateSubmission, validateRequestId, TaskSubmissionError, type CreatedTask } from "./task-submission";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";
const journalPath = (root: string, requestId: string) => join(root, "controls", "ui-submissions", `${requestId}.json`);
const accepted = (id: string): CreatedTask => ({ id, state: "accepted", notice: "Queued for agent" });
async function existingTask(root: string, id: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const queue of ["incoming", "in_progress", "completed", "failed"]) {
      const task = await readOptionalJson(join(root, "queues", queue, `${id}.json`));
      if (task !== undefined) {
        if (!record(task) || task.id !== id) throw new Error("Invalid Spool work item.");
        return task;
      }
    }
  }
}
function journal(value: unknown, id: string) {
  if (!record(value) || value.taskId !== id || typeof value.fingerprint !== "string" ||
    !["reserved", "published"].includes(String(value.phase))) throw new Error("Invalid task submission receipt.");
  return value;
}
async function confirm(root: string, requestId: string, saved: Record<string, unknown>) {
  const id = `manual-${requestId}`;
  if (saved.phase === "published") return accepted(id);
  const task = await existingTask(root, id);
  if (!record(task?.interaction) || !Array.isArray(task.interaction.applied_requests) || !task.interaction.applied_requests.includes(requestId)) {
    throw new TaskSubmissionError("Submission could not be confirmed. This request has not been duplicated; check the queue before retrying.", 503);
  }
  await publishJson(journalPath(root, requestId), { ...saved, phase: "published" }, true);
  return accepted(id);
}
export async function readSpoolSubmission(root: string, requestId: string): Promise<CreatedTask> {
  validateRequestId(requestId);
  const saved = await readOptionalJson(journalPath(root, requestId));
  if (saved === undefined) throw new TaskSubmissionError("Submission not found.", 404);
  return confirm(root, requestId, journal(saved, `manual-${requestId}`));
}
export async function submitSpoolTask(root: string, input: unknown): Promise<CreatedTask> {
  const draft = validateSubmission(input), id = `manual-${draft.requestId}`;
  const fingerprint = createHash("sha256").update(JSON.stringify(draft)).digest("hex");
  return withAgentLock(root, draft.agent, async () => {
    await readAgentPrompt(root, draft.agent);
    const file = journalPath(root, draft.requestId), previous = await readOptionalJson(file);
    if (previous !== undefined) {
      const saved = journal(previous, id);
      if (saved.fingerprint !== fingerprint) throw new TaskSubmissionError("Submission identity was reused for different input.", 409);
      return confirm(root, draft.requestId, saved);
    }
    if (await readOptionalJson(join(root, "controls", "commands", `${draft.requestId}.json`)) !== undefined) {
      throw new TaskSubmissionError("This earlier request is still owned by the preparation flow. It has not been submitted again.", 409);
    }
    if (await existingTask(root, id)) throw new TaskSubmissionError("This task identity already exists.", 409);
    const capability = await readOptionalJson(join(root, "controls", "capabilities.json"));
    const age = record(capability) && typeof capability.updatedAt === "string" ? Date.now() - Date.parse(capability.updatedAt) : NaN;
    if (!record(capability) || capability.taskControl !== true || !Number.isFinite(age) || age < 0 || age >= 15000) {
      throw new TaskSubmissionError("Spool is offline. Start the daemon and retry.", 503);
    }
    if (draft.model && capability.taskModelVersion !== 1) {
      throw new TaskSubmissionError("This Spool daemon does not support task model overrides. Update it before submitting an override.", 503, true);
    }
    await mkdir(join(root, "controls", "ui-submissions"), { recursive: true });
    const saved = { taskId: id, fingerprint, phase: "reserved" };
    try { await publishJson(file, saved); }
    catch (error) {
      if (hasCode(error, "EEXIST")) throw new TaskSubmissionError("This submission is already being created. Retry the same request.", 409);
      throw error;
    }
    const now = new Date().toISOString();
    const task = { id, agent: draft.agent, title: draft.title, prompt: draft.prompt, ...(draft.model ? { model: draft.model } : {}), workspace: null,
      independent_workspace: false, status: "incoming", session_id: null, created_at: now, updated_at: now,
      comments: [], cost: {}, error: null, turns: 0, interaction: { applied_requests: [draft.requestId] }, provider: null };
    try { await publishJson(join(root, "queues", "incoming", `${id}.json`), task); }
    catch (error) {
      await rm(file);
      if (hasCode(error, "EEXIST")) throw new TaskSubmissionError("This task identity already exists.", 409);
      throw error;
    }
    await publishJson(file, { ...saved, phase: "published" }, true);
    return accepted(id);
  });
}
