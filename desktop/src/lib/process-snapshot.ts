import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type RunningProcess = { pid: number; command: string };
const execute = promisify(execFile);
let cached: { key: string; until: number; result: Promise<RunningProcess[]> } | undefined;
export function readRunningProcesses(pids?: readonly number[]): Promise<RunningProcess[]> {
  if (pids?.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) return Promise.reject(new Error("Invalid process identity."));
  if (pids && !pids.length) return Promise.resolve([]);
  const key = pids ? [...new Set(pids)].sort((a, b) => a - b).join(",") : "sessions";
  if (cached && cached.key === key && cached.until > Date.now()) return cached.result;
  const result = inspect(pids);
  cached = { key, until: Infinity, result };
  result.then(() => { if (cached?.result === result) cached.until = Date.now() + 1000; },
    () => { if (cached?.result === result) cached = undefined; });
  return result;
}
async function inspect(pids?: readonly number[]): Promise<RunningProcess[]> {
  if (process.platform === "win32") {
    const filter = pids ? pids.map(pid => `ProcessId=${pid}`).join(" OR ")
      : "Name='copilot.exe' OR Name='node.exe' OR Name='cmd.exe'";
    const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " +
      `$items=@(Get-CimInstance Win32_Process -Filter "${filter}" | ` +
      "ForEach-Object { @{pid=$_.ProcessId;command=$_.CommandLine} }); ConvertTo-Json -InputObject $items -Compress";
    const { stdout } = await execute("pwsh.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
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
