import { afterEach, expect, it, vi } from "vitest";
import { PendingConversationMessages } from "./conversation-pending";
import type { TaskConversation } from "./task-conversation";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
const submission = { id: "request", markdown: "Keep my message visible." };
afterEach(() => vi.restoreAllMocks());

it("restores accepted messages and retains them until actual transcript confirmation", () => {
  const storage = new MemoryStorage(), pending = new PendingConversationMessages("test", storage);
  pending.enqueue(submission);
  pending.settle(submission.id);
  const restored = new PendingConversationMessages("test", storage);
  expect(restored.snapshot()).toMatchObject([{ id: submission.id, text: submission.markdown, status: "queued" }]);
  const receipt = { ...restored.snapshot()[0], status: "delivered" };
  const data = { task: { interaction: { messages: [receipt] } }, entries: [] } as unknown as TaskConversation;
  restored.reconcile(data);
  expect(storage.getItem("test")).not.toBeNull();
  restored.reconcile({ ...data, entries: [
    { kind: "user", messageId: submission.id, text: submission.markdown, ts: receipt.created_at },
  ] });
  expect(restored.snapshot()).toEqual([]);
  expect(storage.getItem("test")).toBeNull();
});
it("does not mistake an identical earlier message or a different delivery identity for confirmation", () => {
  const storage = new MemoryStorage(), pending = new PendingConversationMessages("test", storage);
  pending.enqueue(submission); pending.settle(submission.id);
  pending.reconcile({ task: {}, entries: [
    { kind: "user", text: submission.markdown, ts: "2000-01-01T00:00:00Z" },
    { kind: "user", messageId: "different", text: submission.markdown, ts: "2100-01-01T00:00:00Z" },
  ] } as unknown as TaskConversation);
  expect(pending.snapshot()).toHaveLength(1);
});
it("preserves timestamps and prevents duplicate local messages on retries", () => {
  const pending = new PendingConversationMessages("test", new MemoryStorage());
  pending.enqueue(submission);
  const timestamp = pending.snapshot()[0].created_at;
  pending.settle(submission.id, "Connection lost.");
  pending.enqueue(submission);
  expect(pending.snapshot()).toMatchObject([{ id: submission.id, created_at: timestamp, status: "sending" }]);
  expect(pending.snapshot()).toHaveLength(1);
  expect(() => pending.enqueue({ ...submission, markdown: "Different input" })).toThrow("identity");
});
it("keeps a visible saved message when confirmed-receipt cleanup fails", () => {
  const storage = new MemoryStorage(), pending = new PendingConversationMessages("test", storage);
  pending.enqueue(submission); pending.settle(submission.id);
  vi.spyOn(storage, "removeItem").mockImplementation(() => { throw new Error("Storage unavailable."); });
  vi.spyOn(console, "error").mockImplementation(() => {});
  pending.reconcile({ task: {}, entries: [
    { kind: "user", messageId: submission.id, text: submission.markdown, ts: "now" },
  ] } as unknown as TaskConversation);
  expect(new PendingConversationMessages("test", storage).snapshot()).toHaveLength(1);
});
it("never overwrites unreadable saved messages or accepts an unsaved submission", () => {
  const storage = new MemoryStorage();
  storage.setItem("test", "{broken");
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect(() => new PendingConversationMessages("test", storage).enqueue(submission)).toThrow("could not be restored");
  expect(storage.getItem("test")).toBe("{broken");
  const pending = new PendingConversationMessages("other", storage);
  vi.spyOn(storage, "setItem").mockImplementation(() => { throw new Error("Storage full."); });
  expect(() => pending.enqueue(submission)).toThrow("Storage full");
  expect(pending.snapshot()).toEqual([]);
});
