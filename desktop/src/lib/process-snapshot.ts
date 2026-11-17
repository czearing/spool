import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

export type RunningProcess = { pid: number; command: string };
const execute = promisify(execFile);
const cache = new Map<string, { until: number; result: Promise<RunningProcess[]> }>();
export function readRunningProcesses(pids?: readonly number[]): Promise<RunningProcess[]> {
  if (pids?.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) return Promise.reject(new Error("Invalid process identity."));
  if (pids && !pids.length) return Promise.resolve([]);
  const ids = pids ? [...new Set(pids)].sort((a, b) => a - b) : undefined;
  const key = ids ? ids.join(",") : "sessions", now = Date.now(), saved = cache.get(key);
  if (saved && saved.until > now) return saved.result;
  for (const [key, entry] of cache) if (entry.until <= now) cache.delete(key);
  const result = inspect(ids), pending = { until: Infinity, result };
  cache.set(key, pending);
  const oldest = cache.keys().next().value;
  if (cache.size > 32 && oldest !== undefined) cache.delete(oldest);
  result.then(() => { if (cache.get(key) === pending) pending.until = Date.now() + 1000; },
    () => { if (cache.get(key) === pending) cache.delete(key); });
  return result;
}
async function inspect(pids?: readonly number[]): Promise<RunningProcess[]> {
  if (process.platform === "win32") {
    const filter = pids ? pids.map(pid => `ProcessId=${pid}`).join(" OR ")
      : "Name='copilot.exe' OR Name='node.exe' OR Name='cmd.exe'";
    const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " +
      `$items=@(Get-CimInstance Win32_Process -Filter "${filter}" | ` +
      "ForEach-Object { @{pid=$_.ProcessId;command=$_.CommandLine} }); ConvertTo-Json -InputObject $items -Compress";
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot) throw new Error("Windows system directory is unavailable for process inspection.");
    const shell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const { stdout } = await execute(shell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
    const data: unknown = JSON.parse(stdout);
    if (!Array.isArray(data)) throw new Error("Invalid process snapshot.");
    return data.map((item: unknown) => {
      if (!item || typeof item !== "object" || !("pid" in item) || typeof item.pid !== "number" ||
        !("command" in item) || typeof item.command !== "string") throw new Error("Cannot inspect an agent process; live counts are unavailable.");
      return { pid: item.pid, command: item.command };
    });
  }
  const { stdout } = await execute("ps", ["-eo", "pid=,args="], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim().split("\n").map((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) throw new Error("Invalid process snapshot.");
    return { pid: Number(match[1]), command: match[2] };
  });
}
