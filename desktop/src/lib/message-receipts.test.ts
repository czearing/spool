import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { reconcileMessageReceipts } from "./message-receipts";

const run = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execFile: Object.assign(() => {}, { [promisify.custom]: run }),
}));
const messages = [{ id: "original-message", text: "Original input", status: "delivery_uncertain", created_at: "now" }];
beforeEach(() => {
  vi.stubEnv("SPOOL_DESKTOP_TASK_RUNTIME", "1");
  vi.stubEnv("SPOOL_AGENT_BINARY", "bundled-spool");
  run.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("shares native receipt verification across concurrent reads without starting or replacing a daemon", async () => {
  run.mockResolvedValue({ stdout: "1\n" });
  expect(await Promise.all(Array.from({ length: 16 }, () => reconcileMessageReceipts("shared", "one", messages))))
    .toEqual(Array(16).fill(true));
  expect(run).toHaveBeenCalledOnce();
  expect(run).toHaveBeenCalledWith("bundled-spool", ["--root", "shared", "message-receipts", "--task", "one"],
    expect.objectContaining({ windowsHide: true }));
});
it("does not treat absent receipt evidence or a failed inspection as confirmed delivery", async () => {
  run.mockResolvedValue({ stdout: "0\n" });
  expect(await reconcileMessageReceipts("missing", "one", messages)).toBe(false);
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  run.mockRejectedValue(new Error("Cannot inspect provider history"));
  expect(await reconcileMessageReceipts("failed", "one", messages)).toBe(false);
  expect(report).toHaveBeenCalledOnce();
});
it("bounds repeated failed reconciliation and retries when evidence may have become available", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1000);
  run.mockResolvedValue({ stdout: "0\n" });
  expect(await reconcileMessageReceipts("retry", "one", messages)).toBe(false);
  expect(await reconcileMessageReceipts("retry", "one", messages)).toBe(false);
  expect(run).toHaveBeenCalledOnce();
  vi.mocked(Date.now).mockReturnValue(31000);
  expect(await reconcileMessageReceipts("retry", "one", messages)).toBe(false);
  expect(run).toHaveBeenCalledTimes(2);
});
it("does not probe ordinary reads or use the native repair outside the desktop adapter", async () => {
  expect(await reconcileMessageReceipts("ordinary", "one", [])).toBe(false);
  vi.stubEnv("SPOOL_DESKTOP_TASK_RUNTIME", undefined);
  expect(await reconcileMessageReceipts("browser", "one", messages)).toBe(false);
  expect(run).not.toHaveBeenCalled();
});
