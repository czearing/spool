import { afterEach, expect, it, vi } from "vitest";
import { promisify } from "node:util";
import { join } from "node:path";

const run = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => {
  const execute = Object.assign(() => {}, { [promisify.custom]: run });
  return { execFile: execute };
});
afterEach(() => { run.mockReset(); vi.resetModules(); vi.unstubAllEnvs(); });
it("limits provider inspection to validated task-owned process IDs", async () => {
  const { readRunningProcesses } = await import("./process-snapshot");
  run.mockResolvedValue({ stdout: JSON.stringify([{ pid: 1234, command: "copilot --provider-token fixture" }]) });
  if (process.platform !== "win32") return;
  vi.stubEnv("SystemRoot", "C:\\Windows");
  expect(await readRunningProcesses([1234])).toHaveLength(1);
  expect(run.mock.calls[0][0]).toBe(join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  const args = run.mock.calls[0][1];
  const command = Buffer.from(args.at(-1), "base64").toString("utf16le");
  expect(command).toContain('ProcessId=1234');
  expect(command).not.toContain("Name='cmd.exe'");
});
it("reports a missing Windows system directory instead of invoking an unrelated PATH executable", async () => {
  if (process.platform !== "win32") return;
  vi.stubEnv("SystemRoot", undefined);
  const { readRunningProcesses } = await import("./process-snapshot");
  await expect(readRunningProcesses([1234])).rejects.toThrow("Windows system directory is unavailable");
  expect(run).not.toHaveBeenCalled();
});
it("does not query unrelated processes for empty or invalid provider lists", async () => {
  const { readRunningProcesses } = await import("./process-snapshot");
  expect(await readRunningProcesses([])).toEqual([]);
  await expect(readRunningProcesses([-1])).rejects.toThrow("Invalid process identity");
  expect(run).not.toHaveBeenCalled();
});
