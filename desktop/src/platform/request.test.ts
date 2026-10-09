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
afterEach(() => { vi.clearAllMocks(); native.frames.length = 0; });

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
