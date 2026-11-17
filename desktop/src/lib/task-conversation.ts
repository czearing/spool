import type { ChatMessage } from "../components/ui/message-history";

export type ConversationEntry = {
  kind: string; ts: string; text?: string; delta?: boolean;
  id?: string; offset?: number; messageId?: string;
  name?: string; toolUseId?: string; input?: string; content?: string; isError?: boolean;
};
export type OperatorMessage = { id: string; text: string; status: string; created_at: string; error?: string | null };
export type ConversationActivity = "queued" | "starting" | "working" | "writing" | "waiting" | "completed" | "failed" | "superseded" | "offline" | "unknown";
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
  connection?: { message: string; retryAt?: string };
  raw?: boolean; logId?: string | null;
};
export function connectionIssue(error: string): string | undefined {
  if (/Codespace preparation is not ready|live runner-owned preparation/.test(error))
    return "The agent's workspace needs preparation before it can continue. Your conversation is saved.";
  if (/You have too many codespaces running/i.test(error))
    return "No Codespace slot is available. Your messages are saved.";
  if (/Remote review lease is no longer held|Remote revision changed|Pinned PR revision changed/.test(error))
    return "The agent's workspace changed and must be verified again before continuing. Your conversation is saved.";
  if (/Copilot ACP startup failed|Copilot ACP closed its output|failed to start SSH server|Connection reset by peer|SSH command channel (?:closed|exited|startup timed out)|Assigned Codespace is shutting down/.test(error))
    return "The connection to the agent was interrupted. Your conversation is saved.";
}
export function taskActivity(task: TaskConversation["task"], last: ConversationEntry | undefined, online: boolean): ConversationActivity {
  if (task.status === "completed" || task.status === "failed" || task.status === "superseded") return task.status;
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
export function matchOperatorMessages(entries: ConversationEntry[], messages: OperatorMessage[]) {
  const matches = new Map<string, number>();
  if (!messages.length) return matches;
  const byId = new Map<string, number>(), byText = new Map<string, number[]>(), legacy: number[] = [];
  entries.forEach((entry, index) => {
    if (entry.kind !== "user") return;
    if (entry.messageId !== undefined) {
      if (!byId.has(entry.messageId)) byId.set(entry.messageId, index);
    } else {
      legacy.push(index);
      if (entry.text !== undefined) {
        const candidates = byText.get(entry.text);
        if (candidates) candidates.push(index); else byText.set(entry.text, [index]);
      }
    }
  });
  const claimed = new Set<number>();
  for (const message of messages) {
    let index = byId.get(message.id);
    if (index === undefined) {
      const createdAt = Date.parse(message.created_at), prefix = message.text.length > 20000 ? message.text.slice(0, 20000) : undefined;
      index = (prefix === undefined ? byText.get(message.text) ?? [] : legacy).find(index =>
        !claimed.has(index) && (prefix === undefined || entries[index].text?.startsWith(prefix)) &&
        Date.parse(entries[index].ts) >= createdAt);
    }
    if (index !== undefined) { matches.set(message.id, index); claimed.add(index); }
  }
  return matches;
}
function operatorBubble(message: OperatorMessage): ChatMessage {
  const resolved = ["retried", "dismissed"].includes(message.status), uncertain = message.status === "delivery_uncertain";
  const error = resolved ? undefined : uncertain
    ? "Delivery of this earlier message is unconfirmed. It was not automatically resent." : message.error ?? undefined;
  const status = uncertain || resolved ? "stopped" : error || message.status === "failed" || message.status === "unconfirmed" ? "failed"
    : message.status === "sending" ? "sending" : ["sent", "delivered"].includes(message.status) ? "complete" : "accepted";
  return { id: message.id, author: "You", direction: "outgoing", markdown: message.text,
    createdAt: message.created_at, status, error,
    statusLabel: uncertain ? "Delivery unconfirmed" : message.status === "retried" ? "Resent by you"
      : message.status === "dismissed" ? "Left unsent" : error || message.status === "failed" || status === "complete" ? undefined
      : message.status === "sending" ? "Sending" : message.status === "unconfirmed" ? "Not confirmed"
        : message.status === "delivering" ? "Delivering" : "Queued" };
}
export function conversationMessages(data: TaskConversation): (ChatMessage & { entryId?: string })[] {
  const firstUser = data.limited ? -1 : data.entries.findIndex((entry) => entry.kind === "user");
  const firstText = data.entries[firstUser]?.text;
  const hasOriginal = data.entries[firstUser]?.messageId === undefined && !!data.task.prompt &&
    (firstText === data.task.prompt || !!firstText?.endsWith(`\n\n${data.task.prompt}`));
  const lastAssistant = data.entries.findLastIndex((entry) => entry.kind === "assistant");
  const receipts = data.task.interaction?.messages ?? [];
  const loggedMessages = matchOperatorMessages(data.entries, receipts);
  const byIndex = new Map(receipts.flatMap(message => {
    const index = loggedMessages.get(message.id);
    return index === undefined ? [] : [[index, message] as const];
  }));
  const messages: (ChatMessage & { entryId?: string })[] = [];
  data.entries.forEach((entry, index) => {
    if (!entry.text || !["user", "assistant", "stderr"].includes(entry.kind)) return;
    if (entry.kind === "stderr" && (/^\[Copilot ACP setup\]/.test(entry.text) || connectionIssue(entry.text))) return;
    const entryId = conversationEntryId(entry, index), receipt = byIndex.get(index);
    if (receipt) {
      messages.push({ ...operatorBubble(receipt), entryId,
        createdAt: Number.isFinite(Date.parse(receipt.created_at)) ? receipt.created_at : entry.ts });
      return;
    }
    const original = hasOriginal && index === firstUser;
    messages.push({ id: original ? "task-prompt" : entry.messageId ?? entryId, entryId,
      author: entry.kind === "user" ? "You" : entry.kind === "stderr" ? "Spool" : data.task.agent,
      markdown: hasOriginal && index === firstUser ? data.task.prompt : entry.text,
      direction: entry.kind === "user" ? "outgoing" : "incoming",
      createdAt: original ? data.task.createdAt ?? entry.ts : entry.ts,
      status: entry.kind === "stderr" ? "failed"
        : index === lastAssistant && entry.delta && data.activity === "writing" ? "generating" : "complete",
      statusLabel: entry.kind === "assistant" ? "" : undefined });
  });
  if (!data.limited && !hasOriginal && data.task.prompt.trim()) {
    messages.unshift({ id: "task-prompt", author: "You", direction: "outgoing", markdown: data.task.prompt,
      createdAt: data.task.createdAt, status: ["incoming", "in_progress"].includes(data.task.status) ? "accepted" : "complete",
      statusLabel: data.task.status === "incoming" ? "Queued" : data.task.status === "in_progress" ? "Starting" : undefined });
  }
  const firstTime = data.limited ? data.entries.find(entry => Number.isFinite(Date.parse(entry.ts)))?.ts : undefined;
  for (const message of receipts) {
    if (loggedMessages.has(message.id)) continue;
    if (firstTime && ["sent", "delivered", "retried", "dismissed"].includes(message.status) && Date.parse(message.created_at) < Date.parse(firstTime)) continue;
    messages.push(operatorBubble(message));
  }
  return messages;
}
