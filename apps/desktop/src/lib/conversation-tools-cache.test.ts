import { expect, it } from "vitest";
import { appendEvents } from "../../backend/transcript.mjs";
import { conversationItems, createConversationItemsSelector } from "./conversation-tools";
import { conversationToolOutput } from "./conversation-tool-output";
import type { TaskConversation } from "./task-conversation";

const data: TaskConversation = {
  task: { id: "task", title: "Task", agent: "engineer", status: "in_progress", prompt: "Investigate." },
  entries: [], available: true, limited: false, nextBefore: null, cursor: 0, canSend: true, readOnlyReason: "", activity: "working",
};
it("reuses the timeline when polling changes only metadata or composer availability", () => {
  const select = createConversationItemsSelector();
  const snapshot = { ...data, entries: [{ kind: "tool_call", ts: "1", toolUseId: "read", name: "Read" }] };
  const items = select(snapshot);
  expect(select({ ...snapshot, cursor: 100, canSend: false, readOnlyReason: "Temporarily offline.",
    task: { ...snapshot.task, title: "New title" } })).toBe(items);
});
it("preserves historical tool identity while streaming updates the last response", () => {
  const select = createConversationItemsSelector();
  const snapshot = { ...data, raw: true, activity: "writing" as const, entries: [
    { id: "log:0", offset: 0, kind: "tool_call", ts: "1", toolUseId: "read", name: "Read" },
    { id: "log:100", offset: 100, kind: "tool_result", ts: "2", toolUseId: "read", content: "Done" },
    { id: "log:200", offset: 200, kind: "assistant", ts: "3", text: "Hello ", delta: true },
  ] };
  const before = select(snapshot);
  const after = select({ ...snapshot, entries: [...snapshot.entries,
    { id: "log:300", offset: 300, kind: "assistant", ts: "4", text: "world", delta: true }] });
  expect(after[0]).toEqual(before[0]);
  expect(after[1]).toBe(before[1]);
  expect(after.at(-1)).not.toBe(before.at(-1));
  expect(after.at(-1)).toMatchObject({ message: { markdown: "Hello world", status: "generating" } });
});
it("does not cache away tool completion, task status, or response author changes", () => {
  const select = createConversationItemsSelector();
  const snapshot = { ...data, entries: [
    { kind: "tool_call", ts: "1", toolUseId: "read", name: "Read" },
    { kind: "assistant", ts: "2", text: "Checking." },
  ] };
  const pending = select(snapshot);
  const finished = select({ ...snapshot, task: { ...snapshot.task, status: "completed", agent: "reviewer" } });
  expect(finished[1]).toMatchObject({ tool: { status: "Unconfirmed" } });
  expect(finished[2]).toMatchObject({ message: { author: "reviewer" } });
  expect(pending[1]).toMatchObject({ tool: { status: "Pending" } });
  const result = select({ ...snapshot, entries: [...snapshot.entries,
    { kind: "tool_result", ts: "3", toolUseId: "read", content: "Rejected.", isError: true }] });
  expect(result[1]).toMatchObject({ tool: { status: "Failed", output: "Rejected." } });
});
it("updates pending delivery failures, original assignment, and pagination visibility", () => {
  const select = createConversationItemsSelector(), original = select(data);
  const queued = { id: "pending", text: "Follow-up", status: "queued", created_at: "2026-11-03T00:00:00Z" };
  const pending = select({ ...data, task: { ...data.task, prompt: "Updated assignment.", createdAt: queued.created_at,
    interaction: { messages: [queued] } } });
  expect(pending[0]).toMatchObject({ message: { markdown: "Updated assignment.", createdAt: queued.created_at } });
  expect(pending.at(-1)).toMatchObject({ message: { id: queued.id, statusLabel: "Queued" } });
  const failed = select({ ...data, task: { ...data.task,
    interaction: { messages: [{ ...queued, status: "delivery_uncertain", error: "Connection lost" }] } } });
  expect(failed.at(-1)).toMatchObject({ message: { status: "stopped", statusLabel: "Delivery unconfirmed" } });
  expect(select({ ...data, limited: true })).toEqual([]);
  expect(original).toMatchObject([{ message: { markdown: "Investigate." } }]);
});
it("updates connection diagnostics without treating connection-message changes as historical changes", () => {
  const select = createConversationItemsSelector(), failed = { ...data, task: { ...data.task, error: "Disconnected." } };
  expect(select(failed).at(-1)).toEqual({ id: "task-error", kind: "error", text: "Disconnected." });
  const reconnecting = select({ ...failed, connection: { message: "Reconnecting." } });
  expect(reconnecting).toHaveLength(1);
  expect(select({ ...failed, connection: { message: "Trying again.", retryAt: "later" } })).toBe(reconnecting);
  expect(select({ ...failed, task: { ...failed.task, error: "Different failure." } }).at(-1))
    .toMatchObject({ text: "Different failure." });
});
it("keeps tool identity across pagination, reordering, and removal without retaining vanished rows", () => {
  const select = createConversationItemsSelector(), first = { kind: "tool_call", ts: "1", toolUseId: "a", name: "First" };
  const second = { kind: "tool_call", ts: "2", toolUseId: "b", name: "Second" };
  const snapshot = { ...data, limited: true, entries: [first, second] }, original = select(snapshot);
  const older = { kind: "tool_call", ts: "0", toolUseId: "older", name: "Older" };
  const paged = select({ ...snapshot, entries: [older, first, second] });
  expect(paged[1]).toBe(original[0]); expect(paged[2]).toBe(original[1]);
  const removed = select({ ...snapshot, entries: [second] });
  expect(removed).toEqual([original[1]]);
  expect(removed[0]).toBe(original[1]);
});
it("places retained failed and queued sends by creation time among messages and tools", () => {
  const at = (minute: string) => `2026-11-03T15:${minute}:00Z`;
  const failed = { id: "failed", text: "Why not cache?", status: "failed", created_at: at("25"),
    error: "Original conversation ownership changed while its message waited" };
  const entries = [
    { id: "before", kind: "assistant", ts: at("24"), text: "Earlier reply." },
    { id: "call", kind: "tool_call", ts: at("26"), toolUseId: "read", name: "Read" },
    { id: "result", kind: "tool_result", ts: at("27"), toolUseId: "read", content: "Done" },
    { id: "after", kind: "assistant", ts: at("30"), text: "Later reply." },
  ];
  const value = { ...data, entries, task: { ...data.task, interaction: { messages: [
    { ...failed, id: "later", created_at: at("29") },
    { ...failed, id: "equal-first" }, { ...failed, id: "equal-second" },
    { ...failed, id: "queued", created_at: at("28"), status: "queued", error: undefined },
  ] } } };
  const items = conversationItems(value);
  expect(items.map(item => item.id)).toEqual([
    "task-prompt", "before", "equal-first", "equal-second", "tool:read", "queued", "later", "after",
  ]);
  expect(items.filter(item => item.kind === "message" && item.message.status === "failed")).toHaveLength(3);
  expect(value.task.interaction.messages.map(message => message.id)).toEqual(["later", "equal-first", "equal-second", "queued"]);
});
it("preserves native log order and exact message identity despite clock skew when inserting failed sends", () => {
  const failed = { id: "original", text: "Repeated input", status: "failed", created_at: "2026-11-03T15:20:00Z", error: "Rejected" };
  const items = conversationItems({ ...data, task: { ...data.task, interaction: { messages: [
    failed, { ...failed, id: "unlogged", created_at: "2026-11-03T15:25:00Z" },
    { ...failed, id: "invalid", created_at: "invalid" },
  ] } }, entries: [
    { id: "logged", kind: "user", messageId: failed.id, ts: "2026-11-03T15:24:00Z", text: failed.text },
    { id: "skewed", kind: "assistant", ts: "2026-11-03T15:23:00Z", text: "Clock-skewed reply" },
    { id: "later", kind: "assistant", ts: "2026-11-03T15:26:00Z", text: "Later reply" },
  ] });
  expect(items.map(item => item.id)).toEqual(["task-prompt", failed.id, "skewed", "unlogged", "later", "invalid"]);
  expect(items[1]).toMatchObject({ kind: "message", message: { status: "failed", error: "Rejected" } });
});
it("keeps old failed sends before a bounded latest window and places them correctly when earlier history arrives", () => {
  const failed = { id: "failed", text: "Older failed send", status: "failed", created_at: "2026-11-03T15:25:00Z" };
  const latest = { ...data, limited: true, task: { ...data.task, interaction: { messages: [failed] } }, entries: [
    { id: "latest", kind: "assistant", ts: "2026-11-03T15:30:00Z", text: "Latest reply" },
  ] };
  expect(conversationItems(latest).map(item => item.id)).toEqual(["failed", "latest"]);
  expect(conversationItems({ ...latest, entries: [
    { id: "old", kind: "assistant", ts: "2026-11-03T15:20:00Z", text: "Earlier reply" }, ...latest.entries,
  ] }).map(item => item.id)).toEqual(["old", "failed", "latest"]);
});
