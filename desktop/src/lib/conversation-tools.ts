import { connectionIssue, conversationEntryId, conversationMessages, type TaskConversation } from "./task-conversation";
import type { ChatMessage } from "../components/ui/message-history";
import { assembleConversation } from "./conversation-history";

export type ConversationTool = {
  id: string; name: string; startedAt: string; completedAt?: string; input?: string; output?: string;
  status: "Completed" | "Failed" | "Pending" | "Unconfirmed";
};
export type ConversationItem = { id: string; kind: "message"; message: ChatMessage } | { id: string; kind: "tool"; tool: ConversationTool }
  | { id: string; kind: "error"; text: string };
function completionMessage(item: ConversationItem, author: string): ConversationItem {
  if (item.kind !== "tool" || item.tool.name !== "task_complete" || !item.tool.input) return item;
  let input;
  try { input = JSON.parse(item.tool.input); }
  catch { return item; }
  if (typeof input?.summary !== "string" || !input.summary.trim()) return item;
  const tool = item.tool;
  return { id: item.id, kind: "message", message: {
    id: item.id, author, direction: "incoming", markdown: input.summary, createdAt: tool.startedAt,
    status: tool.status === "Failed" ? "failed" : tool.status === "Completed" ? "complete" : "accepted",
    statusLabel: tool.status === "Completed" ? "" : tool.status,
    error: tool.status === "Failed" ? tool.output || "Task completion failed." : undefined,
  } };
}
export function conversationItems(data: TaskConversation): ConversationItem[] {
  if (data.raw) data = { ...data, entries: assembleConversation(data.entries) };
  const positions = new Map(data.entries.map((entry, index) => [conversationEntryId(entry, index), index]));
  let times: number[] | undefined;
  const items: { position: number; time: number; item: ConversationItem }[] = conversationMessages(data).map(({ entryId, ...message }) => {
    let position = message.id === "task-prompt" ? -1 : positions.get(entryId ?? message.id), time = 0;
    if (position === undefined) {
      time = Date.parse(message.createdAt ?? "");
      position = data.entries.length;
      if (Number.isFinite(time)) {
        if (!times) {
          let latest = -Infinity;
          // Keep native log order authoritative even when provider clocks move backwards.
          times = data.entries.map(entry => {
            const timestamp = Date.parse(entry.ts);
            if (Number.isFinite(timestamp)) latest = Math.max(latest, timestamp);
            return latest;
          });
        }
        let low = 0, high = times.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (times[middle] <= time) low = middle + 1;
          else high = middle;
        }
        position = low - .5;
      } else time = 0;
    }
    return { position, time, item: { id: message.id, kind: "message", message } };
  });
  const calls = new Map<string, ConversationTool>();
  data.entries.forEach((entry, index) => {
    if (!["tool_call", "tool_result"].includes(entry.kind)) return;
    const id = entry.toolUseId ?? conversationEntryId(entry, index);
    let tool = calls.get(id);
    if (!tool) {
      tool = { id, name: entry.name || "Earlier tool", startedAt: entry.ts,
        status: data.activity === "unknown" || ["completed", "failed", "superseded"].includes(data.task.status) ? "Unconfirmed" : "Pending" };
      calls.set(id, tool); items.push({ position: index, time: 0, item: { id: `tool:${id}`, kind: "tool", tool } });
    }
    if (entry.kind === "tool_call") { tool.name = entry.name || "Tool"; tool.input = entry.input; }
    else { tool.output = entry.content; tool.completedAt = entry.ts; tool.status = entry.isError ? "Failed" : "Completed"; }
  });
  const ordered = items.sort((a, b) => a.position - b.position || a.time - b.time)
    .map(({ item }) => completionMessage(item, data.task.agent));
  if (data.task.error && !data.connection && data.task.status !== "superseded")
    ordered.push({ id: "task-error", kind: "error", text: connectionIssue(data.task.error) ?? data.task.error });
  if (data.task.status === "superseded")
    ordered.push({ id: "review-superseded", kind: "message", message: { id: "review-superseded",
      author: "Spool", direction: "incoming", markdown: "Superseded by a newer PR source revision. " +
        "The original review evidence is retained; this is not a failed validation or an approval. " +
        "The runner handles the newer revision separately.", status: "complete", statusLabel: "Superseded" } });
  return ordered;
}
export function createConversationItemsSelector() {
  let previousInputs: unknown[] = [], previousItems: ConversationItem[] = [];
  return (data: TaskConversation) => {
    const task = data.task;
    // Query snapshots are immutable; polling-only metadata must not invalidate historical rows.
    const inputs = [data.entries, data.raw, data.limited, data.activity, !!data.connection,
      task.agent, task.prompt, task.createdAt, task.status, task.error, task.interaction?.messages];
    if (inputs.every((value, index) => value === previousInputs[index])) return previousItems;
    let byId: Map<string, ConversationItem> | undefined;
    const items = conversationItems(data).map((item, index) => {
      const positioned = previousItems[index];
      const previous = positioned?.id === item.id ? positioned
        : (byId ??= new Map(previousItems.map(item => [item.id, item]))).get(item.id);
      if (previous?.kind === "tool" && item.kind === "tool" && sameFields(previous.tool, item.tool)) return previous;
      if (previous?.kind === "message" && item.kind === "message" && sameFields(previous.message, item.message)) return previous;
      return previous && previous.kind === item.kind && sameFields(previous, item) ? previous : item;
    });
    if (items.length !== previousItems.length || items.some((item, index) => item !== previousItems[index]))
      previousItems = items;
    previousInputs = inputs;
    return previousItems;
  };
}
function sameFields(before: object, after: object) {
  const left = before as Record<string, unknown>, right = after as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) if (left[key] !== right[key]) return false;
  return true;
}
