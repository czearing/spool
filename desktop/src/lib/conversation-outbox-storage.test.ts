import { afterEach, expect, it, vi } from "vitest";
import { appFetch } from "../platform/request";
import { ConversationOutbox, conversationOutbox, fetchConversation, resumeConversationOutboxes, type ConversationResponseCache } from "./conversation-outbox";
import type { ChatSubmission } from "../components/ui/chat-input";
import type { TaskConversation } from "./task-conversation";

vi.mock("../platform/request", () => ({ appFetch: vi.fn() }));
const fetch = vi.mocked(appFetch);
class MemoryStorage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
const submission = (markdown = "First message"): ChatSubmission =>
  ({ id: crypto.randomUUID(), markdown, createdAt: new Date().toISOString() });
const accepted = (_url: unknown, init?: RequestInit) => {
  const { id } = JSON.parse(String(init?.body));
  return Promise.resolve(new Response(JSON.stringify({ id, state: "queued" })));
};
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); fetch.mockReset(); });

it("migrates a legacy pending submission separately from a newer editable draft", async () => {
  const local = new MemoryStorage(), session = new MemoryStorage(), pending = submission();
  vi.stubGlobal("localStorage", local); vi.stubGlobal("sessionStorage", session);
  vi.stubGlobal("window", { addEventListener: vi.fn() });
  const project = crypto.randomUUID(), task = crypto.randomUUID(), draft = { markdown: "My newer draft", pending };
  session.setItem(`spool-chat:${project}:${task}`, JSON.stringify(draft));
  const outbox = conversationOutbox(project, task);
  expect(outbox.snapshot()).toMatchObject([{ id: pending.id, text: pending.markdown, status: "sending" }]);
  expect(JSON.parse(session.getItem(`spool-chat:${project}:${task}`)!)).toEqual({ markdown: draft.markdown });
  fetch.mockImplementation(accepted);
  await outbox.flush("/conversation");
});
it("clears an unchanged legacy draft while retaining its queued message", async () => {
  const local = new MemoryStorage(), session = new MemoryStorage(), pending = submission();
  vi.stubGlobal("localStorage", local); vi.stubGlobal("sessionStorage", session);
  vi.stubGlobal("window", { addEventListener: vi.fn() });
  const project = crypto.randomUUID(), task = crypto.randomUUID(), key = `spool-chat:${project}:${task}`;
  session.setItem(key, JSON.stringify({ markdown: pending.markdown, pending }));
  const outbox = conversationOutbox(project, task);
  expect(JSON.parse(session.getItem(key)!)).toEqual({ markdown: "" });
  fetch.mockImplementation(accepted);
  await outbox.flush("/conversation");
  expect(outbox.snapshot()).toMatchObject([{ id: pending.id, status: "queued" }]);
  expect(JSON.parse(session.getItem(key)!)).toEqual({ markdown: "" });
});
it("resumes messages for unopened conversations on app startup", async () => {
  const local = new MemoryStorage(), input = submission(), project = crypto.randomUUID(), task = crypto.randomUUID();
  new ConversationOutbox(`spool-outbox:${project}:${task}:`, local).enqueue(input);
  vi.stubGlobal("localStorage", local); vi.stubGlobal("sessionStorage", new MemoryStorage());
  vi.stubGlobal("window", { addEventListener: vi.fn() });
  fetch.mockImplementation(accepted);
  resumeConversationOutboxes();
  await vi.waitFor(() => expect(conversationOutbox(project, task).snapshot()).toMatchObject([{ id: input.id, status: "queued" }]));
  expect(local.length).toBe(1);
  expect(fetch).toHaveBeenCalledWith(`/api/projects/${project}/tasks/${task}/conversation`,
    expect.objectContaining({ body: JSON.stringify({ id: input.id, message: input.markdown }) }));
});
it("isolates corrupt records without discarding them or blocking valid saved and new messages", async () => {
  const storage = new MemoryStorage(), first = submission(), second = submission("New input");
  new ConversationOutbox("test:", storage).enqueue(first);
  storage.setItem("test:broken", "{");
  vi.spyOn(console, "error").mockImplementation(() => {});
  const outbox = new ConversationOutbox("test:", storage);
  expect(outbox.warning).toContain("record is preserved");
  outbox.enqueue(second);
  fetch.mockImplementation(accepted);
  await outbox.flush("/conversation");
  expect(storage.getItem("test:broken")).toBe("{");
  expect(fetch.mock.calls.map(([, options]) => JSON.parse(String(options?.body)).id)).toEqual([first.id, second.id]);
  storage.removeItem("test:broken");
  outbox.refresh();
  expect(outbox.warning).toBe("");
});
it("still preserves the draft instead of sending when storage itself cannot be read", async () => {
  const storage = new MemoryStorage();
  vi.spyOn(storage, "length", "get").mockImplementation(() => { throw new Error("Storage denied"); });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const outbox = new ConversationOutbox("test:", storage);
  expect(() => outbox.enqueue(submission())).toThrow("Pending messages could not be restored");
  await outbox.flush("/conversation");
  expect(fetch).not.toHaveBeenCalled();
});
it("does not hide a queued message just because an earlier identified message has the same text", async () => {
  const storage = new MemoryStorage(), pending = submission(), outbox = new ConversationOutbox("test:", storage);
  outbox.subscribe(() => {});
  outbox.enqueue(pending);
  fetch.mockImplementation(accepted);
  await outbox.flush("/conversation");
  const log = { kind: "user", messageId: "earlier", text: pending.markdown, ts: "2099-01-01T00:00:00Z" };
  const conversation = { task: { interaction: { messages: [] } }, entries: [log] } as unknown as TaskConversation;
  outbox.reconcile(conversation);
  expect(outbox.snapshot()).toMatchObject([{ id: pending.id }]);
  log.messageId = pending.id; log.ts = "2000-01-01T00:00:00Z";
  outbox.reconcile(conversation);
  expect(outbox.snapshot()).toEqual([]);
});
it("retains a permanent non-JSON rejection instead of retrying it forever", async () => {
  const storage = new MemoryStorage(), pending = submission(), outbox = new ConversationOutbox("test:", storage);
  outbox.enqueue(pending);
  fetch.mockResolvedValue(new Response("<html>Sign in</html>", { status: 403 }));
  await outbox.flush("/conversation");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(new ConversationOutbox("test:", storage).snapshot()).toMatchObject([
    { id: pending.id, status: "failed", error: "Conversation unavailable." },
  ]);
});
