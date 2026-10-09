import { beforeEach, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ start: vi.fn(), listModels: vi.fn(), stop: vi.fn() }));
vi.mock("@github/copilot-sdk", () => ({ CopilotClient: class {
  start = sdk.start;
  listModels = sdk.listModels;
  stop = sdk.stop;
} }));
vi.mock("node:fs/promises", () => ({ stat: vi.fn(async () => ({ isFile: () => true })) }));
beforeEach(() => {
  vi.resetModules();
  sdk.start.mockReset().mockResolvedValue(undefined);
  sdk.stop.mockReset().mockResolvedValue([]);
  sdk.listModels.mockReset().mockResolvedValue([
    { id: "auto", name: "Auto" }, { id: "selected-model", name: "Available model", policy: { state: "enabled" } },
    { id: "disabled-model", name: "Disabled model", policy: { state: "disabled" } },
  ]);
});
it("uses the provider catalog without sessions, hides disabled models and shares cached discovery", async () => {
  const { getModelCatalog } = await import("./model-catalog");
  const [first, second] = await Promise.all([getModelCatalog(), getModelCatalog()]);
  expect(first).toEqual([{ value: "auto", label: "Auto" }, { value: "selected-model", label: "Available model" }]);
  expect(second).toEqual(first);
  expect(sdk.start).toHaveBeenCalledTimes(1);
  expect(sdk.listModels).toHaveBeenCalledTimes(1);
  expect(sdk.stop).toHaveBeenCalledTimes(1);
});
it("closes failed discovery and permits a real retry instead of inventing a catalog", async () => {
  const { getModelCatalog } = await import("./model-catalog");
  sdk.listModels.mockRejectedValueOnce(new Error("Sign in required"));
  await expect(getModelCatalog()).rejects.toThrow("Sign in required");
  await expect(getModelCatalog()).resolves.toHaveLength(2);
  expect(sdk.stop).toHaveBeenCalledTimes(2);
});
