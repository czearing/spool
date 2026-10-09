import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { readOptionalJson } from "./spool-publish";
import { ConversationError, taskActivity, validateTaskId, type TaskConversation } from "./task-conversation";
import { validateRequestId } from "./task-submission";
import { conversationToolOutput } from "./conversation-tool-output";
import { monitorConversation } from "../../backend/conversation-reader.mjs";
import { ConversationStore, messageReceipt, publishMessage, type MessageInput } from "./conversation-store";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";
export async function readConversation(root: string, id: string, before: number | null = null, individual = false): Promise<TaskConversation> {
  validateTaskId(id);
  if (before !== null && (!Number.isSafeInteger(before) || before < 0)) throw new ConversationError("Invalid history position.");
  const store = new ConversationStore(root);
  let data;
  try { data = monitorConversation(store, id, before, individual); }
  catch (error) { if (error instanceof RangeError) throw new ConversationError(error.message, 409); throw error; }
  if (!data) throw new ConversationError("Task not found.", 404);
  const capability = await readOptionalJson(join(root, "controls", "capabilities.json"));
  const age = record(capability) && typeof capability.updatedAt === "string" ? Date.now() - Date.parse(capability.updatedAt) : NaN;
  const online = record(capability) && capability.version === 1 && age >= 0 && age < 12000;
  const historical = !["incoming", "in_progress"].includes(data.task.status);
  const readOnlyReason = !online ? "Spool is offline." : capability.interactive !== true ? "Messaging is not enabled in Spool."
    : historical && capability.messageContinuationVersion !== 1 ? "Update Spool to resume this conversation."
    : historical && !data.task.sessionId ? "No saved session is available for this conversation." : "";
  const token = store.task(id)?.provider?.token;
  const secrets = token ? [token] : [];
  const { task } = data;
  return { task: { id: task.id, title: task.title, agent: task.agent, status: task.status, prompt: task.prompt,
    createdAt: task.createdAt, error: task.error, interaction: { messages: before === null
      ? task.interaction?.messages?.filter((message) => !["sent", "delivered"].includes(message.status)) : [] } },
  entries: data.entries.flatMap(entry => ["tool_call", "tool_result", "tool_progress"].includes(entry.kind)
    ? [conversationToolOutput(entry, secrets)] : ["user", "assistant", "stderr", "stdout", "turn_end"].includes(entry.kind) ? [entry] : []),
  available: data.available, limited: data.limited, nextBefore: data.nextBefore, cursor: data.cursor,
  ...(individual ? { raw: true, logId: data.logId } : {}),
  canSend: !readOnlyReason, readOnlyReason, activity: before === null ? taskActivity(task, data.entries.at(-1), online) : "unknown" };
}
export async function sendTaskMessage(root: string, taskId: string, value: unknown) {
  validateTaskId(taskId);
  if (!record(value) || typeof value.id !== "string" || typeof value.message !== "string"
    || !value.message.trim() || Buffer.byteLength(value.message) > 65536 || value.message.includes("\0")
    || Object.keys(value).some((key) => !["id", "message"].includes(key))) throw new ConversationError("Enter a message of up to 65,536 UTF-8 bytes.");
  validateRequestId(value.id);
  const input: MessageInput = { id: value.id, kind: "message", taskId, message: value.message };
  const saved = await readOptionalJson(join(root, "controls", "commands", `${value.id}.json`));
  if (saved !== undefined && (!record(saved) || JSON.stringify(saved.input) !== JSON.stringify(input))) {
    throw new ConversationError("Message identity was reused for different input.", 409);
  }
  const confirm = async () => {
    const receipt = await messageReceipt(root, input.id);
    if (receipt?.result?.status === "failed") throw new ConversationError(receipt.result.error ?? "Spool rejected the message.", 409);
    return receipt?.result?.status === "accepted";
  };
  if (saved !== undefined && await confirm()) return { id: value.id, state: "accepted" };
  const conversation = await readConversation(root, taskId);
  if (!conversation.canSend) throw new ConversationError(conversation.readOnlyReason, 409);
  try { await publishMessage(root, input); }
  catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "number") throw new ConversationError(error.message, error.code);
    throw error;
  }
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await confirm()) return { id: value.id, state: "accepted" };
    await setTimeout(100);
  }
  throw new ConversationError("Waiting for Spool confirmation. Retry to check the same message.", 504);
}
