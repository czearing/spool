import { openSync, fstatSync, readSync, closeSync } from "node:fs";
import path from "node:path";

const failures = new Map();

export function agentReportedFailure(root, task) {
  if (!root || task.error != null && typeof task.error !== "string" || !task.error && task.status !== "failed" ||
      typeof task.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,179}$/.test(task.id)) return false;
  const name = path.join(root, "logs", `${task.id}.log`);
  let file;
  try { file = openSync(name, "r"); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  try {
    const stat = fstatSync(file, { bigint: true });
    const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
    const version = `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const key = JSON.stringify([name, task.error ?? null]), previous = failures.get(key);
    if (previous?.identity === identity && previous.version === version) return previous.reported;
    const calls = new Set(), buffer = Buffer.alloc(256 * 1024);
    let position = 0, pending = Buffer.alloc(0), reported = false;
    while (position < Number(stat.size) && !reported) {
      const length = readSync(file, buffer, 0, Math.min(buffer.length, Number(stat.size) - position), position);
      if (!length) break;
      position += length;
      const bytes = Buffer.concat([pending, buffer.subarray(0, length)]);
      let start = 0, end;
      while ((end = bytes.indexOf(10, start)) >= 0) {
        const line = bytes.subarray(start, end).toString("utf8");
        start = end + 1;
        if (!line.includes("tool.execution_")) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        const data = event.data;
        if (event.type === "tool.execution_start" &&
            /(?:^|[-_])spool_update_task_status$/.test(data?.toolName ?? "")) {
          let args = data.arguments;
          if (typeof args === "string") {
            try { args = JSON.parse(args); } catch { continue; }
          }
          if (args?.status === "failed" && (args.error ?? null) === (task.error ?? null) && typeof data.toolCallId === "string")
            calls.add(data.toolCallId);
        } else if (event.type === "tool.execution_complete" && calls.has(data?.toolCallId)) {
          calls.delete(data.toolCallId);
          if (data.success === true && data.result?.isError !== true &&
              (data.result?.content === "Task status updated to failed" ||
               data.result?.contents?.some(item => item.text === "Task status updated to failed") ||
               data.result?.content?.some?.(item => item.text === "Task status updated to failed"))) {
            reported = true;
            break;
          }
        }
      }
      pending = bytes.subarray(start);
    }
    failures.delete(key);
    failures.set(key, { identity, version, reported });
    if (failures.size > 64) failures.delete(failures.keys().next().value);
    return reported;
  } finally { closeSync(file); }
}

export function taskFailurePresentation(root, task) {
  if (!agentReportedFailure(root, task)) return {};
  return { ...(task.status === "failed" ? { status: "blocked", queueStatus: "failed" } : {}), error: null };
}
