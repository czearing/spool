import { expect, it } from "vitest";
import { conversationMessages, taskActivity, validateTaskId, type TaskConversation } from "./task-conversation";

const data: TaskConversation = {
  task: { id: "task", title: "Task", agent: "engineer", status: "in_progress", prompt: "" },
  entries: [], available: false, limited: false, nextBefore: null, cursor: 0, canSend: true, readOnlyReason: "",
};
it("shows the opening request once as a message without the agent's system instructions", () => {
  expect(conversationMessages(data)).toEqual([]);
  const task = { ...data.task, prompt: "Original request.", createdAt: "2026-09-30T10:00:00Z" };
  expect(conversationMessages({ ...data, task })).toMatchObject([{ markdown: task.prompt, direction: "outgoing", createdAt: task.createdAt }]);
  for (const text of [task.prompt, `Agent system instructions\n\n${task.prompt}`]) {
    expect(conversationMessages({ ...data, task, entries: [{ kind: "user", ts: task.createdAt, text }] }))
      .toMatchObject([{ markdown: task.prompt, direction: "outgoing" }]);
  }
  const entries = [{ kind: "user", ts: "now", text: "A later follow-up." }];
  expect(conversationMessages({ ...data, task, entries }).map((message) => message.markdown)).toEqual([task.prompt, entries[0].text]);
  expect(conversationMessages({ ...data, task, entries, limited: true }).map((message) => message.markdown)).toEqual([entries[0].text]);
});
it("renders assistant output, stream state and errors without raw tool dumps", () => {
  const messages = conversationMessages({ ...data, entries: [
    { kind: "user", ts: "1", text: "Hello" }, { kind: "tool_call", ts: "2", text: "Sensitive raw tool input" },
    { kind: "assistant", ts: "3", text: "**Working**", delta: true }, { kind: "stderr", ts: "4", text: "Provider failed" },
  ] });
  expect(messages.map((message) => message.status)).toEqual(["complete", "complete", "failed"]);
  expect(messages[1]).toMatchObject({ author: "engineer", markdown: "**Working**" });
});
it("does not invent agent messages from raw task metadata", () => {
  expect(conversationMessages({ ...data, entries: [{ kind: "stdout", ts: "now", text: "Status: completed" }] })).toEqual([]);
});
it("labels only the current streaming reply and distinguishes native work from text generation", () => {
  const entries = [{ kind: "assistant", ts: "2026-09-30T10:00:00Z", text: "First reply", delta: true },
    { kind: "assistant", ts: "2026-09-30T10:01:00Z", text: "Current reply", delta: true }];
  const task = { ...data.task, interaction: { phase: "running" } };
  expect(taskActivity(task, entries.at(-1), true)).toBe("writing");
  expect(taskActivity(task, { kind: "tool_call", ts: "now" }, true)).toBe("working");
  expect(conversationMessages({ ...data, entries, activity: "writing" }).map((message) => message.status)).toEqual(["complete", "generating"]);
  expect(conversationMessages({ ...data, entries, activity: "working" }).every((message) => message.status === "complete")).toBe(true);
  expect(taskActivity(task, entries.at(-1), false)).toBe("offline");
  expect(taskActivity({ ...task, interaction: { paused: true } }, entries.at(-1), true)).toBe("waiting");
  expect(taskActivity({ ...task, status: "incoming" }, undefined, true)).toBe("queued");
});
it("preserves timestamps and uses a visible Queued label rather than ambiguous Accepted", () => {
  const message = { id: "request", text: "Follow-up", status: "queued", created_at: "2026-09-30T10:00:00Z" };
  expect(conversationMessages({ ...data, task: { ...data.task, interaction: { messages: [message] } } })[0])
    .toMatchObject({ createdAt: message.created_at, statusLabel: "Queued", status: "accepted" });
});
it("shows native queued follow-ups in a bounded latest window, never as an agent reply", () => {
  const messages = conversationMessages({ ...data, limited: true, nextBefore: 300,
    task: { ...data.task, interaction: { messages: [{ id: "request", text: "Follow up", status: "queued", created_at: "2026-09-30T10:00:00Z" }] } } });
  expect(messages).toMatchObject([{ id: "request", direction: "outgoing", status: "accepted", markdown: "Follow up" }]);
});
it("deduplicates delivering messages already present in the native log and omits delivered history", () => {
  const pending = { id: "request", text: "Follow up", status: "delivering", created_at: "2026-09-30T10:00:00Z" };
  const value = { ...data, entries: [{ kind: "user", ts: "2026-09-30T10:00:01Z", text: pending.text }],
    task: { ...data.task, interaction: { messages: [pending, { ...pending, id: "older", text: "Older", status: "delivered" }] } } };
  expect(conversationMessages(value)).toHaveLength(1);
});
it("does not call uncertain delivery accepted or keep historical output generating", () => {
  const value = { ...data, task: { ...data.task, status: "failed", interaction: { messages: [
    { id: "request", text: "Follow up", status: "delivery_uncertain", created_at: "now" },
  ] } }, entries: [{ kind: "assistant", text: "Partial reply", ts: "now", delta: true }] };
  expect(conversationMessages(value).at(-1)).toMatchObject({ status: "failed", error: "Delivery could not be confirmed." });
  expect(conversationMessages(value).find((message) => message.markdown === "Partial reply")?.status).toBe("complete");
});
it("rejects invalid task identities, including traversal and oversized identifiers", () => {
  for (const id of ["../outside", "", "a/b", "a\\b", "a".repeat(181)]) expect(() => validateTaskId(id)).toThrow();
  expect(() => validateTaskId("manual-abc_123.4")).not.toThrow();
});
