import type { ConversationEntry, TaskConversation } from "./task-conversation";
import { replaceEqualDeep } from "@tanstack/react-query";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";
export function isConversation(value: unknown): value is TaskConversation {
  return record(value) && record(value.task) && typeof value.task.id === "string" &&
    typeof value.cursor === "number" && Number.isSafeInteger(value.cursor) && value.cursor >= 0 && Array.isArray(value.entries) &&
    value.entries.every(entry => record(entry) && typeof entry.kind === "string" && typeof entry.ts === "string" &&
      (value.raw !== true || typeof entry.id === "string" && typeof entry.offset === "number" && Number.isSafeInteger(entry.offset) && entry.offset >= 0)) &&
    (value.nextBefore === null || typeof value.nextBefore === "number") && typeof value.limited === "boolean";
}
export function mergeConversation(saved: unknown, incoming: unknown, older = false): TaskConversation {
  if (!isConversation(incoming)) throw new Error("Invalid conversation response.");
  if (!isConversation(saved)) return incoming;
  if (saved.logId !== incoming.logId || incoming.cursor < saved.cursor && !older) {
    if (older) throw new Error("Conversation history changed. Retry to load the current history.");
    return incoming;
  }
  const entries = new Map(saved.entries.map(entry => [entry.id, entry]));
  for (const entry of incoming.entries) {
    if (entry.id === undefined || entry.offset === undefined) throw new Error("Conversation event has no stable identity.");
    entries.set(entry.id, entry);
  }
  const nextBefore = saved.nextBefore === null || incoming.nextBefore === null
    ? null : Math.min(saved.nextBefore, incoming.nextBefore);
  return replaceEqualDeep(saved, { ...(older ? saved : incoming), entries: [...entries.values()].sort((a, b) => a.offset! - b.offset!),
    cursor: Math.max(saved.cursor, incoming.cursor), nextBefore, limited: nextBefore !== null });
}
export function assembleConversation(entries: ConversationEntry[]) {
  const result: ConversationEntry[] = [], tools = new Map<string, number>();
  const bounded = (text: string) => text.length > 20000 ? `${text.slice(0, 20000)}\n[Long output shortened in this view.]` : text;
  for (const entry of entries) {
    const last = result.at(-1);
    if (entry.kind === "turn_end") {
      if (last?.delta) result[result.length - 1] = { ...last, delta: false };
    } else if (entry.kind === "tool_progress") {
      const index = entry.toolUseId ? tools.get(entry.toolUseId) : undefined;
      if (index !== undefined) result[index] = { ...result[index],
        ...(entry.name ? { name: entry.name } : {}), ...(entry.input !== undefined ? { input: entry.input } : {}) };
    } else if (entry.kind === "assistant" && last?.kind === "assistant" && last.delta) {
      result[result.length - 1] = { ...last, text: entry.delta ? bounded((last.text ?? "") + (entry.text ?? "")) : entry.text, delta: entry.delta };
    } else {
      if (entry.kind === "tool_call" && entry.toolUseId) tools.set(entry.toolUseId, result.length);
      result.push(entry);
    }
  }
  return result;
}
