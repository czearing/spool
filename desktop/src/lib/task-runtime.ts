import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { readOptionalJson } from "./spool-publish";
import { hasCode } from "./file-snapshot";
import { TaskSubmissionError } from "./task-submission";

const execute = promisify(execFile);
const starting = new Map<string, Promise<void>>();
async function ready(root: string) {
  const value = await readOptionalJson(join(root, "controls", "capabilities.json"));
  if (!value || typeof value !== "object" || !("updatedAt" in value) || typeof value.updatedAt !== "string") return false;
  const age = Date.now() - Date.parse(value.updatedAt);
  if (!Number.isFinite(age) || age < 0 || age >= 12000 || !("pid" in value) ||
    typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) return false;
  try { process.kill(value.pid, 0); }
  catch (error) { if (hasCode(error, "ESRCH")) return false; throw error; }
  if (!("version" in value) || value.version !== 1 || !("taskControl" in value) || value.taskControl !== true ||
    !("interactive" in value) || value.interactive !== true) {
    throw new TaskSubmissionError("The running Spool daemon does not support messaging. Restart an updated daemon with SPOOL_INTERACTIVE_ACP=1.", 503);
  }
  return true;
}
export async function ensureTaskRuntime(root: string): Promise<void> {
  if (process.env.SPOOL_DESKTOP_TASK_RUNTIME !== "1") return;
  root = await realpath(root);
  const key = process.platform === "win32" ? root.toLowerCase() : root;
  const pending = starting.get(key);
  if (pending) return pending;
  const result = start(root);
  starting.set(key, result);
  try { await result; }
  finally { if (starting.get(key) === result) starting.delete(key); }
}
async function start(root: string) {
  if (await ready(root)) return;
  const binary = process.env.SPOOL_AGENT_BINARY;
  if (!binary) throw new TaskSubmissionError("The bundled Spool task runtime is unavailable. Check the server log.", 503);
  try {
    await execute(binary, ["--root", root, "daemon", "--detach"], {
      windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024,
      env: { ...process.env, SPOOL_INTERACTIVE_ACP: "1" },
    });
    if (!await ready(root)) throw new Error("The daemon did not publish a live, interactive readiness record.");
  } catch (error) {
    // Another application may have won the native project lease during startup.
    if (await ready(root)) return;
    console.error("Could not start the Spool task runtime.", root, error);
    throw new TaskSubmissionError(`Spool's task runtime could not start. Check the server log and ${join(root, "logs", "task-runtime.stderr.log")}, then retry.`, 503);
  }
}
