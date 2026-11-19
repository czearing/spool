import { afterEach, expect, it, vi } from "vitest";
import { loadView } from "./load-view";

afterEach(() => { vi.useRealTimers(); });
it("loads a view and clears its deadline", async () => {
  vi.useFakeTimers();
  const view = { default: () => null };
  expect(await loadView(async () => view)).toBe(view);
  expect(vi.getTimerCount()).toBe(0);
});
it("bounds a stalled module import and permits a new attempt after it recovers", async () => {
  vi.useFakeTimers();
  let resolve: (value: string) => void = () => {};
  const module = new Promise<string>(done => { resolve = done; });
  const request = expect(loadView(() => module)).rejects.toThrow("15 seconds");
  await vi.advanceTimersByTimeAsync(15000);
  await request;
  resolve("recovered");
  expect(await loadView(() => module)).toBe("recovered");
  expect(vi.getTimerCount()).toBe(0);
});
it("preserves import failures and synchronous loader errors", async () => {
  vi.useFakeTimers();
  for (const load of [() => Promise.reject(new Error("Missing module")), () => { throw new Error("Missing module"); }]) {
    await expect(loadView(load)).rejects.toThrow("Missing module");
    expect(vi.getTimerCount()).toBe(0);
  }
});
