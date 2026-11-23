import { expect, it } from "vitest";
import { conversationMessages, type TaskConversation } from "./task-conversation";

const data: TaskConversation = {
  task: { id: "task", title: "Task", agent: "engineer", status: "in_progress", prompt: "" },
  entries: [], available: false, limited: false, nextBefore: null, cursor: 0, canSend: true, readOnlyReason: "",
};
it("deduplicates logged messages without hiding delivered receipts missing from history", () => {
  const pending = { id: "request", text: "Follow up", status: "delivering", created_at: "2026-09-30T10:00:00Z" };
  const value = { ...data, entries: [{ kind: "user", ts: "2026-09-30T10:00:01Z", text: pending.text }],
    task: { ...data.task, interaction: { messages: [pending, { ...pending, id: "older", text: "Older", status: "delivered" }] } } };
  expect(conversationMessages(value)).toHaveLength(2);
  expect(conversationMessages(value).at(-1)).toMatchObject({ id: "older", markdown: "Older", status: "complete" });
});
it("keeps the original message visibly queued or starting until the transcript arrives", () => {
  const task = { ...data.task, prompt: "Start this work." };
  expect(conversationMessages({ ...data, task: { ...task, status: "incoming" } }))
    .toMatchObject([{ id: "task-prompt", status: "accepted", statusLabel: "Queued", markdown: task.prompt }]);
  expect(conversationMessages({ ...data, task }))
    .toMatchObject([{ id: "task-prompt", status: "accepted", statusLabel: "Starting" }]);
  expect(conversationMessages({ ...data, task, entries: [{ kind: "user", ts: "now", text: task.prompt }] }))
    .toMatchObject([{ id: "task-prompt", status: "complete" }]);
});
it("does not present an explicitly resolved older delivery as a new runner failure", () => {
  for (const [status, label] of [["dismissed", "Left unsent"], ["retried", "Resent by you"]]) {
    const message = { id: "earlier", text: "Earlier message", status, error: "Old runner error", created_at: "2026-09-30T10:00:00Z" };
    for (const entries of [[], [{ kind: "user", text: message.text, ts: "2026-09-30T10:00:01Z" }]]) {
      const bubbles = conversationMessages({ ...data, entries, task: { ...data.task, status: "completed", interaction: { messages: [message] } } });
      expect(bubbles).toHaveLength(1);
      expect(bubbles[0]).toMatchObject({ status: "stopped", statusLabel: label });
      expect(bubbles[0].error).toBeUndefined();
    }
  }
});
it("does not attach historical uncertainty to the confirmed resend of identical text", () => {
  const message = { id: "earlier", text: "Same instructions", status: "retried", created_at: "2026-09-30T10:00:00Z" };
  for (const status of ["retried", "delivery_uncertain"]) {
    const bubbles = conversationMessages({ ...data, entries: [
      { kind: "user", text: message.text, ts: "2026-09-30T10:01:00Z", messageId: "resend" },
    ], task: { ...data.task, interaction: { messages: [{ ...message, status }] } } });
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0]).toMatchObject({ status: "complete", markdown: message.text });
    expect(bubbles[0].error).toBeUndefined();
    expect(bubbles[1]).toMatchObject({ id: "earlier", status: "stopped" });
  }
});
