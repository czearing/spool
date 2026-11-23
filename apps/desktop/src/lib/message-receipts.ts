import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { applicationPaths } from "./application-paths";
import type { OperatorMessage } from "./task-conversation";

const execute = promisify(execFile);
const attempts = new Map<string, { until: number; result: Promise<boolean> }>();
export async function reconcileMessageReceipts(root: string, task: string, messages: OperatorMessage[]) {
  const uncertain = messages.filter(message => message.status === "delivery_uncertain").map(message => message.id);
  if (!uncertain.length) return false;
  const binary = join(applicationPaths().resources, process.platform === "win32" ? "spool-engine.exe" : "spool-engine");
  const key = JSON.stringify([root, task, uncertain]), saved = attempts.get(key);
  if (saved && saved.until > Date.now()) return saved.result;
  const attempt = { until: Infinity, result: Promise.resolve(false) };
  attempt.result = execute(binary, ["--root", root, "message-receipts", "--task", task], {
    windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024,
  }).then(({ stdout }) => /^[1-9]\d*\s*$/.test(stdout), error => {
    console.error("Could not reconcile saved message receipts.", error);
    return false;
  }).finally(() => { attempt.until = Date.now() + 30000; });
  attempts.set(key, attempt);
  const oldest = attempts.keys().next().value;
  if (attempts.size > 200 && oldest !== undefined) attempts.delete(oldest);
  return attempt.result;
}
