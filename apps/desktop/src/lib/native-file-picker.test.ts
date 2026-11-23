import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
class Process extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn();
  reply(value: unknown) { this.stdout.write(`${JSON.stringify(value)}\n`); }
}
let processes: Process[], pick: typeof import("./native-file-picker").pickNativePath;
const signal = () => new AbortController().signal;
beforeEach(async () => {
  vi.resetModules(); processes = [];
  spawn.mockReset().mockImplementation(() => { const child = new Process(); processes.push(child); return child; });
  pick = (await import("./native-file-picker")).pickNativePath;
});
afterEach(() => {
  for (const child of processes) child.emit("exit", 0);
  vi.useRealTimers();
});

describe.skipIf(process.platform !== "win32")("Windows native picker", () => {
  it.each(["file", "folder"] as const)("returns Unicode %s paths as soon as a result arrives, without waiting for exit", async (kind) => {
    const result = pick(kind, signal()), child = processes[0];
    expect(child.stdin.read().toString()).toBe(`${kind}\n`);
    child.reply({ path: "C:\\Work\\caf\u00e9 & notes" });
    expect(await result).toBe("C:\\Work\\caf\u00e9 & notes");
    expect(child.kill).not.toHaveBeenCalled();
    const [executable, args, options] = spawn.mock.calls[0];
    expect(executable).toMatch(/PowerShell\\7\\pwsh\.exe$/);
    expect(args).toContain("-STA"); expect(args).toContain("-EncodedCommand");
    expect(options).toMatchObject({ windowsHide: true, stdio: "pipe" });
    expect(options.shell).toBeUndefined();
    const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
    expect(script).toContain("[Console]::Out.Flush()");
    expect(script).toContain("$dialog.Dispose()"); expect(script).toContain("$owner.Dispose()");
  });
  it("cancels repeatedly without exiting or starting another PowerShell process", async () => {
    for (let index = 0; index < 10; index++) {
      const result = pick("folder", signal());
      processes[0].reply({ path: null });
      await expect(result).resolves.toBeNull();
    }
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(processes[0].kill).not.toHaveBeenCalled();
  });
  it.each(['{"path":""}', '{"path":"relative"}', '{}', '{"error":"Dialog failure"}', 'broken'])(
    "rejects invalid or failed process output %s and recovers on retry", async (text) => {
      const result = pick("file", signal());
      processes[0].stdout.write(`${text}\n`);
      await expect(result).rejects.toThrow();
      expect(processes[0].kill).toHaveBeenCalledTimes(1);
      const retry = pick("folder", signal()); processes[1].reply({ path: null });
      await expect(retry).resolves.toBeNull();
    });
  it("allows only one dialog while selection is pending", async () => {
    const first = pick("folder", signal());
    await expect(pick("file", signal())).rejects.toMatchObject({ status: 409 });
    expect(spawn).toHaveBeenCalledTimes(1);
    processes[0].reply({ path: null }); await first;
  });
  it("aborting kills only the owned helper, rejects promptly, and allows a fresh picker", async () => {
    const controller = new AbortController(), first = pick("folder", controller.signal);
    controller.abort();
    await expect(first).rejects.toThrow();
    expect(processes[0].kill).toHaveBeenCalledTimes(1);
    const retry = pick("folder", signal());
    processes[0].emit("exit", 1); // A late exit from the old helper must not clear the new one.
    await expect(pick("file", signal())).rejects.toMatchObject({ status: 409 });
    processes[1].reply({ path: null }); await expect(retry).resolves.toBeNull();
    expect(spawn).toHaveBeenCalledTimes(2);
  });
  it("does not spawn for a previously cancelled request", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(pick("file", controller.signal)).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });
  it.each(["error", "exit", "stdin"])("releases pending selection after %s failure", async (event) => {
    const first = pick("folder", signal()), child = processes[0];
    if (event === "stdin") child.stdin.emit("error", new Error("Pipe closed"));
    else child.emit(event, event === "exit" ? 1 : new Error("Spawn failed"));
    await expect(first).rejects.toThrow();
    const retry = pick("folder", signal()); processes[1].reply({ path: null });
    await expect(retry).resolves.toBeNull();
  });
  it("expires idle helpers without accumulating processes", async () => {
    vi.useFakeTimers();
    const first = pick("file", signal()); processes[0].reply({ path: null }); await first;
    vi.advanceTimersByTime(59_999); expect(processes[0].kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(processes[0].kill).toHaveBeenCalledTimes(1);
    const next = pick("folder", signal()); processes[1].reply({ path: null }); await next;
    expect(spawn).toHaveBeenCalledTimes(2);
  });
  it("timeouts report an error and release the pending helper", async () => {
    vi.useFakeTimers();
    const first = pick("folder", signal()), assertion = expect(first).rejects.toMatchObject({ status: 408 });
    vi.advanceTimersByTime(300_000); await assertion;
    expect(processes[0].kill).toHaveBeenCalledTimes(1);
  });
});
