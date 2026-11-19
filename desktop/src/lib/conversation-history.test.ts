import { expect, it } from "vitest";
import { assembleConversation, createConversationAssembler, mergeConversation } from "./conversation-history";
import { conversationItems } from "./conversation-tools";
import type { ConversationEntry, TaskConversation } from "./task-conversation";

const entry = (offset: number, text: string, delta = false): ConversationEntry =>
  ({ id: `log:${offset}`, offset, kind: "assistant", ts: "same-timestamp", text, delta });
const page = (entries: ConversationEntry[], cursor: number, nextBefore: number | null): TaskConversation => ({
  task: { id: "task", title: "Task", agent: "engineer", status: "in_progress", prompt: "" },
  raw: true, logId: "file", entries, cursor, nextBefore, limited: nextBefore !== null,
  available: true, activity: "working", canSend: true, readOnlyReason: "",
});
it("assembles appended events incrementally without revisiting historical event fields or mutating older results", () => {
  const assemble = createConversationAssembler();
  let reads = 0;
  const historical: ConversationEntry = { get kind() { reads++; return "assistant"; }, ts: "1", text: "Earlier", delta: false };
  const first = [historical], original = assemble(first), before = reads;
  const streamed = assemble([...first, entry(100, "Hello ", true)]);
  expect(reads - before).toBeLessThan(3);
  const after = assemble([...first, entry(100, "Hello ", true), entry(200, "world", true)]);
  expect(after).toEqual(assembleConversation([...first, entry(100, "Hello ", true), entry(200, "world", true)]));
  expect(original).toHaveLength(1);
  expect(streamed.at(-1)?.text).toBe("Hello ");
});
it("incremental assembly handles progress, completion, rewritten prefixes and truncation exactly like a full rebuild", () => {
  const assemble = createConversationAssembler();
  const events: ConversationEntry[] = [
    { kind: "tool_call", ts: "1", toolUseId: "read", name: "Read" },
    { kind: "tool_progress", ts: "2", toolUseId: "read", name: "Reading", input: "updated" },
    entry(100, "Hello ", true), entry(200, "world", true), { kind: "turn_end", ts: "3" },
  ];
  for (let size = 1; size <= events.length; size++) expect(assemble(events.slice(0, size))).toEqual(assembleConversation(events.slice(0, size)));
  const rewritten = [entry(0, "Replacement"), ...events.slice(1)];
  expect(assemble(rewritten)).toEqual(assembleConversation(rewritten));
  expect(assemble(events.slice(0, 1))).toEqual(assembleConversation(events.slice(0, 1)));
  expect(assemble([])).toEqual([]);
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
it("replaces a disconnected cached window while keeping its gap available as older history", () => {
  const saved = page([entry(0, "Cached reply")], 100, null);
  const latest = page([entry(20_000_000, "Newest reply")], 20_000_100, 20_000_000);
  const result = mergeConversation(saved, latest);
  expect(result).toEqual(latest);
  expect(conversationItems(result)).toMatchObject([{ message: { markdown: "Newest reply" } }]);
  const older = page([entry(100, "Unread reply")], 20_000_000, 100);
  expect(mergeConversation(result, older, true).entries.map(value => value.text))
    .toEqual(["Unread reply", "Newest reply"]);
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
it("updates permissions and pending-message metadata without rebuilding an unchanged history", () => {
  const saved = page([entry(0, "One"), entry(100, "Two")], 200, null);
  const incoming = { ...page([entry(100, "Two")], 200, 100), canSend: false, activity: "offline" as const,
    readOnlyReason: "Spool is offline.", task: { ...saved.task,
      interaction: { messages: [{ id: "pending", text: "New message", status: "queued" as const }] } } };
  const result = mergeConversation(saved, incoming);
  expect(result.entries).toBe(saved.entries);
  expect(result.canSend).toBe(false); expect(result.activity).toBe("offline");
  expect(result.task.interaction?.messages).toEqual(incoming.task.interaction.messages);
});
it("does not mistake changed entries or backfilled events for unchanged overlapping windows", () => {
  const saved = page([entry(0, "One"), entry(200, "Three")], 300, null);
  const updated = mergeConversation(saved, page([entry(100, "Two"), entry(200, "Updated")], 300, 100));
  expect(updated.entries.map(entry => entry.text)).toEqual(["One", "Two", "Updated"]);
  expect(mergeConversation(updated, page([entry(200, "Updated")], 300, 200))).toBe(updated);
});
it("still sorts and deduplicates noncanonical input instead of taking the unchanged fast path", () => {
  const duplicate = { ...entry(0, "Earlier"), id: "duplicate" };
  const saved = page([entry(200, "Last"), duplicate, { ...duplicate, text: "Replacement" }], 300, null);
  expect(mergeConversation(saved, page([entry(200, "Last")], 300, 200)).entries)
    .toEqual([{ ...duplicate, text: "Replacement" }, entry(200, "Last")]);
});
it("replaces a complete rewritten window even when the file identity and length do not change", () => {
  const saved = page([entry(0, "Old first"), entry(100, "Old last")], 300, null);
  const fresh = page([entry(200, "Replacement")], 300, null);
  expect(mergeConversation(saved, fresh)).toEqual(fresh);
  expect(mergeConversation(saved, page([], 300, null)).entries).toEqual([]);
});
it("removes vanished events only inside the authoritative historical window", () => {
  const saved = page([entry(0, "Earlier"), entry(100, "Removed"), entry(200, "Kept"), entry(300, "Later")], 400, null);
  const result = mergeConversation(saved, page([entry(200, "Kept")], 300, 100), true);
  expect(result.entries.map(entry => entry.text)).toEqual(["Earlier", "Kept", "Later"]);
  expect(result.entries[0]).toBe(saved.entries[0]);
  expect(result.entries[2]).toEqual(saved.entries[3]);
  expect(result.cursor).toBe(400);
});
it("replaces a cached window across an unread gap without hiding the older-history cursor", () => {
  const saved = page([entry(0, "Cached reply")], 100, null);
  const fresh = page([entry(20_000_000, "Latest reply")], 20_000_100, 19_900_000);
  const latest = mergeConversation(saved, fresh);
  expect(latest).toEqual(fresh);
  const history = mergeConversation(latest, page([entry(19_800_000, "Earlier reply")], 19_900_000, 19_700_000), true);
  expect(history.entries.map(value => value.text)).toEqual(["Earlier reply", "Latest reply"]);
  expect(history.nextBefore).toBe(19_700_000);
});
it("does not combine histories from different tasks with the same log identity", () => {
  const saved = page([entry(0, "Other task")], 100, null);
  const fresh = { ...page([entry(100, "Current task")], 200, 100), task: { ...saved.task, id: "another" } };
  expect(mergeConversation(saved, fresh)).toEqual(fresh);
});
