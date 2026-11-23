import { afterEach, expect, it, vi } from "vitest";
import { appFetch } from "../platform/request";
import { ConversationOutbox, fetchConversation, type ConversationResponseCache } from "./conversation-outbox";
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
