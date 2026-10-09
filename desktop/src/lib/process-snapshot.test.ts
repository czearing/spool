import { afterEach, expect, it, vi } from "vitest";
import { promisify } from "node:util";

const run = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => {
  const execute = Object.assign(() => {}, { [promisify.custom]: run });
  return { execFile: execute };
});
afterEach(() => { run.mockReset(); vi.resetModules(); });
it("limits provider inspection to validated task-owned process IDs", async () => {
  const { readRunningProcesses } = await import("./process-snapshot");
  run.mockResolvedValue({ stdout: JSON.stringify([{ pid: 1234, command: "copilot --provider-token fixture" }]) });
  if (process.platform !== "win32") return;
  expect(await readRunningProcesses([1234])).toHaveLength(1);
  const args = run.mock.calls[0][1];
  const command = Buffer.from(args.at(-1), "base64").toString("utf16le");
  expect(command).toContain('ProcessId=1234');
  expect(command).not.toContain("Name='cmd.exe'");
});
it("does not query unrelated processes for empty or invalid provider lists", async () => {
  const { readRunningProcesses } = await import("./process-snapshot");
  expect(await readRunningProcesses([])).toEqual([]);
  await expect(readRunningProcesses([-1])).rejects.toThrow("Invalid process identity");
  expect(run).not.toHaveBeenCalled();
});
