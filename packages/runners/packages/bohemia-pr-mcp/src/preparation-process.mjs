import { spawnSync } from "node:child_process";

export function executePreparation(command, args, cwd, environment = process.env, timeout = 5_400_000) {
  const result = spawnSync(command, args, {
    cwd, encoding: "utf8", windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024,
    env: { ...environment, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
  });
  if (result.error) throw result.error;
  return { code: result.status ?? 1, stdout: result.stdout || "", output: `${result.stdout || ""}${result.stderr || ""}` };
}

// A dead controller can still have a live Git/install child. Unknown state is never idle.

export function preparationProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code !== "ESRCH") throw error; }
  if (process.platform !== "win32") return true;
  const script = `$p=Get-CimInstance Win32_Process -ErrorAction Stop; $children=@($p|Where-Object ParentProcessId -eq ${pid}); if($children.Count){'alive'}else{'dead'}`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, timeout: 15_000,
  });
  if (result.error || result.status !== 0) throw new Error(`Cannot verify interrupted preparation process ${pid}: ${result.error?.message || result.stderr}`);
  return result.stdout.trim() !== "dead";
}
