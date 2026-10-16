import { afterEach, expect, it, vi } from "vitest";
import { appFetch } from "./request";

const native = vi.hoisted(() => ({
  invoke: vi.fn(), frames: [] as { onmessage?: (value: object) => void }[],
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: native.invoke,
  Channel: class { constructor() { native.frames.push(this); } },
}));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); native.frames.length = 0; });

it("preserves HTTP status and streamed UTF-8 bytes across the native bridge", async () => {
  native.invoke.mockImplementation(async (command, args) => {
    if (command !== "request") return;
    const channel = args.channel;
    channel.onmessage({ type: "head", status: 409, headers: [["content-type", "application/json"]] });
    channel.onmessage({ type: "chunk", body: Buffer.from('{"error":"Changed ✓"}').toString("base64") });
    channel.onmessage({ type: "end" });
  });
  const response = await appFetch("/api/projects/example/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: '{"model":"test"}',
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "Changed ✓" });
  expect(native.invoke.mock.calls[0][1].request).toMatchObject({
    method: "PUT", url: "/api/projects/example/settings", body: '{"model":"test"}',
  });
});
it("rejects remote URLs without asking the native backend to fetch them", async () => {
  await expect(appFetch("https://example.com/api/private")).rejects.toThrow("Invalid desktop request");
  expect(native.invoke).not.toHaveBeenCalled();
});
it("cancels native reads when the consumer aborts", async () => {
  native.invoke.mockResolvedValue(undefined);
  const controller = new AbortController();
  const result = appFetch("/api/desktop/page", { signal: controller.signal });
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(native.invoke).toHaveBeenCalledWith("cancel_request", expect.objectContaining({ id: expect.any(String) }));
});
it("reports backend startup and transport errors instead of empty successful data", async () => {
  native.invoke.mockRejectedValue(new Error("Service stopped"));
  await expect(appFetch("/api/desktop/page")).rejects.toThrow("Service stopped");
});
it("bounds stalled native requests before headers and allows a new request", async () => {
  vi.useFakeTimers();
  native.invoke.mockResolvedValue(undefined);
  const result = expect(appFetch("/api/desktop/page")).rejects.toThrow("30 seconds");
  await vi.advanceTimersByTimeAsync(30000); await result;
  expect(native.invoke).toHaveBeenCalledWith("cancel_request", expect.objectContaining({ id: expect.any(String) }));
  native.invoke.mockImplementation(async (command, args) => {
    if (command === "request") {
      args.channel.onmessage({ type: "head", status: 200, headers: [] });
      args.channel.onmessage({ type: "chunk", body: Buffer.from("{}").toString("base64") });
      args.channel.onmessage({ type: "end" });
    }
  });
  expect(await (await appFetch("/api/desktop/page")).json()).toEqual({});
  expect(vi.getTimerCount()).toBe(0);
});
it("keeps the deadline through a stalled body after successful headers", async () => {
  vi.useFakeTimers();
  native.invoke.mockImplementation(async (command, args) => {
    if (command === "request") args.channel.onmessage({ type: "head", status: 200, headers: [] });
  });
  const response = await appFetch("/api/desktop/page");
  const body = expect(response.json()).rejects.toThrow("30 seconds");
  await vi.advanceTimersByTimeAsync(30000); await body;
});
it("does not terminate an established live event stream at the finite-request deadline", async () => {
  vi.useFakeTimers();
  native.invoke.mockImplementation(async (command, args) => {
    if (command === "request") args.channel.onmessage({ type: "head", status: 200, headers: [["content-type", "text/event-stream; charset=utf-8"]] });
  });
  const response = await appFetch("/api/events");
  await vi.advanceTimersByTimeAsync(60000);
  expect(native.invoke).not.toHaveBeenCalledWith("cancel_request", expect.anything());
  expect(vi.getTimerCount()).toBe(0);
  await response.body?.cancel();
});
