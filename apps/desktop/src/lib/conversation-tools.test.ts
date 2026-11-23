import { expect, it } from "vitest";
import { appendEvents } from "../../backend/transcript.mjs";
import { conversationItems, createConversationItemsSelector } from "./conversation-tools";
import { conversationToolOutput } from "./conversation-tool-output";
import type { TaskConversation } from "./task-conversation";

const data: TaskConversation = {
  task: { id: "task", title: "Task", agent: "engineer", status: "in_progress", prompt: "Investigate." },
  entries: [], available: true, limited: false, nextBefore: null, cursor: 0, canSend: true, readOnlyReason: "", activity: "working",
};
it("presents a superseded review neutrally and retains genuine tool failures as evidence", () => {
  const items = conversationItems({ ...data, task: { ...data.task, status: "superseded",
    error: "Assigned source superseded during review" }, activity: "superseded",
  entries: [{ kind: "tool_call", ts: "1", toolUseId: "check", name: "repo_check" },
    { kind: "tool_result", ts: "2", toolUseId: "check", content: "Revision changed", isError: true }] });
  expect(items.some(item => item.kind === "error")).toBe(false);
  expect(items.find(item => item.kind === "tool")).toMatchObject({ tool: { status: "Failed" } });
  expect(items.at(-1)).toMatchObject({ kind: "message", message: { statusLabel: "Superseded" } });
});
it("keeps connection diagnostics in logs rather than duplicating raw startup failures in chat", () => {
  const error = "Copilot ACP startup failed: Codespace preparation is not ready: Copilot ACP closed its output";
  const failed = { ...data, task: { ...data.task, status: "failed", error }, entries: [
    { kind: "stderr", ts: "1", text: "[Copilot ACP setup] Checking assigned Codespace" },
    { kind: "stderr", ts: "2", text: "Codespace preparation is not ready" },
  ] };
  const items = conversationItems(failed);
  expect(items).toHaveLength(2);
  expect(items.at(-1)).toMatchObject({ kind: "error", text:
    "The agent's workspace needs preparation before it can continue. Your conversation is saved." });
  expect(JSON.stringify(items)).not.toMatch(/ACP|stderr|Checking assigned/);
  expect(conversationItems({ ...failed, connection: { message: "Reconnecting. Your messages are saved." } }))
    .toHaveLength(1);
  expect(conversationItems({ ...data, entries: [{ kind: "stderr", ts: "3", text: "Required build failed" }] }).at(-1))
    .toMatchObject({ kind: "message", message: { status: "failed", markdown: "Required build failed" } });
});
it("interleaves messages and tools, pairs concurrent results by ID, and leaves missing completion explicit", () => {
  const items = conversationItems({ ...data, entries: [
    { kind: "tool_call", ts: "1", name: "Read file", toolUseId: "read", input: "file.ts" },
    { kind: "assistant", ts: "2", text: "Investigating." },
    { kind: "tool_call", ts: "3", name: "Check build", toolUseId: "build" },
    { kind: "tool_result", ts: "4", toolUseId: "build", content: "Build failed", isError: true },
    { kind: "tool_result", ts: "5", toolUseId: "read", content: "File contents", isError: false },
    { kind: "tool_call", ts: "6", name: "Prepare repository", toolUseId: "prepare" },
  ] });
  expect(items.map(item => item.kind)).toEqual(["message", "tool", "message", "tool", "tool"]);
  expect(items[1]).toMatchObject({ tool: { id: "read", input: "file.ts", output: "File contents", status: "Completed", completedAt: "5" } });
  expect(items[3]).toMatchObject({ tool: { id: "build", status: "Failed" } });
  expect(items[4]).toMatchObject({ tool: { id: "prepare", status: "Pending" } });
});
it("keeps result-only pages readable and does not claim old or finished tools are running", () => {
  const entries = [{ kind: "tool_result", ts: "2", toolUseId: "old", content: "Earlier result" },
    { kind: "tool_call", ts: "3", toolUseId: "unfinished", name: "Prepare" }];
  const items = conversationItems({ ...data, limited: true, activity: "unknown", entries });
  expect(items).toHaveLength(2);
  expect(items[0]).toMatchObject({ tool: { name: "Earlier tool", output: "Earlier result", status: "Completed" } });
  expect(items[1]).toMatchObject({ tool: { status: "Unconfirmed" } });
  expect(conversationItems({ ...data, task: { ...data.task, status: "failed" }, entries }).at(-1))
    .toMatchObject({ tool: { status: "Unconfirmed" } });
});
it("updates a tool in place without duplicating completion or operator messages", () => {
  const call = { kind: "tool_call", ts: "1", toolUseId: "a", name: "Read" };
  const before = conversationItems({ ...data, entries: [call] });
  const after = conversationItems({ ...data, entries: [call, { kind: "tool_result", ts: "2", toolUseId: "a", content: "Done" }] });
  expect(before.map(item => item.id)).toEqual(after.map(item => item.id));
});
it("renders completion summaries as ordinary agent messages in chronological order", () => {
  const call = { kind: "tool_call", ts: "1", toolUseId: "done", name: "task_complete",
    input: JSON.stringify({ summary: "Fixed **keyboard navigation**.\n\nTests passed." }) };
  const entries = [{ kind: "assistant", ts: "0", text: "Checking the fix." }, call];
  const before = conversationItems({ ...data, entries });
  expect(before.at(-1)).toMatchObject({ id: "tool:done", kind: "message", message: {
    author: "engineer", direction: "incoming", createdAt: "1",
    markdown: "Fixed **keyboard navigation**.\n\nTests passed.", status: "accepted", statusLabel: "Pending" } });
  const after = conversationItems({ ...data, entries: [...entries,
    { kind: "tool_result", ts: "2", toolUseId: "done", content: "Task marked complete." },
    { kind: "user", ts: "3", text: "Thanks." }] });
  expect(after.slice(0, -1).map(item => item.id)).toEqual(before.map(item => item.id));
  expect(after.at(-2)).toMatchObject({ kind: "message", message: { status: "complete", statusLabel: "" } });
  expect(after.at(-1)).toMatchObject({ kind: "message", message: { markdown: "Thanks." } });
  expect(after.filter(item => item.kind === "tool")).toHaveLength(0);
});
it("does not present failed or unconfirmed task completion as successful", () => {
  const call = { kind: "tool_call", ts: "1", toolUseId: "done", name: "task_complete",
    input: '{"summary":"Fixed the bug."}' };
  expect(conversationItems({ ...data, entries: [call,
    { kind: "tool_result", ts: "2", toolUseId: "done", content: "Completion rejected.", isError: true }] }).at(-1))
    .toMatchObject({ kind: "message", message: { markdown: "Fixed the bug.", status: "failed", error: "Completion rejected." } });
  expect(conversationItems({ ...data, activity: "unknown", entries: [call] }).at(-1))
    .toMatchObject({ kind: "message", message: { status: "accepted", statusLabel: "Unconfirmed" } });
});
it("keeps malformed, missing-summary and unrelated calls available as ordinary tools", () => {
  for (const input of [undefined, '{"summary":', "null", '{"summary":42}', '{"summary":" "}', '{"other":"Done"}']) {
    expect(conversationItems({ ...data, entries: [
      { kind: "tool_call", ts: "1", toolUseId: "done", name: "task_complete", input },
    ] }).at(-1)).toMatchObject({ kind: "tool", tool: { name: "task_complete" } });
  }
  expect(conversationItems({ ...data, entries: [
    { kind: "tool_call", ts: "1", toolUseId: "read", name: "read_file", input: '{"summary":"Not a response."}' },
  ] }).at(-1)).toMatchObject({ kind: "tool", tool: { name: "read_file" } });
});
it("renders a streamed task completion summary after tool progress supplies its arguments", () => {
  expect(conversationItems({ ...data, raw: true, entries: [
    { kind: "tool_call", ts: "1", toolUseId: "done", name: "task_complete" },
    { kind: "tool_progress", ts: "2", toolUseId: "done", input: '{"summary":"All done."}' },
    { kind: "tool_result", ts: "3", toolUseId: "done", content: "Accepted." },
  ] }).at(-1)).toMatchObject({ id: "tool:done", kind: "message", message: { markdown: "All done.", status: "complete" } });
});
it("preserves the full completion markdown without a truncated preview", () => {
  const summary = "  Fixed **navigation** and [keyboard focus](https://example.test).\n\nBuild lint typecheck and all tests passed; publication blocked.  ";
  const item = conversationItems({ ...data, entries: [
    { kind: "tool_call", ts: "1", toolUseId: "done", name: "task_complete", input: JSON.stringify({ summary }) },
    { kind: "tool_result", ts: "2", toolUseId: "done", content: "Accepted." },
  ] }).at(-1);
  expect(item).toMatchObject({ kind: "message", message: { markdown: summary } });
});
it("projects native task_complete object arguments without losing the full report", () => {
  const entries = appendEvents([], [
    { type: "tool.execution_start", timestamp: "2026-11-03T22:03:50Z", data: {
      toolName: "task_complete", toolCallId: "native-done",
      arguments: { summary: "## Verification\n\nBoth **deployed previews** load Library.\n\nAuthentication checks passed." },
    } },
    { type: "tool.execution_complete", timestamp: "2026-11-03T22:03:51Z", data: {
      toolCallId: "native-done", success: true, result: "Task marked complete.",
    } },
  ], "2026-11-03T22:03:51Z");
  const item = conversationItems({ ...data, entries }).at(-1);
  expect(item).toMatchObject({ id: "tool:native-done", kind: "message", message: { status: "complete",
    markdown: "## Verification\n\nBoth **deployed previews** load Library.\n\nAuthentication checks passed." } });
});
it("redacts structured credentials, bearer values and provider leases while preserving tool details", () => {
  const entry = conversationToolOutput({ kind: "tool_call", ts: "1", toolUseId: "a", name: "Read",
    input: JSON.stringify({ path: "src\\file.ts", nested: { apiKey: "PRIVATE_KEY", authorization: "PRIVATE_AUTH",
      provider: { token: "PRIVATE_PROVIDER" } }, command: "echo PRIVATE_LEASE" }) }, ["PRIVATE_LEASE"]);
  expect(entry.input).toContain("file.ts"); expect(entry.input).not.toContain("PRIVATE");
  expect(() => JSON.parse(entry.input!)).not.toThrow();
  const result = conversationToolOutput({ kind: "tool_result", ts: "2",
    content: 'Header: Bearer PRIVATE_BEARER\npassword="PRIVATE_PASSWORD"\nSafe output' }, []);
  expect(result.content).not.toContain("PRIVATE"); expect(result.content).toContain("Safe output");
});
it("bounds output and never promotes unrelated event metadata into tool entries", () => {
  const output = conversationToolOutput({ kind: "tool_result", ts: "1", content: "x".repeat(25000), text: "PRIVATE" }, []);
  expect(output.content?.length).toBeLessThan(20100);
  expect(output.content).toContain("shortened");
  expect(output.text).toBeUndefined();
});
it("keeps task failures in the scrollable timeline instead of a fixed error panel", () => {
  expect(conversationItems({ ...data, task: { ...data.task, error: "Preparation failed." } }).at(-1))
    .toEqual({ id: "task-error", kind: "error", text: "Preparation failed." });
});
