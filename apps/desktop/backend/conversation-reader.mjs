import { openSync, fstatSync, readSync, closeSync } from "node:fs";
import path from "node:path";
import { validateTaskId as safeId } from "../src/lib/task-conversation.ts";
import { appendEvent, appendEvents, bounded } from "./transcript.mjs";
import { reviewSupersession } from "../../../packages/runners/packages/repository-mcp/src/review-outcome.mjs";
import { taskFailurePresentation } from "../../../packages/runners/bridge/task-failure.mjs";

export const logWindow = 256 * 1024;
const windows = new Map();
const fileVersion = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
const copyWindow = window => ({ ...window, entries: window.entries.map(entry => ({ ...entry,
  ...(entry.steps ? { steps: entry.steps.map(step => ({ ...step })) } : {}) })) });

function readWindow(file, name, before, individual) {
  const stat = fstatSync(file, { bigint: true }), size = Number(stat.size), end = before ?? size;
  if (end > size) throw new RangeError("Log changed; select Latest to reload it");
  const key = `${name}\0${before ?? "latest"}\0${individual}`;
  const version = fileVersion(stat), cached = windows.get(key);
  if (cached?.version === version) {
    windows.delete(key); windows.set(key, cached);
    return copyWindow(cached.value);
  }
  windows.delete(key);
  const start = Math.max(0, end - logWindow), buffer = Buffer.alloc(end - start);
  const length = readSync(file, buffer, 0, buffer.length, start);
  const bytes = buffer.subarray(0, length), complete = bytes.lastIndexOf(10);
  const cursor = complete < 0 ? start : start + complete + 1;
  const completeBytes = complete >= 0
    ? bytes.subarray(0, complete + 1)
    : (start === 0 && before != null ? bytes : Buffer.alloc(0));
  let body = completeBytes.toString("utf8"), nextBefore = null;
  if (start > 0) {
    const boundary = bytes.indexOf(10);
    nextBefore = boundary >= 0 && boundary + 1 < length ? start + boundary + 1 : start;
    body = boundary < 0 ? "" : completeBytes.subarray(boundary + 1).toString("utf8");
  }
  const entries = [], lines = body.split("\n"), events = individual ? new Map() : undefined;
  let offset = nextBefore ?? 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], position = offset;
    offset += Buffer.byteLength(line) + 1;
    if (!line.trim()) continue;
    const saved = cached?.events?.get(position);
    if (individual && saved?.line === line) {
      entries.push(...saved.entries); events.set(position, saved);
      continue;
    }
    let event;
    try { event = JSON.parse(line); }
    catch {
      if (index === lines.length - 1 && line.startsWith("{")) continue;
      const projected = [{ kind: "stdout", ts: "", text: bounded(line), ...(individual ? { id: `log:${position}`, offset: position } : {}) }];
      entries.push(...projected);
      events?.set(position, { line, entries: projected });
      continue;
    }
    if (!individual) { appendEvent(entries, event, ""); continue; }
    const data = event.data || event, ts = event.timestamp || "";
    const projected = event.type === "tool.execution_progress" ? [{ kind: "tool_progress", ts,
      toolUseId: data.toolCallId, name: typeof data.title === "string" ? data.title : undefined,
      input: data.arguments == null ? undefined : bounded(data.arguments) }]
      : event.type === "session.turn_end" ? [{ kind: "turn_end", ts }] : appendEvents([], [event], "");
    const positioned = projected.map(entry => ({ ...entry, id: `log:${position}`, offset: position }));
    entries.push(...positioned);
    events.set(position, { line, entries: positioned });
  }
  const value = { entries, nextBefore, cursor, limited: start > 0,
    logId: `${stat.dev}:${stat.ino}:${Number(stat.birthtimeNs) / 1e6}`,
    lastOutput: new Date(Number(stat.mtimeMs)).toISOString() };
  if (fileVersion(fstatSync(file, { bigint: true })) === fileVersion(stat)) {
    windows.set(key, { version, value, events });
    if (windows.size > 8) windows.delete(windows.keys().next().value);
  }
  return copyWindow(value);
}

export function taskSummary(task, root) {
  const supersession = reviewSupersession(task);
  return {
    id: task.id, agent: task.agent, title: task.title, status: supersession?.status || task.status,
    ...(supersession ? { queueStatus: task.status, reviewOutcome: supersession } : {}),
    updatedAt: task.updated_at, createdAt: task.created_at, sessionId: task.session_id,
    workspace: task.workspace, error: task.error,
    ...(!supersession ? taskFailurePresentation(root, task) : {}),
    interaction: task.interaction || null, interactive: !!task.provider?.token,
  };
}

export function monitorConversation(store, id, before = null, individual = false) {
  safeId(id);
  if (before !== null && (!Number.isSafeInteger(before) || before < 0)) throw new RangeError("Invalid log position");
  const task = store.task(id);
  if (!task) return null;
  let file;
  const name = path.join(store.root, "logs", `${id}.log`);
  let window = { entries: [], nextBefore: null, lastOutput: null, limited: false, cursor: 0, logId: null };
  try { file = openSync(name, "r"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (file !== undefined) {
    try { window = readWindow(file, name, before, individual); }
    finally { closeSync(file); }
  }
  return {
    task: { ...taskSummary(task, store.root), prompt: task.prompt, cost: task.cost || null, turns: task.turns ?? null },
    available: file !== undefined, limited: window.limited, lastOutput: window.lastOutput, nextBefore: window.nextBefore,
    entries: window.entries, cursor: window.cursor, ...(individual ? { raw: true, logId: window.logId } : {}),
    notes: (task.comments || []).map(note => ({
      author: note.author || "unknown", at: note.created_at, text: bounded(note.message || note.content),
    })),
  };
}
