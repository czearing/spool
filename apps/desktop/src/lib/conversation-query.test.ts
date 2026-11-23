import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { appFetch } from "../platform/request";
import { conversationQuery } from "./conversation-query";
import { conversationOutbox } from "./conversation-outbox";
import type { TaskConversation } from "./task-conversation";

vi.mock("../platform/request", () => ({ appFetch: vi.fn() }));
const fetch = vi.mocked(appFetch), clients: QueryClient[] = [];
class MemoryStorage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
beforeEach(() => {
  vi.stubGlobal("window", { addEventListener: vi.fn() });
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("sessionStorage", new MemoryStorage());
});
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); fetch.mockReset();
});
function client() {
  const value = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  clients.push(value); return value;
}
function snapshot(offsets: number[], nextBefore: number | null = null): TaskConversation {
  return {
    task: { id: "one", title: "Conversation", agent: "engineer", prompt: "Original", status: "completed" },
    entries: offsets.map(offset => ({ kind: "assistant", id: `log:${offset}`, offset,
      ts: "2026-11-11T00:00:00Z", text: `Reply ${offset}` })),
    raw: true, logId: "fixture", cursor: offsets.at(-1)! + 1, nextBefore, limited: nextBefore !== null,
    canSend: true, readOnlyReason: "", available: true,
  };
}
it("prefetches history without scanning storage or recovering and submitting saved drafts", async () => {
  const cache = client(), project = crypto.randomUUID();
  localStorage.setItem("other-preference", "{}");
  const keys = vi.spyOn(localStorage, "key"), drafts = vi.spyOn(sessionStorage, "getItem");
  fetch.mockResolvedValue(new Response(JSON.stringify(snapshot([0]))));
  await cache.prefetchQuery(conversationQuery(project, "one"));
  expect(cache.getQueryData(["task-conversation", project, "one"])).toMatchObject({ entries: [{ text: "Reply 0" }] });
  expect(keys).not.toHaveBeenCalled(); expect(drafts).not.toHaveBeenCalled();
});
it("retains contiguous loaded pages without changing pending-message timestamps", async () => {
  const cache = client(), project = crypto.randomUUID(), key = ["task-conversation", project, "one"];
  const createdAt = "2026-11-11T00:00:00Z";
  conversationOutbox(project, "one").enqueue({ id: "receipt", markdown: "Keep my message", createdAt });
  cache.setQueryData(key, snapshot([0]));
  const latest = snapshot([1, 2, 3], 1);
  latest.task.interaction = { messages: [{ id: "receipt", text: "Keep my message",
    status: "queued", created_at: "2026-11-11T00:00:30Z" }] };
  fetch.mockResolvedValueOnce(new Response(JSON.stringify(latest)));
  await cache.fetchQuery({ ...conversationQuery(project, "one"), staleTime: 0 });
  const result = cache.getQueryData<TaskConversation>(key)!;
  expect(result.entries.map(entry => entry.text)).toEqual(["Reply 0", "Reply 1", "Reply 2", "Reply 3"]);
  expect(result.task.interaction?.messages).toMatchObject([{ id: "receipt", created_at: createdAt }]);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    `/api/projects/${project}/tasks/one/conversation?events=1`,
  ]);
});
it("shows the latest window immediately instead of downloading an unread backlog on reopen", async () => {
  const cache = client(), project = crypto.randomUUID(), key = ["task-conversation", project, "one"];
  cache.setQueryData(key, snapshot([0]));
  const latest = snapshot([20_000_000, 20_000_100], 20_000_000);
  fetch.mockImplementation(async url => {
    if (new URL(String(url), "http://localhost").searchParams.has("before"))
      throw new Error("Opening the latest window must not request the backlog.");
    return new Response(JSON.stringify(latest));
  });
  await cache.fetchQuery({ ...conversationQuery(project, "one"), staleTime: 0, retry: false });
  const result = cache.getQueryData<TaskConversation>(key)!;
  expect(result.entries).toEqual(latest.entries);
  expect(result.nextBefore).toBe(latest.nextBefore);
  expect(result.limited).toBe(true);
  expect(fetch).toHaveBeenCalledOnce();
});
it("rejects mismatched task snapshots without replacing the cached conversation", async () => {
  const cache = client(), project = crypto.randomUUID(), key = ["task-conversation", project, "one"];
  const saved = snapshot([0]), wrong = snapshot([1]); wrong.task.id = "another-task";
  cache.setQueryData(key, saved);
  fetch.mockResolvedValueOnce(new Response(JSON.stringify(wrong)));
  await expect(cache.fetchQuery({ ...conversationQuery(project, "one"), staleTime: 0, retry: false }))
    .rejects.toThrow("Invalid conversation history response.");
  expect(cache.getQueryData(key)).toBe(saved);
});
