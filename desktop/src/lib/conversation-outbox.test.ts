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

it("keeps the draft unacknowledged and never sends when saving its intent fails", async () => {
  const storage = new MemoryStorage(), outbox = new ConversationOutbox("test:", storage);
  vi.spyOn(storage, "setItem").mockImplementation(() => { throw new Error("Storage is full"); });
  expect(() => outbox.enqueue(submission())).toThrow("Storage is full");
  await outbox.flush("/conversation");
  expect(outbox.snapshot()).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});
it("continues after unsubscribing, serializes independent messages, and retries the exact same input", async () => {
  vi.useFakeTimers();
  const storage = new MemoryStorage(), outbox = new ConversationOutbox("test:", storage);
  const first = submission(), second = submission("Newer input");
  outbox.enqueue(first);
  const unsubscribe = outbox.subscribe(() => {});
  fetch.mockRejectedValueOnce(new TypeError("Connection lost")).mockImplementation(accepted);
  const running = outbox.flush("/conversation");
  unsubscribe();
  outbox.enqueue(second);
  expect(outbox.flush("/conversation")).toBe(running);
  expect(storage.length).toBe(2);
  await vi.advanceTimersByTimeAsync(500);
  await running;
  expect(fetch.mock.calls.map(([, options]) => JSON.parse(String(options?.body)))).toEqual([
    { id: first.id, message: first.markdown }, { id: first.id, message: first.markdown },
    { id: second.id, message: second.markdown },
  ]);
  expect(storage.length).toBe(2);
});
it("survives a lost backend acknowledgement and restart without another delivery identity", async () => {
  const storage = new MemoryStorage(), first = submission();
  new ConversationOutbox("test:", storage).enqueue(first);
  const restarted = new ConversationOutbox("test:", storage);
  restarted.subscribe(() => {});
  fetch.mockImplementation(accepted);
  await restarted.flush("/conversation");
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ id: first.id, message: first.markdown });
  expect(restarted.snapshot()).toMatchObject([{ id: first.id, status: "queued" }]);
  expect(storage.length).toBe(1);
  restarted.reconcile({ task: { interaction: { messages: [] } }, entries: [
    { kind: "user", messageId: first.id, text: first.markdown, ts: first.createdAt },
  ] } as unknown as TaskConversation);
  expect(restarted.snapshot()).toEqual([]);
  expect(storage.length).toBe(0);
});
it("retains a failed message across reload and rotates only a definitively rejected delivery identity", async () => {
  const storage = new MemoryStorage(), first = submission(), outbox = new ConversationOutbox("test:", storage);
  outbox.enqueue(first);
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Ownership changed", rejected: true }), { status: 409 }));
  await outbox.flush("/conversation");
  const restarted = new ConversationOutbox("test:", storage);
  expect(restarted.snapshot()).toMatchObject([{ id: first.id, status: "failed", error: "Ownership changed" }]);
  restarted.retry(first.id);
  const retryId = restarted.snapshot()[0].id;
  expect(retryId).not.toBe(first.id);
  expect(new ConversationOutbox("test:", storage).snapshot()[0]).toMatchObject({ id: retryId, status: "sending" });
  expect(storage.length).toBe(1);
  fetch.mockImplementation(accepted);
  await restarted.flush("/conversation");
  expect(storage.length).toBe(1);
});
it("keeps accepted messages durable until their transcript entry arrives, not just a receipt", async () => {
  const storage = new MemoryStorage(), pending = submission(), outbox = new ConversationOutbox("test:", storage);
  outbox.enqueue(pending);
  fetch.mockImplementation(accepted);
  await outbox.flush("/conversation");
  const restarted = new ConversationOutbox("test:", storage);
  expect(restarted.snapshot()).toMatchObject([{ id: pending.id, text: pending.markdown, status: "queued" }]);
  await restarted.flush("/conversation");
  expect(fetch).toHaveBeenCalledTimes(1);
  const receipt = { id: pending.id, text: pending.markdown, status: "delivered", created_at: pending.createdAt };
  const data = { task: { interaction: { messages: [receipt] } }, entries: [] } as unknown as TaskConversation;
  restarted.reconcile(data);
  expect(new ConversationOutbox("test:", storage).snapshot()).toHaveLength(1);
  restarted.reconcile({ ...data, entries: [
    { kind: "user", messageId: pending.id, text: pending.markdown, ts: pending.createdAt! },
  ] });
  expect(storage.length).toBe(0);
  expect(restarted.snapshot()).toEqual([]);
});
it("keeps an uncertain identity when a permanent failure does not certify rejection", async () => {
  const storage = new MemoryStorage(), input = submission(), outbox = new ConversationOutbox("test:", storage);
  outbox.enqueue(input);
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Please sign in" }), { status: 401 }));
  await outbox.flush("/conversation");
  outbox.retry(input.id);
  expect(outbox.snapshot()).toMatchObject([{ id: input.id, status: "sending" }]);
});
it("keeps a confirmed receipt if storage cleanup fails without sending it again", async () => {
  const storage = new MemoryStorage(), first = submission(), outbox = new ConversationOutbox("test:", storage);
  outbox.enqueue(first);
  vi.spyOn(storage, "removeItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
  vi.spyOn(console, "error").mockImplementation(() => {});
  fetch.mockImplementation(accepted);
  await outbox.flush("/conversation");
  outbox.reconcile({ task: { interaction: { messages: [] } }, entries: [
    { kind: "user", messageId: first.id, text: first.markdown, ts: first.createdAt },
  ] } as unknown as TaskConversation);
  const restarted = new ConversationOutbox("test:", storage);
  expect(restarted.snapshot()).toMatchObject([{ id: first.id, status: "queued" }]);
  await restarted.flush("/conversation");
  expect(fetch.mock.calls.map(([, options]) => JSON.parse(String(options?.body)).id)).toEqual([first.id]);
});
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
it("preserves caller cancellation when adding the shared request deadline", async () => {
  const controller = new AbortController();
  fetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  }));
  const request = fetchConversation("/conversation", { signal: controller.signal });
  controller.abort();
  await expect(request).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
});
it("reuses a conditionally verified response without parsing it again", async () => {
  const cache: ConversationResponseCache = {};
  fetch.mockResolvedValueOnce(Response.json({ entries: ["Saved reply"] }, { headers: { ETag: '"first"' } }));
  const value = await fetchConversation("/conversation", {}, cache);
  const unchanged = new Response(null, { status: 304 }), parse = vi.spyOn(unchanged, "json");
  fetch.mockResolvedValueOnce(unchanged);
  expect(await fetchConversation("/conversation", {}, cache)).toBe(value);
  expect(new Headers(fetch.mock.calls[1][1]?.headers).get("If-None-Match")).toBe('"first"');
  expect(parse).not.toHaveBeenCalled();
});
it("isolates conditional responses by URL and clears validators when the server does not supply one", async () => {
  const cache: ConversationResponseCache = { url: "/first", etag: '"first"', value: { old: true } };
  fetch.mockResolvedValueOnce(Response.json({ fresh: true }));
  expect(await fetchConversation("/second", {}, cache)).toEqual({ fresh: true });
  expect(new Headers(fetch.mock.calls[0][1]?.headers).has("If-None-Match")).toBe(false);
  expect(cache.etag).toBeUndefined();
  fetch.mockResolvedValueOnce(Response.json({ latest: true }));
  await fetchConversation("/second", {}, cache);
  expect(new Headers(fetch.mock.calls[1][1]?.headers).has("If-None-Match")).toBe(false);
});
it("rejects an unsolicited not-modified response and preserves verified data across errors and late cancellation", async () => {
  fetch.mockResolvedValueOnce(new Response(null, { status: 304 }));
  await expect(fetchConversation("/conversation", {}, {})).rejects.toMatchObject({ status: 502 });
  const cache: ConversationResponseCache = { url: "/conversation", etag: '"saved"', value: { saved: true } };
  fetch.mockResolvedValueOnce(Response.json({ error: "Task not found." }, { status: 404 }));
  await expect(fetchConversation("/conversation", {}, cache)).rejects.toMatchObject({ status: 404 });
  expect(cache.value).toEqual({ saved: true });
  const controller = new AbortController(), response = Response.json({ stale: true });
  vi.spyOn(response, "json").mockImplementation(async () => { controller.abort(); return { stale: true }; });
  fetch.mockResolvedValueOnce(response);
  await expect(fetchConversation("/conversation", { signal: controller.signal }, cache)).rejects.toMatchObject({ name: "AbortError" });
  expect(cache).toEqual({ url: "/conversation", etag: '"saved"', value: { saved: true } });
});
