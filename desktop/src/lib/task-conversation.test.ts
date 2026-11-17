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
it("keeps the opening message visibly queued or starting until it reaches the transcript", () => {
  const task = { ...data.task, prompt: "Start this work." };
  expect(conversationMessages({ ...data, task: { ...task, status: "incoming" } }))
    .toMatchObject([{ id: "task-prompt", status: "accepted", statusLabel: "Queued", markdown: task.prompt }]);
  expect(conversationMessages({ ...data, task }))
    .toMatchObject([{ id: "task-prompt", status: "accepted", statusLabel: "Starting" }]);
  expect(conversationMessages({ ...data, task, entries: [{ kind: "user", ts: "now", text: task.prompt }] }))
    .toMatchObject([{ id: "task-prompt", status: "complete" }]);
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
it("distinguishes local sending and uncertain acknowledgments from confirmed queue acceptance", () => {
  const message = { id: "request", text: "Follow-up", created_at: "2026-11-03T10:00:00Z" };
  for (const [status, expected, label] of [["sending", "sending", "Sending"], ["unconfirmed", "failed", "Not confirmed"],
    ["queued", "accepted", "Queued"]]) {
    expect(conversationMessages({ ...data, task: { ...data.task, interaction: { messages: [{ ...message, status }] } } })[0])
      .toMatchObject({ status: expected, statusLabel: label });
  }
});
it("shows native queued follow-ups in a bounded latest window, never as an agent reply", () => {
  const messages = conversationMessages({ ...data, limited: true, nextBefore: 300,
    task: { ...data.task, interaction: { messages: [{ id: "request", text: "Follow up", status: "queued", created_at: "2026-09-30T10:00:00Z" }] } } });
  expect(messages).toMatchObject([{ id: "request", direction: "outgoing", status: "accepted", markdown: "Follow up" }]);
});
it("deduplicates delivery and keeps older delivered receipts outside a bounded latest window", () => {
  const pending = { id: "request", text: "Follow up", status: "delivering", created_at: "2026-09-30T10:00:00Z" };
  const value = { ...data, limited: true, entries: [{ kind: "user", ts: "2026-09-30T10:00:01Z", text: pending.text }],
    task: { ...data.task, interaction: { messages: [pending, { ...pending, id: "older", text: "Older", status: "delivered",
      created_at: "2026-09-30T09:00:00Z" }] } } };
  expect(conversationMessages(value)).toHaveLength(1);
});
it("keeps repeated queued input and its failure separate from an earlier identified message", () => {
  const first = { id: "first", text: "Repeat", status: "delivered", created_at: "2026-11-03T10:00:00Z" };
  const second = { ...first, id: "second", status: "delivery_uncertain" };
  const messages = conversationMessages({ ...data, task: { ...data.task, interaction: { messages: [second] } },
    entries: [{ id: "log:0", kind: "user", messageId: first.id, text: first.text, ts: "2026-11-03T10:00:01Z" }] });
  expect(messages).toMatchObject([
    { id: first.id, entryId: "log:0", status: "complete", markdown: first.text },
    { id: second.id, status: "stopped", statusLabel: "Delivery unconfirmed" },
  ]);
});
it("uses the provider's message identity despite clock skew or truncated identical prefixes", () => {
  const prefix = "x".repeat(20000), first = { id: "first", text: prefix + " first", status: "delivering", created_at: "2026-11-03T10:00:00Z" };
  const second = { ...first, id: "second", text: prefix + " second", status: "delivery_uncertain" };
  const messages = conversationMessages({ ...data, task: { ...data.task, interaction: { messages: [first, second] } },
    entries: [
      { id: "log:0", kind: "user", messageId: second.id, text: prefix, ts: "2000-01-01T00:00:00Z" },
      { id: "log:1", kind: "user", messageId: first.id, text: prefix, ts: "2000-01-01T00:00:00Z" },
    ] });
  expect(messages).toHaveLength(2);
  expect(messages[0]).toMatchObject({ id: second.id, entryId: "log:0", status: "stopped" });
  expect(messages[1]).toMatchObject({ id: first.id, entryId: "log:1", status: "accepted", statusLabel: "Delivering" });
});
it("never matches two legacy pending messages to the same transcript entry", () => {
  const first = { id: "first", text: "Repeat", status: "delivering", created_at: "2026-11-03T10:00:00Z" };
  const second = { ...first, id: "second" };
  const messages = conversationMessages({ ...data, task: { ...data.task, interaction: { messages: [first, second] } },
    entries: [{ id: "legacy", kind: "user", text: first.text, ts: "2026-11-03T10:00:01Z" }] });
  expect(messages).toHaveLength(2);
  expect(messages.map(message => message.id)).toEqual([first.id, second.id]);
  expect(messages[0].entryId).toBe("legacy");
});
it("does not mistake an identified follow-up for the original assignment when their text is identical", () => {
  const text = "Repeat";
  expect(conversationMessages({ ...data, task: { ...data.task, prompt: text },
    entries: [{ id: "log:0", kind: "user", messageId: "follow-up", text, ts: "2026-11-03T10:00:01Z" }] })
    .map(message => message.id)).toEqual(["task-prompt", "follow-up"]);
});
it("reconciles repeated text with the first eligible user entry in log order, not an earlier reply or timestamp", () => {
  const pending = { id: "request", text: "Repeat", status: "delivering", created_at: "2026-11-03T10:00:00Z" };
  const entries = [
    { id: "old", kind: "user", text: pending.text, ts: "2026-11-03T09:59:59Z" },
    { id: "assistant", kind: "assistant", text: pending.text, ts: "2026-11-03T10:00:01Z" },
    { id: "invalid", kind: "user", text: pending.text, ts: "invalid" },
    { id: "first", kind: "user", text: pending.text, ts: "2026-11-03T10:00:03Z" },
    { id: "second", kind: "user", text: pending.text, ts: "2026-11-03T10:00:02Z" },
  ];
  const messages = conversationMessages({ ...data, entries, task: { ...data.task, interaction: { messages: [pending] } } });
  expect(messages).toHaveLength(5);
  expect(messages.find(message => message.id === pending.id)).toMatchObject({ entryId: "first", status: "accepted", statusLabel: "Delivering" });
  expect(messages.filter(message => message.id !== pending.id).every(message => message.status === "complete")).toBe(true);
});
it("matches shortened long messages and preserves delivery failures on the existing bubble", () => {
  const text = "x".repeat(20000), pending = { id: "request", text: `${text} and more`, status: "delivery_uncertain",
    created_at: "2026-11-03T10:00:00Z" };
  const messages = conversationMessages({ ...data, entries: [
    { id: "tool", kind: "tool_call", text: pending.text, ts: "2026-11-03T10:00:01Z" },
    { id: "user", kind: "user", text: `${text}\n[Long output shortened in this view.]`, ts: "2026-11-03T10:00:01Z" },
    { id: "later", kind: "user", text: pending.text, ts: "2026-11-03T10:00:02Z" },
  ], task: { ...data.task, interaction: { messages: [pending] } } });
  expect(messages).toHaveLength(2);
  expect(messages[0]).toMatchObject({ id: pending.id, entryId: "user", status: "stopped", statusLabel: "Delivery unconfirmed" });
  expect(messages[1]).toMatchObject({ id: "later", status: "complete" });
});
it("keeps unmatched follow-ups visible when matching user records have invalid timestamps", () => {
  const pending = { id: "request", text: "Follow up", status: "queued", created_at: "invalid" };
  const messages = conversationMessages({ ...data, entries: [
    { id: "user", kind: "user", text: pending.text, ts: "2026-11-03T10:00:01Z" },
  ], task: { ...data.task, interaction: { messages: [pending] } } });
  expect(messages.map(message => message.id)).toEqual(["user", "request"]);
  expect(messages[1]).toMatchObject({ status: "accepted", statusLabel: "Queued" });
});
it("does not call uncertain delivery accepted or keep historical output generating", () => {
  const value = { ...data, task: { ...data.task, status: "failed", interaction: { messages: [
    { id: "request", text: "Follow up", status: "delivery_uncertain", created_at: "now" },
  ] } }, entries: [{ kind: "assistant", text: "Partial reply", ts: "now", delta: true }] };
  expect(conversationMessages(value).at(-1)).toMatchObject({ status: "stopped", statusLabel: "Delivery unconfirmed" });
  expect(conversationMessages(value).find((message) => message.markdown === "Partial reply")?.status).toBe("complete");
});
it("rejects invalid task identities, including traversal and oversized identifiers", () => {
  for (const id of ["../outside", "", "a/b", "a\\b", "a".repeat(181)]) expect(() => validateTaskId(id)).toThrow();
  expect(() => validateTaskId("manual-abc_123.4")).not.toThrow();
});
