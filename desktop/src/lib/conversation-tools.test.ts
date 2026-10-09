import { expect, it } from "vitest";
import { conversationItems } from "./conversation-tools";
import { conversationToolOutput } from "./conversation-tool-output";
import type { TaskConversation } from "./task-conversation";

const data: TaskConversation = {
  task: { id: "task", title: "Task", agent: "engineer", status: "in_progress", prompt: "Investigate." },
  entries: [], available: true, limited: false, nextBefore: null, cursor: 0, canSend: true, readOnlyReason: "", activity: "working",
};
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
