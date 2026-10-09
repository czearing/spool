import { conversationEntryId, conversationMessages, type TaskConversation } from "./task-conversation";
import type { ChatMessage } from "../components/ui/message-history";
import { assembleConversation } from "./conversation-history";

export type ConversationTool = {
  id: string; name: string; startedAt: string; completedAt?: string; input?: string; output?: string;
  status: "Completed" | "Failed" | "Pending" | "Unconfirmed";
};
export type ConversationItem = { id: string; kind: "message"; message: ChatMessage } | { id: string; kind: "tool"; tool: ConversationTool }
  | { id: string; kind: "error"; text: string };
export function conversationItems(data: TaskConversation): ConversationItem[] {
  if (data.raw) data = { ...data, entries: assembleConversation(data.entries) };
  const positions = new Map(data.entries.map((entry, index) => [conversationEntryId(entry, index), index]));
  const items: { position: number; item: ConversationItem }[] = conversationMessages(data).map((message, index) => ({
    position: message.id === "task-prompt" ? -1 : positions.get(message.id) ?? data.entries.length + index,
    item: { id: message.id, kind: "message", message },
  }));
  const calls = new Map<string, ConversationTool>();
  data.entries.forEach((entry, index) => {
    if (!["tool_call", "tool_result"].includes(entry.kind)) return;
    const id = entry.toolUseId ?? conversationEntryId(entry, index);
    let tool = calls.get(id);
    if (!tool) {
      tool = { id, name: entry.name || "Earlier tool", startedAt: entry.ts,
        status: data.activity === "unknown" || ["completed", "failed"].includes(data.task.status) ? "Unconfirmed" : "Pending" };
      calls.set(id, tool); items.push({ position: index, item: { id: `tool:${id}`, kind: "tool", tool } });
    }
    if (entry.kind === "tool_call") { tool.name = entry.name || "Tool"; tool.input = entry.input; }
    else { tool.output = entry.content; tool.completedAt = entry.ts; tool.status = entry.isError ? "Failed" : "Completed"; }
  });
  const ordered = items.sort((a, b) => a.position - b.position).map(({ item }) => item);
  if (data.task.error) ordered.push({ id: "task-error", kind: "error", text: data.task.error });
  return ordered;
}
