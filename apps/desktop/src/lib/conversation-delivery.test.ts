import { expect, it } from "vitest";
import { mergeConversation, mergeOperatorMessages } from "./conversation-history";
import { conversationItems, createConversationItemsSelector } from "./conversation-tools";
import { conversationMessages, type TaskConversation } from "./task-conversation";

const message = { id: "request", text: "Keep going.", created_at: "2026-11-04T10:00:00Z", status: "sending" };
const data: TaskConversation = {
  task: { id: "one", title: "One", agent: "engineer", status: "in_progress", prompt: "",
    interaction: { messages: [message] } },
  entries: [], available: false, limited: false, nextBefore: null, cursor: 0,
  raw: true, logId: null, canSend: true, readOnlyReason: "",
};
it("keeps the same timestamped bubble through acceptance, delivery and transcript arrival", () => {
  for (const status of ["sending", "queued", "delivering", "sent", "delivered"]) {
    const snapshot = { ...data, task: { ...data.task, interaction: { messages: [{ ...message, status }] } } };
    const expected = { id: message.id, markdown: message.text, createdAt: message.created_at };
    expect(conversationMessages(snapshot)).toMatchObject([expected]);
    expect(conversationMessages({ ...snapshot, entries: [
      { id: "log:0", offset: 0, kind: "user", messageId: message.id, text: message.text, ts: "2026-11-04T10:00:05Z" },
    ] })).toMatchObject([expected]);
  }
});
it("retains receipts across a missing snapshot and keeps original time through log creation", () => {
  const missing = { ...data, task: { ...data.task, interaction: { messages: [] } } };
  const queued = mergeConversation(data, missing);
  expect(conversationMessages(queued)).toMatchObject([{ id: message.id, createdAt: message.created_at }]);
  const delivered = mergeConversation(queued, { ...data, logId: "created", available: true,
    task: { ...data.task, interaction: { messages: [{ ...message, status: "delivered", created_at: "2026-11-04T10:00:02Z" }] } } });
  expect(conversationMessages(delivered)).toMatchObject([{ id: message.id, createdAt: message.created_at, status: "complete" }]);
  expect(conversationMessages(mergeConversation(delivered, { ...delivered,
    task: { ...data.task, interaction: { messages: [{ ...message, status: "queued" }] } } })))
    .toMatchObject([{ status: "complete" }]);
});
it("uses message IDs without receipts and keeps native ordering despite provider clock skew", () => {
  const items = conversationItems({ ...data, task: { ...data.task, interaction: { messages: [{ ...message, status: "delivered" }] } },
    entries: [
      { id: "log:0", offset: 0, kind: "tool_call", toolUseId: "read", name: "Read", ts: "2026-11-04T10:01:00Z" },
      { id: "log:1", offset: 1, kind: "user", messageId: message.id, text: message.text, ts: "2000-01-01T00:00:00Z" },
      { id: "log:2", offset: 2, kind: "assistant", text: "Working.", ts: "2000-01-01T00:00:01Z" },
    ] });
  expect(items.map(item => item.id)).toEqual(["tool:read", message.id, "log:2"]);
  expect(conversationMessages({ ...data, task: { ...data.task, interaction: { messages: [] } }, entries: [
    { id: "log:0", kind: "user", messageId: message.id, text: message.text, ts: message.created_at },
  ] })).toMatchObject([{ id: message.id }]);
});
it("does not rebuild unchanged messages when another message changes state", () => {
  const select = createConversationItemsSelector(), before = select(data);
  const after = select({ ...data, task: { ...data.task, interaction: { messages: [
    message, { ...message, id: "second", text: "Next.", status: "queued" },
  ] } } });
  expect(after[0]).toBe(before[0]);
});
it("keeps local rejection details when an older sending snapshot is overlaid", () => {
  const failed = { ...message, status: "failed", error: "Ownership changed." };
  expect(mergeOperatorMessages([failed], [message])).toEqual([failed]);
});
