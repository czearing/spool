import { expect, it } from "vitest";
import { assembleConversation, mergeConversation } from "./conversation-history";
import { conversationItems } from "./conversation-tools";
import type { ConversationEntry, TaskConversation } from "./task-conversation";

const entry = (offset: number, text: string, delta = false): ConversationEntry =>
  ({ id: `log:${offset}`, offset, kind: "assistant", ts: "same-timestamp", text, delta });
const page = (entries: ConversationEntry[], cursor: number, nextBefore: number | null): TaskConversation => ({
  task: { id: "task", title: "Task", agent: "engineer", status: "in_progress", prompt: "" },
  raw: true, logId: "file", entries, cursor, nextBefore, limited: nextBefore !== null,
  available: true, activity: "working", canSend: true, readOnlyReason: "",
});
it("retains loaded history across overlapping live windows and deduplicates by byte identity, not timestamps", () => {
  const latest = page([entry(100, "One"), entry(200, "Two")], 300, 100);
  const history = mergeConversation(latest, page([entry(0, "Zero")], 100, null), true);
  const next = mergeConversation(history, page([entry(200, "Two"), entry(300, "Three")], 400, 200));
  expect(next.entries.map(value => value.text)).toEqual(["Zero", "One", "Two", "Three"]);
  expect(next.nextBefore).toBeNull();
  expect(next.canSend).toBe(true);
  expect(next.entries[1]).toBe(history.entries[1]);
  expect(mergeConversation(next, page([entry(200, "Two"), entry(300, "Three")], 400, 200))).toBe(next);
});
it("assembles streamed messages spanning page boundaries once while retaining their original key", () => {
  const saved = page([entry(0, "Hello ", true)], 100, null);
  const latest = page([entry(100, "world", true)], 200, 100);
  const assembled = conversationItems(mergeConversation(saved, latest));
  expect(assembled).toMatchObject([{ id: "log:0", message: { markdown: "Hello world" } }]);
  const complete = conversationItems(mergeConversation(mergeConversation(saved, latest), page([entry(200, "Hello world!")], 300, 200)));
  expect(complete).toMatchObject([{ id: "log:0", message: { markdown: "Hello world!" } }]);
});
it("applies progress and results after loading a tool start from an older page", () => {
  const call = { ...entry(0, ""), kind: "tool_call", toolUseId: "a", name: "Start", input: "before" };
  const progress = { ...entry(100, ""), kind: "tool_progress", toolUseId: "a", name: "Fetching", input: "updated" };
  const result = { ...entry(200, ""), kind: "tool_result", toolUseId: "a", content: "Done" };
  const data = mergeConversation(page([progress, result], 300, 100), page([call], 100, null), true);
  expect(conversationItems(data)).toMatchObject([{ id: "tool:a", tool: { name: "Fetching", input: "updated", output: "Done", status: "Completed" } }]);
});
it("resets rotated or truncated live logs and rejects historical pages from another generation", () => {
  const saved = page([entry(0, "Old")], 100, null), fresh = { ...page([entry(0, "New")], 100, null), logId: "replacement" };
  expect(mergeConversation(saved, fresh)).toEqual(fresh);
  expect(() => mergeConversation(fresh, saved, true)).toThrow("changed");
  expect(mergeConversation(saved, page([], 0, null)).entries).toEqual([]);
});
it("ends delta rendering at turn completion and bounds accumulated output", () => {
  const values = assembleConversation([entry(0, "x".repeat(19000), true), entry(100, "y".repeat(19000), true),
    { ...entry(200, ""), kind: "turn_end" }]);
  expect(values).toHaveLength(1);
  expect(values[0].delta).toBe(false);
  expect(values[0].text?.length).toBeLessThan(20100);
});
