import { openSync, fstatSync, readSync, closeSync, readdirSync } from "node:fs";
import path from "node:path";
import { validateTaskId as safeId } from "../src/lib/task-conversation.ts";
import { appendEvents, bounded } from "./transcript.mjs";

export const logWindow = 256 * 1024;

export function taskSummary(task) {
  return {
    id: task.id, agent: task.agent, title: task.title, status: task.status,
    updatedAt: task.updated_at, createdAt: task.created_at, sessionId: task.session_id,
    workspace: task.workspace, error: task.error,
    interaction: task.interaction || null, interactive: !!task.provider?.token,
  };
}

export function monitorConversation(store, id, before = null, individual = false) {
  safeId(id);
  if (before !== null && (!Number.isSafeInteger(before) || before < 0)) throw new RangeError("Invalid log position");
  const task = store.task(id);
  if (!task) return null;
  let file, nextBefore = null, lastOutput = null, available = false, limited = false, cursor = 0, logId = null;
  let entries = [];
  try { file = openSync(path.join(store.root, "logs", `${id}.log`), "r"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (file !== undefined) {
    available = true;
    try {
      const stat = fstatSync(file), end = before ?? stat.size;
      logId = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      if (end > stat.size) throw new RangeError("Log changed; select Latest to reload it");
      const start = Math.max(0, end - logWindow), buffer = Buffer.alloc(end - start);
      const length = readSync(file, buffer, 0, buffer.length, start);
      const bytes = buffer.subarray(0, length);
      const complete = bytes.lastIndexOf(10);
      cursor = complete < 0 ? start : start + complete + 1;
      const completeBytes = complete >= 0
        ? bytes.subarray(0, complete + 1)
        : (start === 0 && before != null ? bytes : Buffer.alloc(0));
      let body = completeBytes.toString("utf8");
      if (start > 0) {
        limited = true;
        const boundary = bytes.indexOf(10);
        nextBefore = boundary >= 0 && boundary + 1 < length ? start + boundary + 1 : start;
        body = boundary < 0 ? "" : completeBytes.subarray(boundary + 1).toString("utf8");
      }
      lastOutput = stat.mtime.toISOString();
      const lines = body.split("\n");
      let offset = nextBefore ?? 0;
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const position = offset;
        offset += Buffer.byteLength(line) + 1;
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); }
        catch {
          if (index === lines.length - 1 && line.startsWith("{")) continue;
          entries.push({ kind: "stdout", ts: task.updated_at, text: bounded(line), ...(individual ? { id: `log:${position}`, offset: position } : {}) });
          continue;
        }
        if (!individual) { entries = appendEvents(entries, [event], task.updated_at); continue; }
        const data = event.data || event, ts = event.timestamp || task.updated_at;
        const projected = event.type === "tool.execution_progress" ? [{ kind: "tool_progress", ts,
          toolUseId: data.toolCallId, name: typeof data.title === "string" ? data.title : undefined,
          input: data.arguments == null ? undefined : bounded(data.arguments) }]
          : event.type === "session.turn_end" ? [{ kind: "turn_end", ts }] : appendEvents([], [event], task.updated_at);
        entries.push(...projected.map(entry => ({ ...entry, id: `log:${position}`, offset: position })));
      }
    } finally { closeSync(file); }
  }
  return {
    task: { ...taskSummary(task), prompt: task.prompt, cost: task.cost || null, turns: task.turns ?? null },
    available, limited, lastOutput, nextBefore, entries, cursor, ...(individual ? { raw: true, logId } : {}),
    notes: (task.comments || []).map(note => ({
      author: note.author || "unknown", at: note.created_at, text: bounded(note.message || note.content),
    })),
  };
}
