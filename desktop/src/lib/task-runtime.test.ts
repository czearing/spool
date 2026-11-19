import { ChildProcess, execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureTaskRuntime } from "./task-runtime";

vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn() };
});
let root: string;
const capability = (values = {}) => ({ version: 1, taskControl: true, interactive: true,
  pid: process.pid, updatedAt: new Date(Date.now()).toISOString(), ...values });
const publish = (value = capability()) => writeFile(join(root, "controls", "capabilities.json"), JSON.stringify(value));
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "spool-runtime-"));
  await mkdir(join(root, "controls"));
  vi.stubEnv("SPOOL_DESKTOP_TASK_RUNTIME", "1");
  vi.stubEnv("SPOOL_AGENT_BINARY", "bundled-spool");
  vi.mocked(execFile).mockReset().mockImplementation((_binary, _args, _options, callback) => {
    void publish().then(() => callback?.(null, "", ""), error => callback?.(error, "", ""));
    return new ChildProcess();
  });
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
it("does not start runtimes outside the native adapter", async () => {
  vi.stubEnv("SPOOL_DESKTOP_TASK_RUNTIME", undefined);
  await ensureTaskRuntime(root);
  expect(execFile).not.toHaveBeenCalled();
});
it("starts one interactive detached runtime for concurrent requests and path aliases", async () => {
  await Promise.all([ensureTaskRuntime(root), ensureTaskRuntime(join(root, ".")), ensureTaskRuntime(root)]);
  expect(execFile).toHaveBeenCalledTimes(1);
  expect(execFile).toHaveBeenCalledWith("bundled-spool", ["--root", expect.any(String), "daemon", "--detach"],
    expect.objectContaining({ windowsHide: true, timeout: 15000,
      env: expect.objectContaining({ SPOOL_INTERACTIVE_ACP: "1" }) }), expect.any(Function));
  await ensureTaskRuntime(root);
  expect(execFile).toHaveBeenCalledTimes(1);
});
it("reuses a live external daemon without taking ownership", async () => {
  await publish();
  await ensureTaskRuntime(root);
  expect(execFile).not.toHaveBeenCalled();
});
it.each([[11999, 0], [12000, 1]])("uses the exact heartbeat boundary at %i milliseconds", async (age, launches) => {
  vi.spyOn(Date, "now").mockReturnValue(Date.now());
  await publish(capability({ updatedAt: new Date(Date.now() - age).toISOString() }));
  await ensureTaskRuntime(root);
  expect(execFile).toHaveBeenCalledTimes(launches);
});
it.each([{ updatedAt: "2000-01-01T00:00:00Z" }, { updatedAt: "invalid" },
  { updatedAt: "2999-01-01T00:00:00Z" }, { pid: 0 }])("restarts an unavailable runtime: %j", async values => {
  await publish(capability(values));
  await ensureTaskRuntime(root);
  expect(execFile).toHaveBeenCalledTimes(1);
});
it("does not mistake a fresh heartbeat from an exited process for readiness", async () => {
  await publish();
  vi.spyOn(process, "kill").mockImplementationOnce(() => { throw Object.assign(new Error("Exited"), { code: "ESRCH" }); });
  await ensureTaskRuntime(root);
  expect(execFile).toHaveBeenCalledTimes(1);
});
it.each([{ version: 0 }, { taskControl: false }, { interactive: false }])("does not replace an incompatible active daemon: %j", async values => {
  await publish(capability(values));
  await expect(ensureTaskRuntime(root)).rejects.toMatchObject({ status: 503 });
  expect(execFile).not.toHaveBeenCalled();
});
it("does not start tasks after unreadable or corrupt runtime state", async () => {
  await writeFile(join(root, "controls", "capabilities.json"), "{broken");
  await expect(ensureTaskRuntime(root)).rejects.toThrow(SyntaxError);
  expect(execFile).not.toHaveBeenCalled();
  expect(await readFile(join(root, "controls", "capabilities.json"), "utf8")).toBe("{broken");
});
it("surfaces process-inspection failures instead of launching a competing daemon", async () => {
  await publish();
  vi.spyOn(process, "kill").mockImplementationOnce(() => { throw Object.assign(new Error("Access denied"), { code: "EPERM" }); });
  await expect(ensureTaskRuntime(root)).rejects.toThrow("Access denied");
  expect(execFile).not.toHaveBeenCalled();
});
it("reports a missing bundled binary without publishing a task", async () => {
  vi.stubEnv("SPOOL_AGENT_BINARY", undefined);
  await expect(ensureTaskRuntime(root)).rejects.toMatchObject({ status: 503, message: expect.stringContaining("unavailable") });
  expect(execFile).not.toHaveBeenCalled();
});
it("surfaces startup failures and releases the pending request for retry", async () => {
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(execFile).mockImplementationOnce((_binary, _args, _options, callback) => {
    queueMicrotask(() => callback?.(Object.assign(new Error("Cannot launch"), { code: "ENOENT" }), "", ""));
    return new ChildProcess();
  });
  await expect(ensureTaskRuntime(root)).rejects.toMatchObject({ status: 503, message: expect.stringContaining("could not start") });
  expect(report).toHaveBeenCalled();
  await ensureTaskRuntime(root);
  expect(execFile).toHaveBeenCalledTimes(2);
});
it("joins the actual winning daemon when the native lease rejects a duplicate start", async () => {
  vi.mocked(execFile).mockImplementationOnce((_binary, _args, _options, callback) => {
    void publish().then(() => callback?.(new Error("Duplicate startup refused"), "", ""));
    return new ChildProcess();
  });
  await ensureTaskRuntime(root);
  expect(execFile).toHaveBeenCalledTimes(1);
});
it("does not treat launcher exit success as proof of runtime readiness", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(execFile).mockImplementationOnce((_binary, _args, _options, callback) => {
    queueMicrotask(() => callback?.(null, "", ""));
    return new ChildProcess();
  });
  await expect(ensureTaskRuntime(root)).rejects.toMatchObject({ status: 503 });
});
