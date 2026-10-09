import { spawn } from "node:child_process";
import { join, win32 } from "node:path";
import { createInterface } from "node:readline";
import { nativePickerScript } from "./native-picker-script";

let helper: NativePickerProcess | undefined;
export class PickerError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

class NativePickerProcess {
  private child;
  private lines;
  private idle?: NodeJS.Timeout;
  private closed = false;
  private stderr = "";
  private finish?: (result: { path: string | null } | { error: Error }) => void;
  get busy() { return !!this.finish; }

  constructor() {
    const executable = join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
    this.child = spawn(executable, ["-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden",
      "-EncodedCommand", Buffer.from(nativePickerScript, "utf16le").toString("base64")], { windowsHide: true, stdio: "pipe" });
    this.lines = createInterface({ input: this.child.stdout });
    this.child.stderr.setEncoding("utf8").on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-4096); });
    this.child.on("error", (error) => this.stop(error));
    this.child.stdin.on("error", (error) => this.stop(error));
    this.child.on("exit", (code) => this.stop(new Error(`Native picker exited (${code}). ${this.stderr}`)));
    this.lines.on("line", (line) => {
      try {
        const result: unknown = JSON.parse(line);
        if (result && typeof result === "object" && "error" in result && typeof result.error === "string") {
          throw new Error(result.error);
        }
        if (!result || typeof result !== "object" || !("path" in result) ||
          (result.path !== null && (typeof result.path !== "string" || !win32.isAbsolute(result.path)))) {
          throw new Error("Native picker returned an invalid path.");
        }
        this.finish?.({ path: result.path });
      } catch (error) { this.stop(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  stop(error = new Error("Native picker closed.")) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idle);
    if (helper === this) helper = undefined;
    this.lines.close();
    this.child.kill();
    this.finish?.({ error });
  }

  select(kind: "file" | "folder", signal: AbortSignal): Promise<string | null> {
    clearTimeout(this.idle);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => this.stop(new PickerError("The picker timed out. Try again or enter the path.", 408)), 300_000);
      const abort = () => this.stop(signal.reason instanceof Error ? signal.reason : new Error("Picker cancelled."));
      this.finish = (result) => {
        this.finish = undefined;
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        if ("error" in result) { reject(result.error); return; }
        this.idle = setTimeout(() => this.stop(), 60_000);
        this.idle.unref();
        resolve(result.path);
      };
      signal.addEventListener("abort", abort, { once: true });
      this.child.stdin.write(`${kind}\n`, (error) => { if (error) this.stop(error); });
    });
  }
}

export async function pickNativePath(kind: "file" | "folder", signal: AbortSignal) {
  if (process.platform !== "win32") throw new PickerError("Native browsing requires Windows. Enter the path instead.", 501);
  signal.throwIfAborted();
  if (helper?.busy) throw new PickerError("A picker is already open. Finish or cancel it before opening another.", 409);
  helper ??= new NativePickerProcess();
  return helper.select(kind, signal);
}
