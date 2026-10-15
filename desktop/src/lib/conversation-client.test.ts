import { afterEach, expect, it, vi } from "vitest";
import { appFetch } from "../platform/request";
import { readConversationPage } from "./conversation-client";

vi.mock("../platform/request", () => ({ appFetch: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
const page = { task: { id: "manual-test" }, cursor: 0, entries: [], nextBefore: null, limited: false, raw: true };
function deadline() {
  const controller = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  return () => controller.abort(new DOMException("Timed out", "TimeoutError"));
}
function waiting(signal: AbortSignal) {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
it("reads and validates native conversation pages with a bounded deadline", async () => {
  const timer = vi.spyOn(AbortSignal, "timeout");
  vi.mocked(appFetch).mockResolvedValue(Response.json(page));
  expect(await readConversationPage("/api/task/conversation")).toEqual(page);
  expect(timer).toHaveBeenCalledWith(15000);
  expect(appFetch).toHaveBeenCalledWith("/api/task/conversation", expect.objectContaining({
    signal: expect.any(AbortSignal), cache: "no-store",
  }));
});
it("turns a stalled native request into an actionable error and permits retry", async () => {
  const expire = deadline();
  vi.mocked(appFetch).mockImplementationOnce((_url, init) => waiting(init!.signal!));
  const request = expect(readConversationPage("/api/task/conversation")).rejects.toThrow("Conversation loading timed out");
  expire();
  await request;
  vi.mocked(appFetch).mockResolvedValue(Response.json(page));
  expect(await readConversationPage("/api/task/conversation")).toEqual(page);
});
it("also bounds a response that sends headers but never finishes its body", async () => {
  const expire = deadline();
  vi.mocked(appFetch).mockImplementationOnce(async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      init!.signal!.addEventListener("abort", () => controller.error(init!.signal!.reason), { once: true });
      controller.enqueue(new TextEncoder().encode('{"task":'));
    },
  })));
  const request = expect(readConversationPage("/api/task/conversation")).rejects.toThrow("Conversation loading timed out");
  await Promise.resolve(); expire();
  await request;
});
it("preserves navigation cancellation instead of reporting it as a timeout", async () => {
  const expire = deadline(), navigation = new AbortController();
  vi.mocked(appFetch).mockImplementationOnce((_url, init) => waiting(init!.signal!));
  const request = expect(readConversationPage("/api/task/conversation", navigation.signal)).rejects.toMatchObject({ name: "AbortError" });
  navigation.abort(); expire();
  await request;
});
it("keeps backend failures and malformed history explicit", async () => {
  vi.mocked(appFetch).mockResolvedValueOnce(Response.json({ error: "Project not found." }, { status: 404 }));
  await expect(readConversationPage("/api/task/conversation")).rejects.toMatchObject({ status: 404, message: "Project not found." });
  vi.mocked(appFetch).mockResolvedValueOnce(Response.json({ ...page, raw: false }));
  await expect(readConversationPage("/api/task/conversation")).rejects.toThrow("Invalid conversation history");
  vi.mocked(appFetch).mockResolvedValueOnce(new Response("{broken"));
  await expect(readConversationPage("/api/task/conversation")).rejects.toThrow(SyntaxError);
});
