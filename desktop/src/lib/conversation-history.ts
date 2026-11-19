import type { ConversationEntry, OperatorMessage, TaskConversation } from "./task-conversation";
import { replaceEqualDeep } from "@tanstack/react-query";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";
function entryIndexAtOffset(entries: ConversationEntry[], offset: number) {
  let low = 0, high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (entries[middle].offset! < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}
export function isConversation(value: unknown): value is TaskConversation {
  return record(value) && record(value.task) && typeof value.task.id === "string" &&
    typeof value.cursor === "number" && Number.isSafeInteger(value.cursor) && value.cursor >= 0 && Array.isArray(value.entries) &&
    value.entries.every(entry => record(entry) && typeof entry.kind === "string" && typeof entry.ts === "string" &&
      (value.raw !== true || typeof entry.id === "string" && typeof entry.offset === "number" && Number.isSafeInteger(entry.offset) && entry.offset >= 0)) &&
    (value.nextBefore === null || typeof value.nextBefore === "number") && typeof value.limited === "boolean";
}
export function mergeOperatorMessages(saved: OperatorMessage[] = [], incoming: OperatorMessage[] = []) {
  const messages = new Map(saved.map(message => [message.id, message]));
  for (const message of incoming) {
    const previous = messages.get(message.id);
    const receipt = previous && (["sent", "delivered"].includes(previous.status)
      || message.status === "sending" && previous.status !== "sending"
      || message.status === "queued" && previous.status === "delivering") ? previous : message;
    messages.set(message.id, previous ? { ...receipt,
      created_at: Number.isFinite(Date.parse(previous.created_at)) ? previous.created_at : message.created_at,
    } : message);
  }
  return [...messages.values()];
}
export function mergeConversation(saved: unknown, fresh: unknown, older = false): TaskConversation {
  if (!isConversation(fresh)) throw new Error("Invalid conversation response.");
  let incoming = fresh;
  if (!isConversation(saved) || saved.task.id !== incoming.task.id) return incoming;
  if (!older && (saved.task.interaction?.messages?.length || incoming.task.interaction?.messages?.length)) {
    incoming = { ...incoming, task: { ...incoming.task, interaction: { ...incoming.task.interaction,
      messages: mergeOperatorMessages(saved.task.interaction?.messages, incoming.task.interaction?.messages) } } };
  }
  if (saved.logId !== incoming.logId || !older && (incoming.cursor < saved.cursor ||
      incoming.nextBefore !== null && incoming.nextBefore > saved.cursor)) {
    if (older) throw new Error("Conversation history changed. Retry to load the current history.");
    return incoming;
  }
  for (const entry of incoming.entries) {
    if (entry.id === undefined || entry.offset === undefined) throw new Error("Conversation event has no stable identity.");
  }
  const nextBefore = saved.nextBefore === null || incoming.nextBefore === null
    ? null : Math.min(saved.nextBefore, incoming.nextBefore);
  const ordered = saved.entries.every((entry, position) => entry.id === `log:${entry.offset}`
    && (position === 0 || saved.entries[position - 1].offset! < entry.offset!));
  const start = incoming.nextBefore ?? 0, end = incoming.cursor;
  const first = ordered ? entryIndexAtOffset(saved.entries, start) : 0;
  const last = ordered ? entryIndexAtOffset(saved.entries, end) : 0;
  if (ordered && last - first === incoming.entries.length && incoming.entries.every((entry, index) => {
    const previous = saved.entries[first + index];
    return previous?.id === entry.id && replaceEqualDeep(previous, entry) === previous;
  })) return replaceEqualDeep(saved, { ...(older ? saved : incoming), entries: saved.entries,
    cursor: Math.max(saved.cursor, incoming.cursor), nextBefore, limited: nextBefore !== null });
  const entries = new Map(saved.entries.filter(entry => entry.offset! < start || entry.offset! >= end)
    .map(entry => [entry.id, entry]));
  for (const entry of incoming.entries) entries.set(entry.id, entry);
  return replaceEqualDeep(saved, { ...(older ? saved : incoming), entries: [...entries.values()].sort((a, b) => a.offset! - b.offset!),
    cursor: Math.max(saved.cursor, incoming.cursor), nextBefore, limited: nextBefore !== null });
}
export function assembleConversation(entries: ConversationEntry[]) {
  return appendConversation([], new Map(), entries);
}
export function createConversationAssembler() {
  let previous: ConversationEntry[] = [], result: ConversationEntry[] = [], tools = new Map<string, number>();
  return (entries: ConversationEntry[]) => {
    if (entries === previous) return result;
    const append = entries.length >= previous.length && previous.every((entry, index) => entry === entries[index]);
    if (!append) { result = []; tools = new Map(); }
    else if (entries.length === previous.length) { previous = entries; return result; }
    else result = [...result];
    appendConversation(result, tools, entries, append ? previous.length : 0);
    previous = entries;
    return result;
  };
}
function appendConversation(result: ConversationEntry[], tools: Map<string, number>, entries: ConversationEntry[], start = 0) {
  const bounded = (text: string) => text.length > 20000 ? `${text.slice(0, 20000)}\n[Long output shortened in this view.]` : text;
  for (let index = start; index < entries.length; index++) {
    const entry = entries[index];
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
