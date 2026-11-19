import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { reconcileMessageReceipts } from "./message-receipts";
import { configureApplication } from "./application-paths";

const run = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execFile: Object.assign(() => {}, { [promisify.custom]: run }),
}));
const messages = [{ id: "original-message", text: "Original input", status: "delivery_uncertain", created_at: "now" }];
const resources = join(tmpdir(), "spool-receipt-resources");
const binary = join(resources, process.platform === "win32" ? "spool-engine.exe" : "spool-engine");
beforeEach(() => {
  configureApplication({ data: tmpdir(), resources });
  vi.stubEnv("SPOOL_DESKTOP_TASK_RUNTIME", undefined);
  vi.stubEnv("SPOOL_AGENT_BINARY", undefined);
  run.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("shares native receipt verification across concurrent reads without starting or replacing a daemon", async () => {
  run.mockResolvedValue({ stdout: "1\n" });
  expect(await Promise.all(Array.from({ length: 16 }, () => reconcileMessageReceipts("shared", "one", messages))))
    .toEqual(Array(16).fill(true));
  expect(run).toHaveBeenCalledOnce();
  expect(run).toHaveBeenCalledWith(binary, ["--root", "shared", "message-receipts", "--task", "one"],
    expect.objectContaining({ windowsHide: true }));
});
it("ignores obsolete environment overrides and uses only the configured application resource", async () => {
  vi.stubEnv("SPOOL_DESKTOP_TASK_RUNTIME", "obsolete");
  vi.stubEnv("SPOOL_AGENT_BINARY", "must-not-run");
  run.mockResolvedValue({ stdout: "1\n" });
  expect(await reconcileMessageReceipts("obsolete", "one", messages)).toBe(true);
  expect(run).toHaveBeenCalledWith(binary, ["--root", "obsolete", "message-receipts", "--task", "one"],
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
it("does not probe conversations without uncertain messages", async () => {
  expect(await reconcileMessageReceipts("ordinary", "one", [])).toBe(false);
  expect(await reconcileMessageReceipts("delivered", "one", [{ ...messages[0], status: "delivered" }])).toBe(false);
  expect(run).not.toHaveBeenCalled();
});
