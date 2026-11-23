import { afterEach, beforeEach, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ construct: vi.fn(), start: vi.fn(), listModels: vi.fn(), stop: vi.fn(), forceStop: vi.fn() }));
vi.mock("@github/copilot-sdk", () => ({ CopilotClient: class {
  constructor(options: unknown) { sdk.construct(options); }
  start = sdk.start;
  listModels = sdk.listModels;
  stop = sdk.stop;
  forceStop = sdk.forceStop;
} }));
vi.mock("./copilot-runtime", () => ({ copilotRuntimePath: () => "C:\\Spool\\resources\\copilot\\prebuilds\\win32-x64\\copilot-runtime.exe" }));
beforeEach(() => {
  vi.resetModules();
  sdk.start.mockReset().mockResolvedValue(undefined);
  sdk.stop.mockReset().mockResolvedValue([]);
  sdk.forceStop.mockReset().mockResolvedValue(undefined);
  sdk.construct.mockReset();
  sdk.listModels.mockReset().mockResolvedValue([
    { id: "auto", name: "Auto" }, { id: "selected-model", name: "Available model", policy: { state: "enabled" } },
    { id: "disabled-model", name: "Disabled model", policy: { state: "disabled" } },
  ]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it("uses the provider catalog without sessions, hides disabled models and shares cached discovery", async () => {
  const { getModelCatalog } = await import("./model-catalog");
  const [first, second] = await Promise.all([getModelCatalog(), getModelCatalog()]);
  expect(first).toEqual([{ value: "auto", label: "Auto" }, { value: "selected-model", label: "Available model" }]);
  expect(second).toEqual(first);
  expect(sdk.start).toHaveBeenCalledTimes(1);
  expect(sdk.listModels).toHaveBeenCalledTimes(1);
  expect(sdk.stop).toHaveBeenCalledTimes(1);
  expect(sdk.construct).toHaveBeenCalledWith({ connection: {
    kind: "stdio", path: "C:\\Spool\\resources\\copilot\\prebuilds\\win32-x64\\copilot-runtime.exe",
  } });
});
it("closes failed discovery and permits a real retry instead of inventing a catalog", async () => {
  const { getModelCatalog } = await import("./model-catalog");
  sdk.listModels.mockRejectedValueOnce(new Error("Sign in required"));
  await expect(getModelCatalog()).rejects.toThrow("Sign in required");
  await expect(getModelCatalog()).resolves.toHaveLength(2);
  expect(sdk.stop).toHaveBeenCalledTimes(2);
});
it("bounds discovery and cleanup, then allows a successful retry", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { getModelCatalog } = await import("./model-catalog");
  sdk.start.mockImplementationOnce(() => new Promise(() => {}));
  sdk.stop.mockImplementationOnce(() => new Promise(() => {}));
  const failed = expect(getModelCatalog()).rejects.toThrow("Copilot model discovery timed out.");
  await vi.advanceTimersByTimeAsync(22000);
  await failed;
  expect(sdk.forceStop).toHaveBeenCalledTimes(1);
  await expect(getModelCatalog()).resolves.toHaveLength(2);
});
it("does not discard a valid catalog when graceful cleanup fails", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { getModelCatalog } = await import("./model-catalog");
  sdk.stop.mockRejectedValueOnce(new Error("Shutdown disconnected"));
  await expect(getModelCatalog()).resolves.toHaveLength(2);
  expect(sdk.forceStop).toHaveBeenCalledTimes(1);
});
