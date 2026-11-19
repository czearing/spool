import { afterEach, expect, it, vi } from "vitest";
import { promisify } from "node:util";

const run = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => {
  const execute = Object.assign(() => {}, { [promisify.custom]: run });
  return { execFile: execute };
});
afterEach(() => { run.mockReset(); vi.restoreAllMocks(); vi.resetModules(); });
const snapshot = { stdout: process.platform === "win32"
  ? JSON.stringify([{ pid: 1234, command: "copilot --provider-token fixture" }])
  : "1234 copilot --provider-token fixture" };
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
it("shares in-flight inspections across interleaved projects and canonical PID lists", async () => {
  const { readRunningProcesses } = await import("./process-snapshot");
  run.mockResolvedValue(snapshot);
  const first = readRunningProcesses([5678, 1234, 1234]), second = readRunningProcesses([9012]);
  const duplicate = readRunningProcesses([1234, 5678]);
  expect(duplicate).toBe(first);
  await Promise.all([first, second, duplicate]);
  expect(run).toHaveBeenCalledTimes(2);
  if (process.platform === "win32") {
    const command = Buffer.from(run.mock.calls[0][1].at(-1), "base64").toString("utf16le");
    expect(command.match(/ProcessId=1234/g)).toHaveLength(1);
  }
});
it("keeps full legacy-session inspections separate from task-owned provider lists", async () => {
  const { readRunningProcesses } = await import("./process-snapshot");
  run.mockResolvedValue(snapshot);
  const legacy = readRunningProcesses(), provider = readRunningProcesses([1234]);
  expect(readRunningProcesses()).toBe(legacy);
  await Promise.all([legacy, provider]);
  expect(run).toHaveBeenCalledTimes(2);
});
it("preserves the one-second freshness window independently for each project", async () => {
  const { readRunningProcesses } = await import("./process-snapshot");
  const now = vi.spyOn(Date, "now").mockReturnValue(1000);
  run.mockResolvedValue(snapshot);
  const first = readRunningProcesses([1234]);
  await first;
  now.mockReturnValue(1100);
  const second = readRunningProcesses([5678]);
  await second;
  now.mockReturnValue(1999);
  expect(readRunningProcesses([1234])).toBe(first);
  now.mockReturnValue(2000);
  await readRunningProcesses([1234]);
  expect(readRunningProcesses([5678])).toBe(second);
  expect(run).toHaveBeenCalledTimes(3);
});
it("does not expire in-flight work before inspection has completed", async () => {
  const { readRunningProcesses } = await import("./process-snapshot");
  const now = vi.spyOn(Date, "now").mockReturnValue(1000), pending = Promise.withResolvers<typeof snapshot>();
  run.mockReturnValueOnce(pending.promise).mockResolvedValue(snapshot);
  const first = readRunningProcesses([1234]);
  now.mockReturnValue(5000);
  expect(readRunningProcesses([1234])).toBe(first);
  pending.resolve(snapshot); await first;
  now.mockReturnValue(5999);
  expect(readRunningProcesses([1234])).toBe(first);
  now.mockReturnValue(6000);
  await readRunningProcesses([1234]);
  expect(run).toHaveBeenCalledTimes(2);
});
it("retries failed inspections without discarding another project's successful result", async () => {
  const { readRunningProcesses } = await import("./process-snapshot");
  run.mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error("CIM failed")).mockResolvedValue(snapshot);
  const first = readRunningProcesses([1234]);
  await first;
  await expect(readRunningProcesses([5678])).rejects.toThrow("CIM failed");
  expect(readRunningProcesses([1234])).toBe(first);
  await readRunningProcesses([5678]);
  expect(run).toHaveBeenCalledTimes(3);
});
it("bounds the process cache while keeping recently requested snapshots reusable", async () => {
  const { readRunningProcesses } = await import("./process-snapshot");
  vi.spyOn(Date, "now").mockReturnValue(1000);
  run.mockResolvedValue(snapshot);
  for (let pid = 1; pid <= 33; pid++) await readRunningProcesses([pid]);
  await readRunningProcesses([33]);
  expect(run).toHaveBeenCalledTimes(33);
  await readRunningProcesses([1]);
  expect(run).toHaveBeenCalledTimes(34);
});
