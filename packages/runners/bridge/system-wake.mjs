import { spawn } from "node:child_process";

const script = `
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class SpoolWake { [DllImport("kernel32.dll", SetLastError=true)] public static extern uint SetThreadExecutionState(uint flags); }'
if ([SpoolWake]::SetThreadExecutionState([uint32]2147483649) -eq 0) { throw 'System wake request failed' }
try {
  [Console]::Out.WriteLine('system-required')
  while ($null -ne [Console]::In.ReadLine()) {}
} finally { [void][SpoolWake]::SetThreadExecutionState([uint32]2147483648) }
`;

export async function preventIdleSleep({ platform = process.platform, start = spawn } = {}) {
  if (platform !== "win32") return Object.assign(() => {}, { active: () => true });
  const child = start("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let alive = true;
  child.once("close", () => { alive = false; });
  child.once("error", () => { alive = false; });
  child.stdin.on("error", () => {});
  child.stderr.resume();
  await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => { child.stdin.end(); reject(new Error("System wake request timed out")); }, 15000);
    child.stdout.on("data", bytes => {
      output += bytes;
      if (output.includes("system-required")) { clearTimeout(timer); resolve(); }
    });
    child.once("error", () => { clearTimeout(timer); reject(new Error("System wake helper unavailable")); });
    child.once("close", () => { clearTimeout(timer); reject(new Error("System wake request ended before readiness")); });
  });
  let released = false;
  const release = () => {
    if (!released) { released = true; child.stdin.end(); }
  };
  release.active = () => alive && !released;
  return release;
}
