import { join } from "node:path";
import { readOptionalJson } from "./spool-publish";
import { connectionIssue, ConversationError, taskActivity, validateTaskId, type TaskConversation } from "./task-conversation";
import { validateRequestId } from "./task-submission";
import { conversationToolOutput } from "./conversation-tool-output";
import { monitorConversation } from "../../backend/conversation-reader.mjs";
import { readConversationTask, messageReceipt, pendingMessages, publishMessage, type MessageInput, type MessageRecoveryInput, type StoredTask } from "./conversation-store";
import { setTimeout } from "node:timers/promises";
import { recoveryCommandId } from "../../../../packages/runners/bridge/control-identity.mjs";
import { reconcileMessageReceipts } from "./message-receipts";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";
async function connectionRecovery(root: string, task: StoredTask): Promise<TaskConversation["connection"]> {
  if (task.status !== "failed" || task.interaction?.paused ||
      task.interaction?.messages?.some(message => ["delivering", "delivery_uncertain"].includes(message.status))) return;
  const message = task.interaction?.messages?.findLast(message => message.status === "queued");
  const ids = message
    ? [message.id, recoveryCommandId(task, message), recoveryCommandId(task, message, true)]
    : [recoveryCommandId(task, undefined, true), recoveryCommandId(task)];
  const jobs = await Promise.all(ids.filter(id => /^[a-f0-9-]{36}$/i.test(id)).flatMap(id =>
    ["manual", "native-resumes"].map(async directory => {
      const job = await readOptionalJson(join(root, "controls", directory, `${id}.json`));
      if (!record(job) || !record(job.request) || job.request.taskId !== task.id ||
          job.request.agent !== task.agent || !["waiting", "preparing", "prepared", "submitted"].includes(String(job.status))) return;
      const result = await readOptionalJson(join(root, "controls", "results", `${id}.json`));
      if (result !== undefined) return;
      return { message: "Reconnecting to your Codespace. Your messages are saved.",
        ...(typeof job.retryAt === "string" ? { retryAt: job.retryAt } : {}) };
    })));
  return jobs.find(job => job !== undefined);
}
async function conversationAccess(root: string, task: StoredTask) {
  const capability = await readOptionalJson(join(root, "controls", "capabilities.json"));
  const age = record(capability) && typeof capability.updatedAt === "string" ? Date.now() - Date.parse(capability.updatedAt) : NaN;
  const online = record(capability) && capability.version === 1 && age >= 0 && age < 12000;
  const historical = !["incoming", "in_progress"].includes(task.status);
  const readOnlyReason = historical && !task.session_id ? "No saved session is available for this conversation."
    : online && capability.interactive !== true ? "Messaging is not enabled in Spool."
    : online && historical && capability.messageContinuationVersion !== 1 ? "Update Spool to resume this conversation." : "";
  return { online, readOnlyReason,
    recoveryAvailable: online && capability.interactive === true && capability.messageRecoveryVersion === 1 };
}
async function preparingConversation(root: string, id: string): Promise<TaskConversation | undefined> {
  const requestId = id.match(/^manual-([a-f0-9-]{36})$/i)?.[1];
  if (!requestId) return;
  const submission = await readOptionalJson(join(root, "controls", "ui-submissions", `${requestId}.json`));
  if (!record(submission) || submission.phase !== "preparing" || !record(submission.task)) return;
  const task = submission.task;
  if (task.id !== id || typeof task.agent !== "string" || typeof task.title !== "string" || typeof task.prompt !== "string") return;
  const job = await readOptionalJson(join(root, "controls", "manual", `${requestId}.json`))
    ?? await readOptionalJson(join(root, "controls", "manual-history", `${requestId}.json`));
  const failed = record(job) && job.status === "failed";
  const detail = record(job) && typeof job.detail === "string" ? job.detail : "Waiting for workspace preparation.";
  return {
    task: { id, agent: task.agent, title: task.title, prompt: task.prompt,
      status: failed ? "failed" : "incoming", ...(typeof task.created_at === "string" ? { createdAt: task.created_at } : {}),
      ...(failed ? { error: detail } : {}) },
    entries: [], available: false, limited: false, nextBefore: null, cursor: 0,
    canSend: false, readOnlyReason: failed ? "Workspace preparation failed." : "Preparing the workspace before starting the agent.",
    activity: failed ? "failed" : "waiting", ...(!failed ? { connection: { message: detail } } : {}),
  };
}
export async function readConversation(root: string, id: string, before: number | null = null, individual = false): Promise<TaskConversation> {
  validateTaskId(id);
  if (before !== null && (!Number.isSafeInteger(before) || before < 0)) throw new ConversationError("Invalid history position.");
  let stored = readConversationTask(root, id);
  if (!stored) {
    const preparing = await preparingConversation(root, id);
    if (preparing) return individual ? { ...preparing, raw: true, logId: null } : preparing;
    throw new ConversationError("Task not found.", 404);
  }
  if (before === null && await reconcileMessageReceipts(root, id, stored.interaction?.messages ?? [])) {
    stored = readConversationTask(root, id) ?? stored;
  }
  let data;
  try { data = monitorConversation({ root, task: () => stored }, id, before, individual); }
  catch (error) { if (error instanceof RangeError) throw new ConversationError(error.message, 409); throw error; }
  if (!data) throw new ConversationError("Task not found.", 404);
  const { online, readOnlyReason, recoveryAvailable } = await conversationAccess(root, stored);
  const connection = before !== null ? undefined : online ? await connectionRecovery(root, stored)
    : !readOnlyReason ? { message: "Spool is reconnecting. Messages are saved here and will send when it reconnects." } : undefined;
  const queued = before === null ? await pendingMessages(root, stored) : [];
  const token = stored.provider?.token;
  const secrets = token ? [token] : [];
  const { task } = data;
  return { task: { id: task.id, title: task.title, agent: task.agent, status: task.status, prompt: task.prompt,
    createdAt: task.createdAt, error: connection ? null : task.error ? connectionIssue(task.error) ?? task.error : task.error, interaction: { messages: before === null
      ? [...(task.interaction?.messages ?? []), ...queued] : [] } },
  entries: data.entries.flatMap(entry => ["tool_call", "tool_result", "tool_progress"].includes(entry.kind)
    ? [conversationToolOutput(entry, secrets)] : entry.kind === "stderr" &&
      (/^\[Copilot ACP setup\]/.test(entry.text || "") || connectionIssue(entry.text || "")) ? []
      : ["user", "assistant", "stderr", "stdout", "turn_end"].includes(entry.kind) ? [entry] : []),
  available: data.available, limited: data.limited, nextBefore: data.nextBefore, cursor: data.cursor,
  ...(individual ? { raw: true, logId: data.logId } : {}),
  canSend: !readOnlyReason, recoveryAvailable, readOnlyReason, ...(connection ? { connection } : {}),
  activity: connection && online ? "waiting" : before === null ? taskActivity(task, data.entries.at(-1), online) : "unknown" };
}
export async function sendTaskMessage(root: string, taskId: string, value: unknown) {
  validateTaskId(taskId);
  if (!record(value) || typeof value.id !== "string") throw new ConversationError("Invalid message request.");
  validateRequestId(value.id);
  let input: MessageInput | MessageRecoveryInput;
  if ("decision" in value) {
    if ((value.decision !== "retry" && value.decision !== "dismiss") || typeof value.messageId !== "string" ||
        Object.keys(value).some(key => !["id", "messageId", "decision"].includes(key))) throw new ConversationError("Invalid recovery decision.");
    validateTaskId(value.messageId);
    input = { id: value.id, kind: "resolve_message", taskId, metadata: { messageId: value.messageId, decision: value.decision } };
  } else {
    if (typeof value.message !== "string" || !value.message.trim() || Buffer.byteLength(value.message) > 65536 ||
        value.message.includes("\0") || Object.keys(value).some(key => !["id", "message"].includes(key)))
      throw new ConversationError("Enter a message of up to 65,536 UTF-8 bytes.");
    input = { id: value.id, kind: "message", taskId, message: value.message };
  }
  const saved = await readOptionalJson(join(root, "controls", "commands", `${value.id}.json`));
  if (saved !== undefined && (!record(saved) || JSON.stringify(saved.input) !== JSON.stringify(input))) {
    throw new ConversationError("Message identity was reused for different input.", 409);
  }
  const confirm = async () => {
    const receipt = await messageReceipt(root, input.id);
    if (receipt?.result?.status === "failed") {
      const task = readConversationTask(root, taskId);
      const rejected = !!task && !task.interaction?.applied_requests?.includes(input.id)
        && !task.interaction?.messages?.some(message => message.id === input.id);
      throw new ConversationError(receipt.result.error ?? "Spool rejected the message.", 409, rejected);
    }
    return receipt?.result?.status === "accepted";
  };
  if (saved !== undefined && await confirm()) return { id: value.id, state: "accepted" };
  const task = readConversationTask(root, taskId);
  if (!task) throw new ConversationError("Task not found.", 404);
  const { readOnlyReason, recoveryAvailable } = await conversationAccess(root, task);
  if (input.kind === "resolve_message") {
    if (!recoveryAvailable) throw new ConversationError("Update the running Spool daemon to resolve uncertain messages.", 503);
    if (saved === undefined && !task.interaction?.messages?.some(message =>
        message.id === input.metadata.messageId && message.status === "delivery_uncertain"))
      throw new ConversationError("This message's delivery state changed. Reload the conversation.", 409);
  } else if (saved === undefined && readOnlyReason) throw new ConversationError(readOnlyReason, 409);
  try { await publishMessage(root, input); }
  catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "number") throw new ConversationError(error.message, error.code);
    throw error;
  }
  if (input.kind === "resolve_message") {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await confirm()) return { id: value.id, state: "accepted" };
      await setTimeout(100);
    }
    throw new ConversationError("Waiting for Spool confirmation. Retry to check the same message.", 504);
  }
  return { id: value.id, state: await confirm() ? "accepted" : "queued" };
}
