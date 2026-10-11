import { execFileSync } from "node:child_process";

export function windowsProcesses(run = execFileSync) {
  const output = run("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; $json=@(Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine) | ConvertTo-Json -Compress; [Console]::Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))",
  ], { encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  // Transport as ASCII so the console cannot reinterpret controls inside command lines.
  return JSON.parse(Buffer.from(output.trim(), "base64").toString("utf8"));
}

export function isRunnerProcess(processes, pid, entry) {
  const expected = entry.replaceAll("/", "\\").toLowerCase();
  const pattern = new RegExp(`(?:^|\\s|")${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|\\s|")`);
  return processes.some((p) => p.ProcessId === pid
    && /^(node|bun)(\.exe)?$/i.test(p.Name)
    && typeof p.CommandLine === "string"
    && pattern.test(p.CommandLine.replaceAll("/", "\\").toLowerCase()));
}
