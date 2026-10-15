import type { ChatMessage } from "../components/ui/message-history";

export type ConversationEntry = {
  kind: string; ts: string; text?: string; delta?: boolean;
  id?: string; offset?: number; messageId?: string;
  name?: string; toolUseId?: string; input?: string; content?: string; isError?: boolean;
};
export type OperatorMessage = { id: string; text: string; status: string; created_at: string; error?: string | null };
export type ConversationActivity = "queued" | "starting" | "working" | "writing" | "waiting" | "completed" | "failed" | "offline" | "unknown";
export type TaskConversation = {
  task: {
    id: string; title: string; agent: string; status: string; prompt: string; createdAt?: string; error?: string | null;
    interaction?: { messages?: OperatorMessage[]; phase?: string; paused?: boolean } | null;
  };
  entries: ConversationEntry[];
  available: boolean; limited: boolean; nextBefore: number | null; cursor: number;
  canSend: boolean; readOnlyReason: string;
  recoveryAvailable?: boolean;
  activity?: ConversationActivity;
  raw?: boolean; logId?: string | null;
};
export function taskActivity(task: TaskConversation["task"], last: ConversationEntry | undefined, online: boolean): ConversationActivity {
  if (task.status === "completed" || task.status === "failed") return task.status;
  if (!online) return "offline";
  if (task.interaction?.paused) return "waiting";
  if (task.status === "incoming") return "queued";
  if (task.interaction?.phase === "starting") return "starting";
  if (task.interaction?.phase !== "running") return "unknown";
  return last?.kind === "assistant" && last.delta ? "writing" : "working";
}
export class ConversationError extends Error {
  constructor(message: string, readonly status = 400, readonly rejected = false) { super(message); }
}
export function validateTaskId(id: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,179}$/.test(id)) throw new ConversationError("Invalid task identity.");
}
export const conversationEntryId = (entry: ConversationEntry, index: number) => entry.id ?? `${entry.kind}:${entry.ts}:${index}`;
export function conversationMessages(data: TaskConversation): ChatMessage[] {
  const firstUser = data.limited ? -1 : data.entries.findIndex((entry) => entry.kind === "user");
  const firstText = data.entries[firstUser]?.text;
  const hasOriginal = !!data.task.prompt && (firstText === data.task.prompt || !!firstText?.endsWith(`\n\n${data.task.prompt}`));
  const lastAssistant = data.entries.findLastIndex((entry) => entry.kind === "assistant");
  const messages: ChatMessage[] = data.entries.flatMap((entry, index) => {
    if (!entry.text || !["user", "assistant", "stderr"].includes(entry.kind)) return [];
    return [{ id: conversationEntryId(entry, index), author: entry.kind === "user" ? "You"
      : ["stderr", "stdout"].includes(entry.kind) ? "Spool" : data.task.agent,
      markdown: hasOriginal && index === firstUser ? data.task.prompt : entry.text,
      direction: entry.kind === "user" ? "outgoing" : "incoming", createdAt: entry.ts,
      status: entry.kind === "stderr" ? "failed"
        : index === lastAssistant && entry.delta && data.activity === "writing" ? "generating" : "complete",
      statusLabel: entry.kind === "assistant" ? "" : undefined }];
  });
  if (!data.limited && !hasOriginal && data.task.prompt.trim()) {
    messages.unshift({ id: "task-prompt", author: "You", direction: "outgoing", markdown: data.task.prompt,
      createdAt: data.task.createdAt, status: "complete" });
  }
  for (const message of data.task.interaction?.messages ?? []) {
    if (["sent", "delivered"].includes(message.status)) continue;
    const logged = data.entries.findIndex((entry) => entry.kind === "user" && (entry.messageId
      ? entry.messageId === message.id : (entry.text === message.text
        || (message.text.length > 20000 && entry.text?.startsWith(message.text.slice(0, 20000))))
        && Date.parse(entry.ts) >= Date.parse(message.created_at)));
    const resolved = ["retried", "dismissed"].includes(message.status);
    if (resolved && logged < 0 && data.limited &&
      Date.parse(message.created_at) < Date.parse(data.entries[0]?.ts ?? "")) continue;
    const uncertain = message.status === "delivery_uncertain";
    const error = resolved ? undefined : uncertain
      ? "Delivery of this earlier message is unconfirmed. It was not automatically resent." : message.error ?? undefined;
    const statusLabel = uncertain ? "Delivery unconfirmed" : message.status === "retried" ? "Resent by you"
      : message.status === "dismissed" ? "Left unsent" : undefined;
    if (logged >= 0 && (error || message.status === "failed")) {
      const entry = data.entries[logged], bubble = messages.find((item) => item.id === conversationEntryId(entry, logged));
      if (bubble) { bubble.status = uncertain ? "stopped" : "failed"; bubble.statusLabel = statusLabel; bubble.error = error; }
    }
    if (logged >= 0 && !error && message.status !== "failed") {
      const entry = data.entries[logged], bubble = messages.find((item) => item.id === conversationEntryId(entry, logged));
      if (bubble) { bubble.status = resolved ? "stopped" : "accepted";
        bubble.statusLabel = statusLabel ?? (message.status === "delivering" ? "Delivering" : "Queued"); }
    }
    if (logged < 0) messages.push({ id: message.id, author: "You", direction: "outgoing", markdown: message.text,
      status: uncertain || resolved ? "stopped" : error || message.status === "failed" ? "failed" : "accepted",
      error, createdAt: message.created_at,
      statusLabel: statusLabel ?? (error || message.status === "failed" ? undefined : message.status === "delivering" ? "Delivering" : "Queued") });
  }
  return messages;
}
